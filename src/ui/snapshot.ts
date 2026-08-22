import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { findStepDir, readStatus } from '../core/journal/reader.js';
import type { RunPaths } from '../core/journal/paths.js';
import { ContextReportSchema, type StatusValue } from '../core/journal/schema.js';
import { readLockJobs, type LockJob, type LockStep } from './lock.js';
import { readJournalJson } from './file.js';

/**
 * Детальный снимок одного прогона: что каждая работа получила на вход и что
 * отдала на выход.
 *
 * Три источника. `status.json` — исполнение (статусы, попытки, причины).
 * `pipeline.lock.yml` — определение (промпт, команда, `needs`, объявленный
 * выход), нужное, чтобы показать работу, которая ещё не исполнялась. Файлы
 * шага — фактические данные.
 */

/** Уровни контекста в том же порядке, в каком их склеивает `assembleContext`. */
export type ContextLevel = 'upstream' | 'pipeline' | 'job' | 'step';

export interface ContextBreakdown {
  readonly levels: Readonly<Record<ContextLevel, number>>;
  readonly total: number;
}

export interface JournalFileRef {
  readonly name: string;
  /** Путь относительно каталога прогона — абсолютные наружу не отдаются. */
  readonly path: string;
  readonly bytes: number;
}

export interface StepSnapshot {
  readonly id: string;
  readonly kind: 'agent' | 'run';
  readonly status?: StatusValue;
  readonly reason?: string;
  readonly attempts: number;
  /** Промпт агентского шага из лока. */
  readonly prompt?: string;
  /** Команда командного шага из лока. */
  readonly command?: string;
  readonly context: readonly string[];
  /** Разрез контекста: есть только у исполнившегося агентского шага. */
  readonly contextBreakdown?: ContextBreakdown;
  readonly files: readonly JournalFileRef[];
}

export interface JobSnapshot {
  readonly id: string;
  readonly description?: string;
  readonly status?: StatusValue;
  readonly reason?: string;
  readonly needs: readonly string[];
  readonly context: readonly string[];
  /** Выходы предшественников, доступные этой работе. */
  readonly inputs: readonly JournalFileRef[];
  /** Собственный опубликованный выход, если работа его объявляет и уже дала. */
  readonly output?: JournalFileRef;
  /** Работа объявляет выход, но ещё не опубликовала его. */
  readonly outputDeclared: boolean;
  readonly steps: readonly StepSnapshot[];
}

export interface RunSnapshot {
  readonly runId: string;
  readonly projectKey: string;
  readonly pipeline: string;
  readonly status?: StatusValue;
  readonly jobs: readonly JobSnapshot[];
  /** Прогон убран: остались только манифест, состояние и расход. */
  readonly swept: boolean;
}

function fileRef(runDir: string, absolute: string): JournalFileRef | undefined {
  let bytes: number;
  try {
    bytes = statSync(absolute).size;
  } catch {
    return undefined;
  }
  return {
    name: relative(runDir, absolute).split(/[\\/]/).pop() ?? '',
    path: relative(runDir, absolute).replace(/\\/g, '/'),
    bytes,
  };
}

/** Все файлы каталога шага: перечисляются как есть, а не по ожидаемым именам. */
function stepFiles(runDir: string, dir: string | undefined): JournalFileRef[] {
  if (dir === undefined || !existsSync(dir)) return [];
  const out: JournalFileRef[] = [];
  for (const name of readdirSync(dir).sort()) {
    const ref = fileRef(runDir, join(dir, name));
    if (ref !== undefined) out.push(ref);
  }
  return out;
}

function contextBreakdown(dir: string | undefined): ContextBreakdown | undefined {
  if (dir === undefined) return undefined;
  const parsed = ContextReportSchema.safeParse(readJournalJson(join(dir, 'context.json')));
  if (!parsed.success) return undefined;

  const levels: Record<ContextLevel, number> = { upstream: 0, pipeline: 0, job: 0, step: 0 };
  for (const entry of parsed.data.entries) levels[entry.origin] += entry.tokens;

  return { levels, total: parsed.data.total_tokens };
}

