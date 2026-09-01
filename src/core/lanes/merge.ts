import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkCompositeComposition, type AnchorKind } from '../anchor/index.js';
import { StepcastError, isStepcastError } from '../errors.js';
import { REASON_LIMIT, finishItem, parseBacklogFile, tailLine } from '../backlog/index.js';
import type { RunPaths } from '../journal/paths.js';
import { readManifest, readStatus } from '../journal/reader.js';
import type { RunStatus } from '../journal/schema.js';
import { applyRun, laneAnchorRange, type LaneAnchorRange } from '../run/apply.js';
import { runCheck } from './check.js';
import { hasLaneItem, readLaneItem } from './item.js';
import { evaluateLane, knownLanes } from './lanes.js';
import {
  assertCleanTree,
  commitAll,
  currentCommit,
  headMessage,
  nestedRepoOf,
  resetToCommit,
  tracksGitlink,
} from './tree.js';

/**
 * Обход дорожек прогона: наложение, проверка, коммит зелёной, откат красной —
 * по каждому затронутому репозиторию. Возвращает исход каждой дорожки
 * перечня — печать и код возврата остаются заботой команды
 * (`src/cli/commands/merge-lanes.ts`).
 */

export interface MergeLanesOptions {
  readonly paths: RunPaths;
  /** Дерево запуска: команда коммитит и, при красной проверке, стирает его правки. */
  readonly cwd: string;
  /** Дорожки в порядке обхода. Каждая обязана быть известна прогону. */
  readonly lanes: readonly string[];
  /** Команда проверки корня, строка для оболочки. */
  readonly check: string;
  /** Файл очереди улучшений. */
  readonly file: string;
  /**
   * Объявленный состав вложенных репозиториев дерева (`project.nested_repos`)
   * — читает конфигурацию вызывающая команда, а не это ядро: см. `allow` у
   * `assertCleanTree`.
   */
  readonly nestedRepos?: readonly string[];
  /**
   * Объявленные команды проверки вложенных репозиториев, по объявленному
   * каталогу — читает конфигурацию вызывающая команда (`src/cli/commands/
   * merge-lanes.ts`), а не это ядро (design.md, решение 7). Корневая команда
   * приезжает отдельным ключом `check` и вложенному репозиторию не
   * подставляется.
   */
  readonly repoChecks?: ReadonlyMap<string, string>;
}

export type LaneMergeResult =
  | { readonly lane: string; readonly kind: 'merged'; readonly slug: string; readonly repos: readonly string[] }
  | { readonly lane: string; readonly kind: 'empty' }
  | { readonly lane: string; readonly kind: 'no_item' }
  | { readonly lane: string; readonly kind: 'unfit'; readonly reason: string }
  | { readonly lane: string; readonly kind: 'conflict'; readonly reason: string }
  | { readonly lane: string; readonly kind: 'check_failed'; readonly reason: string }
  | { readonly lane: string; readonly kind: 'no_contribution'; readonly reason: string }
  | { readonly lane: string; readonly kind: 'not_reached'; readonly reason: string };

/** Причина с хвостом чужого вывода: приставка целиком, вывод — сколько влезло. */
function reasonWithOutput(prefix: string, output: string): string {
  return `${prefix}${tailLine(output, REASON_LIMIT - prefix.length)}`;
}

/**
 * Сколько вывода красной проверки остаётся в причине дорожки, откат которой
 * не подтверждён: причина несёт тогда оба отказа сразу, и делить предел поля
 * поровну незачем — читать её будут ради грязного дерева, а хвост упавшей
 * команды в ней остаётся приметой, по которой узнаётся сама проверка.
 */
const RED_OUTPUT_ON_UNCONFIRMED = 120;

/** Путь рабочего дерева дорожки — последняя её работа, несущая `workspace`. */
function workspaceOf(status: RunStatus, lane: string): string | undefined {
  const records = status.jobs.filter((job) => job.lane === lane);
  return [...records].reverse().find((job) => job.workspace !== undefined)?.workspace?.path;
}

/** Каталог репозитория по его имени в перечне затронутых — `.` значит `cwd`. */
function repoDirOf(cwd: string, repo: string): string {
  return repo === '.' ? cwd : join(cwd, repo);
}

