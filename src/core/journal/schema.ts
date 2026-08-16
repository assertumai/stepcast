import { z } from 'zod';

/**
 * Схемы файлов журнала. Они же задают формат, который читают UI и внешние
 * инструменты, поэтому описаны явно, а не выводятся из внутренних типов.
 */

export const StatusValueSchema = z.enum([
  'pending',
  'running',
  'success',
  'failed',
  'skipped',
  'canceled',
  'budget_exceeded',
]);

export type StatusValue = z.infer<typeof StatusValueSchema>;

/** Исход, который для условий считается отказом. */
export function isFailure(status: StatusValue): boolean {
  return status === 'failed' || status === 'budget_exceeded' || status === 'canceled';
}

export const UsageSchema = z
  .object({
    backend: z.string(),
    model: z.string().optional(),
    // Несообщаемое поле остаётся null: ноль превратил бы неполный учёт в
    // мнимую точность.
    tokens_in: z.number().nullable(),
    tokens_out: z.number().nullable(),
    cache_read: z.number().nullable(),
    cache_write: z.number().nullable(),
    wallclock_ms: z.number(),
    rate_limits: z
      .record(
        z.string(),
        z.object({ used_pct: z.number(), resets_at: z.number().optional() }).strict(),
      )
      .optional(),
    reported_cost_usd: z.number().optional(),
  })
  .strict();

export type Usage = z.infer<typeof UsageSchema>;

export const PredicateResultSchema = z
  .object({
    predicate: z.string(),
    passed: z.boolean(),
    hard: z.boolean(),
    detail: z.string().optional(),
    expected: z.unknown().optional(),
    actual: z.unknown().optional(),
  })
  .strict();

export const ExpectReportSchema = z
  .object({
    attempt: z.number().int().positive(),
    results: z.array(PredicateResultSchema),
  })
  .strict();

export const ContextEntryReportSchema = z
  .object({
    origin: z.enum(['upstream', 'pipeline', 'job', 'step']),
    kind: z.enum(['path', 'text']),
    path: z.string().optional(),
    mode: z.enum(['inline', 'reference']),
    tokens: z.number(),
  })
  .strict();

export const ContextReportSchema = z
  .object({
    session: z.string().optional(),
    entries: z.array(ContextEntryReportSchema),
    total_tokens: z.number(),
    downgraded: z.array(z.string()).optional(),
  })
  .strict();

export const AttemptRecordSchema = z
  .object({
    attempt: z.number().int().positive(),
    status: StatusValueSchema,
    reason: z.string().optional(),
    started_at: z.string(),
    finished_at: z.string(),
    exit_code: z.number().nullable().optional(),
    usage: UsageSchema.optional(),
  })
  .strict();

