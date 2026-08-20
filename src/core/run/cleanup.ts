import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { listRuns, readManifest } from '../journal/reader.js';
import { projectKey, runPaths, type RunPaths } from '../journal/paths.js';

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
  /** Момент, от которого считается возраст: `finished_at`, иначе `started_at`. */
  readonly endedAt: string;
  readonly ageMs: number;
  readonly sizeBytes: number;
}

/** Прогоны проекта как кандидаты на уборку, новейшие первыми — как listRuns. */
export function listCandidates(
  runsRoot: string,
  projectRoot: string,
  now: Date = new Date(),
): RunCandidate[] {
  const key = projectKey(projectRoot);
  return listRuns(runsRoot, projectRoot).map((runId) => {
    const paths = runPaths(runsRoot, key, runId);
    const manifest = readManifest(paths);
    const endedAt = manifest.finished_at ?? manifest.started_at;
    return {
      runId,
      paths,
      endedAt,
      ageMs: now.getTime() - new Date(endedAt).getTime(),
      sizeBytes: dirSize(paths.dir),
    };
  });
}

/** Кандидаты старше указанного порога, в мс. */
export function selectOlderThan(
  candidates: readonly RunCandidate[],
  thresholdMs: number,
): RunCandidate[] {
  return candidates.filter((candidate) => candidate.ageMs >= thresholdMs);
}

/** Удалить всё содержимое прогона, кроме минимума, переживающего уборку. */
export function cleanupRun(paths: RunPaths): void {
  for (const key of Object.keys(paths) as (keyof RunPaths)[]) {
    if (PRESERVED_KEYS.has(key)) continue;
    const value = paths[key];
    if (typeof value !== 'string') continue;
    rmSync(value, { recursive: true, force: true });
  }
}