/**
 * Затронутые репозитории дорожки — те, чьи снятые состояния до и после
 * различаются. `.` обозначает корень; порядок детерминирован — корень
 * первым, затем объявленные части в каноническом порядке состава (design.md,
 * решение 1). Поле `repos` пункта очереди здесь не участвует: дифф говорит о
 * правках точнее объявления. Функция не трогает дерева и не зовёт git —
 * источник данных здесь только сами идентификаторы состояний, записанные
 * прогоном; расхождение состава с действующим — отказ named-причиной, а не
 * молчаливое наложение чужой части в сегодняшнюю.
 */
export function affectedRepos(
  kind: AnchorKind,
  nestedRepos: readonly string[],
  range: LaneAnchorRange,
): readonly string[] {
  const { from, to } = range;
  if (from === to) return [];
  if (kind !== 'composite') return ['.'];

  const fromCheck = checkCompositeComposition(from, nestedRepos);
  if (!fromCheck.ok) throw new StepcastError(fromCheck.reason);
  const toCheck = checkCompositeComposition(to, nestedRepos);
  if (!toCheck.ok) throw new StepcastError(toCheck.reason);

  const canonical = [...nestedRepos].sort();
  const repos: string[] = [];
  if (fromCheck.parsed.root !== toCheck.parsed.root) repos.push('.');
  for (let index = 0; index < canonical.length; index += 1) {
    if (fromCheck.parsed.parts[index] !== toCheck.parsed.parts[index]) repos.push(canonical[index]!);
  }
  return repos;
}

/** Команда проверки репозитория: `.` — ключ `--check`, иначе — его объявление в составе. */
function checkCommandFor(repo: string, check: string, repoChecks: ReadonlyMap<string, string> | undefined): string | undefined {
  return repo === '.' ? check : repoChecks?.get(repo);
}

/**
 * Порядок коммитов дорожки по репозиториям (design.md, решение 8).
 *
 * Снизу вверх по гитлинкам: вложенные репозитории коммитятся раньше корня,
 * который их ведёт, — коммит внутри части двигает запись корня о ней, и
 * корневой коммит обязан её подхватить, иначе дерево запуска остаётся грязным
 * и головное предусловие следующего захода упирается в него. Корень поэтому
 * стоит в перечне всегда, даже когда дорожка его дифом не задела: коммит на
 * пустом индексе `commitAll` пропустит сам.
 *
 * Репозиторий очереди — последний, потому что несёт отметку `done`. Уступает
 * он ровно одному: корню, который ведёт **его самого** гитлинком, — тогда
 * корень идёт после него, подхватывая сдвинутую запись. Порядок этот вынужден
 * и разрешим только так: одним коммитом на репозиторий «отметка последней» и
 * «корень чист» вместе не выполнимы, а грязный корень останавливает петлю
 * целиком, тогда как отметка перед корневым коммитом — лишь порядок в истории.
 */
function commitOrder(cwd: string, affected: readonly string[], queueRepo: string): readonly string[] {
  const nestedCode = affected.filter((repo) => repo !== '.' && repo !== queueRepo);
  if (queueRepo === '.') return [...nestedCode, '.'];
  return tracksGitlink(cwd, queueRepo) ? [...nestedCode, queueRepo, '.'] : [...nestedCode, '.', queueRepo];
}

/**
 * До первого наложения — у каждого репозитория, который затронет хоть одна
 * дорожка перечня, обязана быть объявленная команда проверки. Перечень
 * затронутых читается из состояний прогона (`affectedRepos`), дерева не
 * касаясь: вся проверка выполнимости делается на нетронутом дереве, и
 * дорожки не приходится откатывать из-за дырки в конфигурации (design.md,
 * решение 7).
 *
 * Спрашивается это только с дорожек, которые до наложения дойдут: дорожка с
 * неуспешными работами или без доставшегося пункта не сведётся ни при каком
 * содержимом конфигурации, и ронять из-за неё весь обход — значит не свести и
 * все остальные, тогда как прежде она просто помечалась `failed`.
 */
