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
    /**
     * Объём одного самого большого обращения — сумма tokens_in + cache_read +
     * cache_write того сообщения потока, где она была наибольшей. Не путать с
     * трафиком: последний суммирует все обращения, а это — максимум одного.
     * Отсутствует, если бэкенд не сообщает расход по отдельным сообщениям.
     */
    peak_prefix_tokens: z.number().optional(),
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

/**
 * Причина досрочной остановки из закрытого перечня `core/run/halt.ts`.
 * Держится строкой, а не ссылкой на константу: схема описывает формат файла,
 * который читают посторонние инструменты.
 */
export const HaltCauseSchema = z.enum([
  'expect_failed',
  'timeout',
  'spawn_failed',
  'until_not_met',
  'budget_exceeded',
  'canceled',
  'backend_rate_limited',
  'backend_unauthenticated',
]);

export const StepRecordSchema = z
  .object({
    id: z.string(),
    index: z.number().int().positive(),
    kind: z.enum(['agent', 'run']),
    key: z.string(),
    status: StatusValueSchema,
    reason: z.string().optional(),
    /** Причина неуспеха из закрытого перечня. */
    cause: HaltCauseSchema.optional(),
    session: z.string().optional(),
    attempts: z.array(AttemptRecordSchema),
    /** Якорь состояния рабочего дерева на конец шага. */
    tree_id: z.string().optional(),
    /** Якорь на начало шага: база для `changed_only` и для `diff.patch`. */
    tree_before: z.string().optional(),
    /** Способ фиксации: якоря разных способов несравнимы. */
    anchor_kind: z.enum(['git', 'manifest']).optional(),
    /**
     * Почему якорь снять не удалось. Наличие поля означает, что шаг непригоден
     * для переиспользования при возобновлении, но на его статус это не влияло.
     */
    anchor_missing: z.string().optional(),
    /** Отпечаток входов шага — то, что решает вопрос о его валидности. */
    inputs_fingerprint: z.string().optional(),
    /**
     * Откуда взят отпечаток. Пишется рядом с ним, чтобы объяснение
     * инвалидации собиралось из записи, без повторного вычисления.
     */
    inputs_origin: z.enum(['declared', 'observed', 'tree']).optional(),
    /** Файлы, которые шаг фактически прочитал, — уточняют инвалидацию. */
    observed_inputs: z.array(z.string()).optional(),
    /** Что бэкенд сообщил о своей инициализации: плагины, серверы, ошибки. */
    backend_init: z.record(z.string(), z.unknown()).optional(),
    /** Прогон, из которого запись перенесена без исполнения шага. */
    reused_from: z.string().optional(),
  })
  .strict();

export const JobRecordSchema = z
  .object({
    id: z.string(),
    status: StatusValueSchema,
    reason: z.string().optional(),
    /** Причина неуспеха из закрытого перечня. */
    cause: HaltCauseSchema.optional(),
    /** Число выполненных итераций цикла. У работы без цикла отсутствует. */
    iterations: z.number().int().positive().optional(),
    /**
     * Результаты предикатов check последней вычисленной итерации. Есть
     * только при отказе с причиной until_not_met — иначе цикл завершился
     * успехом и объяснять нечего.
     */
    last_check: z.array(PredicateResultSchema).optional(),
    /** Режим и путь рабочей директории работы: их нужно знать для apply. */
    workspace: z.object({ mode: z.string(), path: z.string() }).strict().optional(),
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
    /** Способ фиксации состояния дерева: определяется один раз на прогон. */
    anchor_kind: z.enum(['git', 'manifest']).optional(),
    /** Прогон, из которого этот получен возобновлением. */
    resumed_from: z.string().optional(),
    inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    git: z.object({ head: z.string().optional(), dirty_hash: z.string().optional() }).strict(),
    backends: z.record(z.string(), z.object({ command: z.string(), version: z.string().optional() }).strict()),
    started_at: z.string(),
    finished_at: z.string().optional(),
    status: StatusValueSchema.optional(),
    exit_code: z.number().optional(),
    /**
     * Идентификатор процесса, ведущего прогон. Пишется до запуска первой
     * работы — читатель журнала использует его, чтобы отличить прогон,
     * зависший в `running` после `SIGKILL` или перезагрузки, от идущего или
     * спящего до сброса окна лимита. Манифест прежней формы этого поля не
     * несёт: тот же необратимый шаг, что уже был у сводок расхода.
     */
    pid: z.number().optional(),
  })
  .strict();

