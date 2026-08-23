import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, parse as parsePath } from 'node:path';

/**
 * Раскладка журнала прогона.
 *
 * Журнал всегда лежит вне проекта, независимо от режима рабочей директории:
 * состояние прогона и рабочее дерево не должны смешиваться.
 */

/** Корень проекта: ближайший каталог с `.git`, иначе сам рабочий каталог. */
export function findProjectRoot(from: string): string {
  let current = realpathSync(from);
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current || parent === parsePath(current).root) return realpathSync(from);
    current = parent;
  }
}

/**
 * Ключ проекта от реального пути. Без него прогоны разных проектов
 * смешиваются в одну кучу и `resume` ищет не там.
 */
export function projectKey(root: string): string {
  return createHash('sha256').update(realpathSync(root)).digest('hex').slice(0, 12);
}

/** Идентификатор прогона: отметка времени плюс короткий случайный хвост. */
export function makeRunId(now: Date, random: string): string {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
  return `${stamp}-${random}`;
}

/** Короткий идентификатор из идентификатора прогона: последний сегмент. */
export function shortRunId(runId: string): string {
  return runId.slice(runId.lastIndexOf('-') + 1);
}

export interface RunPaths {
  readonly runId: string;
  readonly dir: string;
  readonly projectDir: string;
  readonly manifest: string;
  readonly lock: string;
  readonly status: string;
  readonly events: string;
  readonly usage: string;
  readonly artifacts: string;
  readonly jobs: string;
  readonly workspace: string;
  /** Служебные файлы якоря: индекс git, тела манифестов. Вне рабочего дерева. */
  readonly anchors: string;
}

export function runPaths(runsRoot: string, key: string, runId: string): RunPaths {
  const projectDir = join(runsRoot, key);
  const dir = join(projectDir, runId);
  return {
    runId,
    dir,
    projectDir,
    manifest: join(dir, 'run.json'),
    lock: join(dir, 'pipeline.lock.yml'),
    status: join(dir, 'status.json'),
    events: join(dir, 'events.ndjson'),
    usage: join(dir, 'usage.json'),
    artifacts: join(dir, 'artifacts'),
    jobs: join(dir, 'jobs'),
    workspace: join(dir, 'workspace'),
    anchors: join(dir, 'anchors'),
  };
}

export function jobDir(paths: RunPaths, jobId: string): string {
  return join(paths.jobs, jobId);
}

/**
 * Каталог шага: числовой префикс задаёт порядок при просмотре, адресация в
 * командах и состоянии идёт по идентификатору.
 */
export function stepDirName(index: number, stepId: string): string {
  return `${String(index).padStart(2, '0')}-${stepId}`;
}

/**
 * Каталог шага. Уровень итерации появляется только у работ с циклом: добавлять
 * его всем единообразнее, но раскладку читает человек, и её краткость стоит
 * дороже единообразия. Точка порождения пути при этом одна — здесь.
 */
export function stepDir(
  paths: RunPaths,
  jobId: string,
  index: number,
  stepId: string,
  iteration?: number,
): string {
  const base = join(jobDir(paths, jobId), 'steps');
  return iteration === undefined
    ? join(base, stepDirName(index, stepId))
    : join(base, iterationDirName(iteration), stepDirName(index, stepId));
}

/**
 * Каталог вызова судьи внутри каталога шага. Номер сквозной для шага — растёт
 * через попытки и предикаты, а не начинается заново на каждой попытке.
 */
export function judgeCallDir(stepDirPath: string, n: number): string {
  return join(stepDirPath, `judge-${n}`);
}

/** Имя каталога итерации: `iter-1`, `iter-2`, … */
export function iterationDirName(iteration: number): string {
  return `iter-${iteration}`;
}

export function parseIterationDirName(name: string): number | undefined {
  const match = /^iter-(\d+)$/.exec(name);
  return match === null ? undefined : Number(match[1]);
}

/** Разобрать имя каталога шага обратно в номер и идентификатор. */
export function parseStepDirName(name: string): { index: number; stepId: string } | undefined {
  const match = /^(\d+)-(.+)$/.exec(name);
  if (match === null) return undefined;
  return { index: Number(match[1]), stepId: match[2] as string };
}