function buildStep(
  paths: RunPaths,
  jobId: string,
  definition: LockStep | undefined,
  record: ReturnType<typeof readStatus>['jobs'][number]['steps'][number] | undefined,
): StepSnapshot {
  const id = definition?.id ?? record?.id ?? '';
  const dir = findStepDir(paths, jobId, id);
  const kind = definition?.kind ?? record?.kind ?? 'run';
  const breakdown = kind === 'agent' ? contextBreakdown(dir) : undefined;

  return {
    id,
    kind,
    ...(record?.status === undefined ? {} : { status: record.status }),
    ...(record?.reason === undefined ? {} : { reason: record.reason }),
    attempts: record?.attempts.length ?? 0,
    ...(definition?.prompt === undefined ? {} : { prompt: definition.prompt }),
    ...(definition?.command === undefined ? {} : { command: definition.command }),
    context: definition?.context ?? [],
    ...(breakdown === undefined ? {} : { contextBreakdown: breakdown }),
    files: stepFiles(paths.dir, dir),
  };
}

function buildJob(
  paths: RunPaths,
  definition: LockJob | undefined,
  record: ReturnType<typeof readStatus>['jobs'][number] | undefined,
  publishedJobs: ReadonlySet<string>,
): JobSnapshot {
  const id = definition?.id ?? record?.id ?? '';
  const needs = definition?.needs ?? [];

  // Вход работы — выходы её предшественников: тот же источник, из которого
  // движок берёт ${jobs.*.output.*}. `needs: all` означает всех, кто опубликовал.
  const upstream = needs.includes('all')
    ? [...publishedJobs].filter((job) => job !== id)
    : needs.filter((job) => publishedJobs.has(job));

  const inputs = upstream
    .map((job) => fileRef(paths.dir, join(paths.artifacts, `${job}.json`)))
    .filter((ref): ref is JournalFileRef => ref !== undefined);

  const output = publishedJobs.has(id)
    ? fileRef(paths.dir, join(paths.artifacts, `${id}.json`))
    : undefined;

  const stepIds = definition?.steps.map((step) => step.id) ?? record?.steps.map((s) => s.id) ?? [];

  return {
    id,
    ...(definition?.description === undefined ? {} : { description: definition.description }),
    ...(record?.status === undefined ? {} : { status: record.status }),
    ...(record?.reason === undefined ? {} : { reason: record.reason }),
    needs,
    context: definition?.context ?? [],
    inputs,
    ...(output === undefined ? {} : { output }),
    outputDeclared: definition?.publishesOutput ?? false,
    steps: stepIds.map((stepId) =>
      buildStep(
        paths,
        id,
        definition?.steps.find((step) => step.id === stepId),
        record?.steps.find((step) => step.id === stepId),
      ),
    ),
  };
}

/** Опубликованные выходы: файлы, реально лежащие в `artifacts/`. */
function publishedOutputs(paths: RunPaths): Set<string> {
  try {
    return new Set(
      readdirSync(paths.artifacts)
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -'.json'.length)),
    );
  } catch {
    return new Set();
  }
}

export function buildSnapshot(paths: RunPaths, projectKeyValue: string): RunSnapshot {
  const status = (() => {
    try {
      return readStatus(paths);
    } catch {
      return undefined;
    }
  })();

  // Уборка сносит всё, кроме манифеста, состояния и расхода: по отсутствию
  // каталога работ прогон и опознаётся как убранный.
  const swept = !existsSync(paths.jobs);
  const definitions = readLockJobs(paths.lock);
  const published = publishedOutputs(paths);

  // Порядок работ задаёт лок; работы, оставшиеся только в состоянии
  // (например, после уборки лока), дописываются следом.
  const ids = [...definitions.map((job) => job.id)];
  for (const record of status?.jobs ?? []) {
    if (!ids.includes(record.id)) ids.push(record.id);
  }

  return {
    runId: paths.runId,
    projectKey: projectKeyValue,
    pipeline: status?.pipeline ?? '',
    ...(status?.status === undefined ? {} : { status: status.status }),
    jobs: ids.map((id) =>
      buildJob(
        paths,
        definitions.find((job) => job.id === id),
        status?.jobs.find((job) => job.id === id),
        published,
      ),
    ),
    swept,
  };
}
