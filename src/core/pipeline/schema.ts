import { z } from 'zod';

/**
 * Схемы документов пайплайна и работы в исходном виде — до подстановок и
 * раскрытия. Строгие: неизвестный ключ почти всегда опечатка.
 */

const amount = z.union([z.string(), z.number()]);

const ContextEntrySchema = z.union([
  z.string(),
  z
    .object({ path: z.string(), mode: z.enum(['inline', 'reference', 'auto']).optional() })
    .strict(),
  z.object({ text: z.string() }).strict(),
]);

const ContextUpstreamSchema = z.union([
  z.literal('all'),
  z.literal('none'),
  z.array(z.string()),
]);

const PredicateSchema = z.union([
  z.object({ exit_code: z.number().int() }).strict(),
  z.object({ file_exists: z.string() }).strict(),
  z.object({ schema: z.string() }).strict(),
  z.object({ matches: z.string() }).strict(),
  z.object({ not_matches: z.string() }).strict(),
  z.object({ changed_only: z.array(z.string()) }).strict(),
  z.object({ cmd: z.string() }).strict(),
  z
    .object({
      judge: z.string(),
      hard: z.boolean().optional(),
      agent: z.string().optional(),
      model: z.string().optional(),
    })
    .strict(),
]);

const BudgetSchema = z
  .object({
    tokens: amount.optional(),
    wallclock: amount.optional(),
    rate_limit_pct: z.number().min(0).max(100).optional(),
    on_exceed: z.enum(['wait', 'stop']).optional(),
  })
  .strict();

const WorkspaceSchema = z
  .object({
    mode: z.enum(['cwd', 'worktree', 'copy']).optional(),
    path: z.string().optional(),
  })
  .strict();

const PermissionsSchema = z
  .object({
    mode: z.string().optional(),
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  })
  .strict();

const AttemptsSchema = z
  .object({
    max: z.number().int().positive(),
    escalation: z
      .array(
        z
          .object({ include_failure: z.boolean().optional(), model: z.string().optional() })
          .strict(),
      )
      .optional(),
  })
  .strict();

const StepCommonShape = {
  id: z.string().min(1),
  env: z.record(z.string(), z.string()).optional(),
  context: z.array(ContextEntrySchema).optional(),
  context_inherit: z.boolean().optional(),
  context_exclude: z.array(z.string()).optional(),
  context_max_tokens: amount.optional(),
  timeout: amount.optional(),
  budget: BudgetSchema.optional(),
  expect: z.array(PredicateSchema).optional(),
  attempts: AttemptsSchema.optional(),
};

const AgentStepSchema = z
  .object({
    ...StepCommonShape,
    agent: z.string().optional(),
    model: z.string().optional(),
    session: z.string().optional(),
    prompt: z.string(),
    output_schema: z.string().optional(),
    permissions: PermissionsSchema.optional(),
  })
  .strict();

const RunStepSchema = z
  .object({
    ...StepCommonShape,
    run: z.union([z.string(), z.array(z.string())]),
    on_fail: z.object({ analyze: z.string(), prompt: z.string() }).strict().optional(),
  })
  .strict();

export const StepSchema = z.union([AgentStepSchema, RunStepSchema]);

const ParamSchema = z
  .object({
    type: z.enum(['string', 'bool', 'int']),
    required: z.boolean().optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  })
  .strict();

const UntilSchema = z
  .object({
    max_iterations: z.number().int().positive().optional(),
    check: z.array(PredicateSchema),
  })
  .strict();

const OutputSchema = z
  .object({ from: z.string().optional(), schema: z.string().optional() })
  .strict();

/** Тело работы — общая часть для отдельного файла и описания на месте. */
const JobBodyShape = {
  name: z.string().optional(),
  description: z.string().optional(),
  session: z.enum(['shared', 'per_step']).optional(),
  workspace: WorkspaceSchema.optional(),
  env: z.record(z.string(), z.string()).optional(),
  context: z.array(ContextEntrySchema).optional(),
  context_upstream: ContextUpstreamSchema.optional(),
  output: OutputSchema.optional(),
  budget: BudgetSchema.optional(),
  until: UntilSchema.optional(),
  steps: z.array(StepSchema).min(1),
};

export const JobDocumentSchema = z
  .object({
    version: z.literal(1).optional(),
    kind: z.literal('job'),
    params: z.record(z.string(), ParamSchema).optional(),
    ...JobBodyShape,
  })
  .strict();

/** Обвязка: живёт только на месте подключения, внутри файла работы запрещена. */
const WiringShape = {
  needs: z.union([z.literal('all'), z.array(z.string())]).optional(),
  on: z.enum(['success', 'failure', 'always']).optional(),
  if: z.string().optional(),
};

const JobUseSchema = z
  .object({
    uses: z.string(),
    with: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    ...WiringShape,
    description: z.string().optional(),
    session: z.enum(['shared', 'per_step']).optional(),
    workspace: WorkspaceSchema.optional(),
    env: z.record(z.string(), z.string()).optional(),
    context: z.array(ContextEntrySchema).optional(),
    context_upstream: ContextUpstreamSchema.optional(),
    budget: BudgetSchema.optional(),
  })
  .strict();

const JobInlineSchema = z.object({ ...WiringShape, ...JobBodyShape }).strict();

export const JobEntrySchema = z.union([JobUseSchema, JobInlineSchema]);

export const PipelineDocumentSchema = z
  .object({
    version: z.literal(1).optional(),
    kind: z.literal('pipeline').optional(),
    name: z.string().optional(),
    inputs: z.record(z.string(), ParamSchema).optional(),
    workspace: WorkspaceSchema.optional(),
    env: z.record(z.string(), z.string()).optional(),
    env_files: z.array(z.string()).optional(),
    env_deny: z.array(z.string()).optional(),
    context: z.array(ContextEntrySchema).optional(),
    context_upstream: ContextUpstreamSchema.optional(),
    defaults: z
      .object({
        agent: z.string().optional(),
        model: z.string().optional(),
        session: z.enum(['shared', 'per_step']).optional(),
        workspace: WorkspaceSchema.optional(),
      })
      .strict()
      .optional(),
    budget: BudgetSchema.optional(),
    concurrency: z.number().int().positive().optional(),
    fail_fast: z.boolean().optional(),
    jobs: z.record(z.string(), JobEntrySchema),
  })
  .strict();

export type PipelineDocument = z.infer<typeof PipelineDocumentSchema>;
export type JobDocument = z.infer<typeof JobDocumentSchema>;
export type JobEntry = z.infer<typeof JobEntrySchema>;
export type RawStep = z.infer<typeof StepSchema>;
export type RawAgentStep = z.infer<typeof AgentStepSchema>;
export type RawPredicate = z.infer<typeof PredicateSchema>;
export type RawContextEntry = z.infer<typeof ContextEntrySchema>;
export type RawBudget = z.infer<typeof BudgetSchema>;
export type RawParam = z.infer<typeof ParamSchema>;

/** Ключи обвязки, недопустимые внутри документа работы. */
export const WIRING_KEYS = ['needs', 'on', 'if', 'with'] as const;