function assertRepoChecksDeclared(
  paths: RunPaths,
  lanes: readonly string[],
  kind: AnchorKind,
  nestedRepos: readonly string[],
  check: string,
  repoChecks: ReadonlyMap<string, string> | undefined,
): void {
  for (const lane of lanes) {
    const range = laneAnchorRange(paths, lane);
    if (range === undefined) continue;
    const repos = affectedRepos(kind, nestedRepos, range);
    for (const repo of repos) {
      if (checkCommandFor(repo, check, repoChecks) === undefined) {
        throw new StepcastError(
          `дорожка «${lane}» затрагивает репозиторий «${repo}», для которого не объявлена команда проверки`,
          { at: lane, hint: 'Объявите check в project.nested_repos для этого каталога' },
        );
      }
    }
  }
}

/**
 * Диагностика обрыва между коммитами (design.md, решение 9): `HEAD`
 * репозитория несёт сообщение `<слаг>: …` пункта, чей исход в очереди не
 * проставлен, — сочетание, которое иначе не возникает: исход проставляется
 * до первого коммита, а конфликт и красная проверка коммитов не оставляют
 * вовсе. Признак читается из самих репозиториев и очереди — без промежуточных
 * учётных файлов, и недостающий коммит команда не дописывает сама.
 *
 * Коммит ищется по всем объявленным репозиториям — он мог лечь и туда, куда
 * его не ждали, — а недостающим называется только тот, кому коммит
 * **полагался**: затронутые дорожкой репозитории и репозиторий очереди
 * (`dueRepos`). Перечислять «без коммита» все объявленные значило бы звать
 * читателя искать недостающий коммит там, где его никогда не должно было
 * быть.
 */
function assertNoBrokenMerge(
  cwd: string,
  nestedRepos: readonly string[],
  file: string,
  lanes: readonly string[],
  runDir: string,
  dueRepos: (lane: string) => readonly string[],
): void {
  const entries = existsSync(file) ? parseBacklogFile(file, readFileSync(file, 'utf8')) : [];
  const statusOf = (slug: string): string | undefined =>
    entries.find((entry) => entry.slug === slug)?.data.status;
  const repos = ['.', ...nestedRepos];

  for (const lane of lanes) {
    if (!hasLaneItem(runDir, lane)) continue;
    const item = readLaneItem(runDir, lane);
    const status = statusOf(item.slug);
    if (status === 'done' || status === 'failed') continue;

    const prefix = `${item.slug}: `;
    const withCommit = repos.filter((repo) => headMessage(repoDirOf(cwd, repo))?.startsWith(prefix) === true);
    if (withCommit.length === 0) continue;

    const withoutCommit = dueRepos(lane).filter((repo) => !withCommit.includes(repo));
    throw new StepcastError(
      `сведение дорожки «${lane}» оборвалось между коммитами: пункт «${item.slug}» закоммичен в ${withCommit.join(
        ', ',
      )}, но не в ${withoutCommit.length === 0 ? '(нет)' : withoutCommit.join(', ')}, а очередь не отмечает исход`,
      {
        at: item.slug,
        file,
        hint: 'Проверьте состояние репозиториев и очереди вручную и проставьте исход — самолечения здесь нет',
      },
    );
  }
}

