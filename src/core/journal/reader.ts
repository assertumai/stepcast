import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

import { StepcastError } from '../errors.js';
import {
  iterationDirName,
  parseIterationDirName,
  parseStepDirName,
  projectKey,
  runPaths,
  stepDir,
  type RunPaths,
} from './paths.js';
import { z } from 'zod';

import {
  EventSchema,
  ExpectReportSchema,
  RunManifestSchema,
  RunStatusSchema,
  UsageReportSchema,
  type Event,
  type ExpectReport,
  type RunManifest,
  type RunStatus,
  type UsageReport,
} from './schema.js';

/** Прогоны проекта, новейшие первыми. */
export function listRuns(runsRoot: string, projectRoot: string): string[] {
  const projectDir = join(runsRoot, projectKey(projectRoot));
  if (!existsSync(projectDir)) return [];
  return readdirSync(projectDir)
    .filter((name) => name !== 'latest' && statSync(join(projectDir, name)).isDirectory())
    .sort()
    .reverse();
}

export interface ProjectEntry {
  readonly key: string;
  /** Путь корня проекта из указателя. Отсутствует, если записи в нём нет. */
  readonly path?: string;
}

/**
 * Проекты, найденные в корне прогонов.
 *
 * Что существует, решают каталоги: ключ проекта необратим (sha256 пути), и по
 * каталогу нельзя восстановить путь. Как это назвать, решает `projects.json`.
 * Указатель может отстать или испортиться — писатель это допускает, — поэтому
 * каталог без записи отдаётся без пути, а не выбрасывается и не подписывается
 * догадкой.
 */
