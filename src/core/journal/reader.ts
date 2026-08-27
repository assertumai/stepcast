import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { uptime } from 'node:os';
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

export type UsageSummaryUnavailable = 'missing' | 'unreadable';

export interface UsageSummaryResult {
  readonly summary?: UsageReport;
  /** Отсутствует — файла ещё нет (прогон идёт); непрочитана — не прошла схему. */
  readonly unavailable?: UsageSummaryUnavailable;
}

/**
 * Сводка расхода, которая не бросает. Отчёт о расходе (команда и витрина)
 * обязан строиться и на идущем прогоне без `usage.json`, и на прогоне со
 * сводкой прежней формы — `readUsage` для этого слишком строг.
 */
export function readUsageSoft(paths: RunPaths): UsageSummaryResult {
  if (!existsSync(paths.usage)) return { unavailable: 'missing' };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(paths.usage, 'utf8'));
  } catch {
    return { unavailable: 'unreadable' };
  }

  const parsed = UsageReportSchema.safeParse(raw);
  return parsed.success ? { summary: parsed.data } : { unavailable: 'unreadable' };
}

/**
 * Момент последней загрузки машины. `os.uptime()` округлён до секунд, поэтому
 * граница берётся с запасом в минуту: ошибиться в сторону «прогон жив»
 * безопаснее (планировщик пропустит момент), чем в сторону «мёртв» (два
 * прогона одного пайплайна разом).
 */
function bootTimeMs(now: number): number {
  return now - uptime() * 1000 - 60_000;
}

/**
 * Прогон жив, если его состояние `running`, процесс с идентификатором из
 * манифеста существует и сам прогон начат после последней загрузки машины.
 * Манифест без `pid` (прежняя форма) считается неживым: сигнал 0 ничего не
 * убивает, только проверяет существование процесса — `ESRCH` означает «нет
 * такого процесса», а `EPERM` означает, что процесс есть, но принадлежит
 * другому пользователю, то есть жив.
 *
 * Сверка с загрузкой нужна против переиспользования идентификатора: прогон,
 * убитый вместе с машиной, навсегда остаётся в состоянии `running`, а его pid
 * после перезагрузки достаётся постороннему процессу — и планировщик молча
 * пропускал бы моменты, ссылаясь на прогон, которого нет. Внутри одной
 * загрузки переиспользование остаётся возможным, но требует, чтобы счётчик
 * pid успел обойти круг, и приводит лишь к пропуску моментов, а не к порче
 * журнала.
 */
export function isRunAlive(paths: RunPaths, now: number = Date.now()): boolean {
  let status: RunStatus;
  try {
    status = readStatus(paths);
  } catch {
    return false;
  }
  if (status.status !== 'running') return false;

  let manifest: RunManifest;
  try {
    manifest = readManifest(paths);
  } catch {
    return false;
  }
  if (manifest.pid === undefined) return false;

  const startedAt = Date.parse(manifest.started_at);
  if (!Number.isNaN(startedAt) && startedAt < bootTimeMs(now)) return false;

  try {
    process.kill(manifest.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Живой прогон пайплайна проекта, если он есть. `listRuns` отдаёт прогоны
 * новейшими первыми, поэтому первый живой найденный — он же единственный,
 * которого стоит искать: планировщик проверяет единственность в пределах
 * одного пайплайна, а не всего проекта.
 */
export function findAliveRun(
  runsRoot: string,
  projectRoot: string,
  pipelineFile: string,
  now: number = Date.now(),
): RunPaths | undefined {
  const key = projectKey(projectRoot);
  for (const runId of listRuns(runsRoot, projectRoot)) {
    const candidate = runPaths(runsRoot, key, runId);
    let manifest: RunManifest;
    try {
      manifest = readManifest(candidate);
    } catch {
      continue;
    }
    if (manifest.pipeline_file !== pipelineFile) continue;
    if (isRunAlive(candidate, now)) return candidate;
  }
  return undefined;
}

export interface ResetHint {
  readonly resetsAt: number;
}

/**
 * Момент сброса окна лимита из последнего завершённого прогона пайплайна.
 *
 * Смотрит только на `backend.refused` и `budget.waiting` — оба несут
 * `resets_at`, а `budget.exceeded` (потолки `tokens`/`cost`/`wallclock`) его не
 * несёт и не должен откладывать следующее срабатывание: эти потолки не
 * сбрасываются по времени и относятся к прогону, а не к внешнему окну.
 * Подсказка даётся только тем прогоном, который упёрся в окно и на этом
 * остановился: если после отказа прогон продолжил работу — дождался сброса
 * (`budget.resumed`), успешно закончил шаг или завершился успехом — окно его
 * не остановило, и откладывать следующее срабатывание нечем. Поэтому
 * `resets_at` последнего отказа сбрасывается любым признаком продолжения.
 */
export function readResetHint(
  runsRoot: string,
  projectRoot: string,
  pipelineFile: string,
): ResetHint | undefined {
  const key = projectKey(projectRoot);
  for (const runId of listRuns(runsRoot, projectRoot)) {
    const candidate = runPaths(runsRoot, key, runId);
    let manifest: RunManifest;
    try {
      manifest = readManifest(candidate);
    } catch {
      continue;
    }
    if (manifest.pipeline_file !== pipelineFile) continue;
    if (manifest.finished_at === undefined) continue;

    let resetsAt: number | undefined;
    for (const event of readEvents(candidate)) {
      if (event.kind === 'backend.refused' && event.resets_at !== undefined) {
        resetsAt = event.resets_at;
      } else if (event.kind === 'budget.waiting') {
        resetsAt = event.resets_at;
      } else if (
        event.kind === 'budget.resumed' ||
        (event.kind === 'step.finished' && event.status === 'success') ||
        (event.kind === 'run.finished' && event.status === 'success')
      ) {
        resetsAt = undefined;
      }
    }
    return resetsAt === undefined ? undefined : { resetsAt };
  }
  return undefined;
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
