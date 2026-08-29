import { z } from 'zod';

import { CheckCommandSchema, RawSpecSchema, RelativeRepoPathSchema } from '../config/schema.js';

/**
 * Схемы документов пайплайна и работы в исходном виде — до подстановок и
 * раскрытия. Строгие: неизвестный ключ почти всегда опечатка.
 */

const amount = z.union([z.string(), z.number()]);
/**
 * Числовые поля, не измеряющие величину: `concurrency`, счётчики итераций и
 * попыток, процент, код возврата. Проверка формы (целое, диапазон, знак)
 * переезжает в разбор из units.ts — она выполняется после раскрытия
 * подстановок, а до него строка `${params.n}` не проходит ни одну из них.
 */
const count = z.union([z.string(), z.number()]);

const ContextEntrySchema = z.union([
  z.string(),
  z
    .object({
      path: z.string(),
      mode: z.enum(['inline', 'reference', 'auto']).optional(),
      // Только у формы объектом: строковая запись — это короткая форма для
      // «как получится», и требование совпадений в ней негде выразить.
      required: z.boolean().optional(),
    })
    .strict(),
  z.object({ text: z.string() }).strict(),
]);

const ContextUpstreamSchema = z.union([
  z.literal('all'),
  z.literal('none'),
  z.array(z.string()),
]);

const PredicateSchema = z.union([
  z.object({ exit_code: count }).strict(),
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
    cost: amount.optional(),
    wallclock: amount.optional(),
    rate_limit_pct: count.optional(),
    on_exceed: z.enum(['wait', 'stop']).optional(),
  })
  .strict();

const WorkspaceSchema = z
  .object({
    mode: z.enum(['cwd', 'worktree', 'copy']).optional(),
    path: z.string().optional(),
  })
  .strict();

/**
 * `inherit` осмыслен только на работе — источник наследования выбирается для
 * конкретной зависимой работы, а не для пайплайна целиком. На уровне
 * пайплайна и в `defaults.workspace` он отклоняется `.strict()` схемы выше,
 * которая этого ключа не знает.
 */
const JobWorkspaceSchema = WorkspaceSchema.extend({
  inherit: z.string().optional(),
});

const PermissionsSchema = z
  .object({
    mode: z.string().optional(),
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
    enforce: z.enum(['inherit', 'strict']).optional(),
  })
  .strict();

const AttemptsSchema = z
  .object({
    max: count,
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
    output_schema: z.string().optional(),
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
    max_iterations: count.optional(),
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
  workspace: JobWorkspaceSchema.optional(),
  env: z.record(z.string(), z.string()).optional(),
  context: z.array(ContextEntrySchema).optional(),
  context_upstream: ContextUpstreamSchema.optional(),
  output: OutputSchema.optional(),
  // Объявленные входы — опция для тех, кому нужна предсказуемость: отпечаток
  // считается только по ним, под ответственность автора.
  inputs: z.array(z.string()).optional(),
  budget: BudgetSchema.optional(),
  until: UntilSchema.optional(),
  permissions: PermissionsSchema.optional(),
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

/**
 * Подпись работы в витрине: произвольные имена в шаблоны значений.
 *
 * Блок, а не плоское поле `title` прямо в обвязке: обвязка строгая, и
 * неизвестный ключ в ней отклоняется разбором — это ловит `titile`, `neds` и
 * `wokspace` на `stepcast lint`, до захода. Разрешить произвольные имена
 * прямо в обвязке значило бы потерять эту проверку для всей обвязки целиком.
 * Блок сохраняет строгость снаружи и даёт полную свободу имён внутри.
 */
const DisplaySchema = z.record(z.string(), z.string());

/** Обвязка: живёт только на месте подключения, внутри файла работы запрещена. */
const WiringShape = {
  needs: z.union([z.literal('all'), z.array(z.string())]).optional(),
  on: z.enum(['success', 'failure', 'always']).optional(),
  if: z.string().optional(),
  lane: z.string().optional(),
  display: DisplaySchema.optional(),
};

const JobUseSchema = z
  .object({
    uses: z.string(),
    with: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    ...WiringShape,
    description: z.string().optional(),
    session: z.enum(['shared', 'per_step']).optional(),
    workspace: JobWorkspaceSchema.optional(),
    env: z.record(z.string(), z.string()).optional(),
    context: z.array(ContextEntrySchema).optional(),
    context_upstream: ContextUpstreamSchema.optional(),
    budget: BudgetSchema.optional(),
  })
  .strict();

const JobInlineSchema = z.object({ ...WiringShape, ...JobBodyShape }).strict();

export const JobEntrySchema = z.union([JobUseSchema, JobInlineSchema]);

/**
 * `cron` объявлен необязательным намеренно: отсутствие поля — это не поломка
 * формы документа, а незаполненная запись расписания, и назвать её должен
 * линт («запись расписания N не содержит обязательного поля cron»), а не общая
 * ошибка схемы, в тексте которой имя поля не звучит. Линт бесплатен и
 * безусловен перед прогоном (`src/cli/commands/run.ts`), поэтому запись без
 * `cron` до запуска не доходит.
 */
const ScheduleTriggerEntrySchema = z
  .object({ cron: z.string().optional(), timezone: z.string().optional() })
  .strict();

/**
 * Ключ `triggers` заведён с запасом на вторую объявленную, но нереализованную
 * форму запуска (GitHub, см. docs/status.md). В этом изменении внутри него
 * признаётся только `schedule` — `.strict()` отклоняет любой другой вид сам,
 * называя его в сообщении об ошибке (см. `validateDocument`).
 */
const TriggersSchema = z.object({ schedule: z.array(ScheduleTriggerEntrySchema).optional() }).strict();

/**
 * Тот же состав, что у секции `project` конфигурации: объявление здесь
 * перекрывает конфигурацию, а не заводит второй формат. Модели значений —
 * буквально те же, что в конфигурации, а не их копия: копии расходятся.
 */
const ProjectSchema = z
  .object({
    check: CheckCommandSchema.optional(),
    tools: z.array(CheckCommandSchema).min(1).optional(),
    spec: RawSpecSchema.optional(),
    edit_paths: z.array(RelativeRepoPathSchema).min(1).optional(),
  })
  .strict();

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
    triggers: TriggersSchema.optional(),
    project: ProjectSchema.optional(),
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
    concurrency: count.optional(),
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
export type RawScheduleTrigger = z.infer<typeof ScheduleTriggerEntrySchema>;
export type RawTriggers = z.infer<typeof TriggersSchema>;
export type RawProject = z.infer<typeof ProjectSchema>;

/** Ключи обвязки, недопустимые внутри документа работы. */
export const WIRING_KEYS = ['needs', 'on', 'if', 'with', 'triggers', 'lane', 'display'] as const;
