import { existsSync } from 'node:fs';

import { listProjects, listRunsByKey, readManifest, readStatus } from '../core/journal/reader.js';
import { runPaths } from '../core/journal/paths.js';
import type { StatusValue } from '../core/journal/schema.js';

/**
 * Обзор всего, что происходит: проекты корня прогонов и их прогоны.
 *
 * Собирается целиком на каждый запрос, без кеша: файлы небольшие, а
 * «пересчитать заново» вместо «кешировать и инвалидировать по частям» — уже
 * стиль движка.
 */

export interface RunOverview {
  readonly runId: string;
  readonly shortId: string;
  readonly pipeline: string;
  /** Отсутствует, если ни манифест, ни состояние прочитать не удалось. */
  readonly status?: StatusValue;
  readonly running: boolean;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  /** Прогон после уборки: подробностей на диске уже нет. */
  readonly swept: boolean;
  /** Манифест или состояние не читаются — прогон показан, но неполно. */
  readonly unreadable: boolean;
}

export interface ProjectOverview {
  readonly key: string;
  /** Путь корня проекта. Отсутствует, если его нет в указателе. */
  readonly path?: string;
  readonly runs: readonly RunOverview[];
}

export interface Overview {
  readonly projects: readonly ProjectOverview[];
  readonly generatedAt: string;
}

function readRun(runsRoot: string, key: string, runId: string): RunOverview {
  const paths = runPaths(runsRoot, key, runId);
  const shortId = runId.slice(runId.lastIndexOf('-') + 1);

  let pipeline = '';
  let startedAt: string | undefined;
  let finishedAt: string | undefined;
  let status: StatusValue | undefined;
  let unreadable = false;

  try {
    const manifest = readManifest(paths);
    pipeline = manifest.pipeline;
    startedAt = manifest.started_at;
    finishedAt = manifest.finished_at;
    status = manifest.status;
  } catch {
    unreadable = true;
  }

  // Состояние точнее манифеста для идущего прогона: манифест дописывается
  // статусом только в конце, а состояние переписывается по ходу.
  try {
    const state = readStatus(paths);
    status = state.status;
    if (pipeline === '') pipeline = state.pipeline;
  } catch {
    if (status === undefined) unreadable = true;
  }

  return {
    runId,
    shortId,
    pipeline,
    ...(status === undefined ? {} : { status }),
    running: status === 'running',
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
    // Каталог работ исчезает только после уборки: движок создаёт его всегда.
    swept: !existsSync(paths.jobs),
    unreadable,
  };
}

export function buildOverview(runsRoot: string, now: Date = new Date()): Overview {
  const projects = listProjects(runsRoot).map((project) => ({
    key: project.key,
    ...(project.path === undefined ? {} : { path: project.path }),
    runs: listRunsByKey(runsRoot, project.key).map((runId) =>
      readRun(runsRoot, project.key, runId),
    ),
  }));

  return {
    // Проект без единого прогона показывать незачем: он попал бы в обзор
    // только из-за пустого каталога.
    projects: projects.filter((project) => project.runs.length > 0),
    generatedAt: now.toISOString(),
  };
}