export async function mergeLanes(options: MergeLanesOptions): Promise<readonly LaneMergeResult[]> {
  const { paths, cwd, lanes, check, file, repoChecks } = options;
  const nestedRepos = options.nestedRepos ?? [];
  const runDir = paths.dir;

  // Репозиторий, в чьём рабочем дереве лежит файл очереди, — чистая работа с
  // путями, ни git, ни журнала: поэтому известен раньше всех проверок.
  const queueRepo = nestedRepoOf(cwd, nestedRepos, file) ?? '.';

  /**
   * Репозитории, которым коммит дорожки полагался: затронутые ею и держащий
   * очередь. Считается лениво — только на пути диагностики обрыва, где журнал
   * прогона заведомо на месте (у дорожки есть файл пункта). Расхождение
   * составов здесь не отказ: о нём скажет своё место, а диагностике довольно
   * знать репозиторий очереди.
   */
  const dueRepos = (lane: string): readonly string[] => {
    try {
      const range = laneAnchorRange(paths, lane);
      const laneKind: AnchorKind = readManifest(paths).anchor_kind ?? 'git';
      const affected = range === undefined ? [] : affectedRepos(laneKind, nestedRepos, range);
      return [...new Set([...affected, queueRepo])];
    } catch {
      return [queueRepo];
    }
  };

  /**
   * Предусловие чистоты дерева запуска и объявленных вложенных репозиториев —
   * с тем же исключением для файла очереди. Заход зовёт его дважды: до
   * первого наложения (богус-путь прогона обязан отказывать о дереве, а не о
   * ненайденном `run.json`) и сразу после отката красной проверки — второй
   * раз отказ ловится вызывающим кодом как признак неподтверждённого отката
   * (design.md, решение 2), а не пробрасывается наружу.
   */
  const assertRunTreeClean = (): void =>
    assertCleanTree(cwd, { allow: [file], ...(nestedRepos.length === 0 ? {} : { nested: nestedRepos }) });

  // Диагностика обрыва — первым делом, раньше даже проверки чистоты: сведение,
  // оборвавшееся между коммитами репозиториев, оставляет корень «грязным» —
  // его гитлинк на затронутую часть указывает на её новый коммит, которого
  // сам корень ещё не зафиксировал. Проверь чистоту первой — и это состояние
  // объяснялось бы общим «дерево не чисто» вместо названной причины.
  assertNoBrokenMerge(cwd, nestedRepos, file, lanes, runDir, dueRepos);

  // Файл очереди из проверки чистоты исключён: отметку `in_progress` в него
  // ставит голова той же петли, в начале того же прогона, и к сведению она
  // закономерно не закоммичена. Требовать её коммита значило бы требовать
  // коммита посреди прогона — правки же агента дерево по-прежнему обязано
  // не содержать. Исключение относится к тому дереву, где очередь лежит —
  // маршрутизируется тем же правилом, что и остальные пути allow.
  assertRunTreeClean();

  const kind: AnchorKind = readManifest(paths).anchor_kind ?? 'git';

  const status = readStatus(paths);
  const known = knownLanes(status.jobs);
  for (const lane of lanes) {
    if (!known.includes(lane)) {
      throw new StepcastError(`дорожка «${lane}» неизвестна прогону`, {
        hint: known.length === 0 ? 'В прогоне нет ни одной работы с меткой lane' : `Известны: ${known.join(', ')}`,
      });
    }
  }

  // Спрашивается команда проверки только с дорожек, которые до наложения
  // дойдут: негодная и не получившая пункта не сведутся ни при какой
  // конфигурации, и отказ из-за них не свёл бы заодно и все остальные.
  const mergeable = lanes.filter(
    (lane) => evaluateLane(status.jobs, lane).kind === 'ready' && hasLaneItem(runDir, lane),
  );
  assertRepoChecksDeclared(paths, mergeable, kind, nestedRepos, check, repoChecks);

  const results: LaneMergeResult[] = [];

  /**
   * «Дерево в неизвестном состоянии» — единственное основание прекратить
   * обход целиком. Красная проверка сюда не относится: адресный откат уже
   * вернул каждый затронутый репозиторий к записанному коммиту, и как только
   * чистота деревьев после отката подтверждена, дальше лежит ровно то дерево,
   * на которое легла бы следующая дорожка, не будь упавшей в перечне вовсе.
   * Оснований остановки ровно два: конфликт наложения (`applyRun`
   * восстанавливает дерево своим якорем, и отказ самого восстановления
   * приходит тем же типом ошибки, что и чистый конфликт, — отличить их
   * нечем) и неподтверждённый откат (команда проверки — произвольная строка
   * проекта и могла тронуть то, чего адресный откат не покрывает).
   *
   * Причина остановки хранится разложенной на приставку и чужой вывод: из тех
   * же частей собирается причина недостигнутой дорожки — своей приставкой
   * поверх этой. Сложить две готовые причины нельзя: каждая уже занимает
   * `REASON_LIMIT` целиком, и хвост срезала бы запись в очередь.
   */
  let stoppedAt:
    | {
        readonly lane: string;
        readonly basis: 'conflict' | 'unconfirmed_rollback';
        readonly prefix: string;
        readonly output: string;
      }
    | undefined;

  /** Проставить дорожке `failed`, только если ей вообще достался пункт очереди. */
  const markFailed = (lane: string, reason: string): void => {
    if (!hasLaneItem(runDir, lane)) return;
    const item = readLaneItem(runDir, lane);
    finishItem(file, item.slug, 'failed', reason);
  };

  /**
   * Снимок очереди на момент до наложения дорожки — то, к чему её откат
   * обязан вернуть файл.
   *
   * Откат красной проверки — `git reset --hard` с `clean -fd`, и он сносит
   * из очереди всё, что не попало в коммит: и отметку `in_progress`,
   * проставленную головой петли до сведения, и исходы более ранних дорожек
   * этого же обхода. Снимок берётся на каждую дорожку заново, поэтому несёт
   * их все, независимо от того, закоммичены они или нет, — и восстановление
   * им не путает содержимое очереди ни при отслеживаемом файле, ни при
   * игнорируемом, ни при лежащем вне дерева.
   */
  const snapshotBacklog = (): Buffer | undefined => (existsSync(file) ? readFileSync(file) : undefined);

  /**
   * Вернуть каждый затронутый репозиторий к записанному в нём коммиту,
   * восстановив снятую откатом очередь. Откат адресован репозиторию: каждый
   * возвращается своим вызовом к своему коммиту, и откат одного не достаёт до
   * соседних (design.md, решение 10).
   */
  const rollback = (commits: ReadonlyMap<string, string>, backlog: Buffer | undefined): void => {
    for (const [repo, sha] of commits) resetToCommit(repoDirOf(cwd, repo), sha);
    if (backlog !== undefined) writeFileSync(file, backlog);
  };

  for (const lane of lanes) {
    if (stoppedAt !== undefined) {
      const basisLabel = stoppedAt.basis === 'conflict' ? 'конфликт наложения' : 'неподтверждённый откат';
      // Приставка недостигнутой дорожки складывается с приставкой причины
      // остановки, а чужой вывод берёт остаток предела: приставки здесь и
      // называют основание, ради которого причину читают, — ужимается вывод.
      const reason = reasonWithOutput(
        `сведение остановилось на дорожке «${stoppedAt.lane}» (${basisLabel}): ${stoppedAt.prefix}`,
        stoppedAt.output,
      );
      markFailed(lane, reason);
      results.push({ lane, kind: 'not_reached', reason });
      continue;
    }

    const verdict = evaluateLane(status.jobs, lane);

    if (verdict.kind === 'empty') {
      results.push({ lane, kind: 'empty' });
      continue;
    }

    if (verdict.kind === 'unfit') {
      const reason = `работы дорожки не все успешны: ${verdict.jobs
        .map((job) => `${job.id}=${job.status}`)
        .join(', ')}`;
      markFailed(lane, reason);
      results.push({ lane, kind: 'unfit', reason });
      continue;
    }

    // verdict.kind === 'ready'

    // Пункт читается до наложения: слаг и заголовок нужны сообщению коммита,
    // и дорожка, которой пункт не достался, пропускается, не тронув дерево, —
    // иначе её дифф остался бы наложенным и незакоммиченным. По той же
    // причине здесь, а не после проверки, отказывает файл пункта без слага.
    if (!hasLaneItem(runDir, lane)) {
      results.push({ lane, kind: 'no_item' });
      continue;
    }
    const item = readLaneItem(runDir, lane);

    const range = laneAnchorRange(paths, lane);
    const affected = range === undefined ? [] : affectedRepos(kind, nestedRepos, range);

    // Коммит каждого затронутого репозитория запоминается до наложения —
    // откат красной проверки обязан вернуть каждый к нему своим вызовом
    // (design.md, решение 6). Наложение само откатывается своим якорем
    // (`applyRun`/составной `TreeAnchorer`) на конфликте — этот снимок нужен
    // только для отката ПОСЛЕ успешного наложения, когда наложение уже не
    // тронуть иначе, чем коммитом.
    const commitsBefore = new Map(affected.map((repo) => [repo, currentCommit(repoDirOf(cwd, repo))] as const));
    const backlogBefore = snapshotBacklog();

    let applied: ReturnType<typeof applyRun>;
    try {
      applied = applyRun({ paths, cwd, lane, nestedRepos });
    } catch (error) {
      if (!isStepcastError(error)) throw error;
      const workspace = workspaceOf(status, lane);
      const prefix = `наложение дорожки не сошлось с текущим деревом (рабочее дерево: ${workspace ?? 'неизвестно'}): `;
      const reason = reasonWithOutput(prefix, error.message);
      markFailed(lane, reason);
      results.push({ lane, kind: 'conflict', reason });
      stoppedAt = { lane, basis: 'conflict', prefix, output: error.message };
      continue;
    }

    if (applied.kind !== 'applied') {
      const reason = 'дорожка не изменила дерево';
      markFailed(lane, reason);
      results.push({ lane, kind: 'no_contribution', reason });
      continue;
    }

    // Проверки идут в детерминированном порядке (корень, затем части в
    // каноническом порядке состава — тот же порядок, что вернул
    // `affectedRepos`) и прекращаются на первой красной.
    let red: { readonly prefix: string; readonly output: string } | undefined;
    for (const repo of affected) {
      const command = checkCommandFor(repo, check, repoChecks);
      // Проверено до первого наложения (`assertRepoChecksDeclared`) — сюда
      // недостающая команда дойти не может.
      if (command === undefined) continue;

      const checked = await runCheck({ command, cwd: repoDirOf(cwd, repo) });
      const green = checked.outcome === 'exited' && checked.exitCode === 0;
      if (green) continue;

      const workspace = workspaceOf(status, lane);
      const output = checked.stderr.trim() !== '' ? checked.stderr : checked.stdout;
      // Однорепозиторный путь (без объявленного состава) отвечает прежним
      // текстом — репозиторий здесь всегда один, и называть его незачем.
      const prefix =
        nestedRepos.length === 0
          ? `проверка после наложения красная (рабочее дерево: ${workspace ?? 'неизвестно'}): `
          : `проверка после наложения красная (репозиторий: ${repo}, рабочее дерево: ${workspace ?? 'неизвестно'}): `;
      red = { prefix, output };
      break;
    }

    if (red !== undefined) {
      rollback(commitsBefore, backlogBefore);

      // Откат адресован затронутым репозиториям (`commitsBefore`) — то, чего
      // он не покрывает (репозиторий, которого дорожка не затрагивала; файл,
      // созданный заново самой командой проверки после `reset`), проверка
      // чистоты ловит здесь и превращает в остановку, а не в отказ команды:
      // оставшиеся дорожки перечня обязаны получить исход, как при любой
      // другой остановке.
      let unconfirmed: { readonly prefix: string; readonly output: string } | undefined;
      try {
        assertRunTreeClean();
      } catch (error) {
        if (!isStepcastError(error)) throw error;
        unconfirmed = { prefix: `откат дорожки «${lane}» не подтверждён: `, output: error.message };
      }

      // Неподтверждённый откат называется в причине самой откачённой дорожки,
      // а не только в причинах недостигнутых: перечень мог кончиться на ней —
      // тогда остановка не досталась бы ни одной записи, и грязное дерево
      // дожило бы до головного предусловия следующего захода без объяснения,
      // кто его таким оставил.
      const reason =
        unconfirmed === undefined
          ? reasonWithOutput(red.prefix, red.output)
          : reasonWithOutput(
              `${red.prefix}${tailLine(red.output, RED_OUTPUT_ON_UNCONFIRMED)}; ${unconfirmed.prefix}`,
              unconfirmed.output,
            );
      markFailed(lane, reason);
      results.push({ lane, kind: 'check_failed', reason });

      if (unconfirmed !== undefined) stoppedAt = { lane, basis: 'unconfirmed_rollback', ...unconfirmed };
      continue;
    }

    // Правка очереди идёт до коммитов: улучшение и его бухгалтерия остаются
    // одним набором коммитов с одним сообщением, который `git revert`
    // снимает целиком.
    finishItem(file, item.slug, 'done');
    const message = `${item.slug}: ${item.title ?? 'улучшение из очереди'}`;
    // Порядок — `commitOrder`: вложенные раньше ведущего их корня, репозиторий
    // очереди последним из тех, кого корень гитлинком не ведёт. В перечень
    // исхода попадает только тот, где коммит действительно возник: коммит на
    // пустом индексе (файл очереди этим репозиторием не отслеживается, а
    // дифом дорожка его не задела) пропускается без отказа, и называть его
    // среди сведённых значило бы утверждать коммит, которого нет.
    const committed: string[] = [];
    for (const repo of commitOrder(cwd, affected, queueRepo)) {
      if (commitAll(repoDirOf(cwd, repo), message)) committed.push(repo);
    }

    results.push({ lane, kind: 'merged', slug: item.slug, repos: committed });
  }

  return results;
}
