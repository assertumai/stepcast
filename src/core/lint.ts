import { existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';

import type { Config } from './config/resolve.js';
import { parseExpression, references } from './expr/parse.js';
import { buildGraph } from './graph.js';
import { isStepcastError } from './errors.js';
import { workspacePathNeedsCopy } from './run/workspace.js';
import { formatDuration, formatTokens } from './units.js';
import type { ContextEntry, ExpandedPipeline, Job, Predicate, Step } from './pipeline/model.js';

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
 */
function checkDeclaredPath(
  declared: DeclaredPath,
  substitutions: ExpandedPipeline['substitutions'],
  push: (diagnostic: Diagnostic) => void,
): void {
  const keys = declared.keys ?? [declared.declaredAt];
  if (keys.some((key) => (substitutions.get(key) ?? []).length > 0)) return;
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
): void {
  for (const [index, entry] of entries.entries()) {
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

  checkContext(pipeline.context, base, pipeline.file, 'context', substitutions, push);

  for (const job of pipeline.jobs) {
    const at = `jobs.${job.id}`;
    checkContext(job.context, base, job.source, `${at}.context`, substitutions, push);

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

    checkCondition(job, graph.upstream.get(job.id) ?? new Set(), declaredInputs, pipeline.file, push);
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
      checkStep(job, step, base, options, substitutions, envDenyMatchers, pipeline.envDeny, push);
    }
  }

  checkLimits(pipeline, options.config, push);

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

  const inertWaitBudgets: Array<{ readonly at: string; readonly file: string; readonly budget: Job['budget'] }> = [
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

  for (const { at, file, budget } of inertWaitBudgets) {
    if (budget === undefined || budget.onExceed !== 'wait' || budget.rateLimitPct !== undefined) {
      continue;
    }
    push({
      severity: 'warning',
      message: `Бюджет ${at} объявляет on_exceed: wait без rate_limit_pct`,
      file,
      at,
      hint: 'Ждать нечего: ждёт только превышение rate_limit_pct, превышение остановит прогон',
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
      // Условие вычисляется в момент готовности работы: до этого момента
      // известны исходы только тех работ, что выше по графу.
      if (other !== undefined && job.needs !== 'all' && !upstream.has(other)) {
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

function checkStep(
  job: Job,
  step: Step,
  base: string,
  options: LintOptions,
  substitutions: ExpandedPipeline['substitutions'],
  envDenyMatchers: readonly RegExp[],
  envDenyPatterns: readonly string[],
  push: (diagnostic: Diagnostic) => void,
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
  }

  checkContext(step.context, base, job.source, `${at}.context`, substitutions, push);

  for (const [index, predicate] of step.expect.entries()) {
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
