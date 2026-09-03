import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { isRunAlive, listProjects, listRuns, listRunsByKey, readManifest, readStatus } from '../journal/reader.js';
import { projectKey, runPaths, type RunPaths } from '../journal/paths.js';
import { isFailure, type StatusValue } from '../journal/schema.js';
import { removeWorktree } from './worktrees.js';

/**
 * Уборка прогонов.
 *
 * `run.json`, `status.json` и `usage.json` — минимум, достаточный для того,
 * чтобы прогон остался виден в истории и в `stepcast usage`; всё остальное
 * внутри директории прогона уборка удаляет. Список удаляемого выводится из
 * полей `RunPaths`, а не задаётся отдельным списком: новое поле раскладки
 * попадёт под уборку само, без отдельной правки здесь.
 */

const PRESERVED_KEYS: ReadonlySet<keyof RunPaths> = new Set([
  'runId',
  'dir',
  'projectDir',
  'manifest',
  'status',
  'usage',
]);

/** Размер директории рекурсивным обходом, в байтах. Отсутствующий путь — 0. */
export function dirSize(path: string): number {
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return 0;
  }

  let total = 0;
  for (const entry of entries) {
    const full = join(path, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      total += dirSize(full);
      continue;
    }
    try {
      total += statSync(full).size;
    } catch {
      // Файл исчез между readdir и stat — гонка, не повод падать.
    }
  }
  return total;
}

export interface RunCandidate {
  readonly runId: string;
  readonly paths: RunPaths;
  /**
   * Момент, от которого считается возраст: `finished_at`, иначе `started_at`,
   * а у прогона с нечитаемым манифестом — время его каталога.
   */
  readonly endedAt: string;
  readonly ageMs: number;
  readonly sizeBytes: number;
  /** Манифест не читается: возраст взят по времени каталога, а не по журналу. */
  readonly unreadable: boolean;
}

/** Время каталога прогона: последняя опора для возраста, когда журнала нет. */
function dirTime(path: string, now: Date): string {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return now.toISOString();
  }
}

/**
 * Прогон как кандидат на уборку: момент возраста, сам возраст, размер на
 * диске. Общая точка для `listCandidates` и отбора по признаку — иначе два
 * места считали бы возраст и размер каждое по-своему и разошлись бы при
 * первой же правке.
 *
 * Нечитаемый манифест кандидата не отменяет: прогон с испорченным журналом —
 * ровно тот мусор, ради которого уборка и заводится, и выпасть из отбора он
 * не должен. Возраст такого прогона считается по времени его каталога.
 */
function candidateOf(paths: RunPaths, runId: string, now: Date): RunCandidate {
  let endedAt: string | undefined;
  try {
    const manifest = readManifest(paths);
    endedAt = manifest.finished_at ?? manifest.started_at;
  } catch {
    endedAt = undefined;
  }

  const moment = endedAt ?? dirTime(paths.dir, now);
  return {
    runId,
    paths,
    endedAt: moment,
    // Отрицательного возраста не бывает: время файловой системы точнее
    // миллисекунды и может округлиться вперёд относительно `now`, и тогда
    // только что созданный прогон не подпадал бы под нулевой порог.
    ageMs: Math.max(0, now.getTime() - new Date(moment).getTime()),
    sizeBytes: dirSize(paths.dir),
    unreadable: endedAt === undefined,
  };
}

/**
 * Статус прогона: состояние точнее манифеста у идущего, но у прогона с
 * испорченным `status.json` манифест — единственное, что о нём известно.
 * Молчаливое «статуса нет» увело бы такой прогон из-под признаков.
 */
function statusOf(paths: RunPaths): StatusValue | undefined {
  try {
    return readStatus(paths).status;
  } catch {
    // Состояние не читается — остаётся манифест.
  }
  try {
    return readManifest(paths).status;
  } catch {
    return undefined;
  }
}