export const BudgetStateSchema = z
  .object({
    tokens_used: z.number(),
    tokens_limit: z.number().optional(),
    cost_used_usd: z.number().optional(),
    cost_limit_usd: z.number().optional(),
    /** Попытки, чья цена неизвестна: объявленный денежный потолок мог не применяться. */
    cost_unreported_attempts: z.number().optional(),
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
    /** Прогон, из которого этот получен возобновлением. */
    resumed_from: z.string().optional(),
    inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    jobs: z.array(JobRecordSchema),
    budget: BudgetStateSchema,
    /** Команда возобновления: состояние должно объяснять, как продолжить. */
    resume: z.object({ command: z.string(), blocked_by: z.string().optional() }).strict().optional(),
    /**
     * Момент, когда прогон, уснувший до сброса окна лимита, должен
     * возобновиться. Пишется на диск до начала сна и снимается после
     * пробуждения — это отличает спящий прогон от зависшего.
     */
    wake_at: z.string().optional(),
    updated_at: z.string(),
  })
  .strict();

export const UsageAttemptReportSchema = z
  .object({
    attempt: z.number().int().positive(),
    backend: z.string(),
    model: z.string().optional(),
    billable_tokens: z.number(),
    wallclock_ms: z.number(),
    /** Отсутствует, если ни один сообщённый расход попытки не содержал цены. */
    cost_usd: z.number().optional(),
    /** Наибольший префикс обращения этой попытки. См. `UsageSchema`. */
    peak_prefix_tokens: z.number().optional(),
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
        cost_usd: z.number().optional(),
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
          cost_usd: z.number().optional(),
          steps: z.record(
            z.string(),
            z
              .object({
                billable_tokens: z.number(),
                wallclock_ms: z.number(),
                cost_usd: z.number().optional(),
                // Максимум по попыткам шага, не сумма. Отсутствует, если ни
                // одна попытка не сообщила пика, — уровни работы и прогона
                // этого поля не несут вовсе: величина теряет смысл ориентира
                // выше шага.
                peak_prefix_tokens: z.number().optional(),
                // Прежняя форма сводки хранила число попыток. Разбивки в ней
                // нет и взять её неоткуда, но остальная сводка старого прогона
                // остаётся годной: терять её целиком ради поля, которого тогда
                // не писали, значит ослепить отчёт на всех прошлых прогонах.
                attempts: z.preprocess(
                  (value) => (typeof value === 'number' ? [] : value),
                  z.array(UsageAttemptReportSchema),
                ),
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
  z.object({ ...eventBase, kind: z.literal('job.errored'), job: z.string(), detail: z.string() }).strict(),
  z.object({ ...eventBase, kind: z.literal('job.finished'), job: z.string(), status: StatusValueSchema, reason: z.string().optional() }).strict(),
  z.object({ ...eventBase, kind: z.literal('step.started'), job: z.string(), step: z.string(), attempt: z.number().int().positive() }).strict(),
  z.object({ ...eventBase, kind: z.literal('step.finished'), job: z.string(), step: z.string(), attempt: z.number().int().positive(), status: StatusValueSchema, reason: z.string().optional() }).strict(),
  z.object({ ...eventBase, kind: z.literal('step.stalled'), job: z.string(), step: z.string(), silent_ms: z.number() }).strict(),
  z.object({ ...eventBase, kind: z.literal('expect.failed'), job: z.string(), step: z.string(), attempt: z.number().int().positive(), predicate: z.string(), detail: z.string().optional() }).strict(),
  z.object({ ...eventBase, kind: z.literal('env.denied'), name: z.string(), pattern: z.string(), scope: z.string() }).strict(),
  z.object({ ...eventBase, kind: z.literal('context.denied'), path: z.string(), pattern: z.string() }).strict(),
  z.object({ ...eventBase, kind: z.literal('context.downgraded'), job: z.string(), step: z.string(), path: z.string(), tokens: z.number() }).strict(),
  z.object({ ...eventBase, kind: z.literal('context.note_truncated'), job: z.string(), step: z.string(), original_tokens: z.number(), final_tokens: z.number() }).strict(),
  z.object({ ...eventBase, kind: z.literal('budget.warning'), scope: z.string(), used: z.number(), limit: z.number() }).strict(),
  z.object({ ...eventBase, kind: z.literal('budget.exceeded'), scope: z.string(), used: z.number(), limit: z.number() }).strict(),
  z.object({
    ...eventBase,
    kind: z.literal('budget.waiting'),
    scope: z.string(),
    dimension: z.literal('rate_limit'),
    // Отсутствует, когда ожидание вызвано отказом бэкенда, а не превышением
    // объявленного `rate_limit_pct`: измеренного порога тут нет.
    threshold: z.number().optional(),
    resets_at: z.number(),
    wait_ms: z.number(),
  }).strict(),
  z.object({ ...eventBase, kind: z.literal('budget.resumed'), actual_ms: z.number() }).strict(),
  // Неустранимый отказ бэкенда: виден без чтения stdout.log шага.
  z.object({
    ...eventBase,
    kind: z.literal('backend.refused'),
    job: z.string(),
    step: z.string(),
    attempt: z.number().int().positive(),
    class: z.enum(['rate_limit', 'unauthenticated']),
    status_code: z.number().optional(),
    message: z.string(),
    resets_at: z.number().optional(),
  }).strict(),
  // Первая завершившаяся попытка без цены при объявленном денежном потолке:
  // молча довести прогон до конца значило бы соврать, что потолок применялся.
  z.object({ ...eventBase, kind: z.literal('budget.cost_unreported'), job: z.string(), step: z.string(), attempt: z.number().int().positive() }).strict(),
  z.object({ ...eventBase, kind: z.literal('backend.degraded'), backend: z.string(), capability: z.string(), detail: z.string() }).strict(),
  z.object({ ...eventBase, kind: z.literal('backend.unparsed'), job: z.string(), step: z.string(), line: z.string() }).strict(),
  // Неудача внутреннего учёта. Статусов не меняет: см. core/run/bookkeeping.ts.
  z.object({ ...eventBase, kind: z.literal('iteration.started'), job: z.string(), iteration: z.number().int().positive() }).strict(),
  z.object({ ...eventBase, kind: z.literal('iteration.finished'), job: z.string(), iteration: z.number().int().positive(), passed: z.boolean(), reason: z.string().optional() }).strict(),
  z.object({ ...eventBase, kind: z.literal('step.reused'), job: z.string(), step: z.string(), source: z.string() }).strict(),
  z.object({ ...eventBase, kind: z.literal('tree.restored'), anchor: z.string(), path: z.string() }).strict(),
  // Состояние каталога прогона, оставленное переиспользованными шагами:
  // перенесено из исходного прогона, потому что каталог нового пуст.
  z.object({ ...eventBase, kind: z.literal('run_dir.carried'), path: z.string(), source: z.string() }).strict(),
  z.object({ ...eventBase, kind: z.literal('bookkeeping.failed'), operation: z.string(), job: z.string().optional(), step: z.string().optional(), detail: z.string() }).strict(),
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
export type UsageAttemptReport = z.infer<typeof UsageAttemptReportSchema>;
export type ContextReport = z.infer<typeof ContextReportSchema>;
export type ContextEntryReport = z.infer<typeof ContextEntryReportSchema>;
export type ExpectReport = z.infer<typeof ExpectReportSchema>;
export type PredicateResult = z.infer<typeof PredicateResultSchema>;
