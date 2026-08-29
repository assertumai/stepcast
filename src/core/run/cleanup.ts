import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

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
function collectRunWorktrees(paths: RunPaths): { readonly repoDir: string; readonly path: string }[] {
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

  const byPath = new Map<string, { readonly repoDir: string; readonly path: string }>();
  for (const job of jobs) {
    const workspace = job.workspace;
    if (workspace === undefined || workspace.mode !== 'worktree') continue;
    for (const part of [...(workspace.nested ?? [])].reverse()) {
      const partPath = join(workspace.path, part.dir);
      byPath.set(partPath, { repoDir: part.repo, path: partPath });
    }
    if (projectRoot !== undefined) {
      byPath.set(workspace.path, { repoDir: projectRoot, path: workspace.path });
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
function removeRunWorktrees(paths: RunPaths): readonly string[] {
  const unresolved: string[] = [];
  for (const { repoDir, path } of collectRunWorktrees(paths)) {
    try {
      const outcome = removeWorktree({ repoDir, path, runDir: paths.dir });
      if (outcome.kind === 'record_kept') unresolved.push(`${path}: ${outcome.reason}`);
    } catch (error) {
      unresolved.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return unresolved;
}

/** Удалить всё содержимое прогона, кроме минимума, переживающего уборку. */
export function cleanupRun(paths: RunPaths): RunCleanupResult {
  const unresolvedWorktrees = removeRunWorktrees(paths);

  for (const key of Object.keys(paths) as (keyof RunPaths)[]) {
    if (PRESERVED_KEYS.has(key)) continue;
    const value = paths[key];
    if (typeof value !== 'string') continue;
    rmSync(value, { recursive: true, force: true });
  }

  return { unresolvedWorktrees };
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
  const unresolvedWorktrees = removeRunWorktrees(paths);
  rmSync(paths.dir, { recursive: true, force: true });
  repointLatest(paths.projectDir, runsRoot, key);

  if (listRunsByKey(runsRoot, key).length === 0) dropProjectEntry(runsRoot, key);

  return { unresolvedWorktrees };
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