/** Прогоны проекта как кандидаты на уборку, новейшие первыми — как listRuns. */
export function listCandidates(
  runsRoot: string,
  projectRoot: string,
  now: Date = new Date(),
): RunCandidate[] {
  const key = projectKey(projectRoot);
  return listRuns(runsRoot, projectRoot).map((runId) =>
    candidateOf(runPaths(runsRoot, key, runId), runId, now),
  );
}

/** Кандидаты старше указанного порога, в мс. */
export function selectOlderThan(
  candidates: readonly RunCandidate[],
  thresholdMs: number,
): RunCandidate[] {
  return candidates.filter((candidate) => candidate.ageMs >= thresholdMs);
}

/** Кандидат отбора по признаку: адресуется парой ключ проекта / прогон. */
export interface AddressedCandidate extends RunCandidate {
  readonly key: string;
  readonly address: string;
}

export interface SelectTraits {
  readonly abandoned?: boolean;
  readonly failed?: boolean;
  readonly olderThanMs?: number;
}

export interface SelectOptions {
  /** Ключ проекта: без него отбор идёт по всем проектам корня. */
  readonly project?: string;
  readonly now?: Date;
}

/**
 * Отбор прогонов корня к полному снятию по признакам — оборванные, отказавшие,
 * старше срока, — объединённым по «или». Прогон под несколькими признаками
 * назван один раз. Ничего на диске отбор не меняет.
 */
export function selectCandidates(
  runsRoot: string,
  traits: SelectTraits,
  options: SelectOptions = {},
): AddressedCandidate[] {
  const now = options.now ?? new Date();
  const keys =
    options.project !== undefined
      ? [options.project]
      : listProjects(runsRoot).map((project) => project.key);

  const selected: AddressedCandidate[] = [];
  for (const key of keys) {
    for (const runId of listRunsByKey(runsRoot, key)) {
      const paths = runPaths(runsRoot, key, runId);
      const candidate = candidateOf(paths, runId, now);
      const status = statusOf(paths);

      const matches =
        (traits.abandoned === true &&
          status === 'running' &&
          !isRunAlive(paths, now.getTime())) ||
        (traits.failed === true && status !== undefined && isFailure(status)) ||
        (traits.olderThanMs !== undefined && candidate.ageMs >= traits.olderThanMs);

      if (!matches) continue;
      selected.push({ ...candidate, key, address: `${key}/${runId}` });
    }
  }
  return selected;
}

export interface RunAddress {
  readonly key: string;
  readonly runId: string;
  /**
   * Размер, снятый отбором. Вызывающий, у которого он уже есть, избавляет
   * снятие от повторного обхода каталога; без него размер меряется здесь —
   * после `rmSync` мерить уже нечего, а освобождённое место назвать надо.
   */
  readonly sizeBytes?: number;
}

export type RemovalOutcome =
  | {
      readonly address: string;
      readonly outcome: 'removed';
      readonly sizeBytes: number;
      /** Записи рабочих деревьев, которые снять не удалось. Отсутствует, если их нет. */
      readonly unresolvedWorktrees?: readonly string[];
      /** Каталоги, сохранённые ради продолжения в другом прогоне. Отсутствует, если их нет. */
      readonly preservedWorkspaces?: readonly { readonly path: string; readonly adoptedBy: string }[];
    }
  | { readonly address: string; readonly outcome: 'skipped_alive' }
  | { readonly address: string; readonly outcome: 'skipped_missing' }
  | { readonly address: string; readonly outcome: 'failed'; readonly reason: string };

export interface RemovalSummary {
  readonly outcomes: readonly RemovalOutcome[];
  readonly freedBytes: number;
}

/**
 * Снять список прогонов, по одному исходу на адрес. Живость перепроверяется
 * заново перед каждым снятием: список адресов приходит с отбора, сделанного
 * раньше показа подтверждения, а прогон за это время мог перезапуститься.
 * Отказ на одном адресе не останавливает снятие остальных.
 */
