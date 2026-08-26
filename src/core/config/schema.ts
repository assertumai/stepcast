import { z } from 'zod';

/**
 * Схема конфигурации в «сыром» виде: величины ещё строки, всё необязательно,
 * потому что каждый источник задаёт только свою часть. Приведение к числам
 * выполняется один раз после слияния слоёв — см. finalize.ts.
 *
 * Схемы строгие: неизвестный ключ в конфигурации почти всегда опечатка, и
 * молча проглатывать её дороже, чем отклонить.
 */

const amount = z.union([z.string(), z.number()]);

export const RawRunsSchema = z
  .object({
    root: z.string().optional(),
    keep: amount.optional(),
  })
  .strict();

export const RawWorkspaceSchema = z
  .object({
    mode: z.enum(['cwd', 'worktree', 'copy']).optional(),
    path: z.string().optional(),
  })
  .strict();

export const RawDefaultsSchema = z
  .object({
    agent: z.string().optional(),
    model: z.string().optional(),
    workspace: RawWorkspaceSchema.optional(),
    session: z.enum(['shared', 'per_step']).optional(),
    concurrency: z.number().int().positive().optional(),
    fail_fast: z.boolean().optional(),
    step_timeout: amount.optional(),
    stall_timeout: amount.optional(),
    max_wait: amount.optional(),
  })
  .strict();

export const RawLimitsSchema = z
  .object({
    tokens: amount.optional(),
    cost: amount.optional(),
    wallclock: amount.optional(),
    concurrency: z.number().int().positive().optional(),
    attempts: z.number().int().positive().optional(),
    iterations: z.number().int().positive().optional(),
  })
  .strict();

export const RawContextSchema = z
  .object({
    inline_threshold: amount.optional(),
    max_tokens: amount.optional(),
    note_max_tokens: amount.optional(),
    deny: z.array(z.string()).optional(),
  })
  .strict();

export const RawPermissionsSchema = z
  .object({
    mode: z.string().optional(),
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  })
  .strict();

export const RawBackendSchema = z
  .object({
    command: z.string().optional(),
    enabled: z.boolean().optional(),
    default_model: z.string().optional(),
    concurrency: z.number().int().positive().optional(),
    cache_read_weight: z.number().min(0).optional(),
    sessions: z.boolean().optional(),
    structured_output: z.boolean().optional(),
    permissions: RawPermissionsSchema.optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const RawUiSchema = z
  .object({
    port: z.number().int().positive().optional(),
  })
  .strict();

export const RawConfigSchema = z
  .object({
    version: z.literal(1).optional(),
    kind: z.literal('config').optional(),
    runs: RawRunsSchema.optional(),
    defaults: RawDefaultsSchema.optional(),
    limits: RawLimitsSchema.optional(),
    env_deny: z.array(z.string()).optional(),
    context: RawContextSchema.optional(),
    backends: z.record(z.string(), RawBackendSchema).optional(),
    ui: RawUiSchema.optional(),
  })
  .strict();

export type RawConfig = z.infer<typeof RawConfigSchema>;
export type RawBackend = z.infer<typeof RawBackendSchema>;

/**
 * Ключи, допустимые только в глобальном конфиге. Проектный конфиг лежит в
 * репозитории и попадает в ревью, поэтому машинно-зависимым путям там не место.
 * Шаблон `*` совпадает с одним сегментом пути.
 */
export const GLOBAL_ONLY_KEYS = ['runs.root', 'backends.*.command'] as const;

/** Списки, которые между слоями объединяются, а не заменяются. */
export const UNION_LIST_KEYS = ['env_deny', 'context.deny'] as const;

/** Потолки: между слоями берётся строжайшее значение, поднять их снизу нельзя. */
export const TIGHTEN_ONLY_KEYS = [
  'limits.tokens',
  'limits.cost',
  'limits.wallclock',
  'limits.concurrency',
  'limits.attempts',
  'limits.iterations',
] as const;
