import { existsSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';

import type { BackendConfig, Config } from './config/resolve.js';
import { PERMISSIVE_MODES } from './backend/claude.js';
import { effectivePermissions } from './backend/permissions.js';
import { parseExpression, references } from './expr/parse.js';
import { buildGraph } from './graph.js';
import { isStepcastError } from './errors.js';
import { isGitWorktree } from './anchor/git.js';
import { workspaceInheritanceDiagnostics } from './run/inherit.js';
import {
  describeCopyRejection,
  describeNoCommitForWorktree,
  describeTrackedByRoot,
  hasCommit,
  rootTracksPart,
  workspacePathNeedsCopy,
} from './run/workspace.js';
import { isKnownTimeZone, isSatisfiable, parseCron } from './trigger/cron.js';
import { formatDuration, formatMoney, formatTokens } from './units.js';
import type { ContextEntry, ExpandedPipeline, Job, Predicate, Step, Substitution } from './pipeline/model.js';

/**
 * Статическая проверка раскрытого пайплайна.
 *
 * Ошибки раскрытия фатальны и прерывают работу на первой же — без раскрытия
 * проверять нечего. Здесь наоборот: диагностики собираются все сразу, потому
 * что линтер, сообщающий об одной проблеме за прогон, заставляет чинить их по
 * одной.
 */

export type Severity = 'error' | 'warning';

export interface Diagnostic {
  readonly severity: Severity;
  readonly message: string;
  readonly file?: string;
  readonly at?: string;
  readonly hint?: string;
}

export interface LintOptions {
  readonly config: Config;
  /**
   * Корень рабочей директории: от него отсчитываются пути контекста. Каталог
   * файла пайплайна основанием не годится — пайплайн живёт и в
   * `.stepcast/pipelines/`, а контекст всё равно считается от корня проекта.
   */
  readonly cwd?: string;
  /** Проверять ли существование путей, зависящих от рабочей директории. */
  readonly resolvePaths?: boolean;
}

/** Метасимволы глоба. Глоб запрашивает совпадения, и их отсутствие не ошибка. */
const GLOB = /[*?[]/;

/** Правило имени слага: то же, что у идентификатора работы и у пунктов витрины. */
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface DeclaredPath {
  readonly path: string;
  /** Каталог, от которого путь отсчитывается. Пусто — путь уже абсолютный. */
  readonly base?: string;
  readonly declaredAt: string;
  /** Ключи карты подстановок, под которыми этот путь мог быть записан. */
  readonly keys?: readonly string[];
  readonly file: string;
  readonly kind: string;
}

/**
 * Проверить, что объявленный путь существует.
 *
 * Пропускается то, что проверить нельзя: путь с подстановкой — его значение
 * появляется только в прогоне, а произведённый работой выше по графу файл на
 * момент линта и не обязан существовать; глоб — по той же причине, что и
 * пустой результат поиска не ошибка.
 *
 * Исключение — путь, целиком собранный из `${project.*}`: это пространство
 * объявляет то, что в репозитории есть до прогона (команда проверки, каталог
 * документов, файл правил), а не то, что прогон произведёт, — в отличие от
 * `inputs` и `params`, которыми как раз и адресуют ещё не созданное
 * (`changes/${inputs.change}/tasks.md`). Пропуск такого пути прятал бы
 * опечатку в объявлении: файл, названный `project.spec.rules`, иначе не
 * проверяет никто, и промах виден только отказом работы посреди прогона.
 */
function checkDeclaredPath(
  declared: DeclaredPath,
  substitutions: ExpandedPipeline['substitutions'],
  push: (diagnostic: Diagnostic) => void,
): void {
  const keys = declared.keys ?? [declared.declaredAt];
  const applied = keys.flatMap((key) => [...(substitutions.get(key) ?? [])]);
  if (applied.some((item) => item.deferred || item.namespace !== 'project')) return;
  if (declared.path.includes('${') || GLOB.test(declared.path)) return;

  const full =
    declared.base === undefined ? declared.path : resolvePath(declared.base, declared.path);
  if (existsSync(full)) return;

  push({
    severity: 'error',
    message: `${declared.kind} не найден: ${full}`,
    file: declared.file,
    at: declared.declaredAt,
  });
}

/** Проверить пути записей контекста одного уровня. */
function checkContext(
  entries: readonly ContextEntry[],
  base: string,
  file: string,
  prefix: string,
  substitutions: ExpandedPipeline['substitutions'],
  push: (diagnostic: Diagnostic) => void,
  knowledgeDeclared = false,
): void {
  for (const [index, entry] of entries.entries()) {
    if (entry.kind === 'knowledge') {
      // Запись знания без объявленной практики памяти отклоняется здесь, а не
      // в прогоне: молчаливо пустой контекст выглядел бы работающим шагом с
      // беднее объявленного контекстом, и разбирать это пришлось бы по
      // результату агента, а не по диагностике.
      if (knowledgeDeclared) continue;
      push({
        severity: 'error',
        message: 'Запись контекста knowledge объявлена, но практика памяти не объявлена',
        file,
        at: `${prefix}.${index}`,
        hint: 'Объявите project.knowledge в .stepcast/config.yml или уберите запись',
      });
      continue;
    }
    if (entry.kind !== 'path') continue;
    checkDeclaredPath(
      {
        path: entry.path,
        base,
        declaredAt: `${prefix}.${index}`,
        // Запись контекста бывает строкой и объектом, и подстановка
        // записывается под разными ключами.
        keys: [`${prefix}.${index}`, `${prefix}.${index}.path`],
        file,
        kind: 'Файл контекста',
      },
      substitutions,
      push,
    );
  }
}

/** Пространства, чьи имена в `if` известны заранее. */
const STATIC_NAMESPACES = new Set(['inputs', 'run', 'env', 'jobs']);

/**
 * Группа сессий: работы, объявившие одинаковый `session_group`, продолжают
 * один диалог агента. Три условия делают это исполнимым, и ни одно из них не
 * видно в прогоне до того, как станет поздно, — поэтому они здесь.
 */
function checkSessionGroups(
  pipeline: ExpandedPipeline['pipeline'],
  graph: ReturnType<typeof buildGraph>['graph'],
  push: (diagnostic: Diagnostic) => void,
): void {
  const groups = new Map<string, Job[]>();
  for (const job of pipeline.jobs) {
    if (job.sessionGroup === undefined) continue;
    const members = groups.get(job.sessionGroup) ?? [];
    members.push(job);
    groups.set(job.sessionGroup, members);
  }

  for (const [name, members] of groups) {
    // Цикл until: его новая итерация начинает сессии заново, а сессия группы
    // переживает границу работы — «заново» для неё значило бы оборвать диалог
    // работам, которые уже закончились. Разрешить одно из двух нельзя молча.
    for (const job of members) {
      if (job.until === undefined) continue;
      push({
        severity: 'error',
        message: `Работа ${job.id} объявляет цикл until и состоит в группе сессий ${name}`,
        file: pipeline.file,
        at: `jobs.${job.id}.session_group`,
        hint: 'Новая итерация until начинает сессии заново, а сессия группы живёт дольше работы: перенесите условие в предикат cmd шага и повторяйте шаг через attempts',
      });
    }

    // Порядок: две работы группы не вправе идти одновременно — иначе один и
    // тот же диалог продолжают два процесса разом.
    for (const [index, job] of members.entries()) {
      for (const other of members.slice(index + 1)) {
        const ordered =
          graph.upstream.get(job.id)?.has(other.id) === true ||
          graph.upstream.get(other.id)?.has(job.id) === true;
        if (ordered) continue;
        push({
          severity: 'error',
          message: `Работы ${job.id} и ${other.id} состоят в группе сессий ${name}, но не упорядочены зависимостями`,
          file: pipeline.file,
          at: `jobs.${other.id}.needs`,
          hint: 'Одну сессию нельзя продолжать двумя работами одновременно — свяжите их needs либо разведите по разным группам',
        });
      }
    }

    // Рабочее дерево: у агента посреди диалога не должен смениться каталог.
    // Первая работа группы своё дерево заводит — остальные обязаны его
    // продолжить.
    const inOrder = [...members].sort(
      (left, right) =>
        (graph.upstream.get(left.id)?.size ?? 0) - (graph.upstream.get(right.id)?.size ?? 0),
    );
    for (const job of inOrder.slice(1)) {
      const first = inOrder[0]!;
      if (job.workspace.inherit === 'none') {
        push({
          severity: 'error',
          message: `Работа ${job.id} в группе сессий ${name} заводит своё рабочее дерево`,
          file: pipeline.file,
          at: `jobs.${job.id}.workspace.inherit`,
          hint: `Диалог продолжается в дереве работы ${first.id}: inherit: none сменил бы агенту каталог посреди сессии`,
        });
      }
      if (job.workspace.mode !== first.workspace.mode) {
        push({
          severity: 'error',
          message: `Работы группы сессий ${name} объявляют разные режимы рабочего дерева: ${first.id} — ${first.workspace.mode}, ${job.id} — ${job.workspace.mode}`,
          file: pipeline.file,
          at: `jobs.${job.id}.workspace.mode`,
          hint: 'Работы одного диалога обязаны видеть одно дерево',
        });
      }
    }
  }
}

export function lintPipeline(expanded: ExpandedPipeline, options: LintOptions): Diagnostic[] {
  const { pipeline, substitutions } = expanded;
  const diagnostics: Diagnostic[] = [];
  const push = (diagnostic: Diagnostic): void => {
    diagnostics.push(diagnostic);
  };

  const { graph, problems } = buildGraph(pipeline);

  for (const problem of problems) {
    const at = `jobs.${problem.job}.needs`;
    switch (problem.kind) {
      case 'unknown_dependency':
        push({
          severity: 'error',
          message: `Работа ${problem.job} зависит от несуществующих работ: ${problem.detail.join(', ')}`,
          file: pipeline.file,
          at,
        });
        break;
      case 'cycle':
        push({
          severity: 'error',
          message: `Цикл в зависимостях: ${problem.detail.join(' → ')} → ${problem.detail[0]}`,
          file: pipeline.file,
          at,
        });
        break;
      case 'unreachable':
        push({
          severity: 'error',
          message: `Работа ${problem.job} недостижима: зависит от участника цикла (${problem.detail.join(', ')})`,
          file: pipeline.file,
          at,
        });
        break;
      case 'redundant_dependency':
        push({
          severity: 'warning',
          message: `Работа ${problem.job} перечисляет транзитивные зависимости: ${problem.detail.join(', ')}`,
          file: pipeline.file,
          at,
          hint: 'Достаточно прямых зависимостей — транзитивные подразумеваются',
        });
        break;
    }
  }

  const declaredInputs = new Set(Object.keys(pipeline.inputs));
  const envDenyMatchers = pipeline.envDeny.map(compileNameGlob);

  // Рабочая директория на этапе линта ещё не подготовлена, но её содержимое
  // берётся из каталога проекта: в режиме `cwd` он с ней совпадает, а
  // `worktree` и `copy` копируют дерево из него же.
  const base = options.cwd ?? dirname(pipeline.file);

  // Практика памяти объявлена — значит записи `knowledge:` и предикат
  // `knowledge_valid` имеют кем разрешаться. Значение уже слито (пайплайн
  // поверх конфигурации) в `expandPipeline`, поэтому линт читает одно поле, а
  // не сравнивает два слоя заново.
  const knowledgeDeclared = pipeline.knowledge.provider !== undefined;

  checkContext(pipeline.context, base, pipeline.file, 'context', substitutions, push, knowledgeDeclared);
  checkPipelineSubstitutions(substitutions, graph.byId, pipeline.file, push);
  checkSessionGroups(pipeline, graph, push);

  for (const job of pipeline.jobs) {
    const at = `jobs.${job.id}`;
    checkContext(job.context, base, job.source, `${at}.context`, substitutions, push, knowledgeDeclared);

    for (const [index, predicate] of job.until?.check.entries() ?? []) {
      if (predicate.kind !== 'schema') continue;
      checkDeclaredPath(
        {
          path: predicate.path,
          declaredAt: `${at}.until.check.${index}.schema`,
          file: job.source,
          kind: 'Файл схемы',
        },
        substitutions,
        push,
      );
    }

    if (job.lane !== undefined && !KEBAB_CASE.test(job.lane)) {
      push({
        severity: 'error',
        message: `Работа ${job.id} объявляет lane «${job.lane}», не являющийся слагом в kebab-case`,
        file: pipeline.file,
        at: `${at}.lane`,
        hint: 'Слаг — строчные латинские буквы, цифры и дефис, как у идентификатора работы',
      });
    }

    const upstreamOf = graph.upstream.get(job.id) ?? new Set();
    checkCondition(job, upstreamOf, declaredInputs, graph.byId, pipeline.concurrency, pipeline.file, push);
    checkJobSubstitutions(job, upstreamOf, substitutions, graph.byId, pipeline.file, push);
    checkDisplaySubstitutions(job, substitutions, graph.byId, pipeline.file, push);
    checkContextUpstream(job, upstreamOf, push);
    checkEnv(job.env, envDenyMatchers, pipeline.envDeny, job.source, `${at}.env`, push);

    if (job.context.length > 0 && !job.steps.some((step) => step.kind === 'agent')) {
      push({
        severity: 'warning',
        message: `У работы ${job.id} объявлен context, но нет агентских шагов`,
        file: job.source,
        at: `${at}.context`,
        hint: 'Контекст читают только агентские шаги',
      });
    }

    for (const step of job.steps) {
      checkStep(
        job,
        step,
        base,
        options,
        substitutions,
        envDenyMatchers,
        pipeline.envDeny,
        push,
        knowledgeDeclared,
      );
    }
  }

  checkLimits(pipeline, options.config, push);
  checkTriggers(pipeline, push);

  if (pipeline.budget === undefined) {
    push({
      severity: 'warning',
      message: 'У пайплайна нет бюджета',
      file: pipeline.file,
      at: 'budget',
      hint: 'Повторы будут ограничены только attempts.max',
    });
  }

  for (const job of pipeline.jobs) {
    if (job.until === undefined || job.budget !== undefined) continue;
    // Худший случай работы с циклом = Σ по шагам (бюджет × attempts.max) ×
    // max_iterations. Без собственного бюджета он ограничен только сверху
    // бюджетом пайплайна, а это обычно не то, чего ждёт автор.
    const attempts = job.steps.reduce((sum, step) => sum + step.attempts.max, 0);
    push({
      severity: 'warning',
      message: `У работы ${job.id} есть цикл until, но нет собственного бюджета`,
      file: job.source,
      at: `jobs.${job.id}.budget`,
      hint: `Худший случай: до ${attempts * job.until.maxIterations} исполнений шагов (${job.until.maxIterations} итераций)`,
    });
  }

  for (const job of pipeline.jobs) {
    if (!workspacePathNeedsCopy(job.workspace)) continue;
    push({
      severity: 'error',
      message: 'Путь размещения рабочей копии допустим только при режиме copy',
      file: job.source,
      at: `jobs.${job.id}.workspace.path`,
      hint: `Работа объявляет workspace.mode: ${job.workspace.mode}`,
    });
  }

  const nestedRepos = options.config.project.nestedRepos ?? [];
  if (nestedRepos.length > 0) {
    // Копия `.git` не содержит: то же самое отклонение и та же причина, что
    // в `checkWorkspaceAvailability` (run/workspace.ts) — только раньше,
    // статически. `worktree` при пригодном составе не отклоняется.
    for (const job of pipeline.jobs) {
      if (job.workspace.mode !== 'copy') continue;
      const { message, hint } = describeCopyRejection(job.id);
      push({ severity: 'error', message, file: job.source, at: `jobs.${job.id}.workspace.mode`, hint });
    }

    // Часть без коммита и путь, занятый файлами корня, — те же два отказа,
    // что и в `checkWorkspaceAvailability`, и только для работ в режиме
    // worktree. Требуют настоящего репозитория: на дереве, где `base` им не
    // является (лог не запущен из проекта, часть ещё не склонирована), они
    // молчат — тем же правом, каким `checkDeclaredPath` молчит про путь,
    // который на момент линта проверить нечем. Полная проверка остаётся за
    // `checkWorkspaceAvailability`, исполняемой перед первой работой.
    if (pipeline.jobs.some((job) => job.workspace.mode === 'worktree') && isGitWorktree(base)) {
      for (const relDir of nestedRepos) {
        const full = join(base, relDir);
        if (!isGitWorktree(full)) continue;

        if (!hasCommit(full)) {
          const { message, hint } = describeNoCommitForWorktree(relDir);
          push({ severity: 'error', message, file: pipeline.file, at: 'project.nested_repos', hint });
          continue;
        }

        if (rootTracksPart(base, relDir)) {
          const { message, hint } = describeTrackedByRoot(relDir);
          push({ severity: 'error', message, file: pipeline.file, at: 'project.nested_repos', hint });
        }
      }
    }
  }

  for (const diagnostic of workspaceInheritanceDiagnostics(pipeline, graph)) push(diagnostic);

  if (pipeline.workspace.mode === 'cwd' && pipeline.concurrency > 1) {
    push({
      severity: 'warning',
      message: `workspace.mode: cwd при concurrency: ${pipeline.concurrency}`,
      file: pipeline.file,
      at: 'concurrency',
      hint: 'В режиме cwd работы делят одно дерево и будут мешать друг другу',
    });
  }

  return diagnostics;
}

function checkCondition(
  job: Job,
  upstream: ReadonlySet<string>,
  declaredInputs: ReadonlySet<string>,
  byId: ReadonlyMap<string, Job>,
  concurrency: number,
  file: string,
  push: (diagnostic: Diagnostic) => void,
): void {
  if (job.if === undefined) return;
  const at = `jobs.${job.id}.if`;

  let expression;
  try {
    expression = parseExpression(job.if, at);
  } catch (error) {
    push({
      severity: 'error',
      message: isStepcastError(error) ? error.message : String(error),
      file,
      at,
      ...(isStepcastError(error) && error.hint !== undefined ? { hint: error.hint } : {}),
    });
    return;
  }

  for (const path of references(expression)) {
    const namespace = path[0] as string;
    if (!STATIC_NAMESPACES.has(namespace)) {
      push({
        severity: 'error',
        message: `Неизвестное пространство ${namespace} в условии работы ${job.id}`,
        file,
        at,
        hint: `Доступны: ${[...STATIC_NAMESPACES].sort().join(', ')}`,
      });
      continue;
    }

    if (namespace === 'inputs') {
      const name = path[1];
      if (name === undefined || !declaredInputs.has(name)) {
        push({
          severity: 'error',
          message: `Условие работы ${job.id} обращается к необъявленному входу ${name ?? ''}`,
          file,
          at,
          hint: `Объявлены: ${[...declaredInputs].sort().join(', ') || 'нет'}`,
        });
      }
      continue;
    }

    if (namespace === 'jobs') {
      const other = path[1];

      // Отсутствующее в графе имя не разрешится ни при каком порядке
      // исполнения — это ошибка независимо от concurrency и needs, в отличие
      // от существующего соседа ниже, чей исход просто ещё не гарантирован.
      if (other !== undefined && !byId.has(other)) {
        push({
          severity: 'error',
          message: `Условие работы ${job.id} обращается к несуществующей работе ${other}`,
          file,
          at,
          hint: similarJobsHint(other, byId.keys()),
        });
        continue;
      }

      // Условие вычисляется в момент готовности работы: до этого момента
      // известны исходы только тех работ, что выше по графу.
      if (other !== undefined && job.needs !== 'all' && !upstream.has(other)) {
        // При concurrency: 1 работы идут в порядке объявления — обращение
        // остаётся строгой ошибкой, потому что от неё зависит порядок,
        // который явно нигде не заявлен. При параллелизме тот же порядок
        // никем не гарантирован вовсе, и жёсткий отказ здесь — не о точности
        // диагностики, а о старом правиле; сообщать о риске правильнее
        // предупреждением, называющим причину, чем гасить прогон ошибкой,
        // которая в части случаев (соседняя работа успела раньше) окажется
        // ложной тревогой.
        if (concurrency > 1) {
          push({
            severity: 'warning',
            message: `Условие работы ${job.id} ссылается на работу ${other}, не входящую в её зависимости`,
            file,
            at,
            hint: `При concurrency: ${concurrency} исход ${other} к этому моменту может быть ещё не известен — добавьте её в needs или используйте needs: all`,
          });
        } else {
          push({
            severity: 'error',
            message: `Условие работы ${job.id} обращается к работе ${other}, которой нет выше по графу`,
            file,
            at,
            hint: `Добавьте ${other} в needs или используйте needs: all`,
          });
        }
      }
    }
  }
}

/**
 * Подстановки внутри блока `display`.
 *
 * Правила здесь свои и обратны правилам полей, потребляемых шагом. Подпись
 * раскрывается витриной в момент отрисовки, против уже записанных данных, —
 * поэтому самоссылка `${jobs.<сам>.data.*}` тут законна, а требование «работа
 * выше по графу» бессмысленно: к отрисовке в графе завершились все.
 *
 * Проверяется ровно то, что на этапе разбора и правда неверно: имя работы,
 * которой в пайплайне нет, и обращение не к `data` — единственному
 * пространству, которое витрина умеет раскрыть.
 */
function checkDisplaySubstitutions(
  job: Job,
  substitutions: ExpandedPipeline['substitutions'],
  byId: ReadonlyMap<string, Job>,
  pipelineFile: string,
  push: (diagnostic: Diagnostic) => void,
): void {
  const prefix = `jobs.${job.id}.display.`;

  for (const [key, list] of substitutions) {
    if (!key.startsWith(prefix)) continue;

    for (const item of list) {
      // Неотложенное имя (`inputs`, `params`, `project`) уже раскрыто разбором
      // и до витрины доезжает литералом: проверять в подписи нечего.
      if (!item.deferred) continue;
      const location = substitutionLocation(item, key, pipelineFile);

      if (item.namespace !== 'jobs') {
        push({
          severity: 'error',
          message: `display работы ${job.id} подставляет ${item.expression} — в подписи доступно только пространство jobs.<работа>.data.<ключ>`,
          ...location,
          hint: 'Подпись раскрывается витриной, а не движком: пространства run и env к этому моменту принадлежат уже завершённому прогону',
        });
        continue;
      }

      const [other, namespace] = item.path.split('.');
      if (other === undefined || !byId.has(other)) {
        push({
          severity: 'error',
          message: `display работы ${job.id} подставляет ${item.expression} — работы ${other ?? '?'} нет в пайплайне`,
          ...location,
          hint: similarJobsHint(other ?? '', byId.keys()),
        });
        continue;
      }

      if (namespace !== 'data') {
        push({
          severity: 'error',
          message: `display работы ${job.id} подставляет ${item.expression} — в подписи доступны только данные работы`,
          ...location,
          hint: `Допустимо ${'${'}jobs.${other}.data.<ключ>${'}'}: их публикует сама работа командой stepcast data`,
        });
      }
    }
  }
}

/**
 * Идентификаторы работ, похожие на отсутствующее имя, — для подсказки. Похож
 * тот, чей префикс до первого дефиса совпадает: типичный промах — общий файл
 * промпта на пайплайне с дорожками, называющий работу без её суффикса
 * (`propose` вместо `propose-a`/`propose-b`).
 */
function similarJobsHint(missing: string, ids: Iterable<string>): string {
  const all = [...ids];
  const prefix = missing.split('-')[0];
  const similar = all.filter((id) => id !== missing && id.split('-')[0] === prefix).sort();
  if (similar.length > 0) return `Похожие идентификаторы: ${similar.join(', ')}`;
  return `Объявлены: ${all.sort().join(', ') || 'нет'}`;
}

/**
 * Место подстановки: для поля документа — объявивший его файл и точечный путь
 * поля, для текста, взятого из подключённого файла (промпт), — сам этот файл и
 * позиция выражения в нём.
 *
 * Объявивший файл берётся из самой подстановки: у тела подключённой работы это
 * `jobs/*.yml`, а у `with` и прочей обвязки того же подключения — пайплайн,
 * и по одному лишь ключу карты их не различить.
 */
function substitutionLocation(
  item: Substitution,
  key: string,
  pipelineFile: string,
): { file: string; at: string } {
  if (item.origin === undefined) return { file: item.file ?? pipelineFile, at: key };
  return { file: item.origin, at: `${item.line}:${item.column}` };
}

/**
 * Подстановки `${jobs.<id>.*}` в полях самого пайплайна — контексте, env,
 * бюджете: они принадлежат не работе, и перебор по работам их не видит.
 *
 * Проверяется только существование имени: у поля уровня пайплайна нет
 * предшественниц, оно раскрывается в каждой работе отдельно, и «выше по графу»
 * для него не определено. Отсутствующее же имя не разрешится ни у одной.
 */
function checkPipelineSubstitutions(
  substitutions: ExpandedPipeline['substitutions'],
  byId: ReadonlyMap<string, Job>,
  pipelineFile: string,
  push: (diagnostic: Diagnostic) => void,
): void {
  const flagged = new Set<string>();

  for (const [key, list] of substitutions) {
    if (key.startsWith('jobs.')) continue;

    for (const item of list) {
      if (item.namespace !== 'jobs') continue;
      const other = item.path.split('.')[0];
      if (other === undefined || byId.has(other) || flagged.has(other)) continue;
      flagged.add(other);
      push({
        severity: 'error',
        message: `Пайплайн подставляет ${item.expression} — работы ${other} нет в пайплайне`,
        ...substitutionLocation(item, key, pipelineFile),
        hint: similarJobsHint(other, byId.keys()),
      });
    }
  }
}

/**
 * Подстановки `${jobs.<id>.*}` в определении работы (контекст, env, run,
 * бюджет, промпт — всё, что не `if`).
 *
 * Имя, отсутствующее в графе, не разрешится ни при каком порядке исполнения —
 * это ошибка независимо от concurrency и needs. Имя, которое в графе есть, но
 * не входит в число предшественниц, — тоже ошибка, а не предупреждение: выход
 * публикует работа выше по графу, и у работы вне предшественниц он на момент
 * подстановки не опубликован ни при каком concurrency — в отличие от `if`,
 * читающего исход, а не выход, где порядок объявления при concurrency: 1
 * порой достаточен.
 */
function checkJobSubstitutions(
  job: Job,
  upstream: ReadonlySet<string>,
  substitutions: ExpandedPipeline['substitutions'],
  byId: ReadonlyMap<string, Job>,
  pipelineFile: string,
  push: (diagnostic: Diagnostic) => void,
): void {
  const prefix = `jobs.${job.id}.`;
  const displayPrefix = `${prefix}display.`;
  const flagged = new Set<string>();

  for (const [key, list] of substitutions) {
    if (!key.startsWith(prefix)) continue;
    // Подпись живёт по своим правилам и проверяется отдельно: её раскрывает
    // витрина в момент отрисовки, а не движок перед исполнением работы.
    if (key.startsWith(displayPrefix)) continue;

    for (const item of list) {
      if (item.namespace !== 'jobs') continue;
      // path подстановки уже без пространства: у `${jobs.propose.output.slug}`
      // это `propose.output.slug`, поэтому идентификатор работы — первый сегмент.
      const other = item.path.split('.')[0];

      // Собственные данные вне подписи: поля, потребляемые шагом, раскрываются
      // один раз на работу, до первого её шага, — и там работа заведомо ещё
      // ничего не опубликовала. Ссылка не опасна, она попросту не работает.
      if (other === job.id && item.path.split('.')[1] === 'data') {
        if (flagged.has(`${job.id}.data`)) continue;
        flagged.add(`${job.id}.data`);
        push({
          severity: 'error',
          message: `Работа ${job.id} подставляет ${item.expression} — собственные данные вне display`,
          ...substitutionLocation(item, key, pipelineFile),
          hint: 'Поля, потребляемые шагом, раскрываются до первого шага работы, когда данных ещё нет; собственные данные читает только display',
        });
        continue;
      }

      if (other === undefined || other === job.id || flagged.has(other)) continue;

      const location = substitutionLocation(item, key, pipelineFile);

      if (!byId.has(other)) {
        flagged.add(other);
        push({
          severity: 'error',
          message: `Работа ${job.id} подставляет ${item.expression} — работы ${other} нет в пайплайне`,
          ...location,
          hint: similarJobsHint(other, byId.keys()),
        });
        continue;
      }

      if (job.needs === 'all' || upstream.has(other)) continue;
      flagged.add(other);

      push({
        severity: 'error',
        message: `Работа ${job.id} подставляет ${item.expression} — выход работы ${other}, не входящей в её зависимости`,
        ...location,
        hint: `Добавьте ${other} в needs или используйте needs: all`,
      });
    }
  }
}

/**
 * Перечень `context_upstream`, называющий работу вне предшественников.
 *
 * Блок контекста собирается из выходов работ выше по графу, и имя за их
 * пределами в перечне не отбирает ничего: работа, названная явно, в блок не
 * попадает, и шаг молча получает контекст беднее заявленного. Это ошибка
 * определения — перечень называет ровно то, что автор хотел видеть.
 */
function checkContextUpstream(
  job: Job,
  upstream: ReadonlySet<string>,
  push: (diagnostic: Diagnostic) => void,
): void {
  const selector = job.contextUpstream;
  if (selector === 'all' || selector === 'none') return;

  for (const other of selector) {
    if (upstream.has(other)) continue;
    push({
      severity: 'error',
      message: `context_upstream работы ${job.id} называет работу ${other}, которой нет выше по графу`,
      file: job.source,
      at: `jobs.${job.id}.context_upstream`,
      hint:
        other === job.id
          ? 'Работа не может взять в контекст собственный выход'
          : `Добавьте ${other} в needs или уберите её из context_upstream`,
    });
  }
}

function checkStep(
  job: Job,
  step: Step,
  base: string,
  options: LintOptions,
  substitutions: ExpandedPipeline['substitutions'],
  envDenyMatchers: readonly RegExp[],
  envDenyPatterns: readonly string[],
  push: (diagnostic: Diagnostic) => void,
  knowledgeDeclared = false,
): void {
  const at = `jobs.${job.id}.steps.${step.index - 1}`;

  checkEnv(step.env, envDenyMatchers, envDenyPatterns, job.source, `${at}.env`, push);

  if (step.kind === 'run' && typeof step.command === 'string') {
    // Вывод модели — это данные. В строковой форме они попадают в командную
    // строку оболочки, и подстановка становится исполнением.
    const applied = substitutions.get(`${at}.run`) ?? [];
    const fromModel = applied.filter((item) => item.namespace === 'jobs');
    if (fromModel.length > 0) {
      push({
        severity: 'error',
        message: `Шаг ${job.id}/${step.id} подставляет вывод работы в строковую форму run`,
        file: job.source,
        at: `${at}.run`,
        hint: `Используйте форму списком argv: подстановка ${fromModel[0]?.expression} в командную строку исполняема`,
      });
    }
  }

  if (step.kind === 'agent') {
    const backend = options.config.backends[step.agent];
    if (backend === undefined) {
      push({
        severity: 'error',
        message: `Неизвестный бэкенд ${step.agent} у шага ${job.id}/${step.id}`,
        file: job.source,
        at: `${at}.agent`,
        hint: `Настроены: ${Object.keys(options.config.backends).sort().join(', ')}`,
      });
    } else if (!backend.enabled) {
      push({
        severity: 'error',
        message: `Бэкенд ${step.agent} выключен в конфигурации`,
        file: job.source,
        at: `${at}.agent`,
      });
    } else {
      checkPermissionsEnforce(job, step, step.agent, backend, at, push);
    }
  }

  if (step.outputSchemaPath !== undefined) {
    checkDeclaredPath(
      {
        path: step.outputSchemaPath,
        declaredAt: `${at}.output_schema`,
        file: job.source,
        kind: 'Файл схемы',
      },
      substitutions,
      push,
    );
  }

  checkContext(step.context, base, job.source, `${at}.context`, substitutions, push, knowledgeDeclared);

  for (const [index, predicate] of step.expect.entries()) {
    if (predicate.kind === 'knowledge_valid' && !knowledgeDeclared) {
      push({
        severity: 'error',
        message: 'Предикат knowledge_valid объявлен, но практика памяти не объявлена',
        file: job.source,
        at: `${at}.expect.${index}.knowledge_valid`,
        hint: 'Объявите project.knowledge в .stepcast/config.yml или уберите предикат',
      });
    }
    if (predicate.kind === 'schema') {
      checkDeclaredPath(
        {
          path: predicate.path,
          declaredAt: `${at}.expect.${index}.schema`,
          file: job.source,
          kind: 'Файл схемы',
        },
        substitutions,
        push,
      );
      continue;
    }
    if (predicate.kind !== 'judge') continue;

    const backendName = predicate.agent ?? options.config.defaults.agent;
    const backend = options.config.backends[backendName];
    if (backend === undefined) {
      push({
        severity: 'error',
        message: `Неизвестный бэкенд судьи ${backendName} у шага ${job.id}/${step.id}`,
        file: job.source,
        at: `${at}.expect.${index}.agent`,
        hint: `Настроены: ${Object.keys(options.config.backends).sort().join(', ')}`,
      });
      continue;
    }
    if (!backend.structuredOutput) {
      push({
        severity: 'error',
        message: `Бэкенд судьи ${backendName} не поддерживает структурированный вывод`,
        file: job.source,
        at: `${at}.expect.${index}.agent`,
        hint: 'Вердикт судьи принимается только структурой { pass, reason } — бэкенд обязан объявлять structured_output: true',
      });
    }
  }

  const structural = step.expect.filter((predicate) => predicate.kind !== 'judge' || predicate.hard);
  if (step.expect.length > 0 && structural.length === 0) {
    push({
      severity: 'warning',
      message: `У шага ${job.id}/${step.id} нет структурных предикатов`,
      file: job.source,
      at: `${at}.expect`,
      hint: 'Гейт держится только на суждении агента',
    });
  }

  if (step.expect.length === 1 && isChangedOnly(step.expect[0])) {
    push({
      severity: 'warning',
      message: `У шага ${job.id}/${step.id} единственный предикат — changed_only`,
      file: job.source,
      at: `${at}.expect`,
      hint: 'Он проверяет границы изменений, но не факт работы: шаг, не сделавший ничего, его пройдёт',
    });
  }
}

function isChangedOnly(predicate: Predicate | undefined): boolean {
  return predicate?.kind === 'changed_only';
}

/**
 * `enforce: strict`, который не может быть исполнен, — ошибка, а не тихое
 * послабление: оставленный без диагностики, он вернул бы ровно ту ложь
 * границы, ради устранения которой заведён режим (см. design.md).
 *
 * Политика шага уже несёт ближайшее объявление (шаг сильнее работы —
 * `expand.ts`), а базовый режим бэкенда применяется поверх неё по тому же
 * правилу, каким его применяет адаптер в `launch` (`effectivePermissions`).
 */
function checkPermissionsEnforce(
  job: Job,
  step: Step,
  backendName: string,
  backend: BackendConfig,
  at: string,
  push: (diagnostic: Diagnostic) => void,
): void {
  if (step.kind !== 'agent') return;
  const effective = effectivePermissions(step.permissions, backend.permissions);
  if ((effective?.enforce ?? 'inherit') !== 'strict') return;

  const { at: enforceAt, file: enforceFile } = enforceOrigin(job, step, backendName, at);

  if (effective?.mode !== undefined && (PERMISSIVE_MODES as readonly string[]).includes(effective.mode)) {
    push({
      severity: 'error',
      message: `Шаг ${job.id}/${step.id}: enforce: strict рядом с mode: ${effective.mode} — разрешающий режим бэкенда ${backendName}`,
      ...(enforceFile === undefined ? {} : { file: enforceFile }),
      at: enforceAt,
      hint: 'enforce: strict требует режима, отклоняющего неназванное — уберите mode либо смените его на запрещающий',
    });
  }

  if (!backend.strictPermissions) {
    push({
      severity: 'error',
      message: `Шаг ${job.id}/${step.id}: бэкенд ${backendName} не объявляет возможность применять enforce: strict`,
      ...(enforceFile === undefined ? {} : { file: enforceFile }),
      at: enforceAt,
      hint: `Включите backends.${backendName}.strict_permissions в конфигурации либо снимите enforce: strict`,
    });
  }
}

/**
 * Место, где `enforce` объявлен на самом деле.
 *
 * `expand.ts` копирует политику работы в каждый её шаг тем же объектом, и
 * назвать в диагностике `jobs.<id>.steps.<n>.permissions.enforce` значило бы
 * указать на поле, которого в файле нет. Тождество ссылки здесь и отличает
 * скопированную политику от объявленной шагом: `toPermissions` для шага
 * строит новый объект.
 */
function enforceOrigin(
  job: Job,
  step: Extract<Step, { kind: 'agent' }>,
  backendName: string,
  at: string,
): { readonly at: string; readonly file?: string } {
  if (step.permissions?.enforce === undefined) {
    return { at: `backends.${backendName}.permissions.enforce` };
  }
  if (job.permissions !== undefined && step.permissions === job.permissions) {
    return { at: `jobs.${job.id}.permissions.enforce`, file: job.source };
  }
  return { at: `${at}.permissions.enforce`, file: job.source };
}

function checkEnv(
  env: Readonly<Record<string, string>>,
  matchers: readonly RegExp[],
  patterns: readonly string[],
  file: string,
  at: string,
  push: (diagnostic: Diagnostic) => void,
): void {
  for (const name of Object.keys(env)) {
    const index = matchers.findIndex((matcher) => matcher.test(name));
    if (index === -1) continue;
    push({
      severity: 'error',
      message: `Переменная ${name} объявлена в env, но попадает под запрет ${patterns[index]}`,
      file,
      at: `${at}.${name}`,
      hint: 'Запреты снизу не отменяются: переименуйте переменную или измените env_deny в конфигурации',
    });
  }
}

function checkLimits(
  pipeline: ExpandedPipeline['pipeline'],
  config: Config,
  push: (diagnostic: Diagnostic) => void,
): void {
  const { limits } = config;

  if (pipeline.concurrency > limits.concurrency) {
    push({
      severity: 'error',
      message: `concurrency ${pipeline.concurrency} превышает потолок limits.concurrency ${limits.concurrency}`,
      file: pipeline.file,
      at: 'concurrency',
    });
  }

  const budgets: Array<{ readonly at: string; readonly budget: Job['budget'] }> = [
    { at: 'budget', budget: pipeline.budget },
    ...pipeline.jobs.map((job) => ({ at: `jobs.${job.id}.budget`, budget: job.budget })),
  ];

  for (const { at, budget } of budgets) {
    if (budget === undefined) continue;
    if (budget.tokens !== undefined && budget.tokens > limits.tokens) {
      push({
        severity: 'error',
        message: `budget.tokens ${formatTokens(budget.tokens)} превышает потолок limits.tokens ${formatTokens(limits.tokens)}`,
        file: pipeline.file,
        at: `${at}.tokens`,
        hint: 'Потолок снизу можно ужесточить, но не поднять',
      });
    }
    if (budget.wallclockMs !== undefined && budget.wallclockMs > limits.wallclockMs) {
      push({
        severity: 'error',
        message: `budget.wallclock ${formatDuration(budget.wallclockMs)} превышает потолок limits.wallclock ${formatDuration(limits.wallclockMs)}`,
        file: pipeline.file,
        at: `${at}.wallclock`,
      });
    }
  }

  // Денежный потолок объявляется на трёх уровнях, включая шаг — тем и
  // отличается от tokens/wallclock, которые лимитируются только сверху.
  const costBudgets: Array<{ readonly at: string; readonly file: string; readonly budget: Job['budget'] }> = [
    { at: 'budget', file: pipeline.file, budget: pipeline.budget },
    ...pipeline.jobs.map((job) => ({ at: `jobs.${job.id}.budget`, file: job.source, budget: job.budget })),
    ...pipeline.jobs.flatMap((job) =>
      job.steps.map((step) => ({
        at: `jobs.${job.id}.steps.${step.index - 1}.budget`,
        file: job.source,
        budget: step.budget,
      })),
    ),
  ];

  for (const { at, file, budget } of costBudgets) {
    if (budget?.costMicroUsd === undefined) continue;
    if (budget.costMicroUsd > limits.costMicroUsd) {
      push({
        severity: 'error',
        message: `budget.cost ${formatMoney(budget.costMicroUsd)} превышает потолок limits.cost ${formatMoney(limits.costMicroUsd)}`,
        file,
        at: `${at}.cost`,
        hint: 'Потолок снизу можно ужесточить, но не поднять',
      });
    }
  }
}

/**
 * Проверить объявленное расписание: наличие и разбор `cron`, известность
 * часового пояса и выполнимость маски.
 *
 * Выполнимость проверяется по календарю (`isSatisfiable`), а не перебором от
 * «сейчас»: вердикт линта не должен зависеть от дня, в который его позвали,
 * а расписание, чьё ближайшее срабатывание лежит у края горизонта перебора,
 * иначе принималось бы или отклонялось по-разному в разные дни.
 */
function checkTriggers(pipeline: ExpandedPipeline['pipeline'], push: (diagnostic: Diagnostic) => void): void {
  const schedule = pipeline.triggers?.schedule ?? [];

  for (const [index, entry] of schedule.entries()) {
    const at = `triggers.schedule.${index}`;

    if (entry.cron === undefined || entry.cron.trim() === '') {
      push({
        severity: 'error',
        message: `Запись расписания ${index} не содержит обязательного поля cron`,
        file: pipeline.file,
        at: `${at}.cron`,
      });
      continue;
    }

    const parsed = parseCron(entry.cron);
    if (!parsed.ok) {
      push({
        severity: 'error',
        message: `Запись расписания ${index}: ${parsed.reason}`,
        file: pipeline.file,
        at: `${at}.cron`,
      });
      continue;
    }

    if (entry.timezone !== undefined && !isKnownTimeZone(entry.timezone)) {
      push({
        severity: 'error',
        message: `Запись расписания ${index}: неизвестный часовой пояс ${entry.timezone}`,
        file: pipeline.file,
        at: `${at}.timezone`,
      });
      continue;
    }

    if (!isSatisfiable(parsed.mask)) {
      push({
        severity: 'error',
        message: `Запись расписания ${index}: расписание невыполнимо — такой день в этом месяце не наступает`,
        file: pipeline.file,
        at,
      });
    }
  }
}

/** Глоб по имени переменной: `*` покрывает любую последовательность символов. */
export function compileNameGlob(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (char) =>
    char === '*' ? '.*' : `\\${char}`,
  );
  // На Windows имена переменных окружения регистронезависимы, и запрет,
  // который обходится сменой регистра, — не запрет.
  const flags = process.platform === 'win32' ? 'i' : '';
  return new RegExp(`^${escaped}$`, flags);
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}