export function removeRuns(runsRoot: string, addresses: readonly RunAddress[]): RemovalSummary {
  const outcomes: RemovalOutcome[] = [];
  let freedBytes = 0;

  for (const { key, runId, sizeBytes: known } of addresses) {
    const address = `${key}/${runId}`;
    const paths = runPaths(runsRoot, key, runId);

    if (!existsSync(paths.dir)) {
      outcomes.push({ address, outcome: 'skipped_missing' });
      continue;
    }

    if (isRunAlive(paths)) {
      outcomes.push({ address, outcome: 'skipped_alive' });
      continue;
    }

    try {
      const sizeBytes = known ?? dirSize(paths.dir);
      const result = removeRun(runsRoot, key, runId);
      freedBytes += sizeBytes;
      outcomes.push({
        address,
        outcome: 'removed',
        sizeBytes,
        ...(result.unresolvedWorktrees.length === 0 ? {} : { unresolvedWorktrees: result.unresolvedWorktrees }),
        ...(result.preservedWorkspaces.length === 0 ? {} : { preservedWorkspaces: result.preservedWorkspaces }),
      });
    } catch (error) {
      outcomes.push({ address, outcome: 'failed', reason: (error as Error).message });
    }
  }

  return { outcomes, freedBytes };
}

export interface RunCleanupResult {
  /**
   * Записи рабочих деревьев, которые снять не удалось, — путь и причина.
   * Каталоги при этом всё равно удаляются: молчание здесь было бы худшим
   * вариантом, именно накопление незамеченных записей и есть цена, ради
   * которой учёт заведён (design.md, решение 7).
   */
  readonly unresolvedWorktrees: readonly string[];
  /**
   * Каталоги, оставленные на месте ради продолжения оборванной сессии в
   * более позднем прогоне — путь и прогон, который его перенял. Пусто, если
   * ни один каталог этого прогона никем не перенят.
   */
  readonly preservedWorkspaces: readonly { readonly path: string; readonly adoptedBy: string }[];
}

/**
 * Каталоги, которые эта уборка обязана оставить на месте, — путь → прогон,
 * ради которого он сохранён.
 *
 * Владелец перенятого каталога — **последний** перенявший его прогон из тех,
 * что ещё есть на диске: он в этом каталоге и работает, он же его и снимет.
 * Каждый прогон цепочки до него каталог бережёт — и тот, кто каталог завёл, и
 * промежуточные перенявшие.
 *
 * «Последний» определяется по самим записям, а не по времени: продолжения
 * выстраиваются в цепочку (B перенял каталог у A, C — у B, путь у всех троих
 * один), и последний в ней — тот, кого никто не назвал своим источником
 * перенимания. Опираться на порядок идентификаторов нельзя: перенявший прогон
 * может оказаться и «младше» по имени, а цена ошибки — снесённое из-под него
 * дерево.
 *
 * Отбирать по `adopted_from === runId` тоже нельзя: в цепочке запись C
 * называет источником B, а лежит каталог в директории A, и такой отбор
 * оставил бы A без защиты, стоило убрать B.
 *
 * Несуществующий каталог не сохраняется: перенявший прогон мог уже убраться и
 * снять его — тогда убираемому прогону беречь нечего, и пустой путь в отчёте
 * только сбивал бы с толку.
 */