export const StepRecordSchema = z
  .object({
    id: z.string(),
    index: z.number().int().positive(),
    kind: z.enum(['agent', 'run']),
    key: z.string(),
    status: StatusValueSchema,
    reason: z.string().optional(),
    session: z.string().optional(),
    attempts: z.array(AttemptRecordSchema),
    /** Файлы, которые шаг фактически прочитал, — уточняют инвалидацию. */
    observed_inputs: z.array(z.string()).optional(),
    /** Что бэкенд сообщил о своей инициализации: плагины, серверы, ошибки. */
    backend_init: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const JobRecordSchema = z
  .object({
    id: z.string(),
    status: StatusValueSchema,
    reason: z.string().optional(),
    started_at: z.string().optional(),
    finished_at: z.string().optional(),
    output: z.string().optional(),
    steps: z.array(StepRecordSchema),
  })
  .strict();

export const RunManifestSchema = z
  .object({
    run_id: z.string(),
    pipeline: z.string(),
    pipeline_file: z.string(),
    lock_hash: z.string(),
    project_root: z.string(),
    workspace: z.object({ mode: z.string(), path: z.string().optional() }).strict(),
    inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    git: z.object({ head: z.string().optional(), dirty_hash: z.string().optional() }).strict(),
    backends: z.record(z.string(), z.object({ command: z.string(), version: z.string().optional() }).strict()),
    started_at: z.string(),
    finished_at: z.string().optional(),
    status: StatusValueSchema.optional(),
    exit_code: z.number().optional(),
  })
  .strict();

export const BudgetStateSchema = z
  .object({
    tokens_used: z.number(),
    tokens_limit: z.number().optional(),
    wallclock_ms: z.number(),
    wallclock_limit_ms: z.number().optional(),
  })
  .strict();

export const RunStatusSchema = z
  .object({
    run_id: z.string(),
    pipeline: z.string(),
    lock_hash: z.string(),
    status: StatusValueSchema,
    workspace: z.object({ mode: z.string(), path: z.string().optional() }).strict(),
    inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    jobs: z.array(JobRecordSchema),
    budget: BudgetStateSchema,
    /** Команда возобновления: состояние должно объяснять, как продолжить. */
    resume: z.object({ command: z.string(), blocked_by: z.string().optional() }).strict().optional(),
    updated_at: z.string(),
  })
  .strict();

export const UsageReportSchema = z
  .object({
    run_id: z.string(),
    total: z
      .object({
        tokens_in: z.number(),
        tokens_out: z.number(),
        cache_read: z.number(),
        cache_write: z.number(),
        billable_tokens: z.number(),
        wallclock_ms: z.number(),
      })
      .strict(),
    /** Измерения, которых бэкенды не сообщили: учёт по ним неполон. */
    unreported: z.array(z.string()),
    jobs: z.record(
      z.string(),
      z
        .object({
          billable_tokens: z.number(),
          wallclock_ms: z.number(),
          steps: z.record(
            z.string(),
            z
              .object({
                billable_tokens: z.number(),
                wallclock_ms: z.number(),
                attempts: z.number().int(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();

const eventBase = { ts: z.string(), seq: z.number().int().nonnegative() };

export const EventSchema = z.discriminatedUnion('kind', [
  z.object({ ...eventBase, kind: z.literal('run.started'), pipeline: z.string(), run_id: z.string() }).strict(),
  z.object({ ...eventBase, kind: z.literal('run.finished'), status: StatusValueSchema, exit_code: z.number() }).strict(),
  z.object({ ...eventBase, kind: z.literal('job.started'), job: z.string() }).strict(),
  z.object({ ...eventBase, kind: z.literal('job.finished'), job: z.string(), status: StatusValueSchema, reason: z.string().optional() }).strict(),
  z.object({ ...eventBase, kind: z.literal('step.started'), job: z.string(), step: z.string(), attempt: z.number().int().positive() }).strict(),
  z.object({ ...eventBase, kind: z.literal('step.finished'), job: z.string(), step: z.string(), attempt: z.number().int().positive(), status: StatusValueSchema, reason: z.string().optional() }).strict(),
  z.object({ ...eventBase, kind: z.literal('step.stalled'), job: z.string(), step: z.string(), silent_ms: z.number() }).strict(),
  z.object({ ...eventBase, kind: z.literal('expect.failed'), job: z.string(), step: z.string(), attempt: z.number().int().positive(), predicate: z.string(), detail: z.string().optional() }).strict(),
  z.object({ ...eventBase, kind: z.literal('env.denied'), name: z.string(), pattern: z.string(), scope: z.string() }).strict(),
  z.object({ ...eventBase, kind: z.literal('context.denied'), path: z.string(), pattern: z.string() }).strict(),
  z.object({ ...eventBase, kind: z.literal('context.downgraded'), job: z.string(), step: z.string(), path: z.string(), tokens: z.number() }).strict(),
  z.object({ ...eventBase, kind: z.literal('budget.warning'), scope: z.string(), used: z.number(), limit: z.number() }).strict(),
  z.object({ ...eventBase, kind: z.literal('budget.exceeded'), scope: z.string(), used: z.number(), limit: z.number() }).strict(),
  z.object({ ...eventBase, kind: z.literal('backend.degraded'), backend: z.string(), capability: z.string(), detail: z.string() }).strict(),
  z.object({ ...eventBase, kind: z.literal('backend.unparsed'), job: z.string(), step: z.string(), line: z.string() }).strict(),
]);

export type Event = z.infer<typeof EventSchema>;
export type EventInput = Omit<Event, 'ts' | 'seq'> extends never ? never : DistributiveOmit<Event, 'ts' | 'seq'>;

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

export type RunManifest = z.infer<typeof RunManifestSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type JobRecord = z.infer<typeof JobRecordSchema>;
export type StepRecord = z.infer<typeof StepRecordSchema>;
export type AttemptRecord = z.infer<typeof AttemptRecordSchema>;
export type UsageReport = z.infer<typeof UsageReportSchema>;
export type ContextReport = z.infer<typeof ContextReportSchema>;
export type ExpectReport = z.infer<typeof ExpectReportSchema>;
export type PredicateResult = z.infer<typeof PredicateResultSchema>;
