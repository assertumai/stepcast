import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

import { ScarpError } from '../errors.js';
import { parseStepDirName, projectKey, runPaths, stepDir, type RunPaths } from './paths.js';
import {
  EventSchema,
  RunStatusSchema,
  UsageReportSchema,
  type Event,
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
      throw new ScarpError('Прогонов ещё не было', {
        hint: 'Запустите пайплайн командой scarp run',
      });
    }
    return runPaths(runsRoot, key, latest);
  }

  const exact = runs.find((name) => name === runId || name.endsWith(`-${runId}`));
  if (exact === undefined) {
    throw new ScarpError(`Прогон ${runId} не найден`, {
      hint: runs.length === 0 ? 'Прогонов ещё не было' : `Последний: ${runs[0]}`,
    });
  }
  return runPaths(runsRoot, key, exact);
}

export function readStatus(paths: RunPaths): RunStatus {
  const parsed = RunStatusSchema.safeParse(readJson(paths.status));
  if (!parsed.success) {
    throw new ScarpError('Состояние прогона повреждено', { file: paths.status });
  }
  return parsed.data;
}

export function readUsage(paths: RunPaths): UsageReport {
  const parsed = UsageReportSchema.safeParse(readJson(paths.usage));
  if (!parsed.success) {
    throw new ScarpError('Сводка расхода повреждена', { file: paths.usage });
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
export function findStepDir(
  paths: RunPaths,
  jobId: string,
  stepId: string,
): string | undefined {
  const stepsDir = join(paths.jobs, jobId, 'steps');
  if (!existsSync(stepsDir)) return undefined;
  for (const name of readdirSync(stepsDir)) {
    const parsed = parseStepDirName(name);
    if (parsed?.stepId === stepId) return stepDir(paths, jobId, parsed.index, parsed.stepId);
  }
  return undefined;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ScarpError(`Не удалось прочитать ${path}: ${(error as Error).message}`, {
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