function adoptedDirectories(
  runsRoot: string,
  key: string,
  runId: string,
): ReadonlyMap<string, string> {
  const adoptions: { readonly runId: string; readonly path: string; readonly from: string }[] = [];
  for (const otherId of listRunsByKey(runsRoot, key)) {
    let jobs: ReturnType<typeof readStatus>['jobs'];
    try {
      jobs = readStatus(runPaths(runsRoot, key, otherId)).jobs;
    } catch {
      continue;
    }
    for (const job of jobs) {
      const workspace = job.workspace;
      if (workspace?.adopted_from === undefined) continue;
      adoptions.push({ runId: otherId, path: workspace.path, from: workspace.adopted_from });
    }
  }

  // Прогоны, у которых перенимание уже перехвачено следующим звеном цепочки:
  // каталогом они больше не владеют.
  const superseded = new Set(adoptions.map((item) => item.from));

  const preserved = new Map<string, string>();
  for (const item of adoptions) {
    // Свой каталог убираемый прогон и снимает — беречь его не от кого.
    if (item.runId === runId) continue;
    if (superseded.has(item.runId)) continue;
    if (!existsSync(item.path)) continue;
    // Обход идёт от новейшего прогона к старшему (`listRunsByKey`): при двух
    // независимых продолжениях одного и того же оборванного прогона владельцем
    // называется новейший из них, а каталог берегут оба.
    if (!preserved.has(item.path)) preserved.set(item.path, item.runId);
  }
  return preserved;
}

/** Путь совпадает с перенятым каталогом либо лежит внутри него. */
function isPreserved(path: string, preserved: ReadonlyMap<string, string>): boolean {
  for (const preservedPath of preserved.keys()) {
    if (path === preservedPath || path.startsWith(`${preservedPath}/`)) return true;
  }
  return false;
}

function preservedList(
  preserved: ReadonlyMap<string, string>,
): readonly { readonly path: string; readonly adoptedBy: string }[] {
  return [...preserved].map(([path, adoptedBy]) => ({ path, adoptedBy }));
}

/**
 * Содержимое каталога, кроме перенятых путей и того, что лежит на пути к
 * ним, — снимается рекурсивно, потому что перенятый каталог работы обычно
 * лежит не прямым потомком удаляемого (`<прогон>/workspace/<работа>`), а
 * `removeRun` снимает от корня каталога прогона целиком.
 */
function removeDirContentsExcept(dir: string, preserved: ReadonlyMap<string, string>): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (isPreserved(full, preserved)) continue;
    if (entry.isDirectory() && hasPreservedDescendant(full, preserved)) {
      removeDirContentsExcept(full, preserved);
      continue;
    }
    rmSync(full, { recursive: true, force: true });
  }
}