export function listProjects(runsRoot: string): ProjectEntry[] {
  if (!existsSync(runsRoot)) return [];

  let index: Record<string, { path?: string }> = {};
  try {
    index = JSON.parse(readFileSync(join(runsRoot, 'projects.json'), 'utf8')) as typeof index;
  } catch {
    // Указателя нет или он повреждён: имена неизвестны, но каталоги на месте.
    index = {};
  }

  return readdirSync(runsRoot)
    .filter((name) => {
      try {
        return statSync(join(runsRoot, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .map((key) => {
      const path = index[key]?.path;
      return typeof path === 'string' ? { key, path } : { key };
    });
}

/** Прогоны проекта по его ключу, новейшие первыми. */
export function listRunsByKey(runsRoot: string, key: string): string[] {
  const projectDir = join(runsRoot, key);
  if (!existsSync(projectDir)) return [];
  return readdirSync(projectDir)
    .filter((name) => {
      if (name === 'latest') return false;
      try {
        return statSync(join(projectDir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .reverse();
}

/**
 * Найти прогон по идентификатору или его короткому хвосту. Пользователь видит
 * короткий идентификатор в выводе и им же адресует прогон.
 */
export function resolveRun(runsRoot: string, projectRoot: string, runId?: string): RunPaths {
  const key = projectKey(projectRoot);
  const runs = listRuns(runsRoot, projectRoot);

  // `latest` — имя ярлыка в каталоге проекта, и пользователь набирает его
  // раньше, чем идентификатор прогона.
  if (runId === undefined || runId === 'latest') {
    const latest = runs[0];
    if (latest === undefined) {
      throw new StepcastError('Прогонов ещё не было', {
        hint: 'Запустите пайплайн командой stepcast run',
      });
    }
    return runPaths(runsRoot, key, latest);
  }

  const exact = runs.find((name) => name === runId || name.endsWith(`-${runId}`));
  if (exact === undefined) {
    throw new StepcastError(`Прогон ${runId} не найден`, {
      hint:
        runs.length === 0
          ? 'Прогонов ещё не было'
          : `Последние: ${runs.slice(0, 5).join(', ')}`,
    });
  }
  return runPaths(runsRoot, key, exact);
}

export function readStatus(paths: RunPaths): RunStatus {
  const parsed = RunStatusSchema.safeParse(readJson(paths.status));
  if (!parsed.success) {
    throw new StepcastError('Состояние прогона повреждено', { file: paths.status });
  }
  return parsed.data;
}

/** Манифест прогона: способ фиксации якоря, входы, происхождение. */
export function readManifest(paths: RunPaths): RunManifest {
  const parsed = RunManifestSchema.safeParse(readJson(paths.manifest));
  if (!parsed.success) {
    throw new StepcastError('Манифест прогона повреждён', { file: paths.manifest });
  }
  return parsed.data;
}

export function readUsage(paths: RunPaths): UsageReport {
  const parsed = UsageReportSchema.safeParse(readJson(paths.usage));
  if (!parsed.success) {
    throw new StepcastError('Сводка расхода повреждена', { file: paths.usage });
  }
  return parsed.data;
}

export function readEvents(paths: RunPaths): Event[] {
  if (!existsSync(paths.events)) return [];
  const events: Event[] = [];
  for (const line of readFileSync(paths.events, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const parsed = EventSchema.safeParse(JSON.parse(line));
    if (parsed.success) events.push(parsed.data);
  }
  return events;
}

/** Найти каталог шага по идентификаторам, без знания его номера. */
/**
 * Результаты предикатов шага по попыткам. Пустой список означает, что отчёта
 * нет, — например, шаг не дошёл до проверок.
 */
export function readExpectReports(
  paths: RunPaths,
  jobId: string,
  stepId: string,
): ExpectReport[] {
  const dir = findStepDir(paths, jobId, stepId);
  if (dir === undefined) return [];
  const file = join(dir, 'expect.json');
  if (!existsSync(file)) return [];

  const raw = readJson(file);
  const many = z.array(ExpectReportSchema).safeParse(raw);
  if (many.success) return many.data;
  const one = ExpectReportSchema.safeParse(raw);
  return one.success ? [one.data] : [];
}

/**
 * Каталог шага. Итерацию можно не указывать — тогда берётся последняя
 * выполненная: чаще всего спрашивают именно про неё.
 */
export function findStepDir(
  paths: RunPaths,
  jobId: string,
  stepId: string,
  iteration?: number,
): string | undefined {
  const stepsDir = join(paths.jobs, jobId, 'steps');
  if (!existsSync(stepsDir)) return undefined;

  const iterations = readdirSync(stepsDir)
    .map(parseIterationDirName)
    .filter((value): value is number => value !== undefined)
    .sort((a, b) => a - b);

  if (iterations.length > 0) {
    const target = iteration ?? iterations.at(-1);
    if (target === undefined || !iterations.includes(target)) return undefined;
    return within(paths, jobId, stepId, join(stepsDir, iterationDirName(target)), target);
  }

  return within(paths, jobId, stepId, stepsDir, undefined);
}

function within(
  paths: RunPaths,
  jobId: string,
  stepId: string,
  dir: string,
  iteration: number | undefined,
): string | undefined {
  if (!existsSync(dir)) return undefined;
  for (const name of readdirSync(dir)) {
    const parsed = parseStepDirName(name);
    if (parsed?.stepId === stepId) {
      return stepDir(paths, jobId, parsed.index, parsed.stepId, iteration);
    }
  }
  return undefined;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new StepcastError(`Не удалось прочитать ${path}: ${(error as Error).message}`, {
      file: path,
      cause: error,
    });
  }
}

export interface FollowOptions {
  readonly intervalMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Читать файл и продолжать отдавать дописанное.
 *
 * Опрос по таймеру, а не слежение средствами платформы: девяностоминутный
 * прогон должен показывать вывод одинаково на любой файловой системе, включая
 * сетевые, где уведомления об изменениях приходят не всегда.
 */
export async function* follow(
  path: string,
  options: FollowOptions = {},
): AsyncGenerator<string> {
  const interval = options.intervalMs ?? 200;
  let offset = 0;
  let carry = '';

  for (;;) {
    if (options.signal?.aborted === true) return;

    if (existsSync(path)) {
      const handle = await open(path, 'r');
      try {
        const { size } = await handle.stat();
        if (size > offset) {
          const length = size - offset;
          const buffer = Buffer.alloc(length);
          await handle.read(buffer, 0, length, offset);
          offset = size;
          carry += buffer.toString('utf8');

          const lines = carry.split('\n');
          carry = lines.pop() ?? '';
          for (const line of lines) yield line;
        } else if (size < offset) {
          // Файл усечён или заменён — начинаем сначала, чтобы не выдавать мусор.
          offset = 0;
          carry = '';
        }
      } finally {
        await handle.close();
      }
    }

    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