/** Лежит ли внутри каталога хотя бы один перенятый путь. */
function hasPreservedDescendant(dir: string, preserved: ReadonlyMap<string, string>): boolean {
  const prefix = `${dir}/`;
  for (const preservedPath of preserved.keys()) {
    if (preservedPath.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Адреса рабочих деревьев, заведённых этим прогоном, — каждой части каждой
 * работы и корневого, — по одной записи на путь, части раньше корня и в
 * порядке, обратном каноническому составу.
 *
 * Порядок важен: снятие дерева убирает с диска весь его каталог вместе с
 * вложенными деревьями, а `git worktree remove` отказывает («not a working
 * tree»), если каталога по его пути уже нет. Обратный порядок снимает
 * сначала то, что лежит глубже: части — раньше корня, вложенную друг в
 * друга часть (`a/b`) — раньше объемлющей (`a`). Тот же разворот, что и у
 * отката подготовки (`discardWorkspaceDir` в `run/workspace.ts`).
 *
 * Дедупликация нужна цепочкам: продолжающая работа делит каталог (и, значит,
 * записи) с предшественницей, и без неё второй проход по тому же пути видел
 * бы уже снятую запись как отказ.
 */
interface WorktreeAddress {
  readonly repoDir: string;
  readonly path: string;
  /**
   * Директория прогона, которому каталог принадлежит на диске: её сверяет
   * инвариант `removeWorktree`. У перенятого каталога это директория не
   * убираемого прогона, а того, в чьей раскладке каталог лежит.
   */
  readonly runDir: string;
}

/**
 * Директория прогона, внутри которой лежит путь. Нужна перенятому каталогу:
 * он лежит в раскладке исходного прогона, а снимает его тот, кто перенял.
 * Ищется перебором прогонов проекта, а не выводится из `adopted_from`: в
 * цепочке продолжений запись называет источником предыдущего перенявшего, а
 * каталог всё это время лежит у первого. Ничего не нашлось — остаётся
 * директория самого прогона, и инвариант отработает как раньше.
 */
function owningRunDir(
  path: string,
  paths: RunPaths,
  runsRoot: string,
  key: string,
): string {
  for (const runId of listRunsByKey(runsRoot, key)) {
    const dir = runPaths(runsRoot, key, runId).dir;
    if (path === dir || path.startsWith(`${dir}/`)) return dir;
  }
  return paths.dir;
}

function collectRunWorktrees(paths: RunPaths, runsRoot: string, key: string): WorktreeAddress[] {
  let projectRoot: string | undefined;
  try {
    projectRoot = readManifest(paths).project_root;
  } catch {
    // Манифест не читается — корневая запись останется неопознанной; части
    // всё равно опознаются по собственному, явно записанному репозиторию.
  }

  let jobs: ReturnType<typeof readStatus>['jobs'] = [];
  try {
    jobs = readStatus(paths).jobs;
  } catch {
    // Состояние не читается — снимать нечего, но каталогам это не помеха.
  }

  const byPath = new Map<string, WorktreeAddress>();
  for (const job of jobs) {
    const workspace = job.workspace;
    if (workspace === undefined || workspace.mode !== 'worktree') continue;
    // Перенятый каталог лежит в директории прогона-источника: снимает его тот
    // прогон, который его перенял (он теперь владелец), но инвариант пути
    // сверяется с директорией, в которой каталог физически лежит.
    const runDir =
      workspace.adopted_from === undefined
        ? paths.dir
        : owningRunDir(workspace.path, paths, runsRoot, key);
    for (const part of [...(workspace.nested ?? [])].reverse()) {
      const partPath = join(workspace.path, part.dir);
      byPath.set(partPath, { repoDir: part.repo, path: partPath, runDir });
    }
    if (projectRoot !== undefined) {
      byPath.set(workspace.path, { repoDir: projectRoot, path: workspace.path, runDir });
    }
  }
  return [...byPath.values()];
}

/**
 * Снять учётные записи всех изолированных деревьев прогона — перед тем, как
 * его каталоги уйдут под `rmSync`. Каждая запись адресуется в своём
 * репозитории: корневая — в `project_root` манифеста, каждая часть — в
 * репозитории, записанном при её заведении (`workspace.nested[].repo`).
 */
function removeRunWorktrees(
  paths: RunPaths,
  runsRoot: string,
  key: string,
  preserved: ReadonlyMap<string, string> = new Map(),
): readonly string[] {
  const unresolved: string[] = [];
  for (const { repoDir, path, runDir } of collectRunWorktrees(paths, runsRoot, key)) {
    // Каталог перенят более поздним прогоном: снять его учётную запись
    // значило бы снести дерево, в котором тот прогон продолжает диалог.
    if (isPreserved(path, preserved)) continue;
    try {
      const outcome = removeWorktree({ repoDir, path, runDir });
      if (outcome.kind === 'record_kept') unresolved.push(`${path}: ${outcome.reason}`);
    } catch (error) {
      unresolved.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return unresolved;
}

/** Удалить содержимое прогона, кроме минимума и перенятых каталогов. */
function removeRunContents(paths: RunPaths, preserved: ReadonlyMap<string, string>): void {
  for (const key of Object.keys(paths) as (keyof RunPaths)[]) {
    if (PRESERVED_KEYS.has(key)) continue;
    const value = paths[key];
    if (typeof value !== 'string') continue;
    if (key === 'workspace' && preserved.size > 0) {
      removeDirContentsExcept(value, preserved);
      continue;
    }
    rmSync(value, { recursive: true, force: true });
  }
}

/** Удалить всё содержимое прогона, кроме минимума, переживающего уборку. */
export function cleanupRun(paths: RunPaths): RunCleanupResult {
  const runsRoot = dirname(paths.projectDir);
  const key = basename(paths.projectDir);
  const preserved = adoptedDirectories(runsRoot, key, paths.runId);
  const unresolvedWorktrees = removeRunWorktrees(paths, runsRoot, key, preserved);

  removeRunContents(paths, preserved);

  return { unresolvedWorktrees, preservedWorkspaces: preservedList(preserved) };
}

/**
 * Снять прогон целиком — из истории, а не только его содержимое.
 *
 * Отличается от `cleanupRun` тем, что не бережёт ничего: `gc` освобождает
 * место, оставляя прогон видимым, а это удаление отвечает на «этот заход был
 * мусорным, уберите его с глаз». Поэтому и следы прогона в раскладке — ярлык
 * `latest` и запись проекта в указателе — тоже приходится подчищать: битый
 * ярлык и запись о проекте без единого прогона переживут удаление и будут
 * врать об истории.
 */
export function removeRun(runsRoot: string, key: string, runId: string): RunCleanupResult {
  const paths = runPaths(runsRoot, key, runId);
  const preserved = adoptedDirectories(runsRoot, key, runId);
  const unresolvedWorktrees = removeRunWorktrees(paths, runsRoot, key, preserved);

  // Считается только то, что лежит в директории удаляемого прогона: каталог
  // рабочей копии, размещённый объявленным `workspace.path` вне раскладки,
  // удалению прогона и так не подлежит, и вырождать его из-за такого каталога
  // незачем.
  const inRunDir = [...preserved.keys()].some(
    (path) => path === paths.dir || path.startsWith(`${paths.dir}/`),
  );

  if (!inRunDir) {
    rmSync(paths.dir, { recursive: true, force: true });
  } else {
    // Каталог, перенятый более поздним прогоном, остаётся на месте — а с ним
    // и директория прогона, в которой он лежит. Раз директория переживает
    // удаление, прогон обязан пережить его **читаемым**: снятие целиком
    // оставило бы каталог без `run.json`, `status.json` и `usage.json`, и
    // `listRunsByKey` продолжал бы отдавать его историей, которую ни
    // `resolveRun`, ни обзор, ни повторное удаление разобрать уже не могут.
    // Поэтому удаление вырождается в уборку: содержимое снимается, минимум
    // журнала остаётся. Снять прогон целиком можно будет тогда, когда уйдёт
    // перенявший, — каталог перестанет быть чужим, и повторное удаление
    // доведёт дело до конца.
    removeRunContents(paths, preserved);
  }
  repointLatest(paths.projectDir, runsRoot, key);

  if (listRunsByKey(runsRoot, key).length === 0) dropProjectEntry(runsRoot, key);

  return { unresolvedWorktrees, preservedWorkspaces: preservedList(preserved) };
}

/** Ярлык `latest` после удаления: на новейший оставшийся прогон либо никуда. */
function repointLatest(projectDir: string, runsRoot: string, key: string): void {
  const link = join(projectDir, 'latest');
  const [newest] = listRunsByKey(runsRoot, key);

  try {
    rmSync(link, { force: true });
    if (newest !== undefined) symlinkSync(newest, link);
  } catch {
    // Платформа без символических ссылок: прогон адресуется идентификатором,
    // отсутствие ярлыка работе не мешает.
  }
}

/** Запись проекта в указателе: без прогонов она называет пустой каталог. */
function dropProjectEntry(runsRoot: string, key: string): void {
  const indexPath = join(runsRoot, 'projects.json');
  if (!existsSync(indexPath)) return;

  let index: Record<string, unknown>;
  try {
    index = JSON.parse(readFileSync(indexPath, 'utf8')) as Record<string, unknown>;
  } catch {
    // Повреждённый указатель перепишется первым же прогоном; трогать его
    // здесь значит гадать о его содержимом.
    return;
  }

  if (!(key in index)) return;
  delete index[key];
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);

  rmSync(join(runsRoot, key), { recursive: true, force: true });
}
