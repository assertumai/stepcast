import { z } from 'zod';

import {
  CheckCommandSchema,
  ModelTierSchema,
  RawKnowledgeSchema,
  RawSpecSchema,
  RelativeRepoPathSchema,
} from '../config/schema.js';

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

// Значение параметра проверяется после подстановки, до выбора модели.
const SelectionShape = {
  agent: z.string().optional(),
  model: z.string().optional(),
  model_tier: z.union([
    ModelTierSchema,
    z.string().regex(/^\$\{[^}]+\}$/, 'model_tier: ожидается max, deep, balance, fast, mini или подстановка'),
  ]).optional(),
};

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
  // Запись, разрешаемая источником знания. Три формы селектора и ни одной
  // сверх них: свободный запрос (`query`) потребовал бы от источника
  // недетерминированного отбора, а воспроизводимость прогона в движке стоит
  // выше удобства формулировки.
  //
  // `scope` и `id` принимают строку и список: список нужен подстановке
  // `${project.edit_paths}`, которая раскрывается по элементу на значение и
  // в скалярном поле не раскрывается вовсе.
  z
    .object({
      knowledge: z.union([
        z.literal('index'),
        z
          .object({
            scope: z.union([z.string(), z.array(z.string())]).optional(),
            id: z.union([z.string(), z.array(z.string())]).optional(),
            budget: amount.optional(),
          })
          .strict(),
      ]),
    })
    .strict(),
]);

const ContextUpstreamSchema = z.union([
  z.literal('all'),
  z.literal('none'),
  z.array(z.string()),
]);

/**
 * Схемы документа собираются от перечня плагинных предикатов.
 *
 * Ключ предиката в `expect` и `until.check` — закрытое объединение: опечатка
 * `exit_cod` обязана быть отказом разбора, а не молча пропущенным полем.
 * Значит перечень допустимых ключей зависит от загруженных плагинов, и схема
 * не может быть константой. Всё, что от предикатов не зависит, остаётся вне
 * фабрики и строится один раз.
 */
/**
 * Ветви встроенных предикатов. Объявлены снаружи фабрики, чтобы тип
 * `RawPredicate` оставался точным размеченным объединением: разбор каждой
 * ветви в `expand.ts` опирается именно на него.
 */
export const BuiltinPredicateSchema = z.union([
  z.object({ exit_code: count }).strict(),
  z.object({ file_exists: z.string() }).strict(),
  z.object({ schema: z.string() }).strict(),
  z.object({ matches: z.string() }).strict(),
  z.object({ not_matches: z.string() }).strict(),
  z.object({ changed_only: z.array(z.string()) }).strict(),
  z.object({ knowledge_valid: z.boolean() }).strict(),
  z.object({ cmd: z.string() }).strict(),
  // Тот же образец, что у `script` шага: пустая строка внутри слоя дала бы сам
  // каталог слоя (см. комментарий у ScriptStepSchema).
  z.object({ script: z.string().min(1).regex(/\S/) }).strict(),
  z
    .object({
      judge: z.string(),
      hard: z.boolean().optional(),
      agent: z.string().optional(),
      model: z.string().optional(),
    })
    .strict(),
]);

/**
 * Форма имени переиспользуемого шага (design.md, решение 2): один сегмент из
 * строчных латинских букв, цифр и дефисов. Путь и форма `автор/имя` отклонены
 * отдельными сообщениями, а не общим «недопустимый символ»: обе формы
 * напрашиваются, и отказ должен сказать, что делать, а не просто что не так.
 */
const STEP_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function describeUsesNameIssue(value: string): string | undefined {
  if (value.startsWith('./') || value.startsWith('../') || value.startsWith('/')) {
    return 'uses называет переиспользуемый шаг по имени, а не путь к файлу — для файла по пути есть шаг script';
  }
  if (value.includes('/')) {
    return 'uses пока не поддерживает форму автор/имя — назовите один сегмент имени шага';
  }
  if (!STEP_NAME_PATTERN.test(value)) {
    return 'uses: имя шага — один сегмент из строчных латинских букв, цифр и дефисов';
  }
  return undefined;
}

const UsesNameSchema = z.string().superRefine((value, ctx) => {
  const issue = describeUsesNameIssue(value);
  if (issue !== undefined) ctx.addIssue(issue);
});

/**
 * Ключ шага `uses`, который объявляет манифест шага (design.md, решение 10):
 * присутствие отклоняется своим сообщением, отсутствие — норма. Строгий объект
 * отклонил бы такой ключ и сам, но сказал бы «неизвестный ключ», отправив
 * автора искать опечатку там, где её нет: ключ известен формату и объявляется
 * в `step.yml`, а не на месте вызова.
 */
function declaredByManifest(key: string) {
  return z
    .never({ error: `ключ ${key} объявляет манифест шага, а не место вызова` })
    .describe(`Объявляется манифестом переиспользуемого шага (step.yml), а не шагом uses`)
    .optional();
}

/**
 * Документ манифеста переиспользуемого шага (`step.yml`, design.md). Строгий
 * объект: незнакомое поле — почти всегда опечатка, как и у документов
 * пайплайна и работы. `params` и `output_schema` — не сами схемы, а значения,
 * которые читает `src/core/pipeline/steps.ts`: `params` обязана быть
 * объектной JSON Schema, но это проверяется при чтении манифеста, а не здесь
 * — zod не выражает «объектная JSON Schema» точнее, чем «объект».
 */
export const StepManifestSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('step'),
    name: z.string().min(1),
    description: z.string().min(1),
    file: z.string().min(1).regex(/\S/),
    params: z.record(z.string(), z.unknown()).optional(),
    output_schema: z.string().optional(),
    runner: z.string().optional(),
  })
  .strict();

export type StepManifestDocument = z.infer<typeof StepManifestSchema>;

export function buildDocumentSchemas(pluginPredicates: readonly string[] = []) {
  const PredicateSchema =
    pluginPredicates.length === 0
      ? BuiltinPredicateSchema
      : z.union([
          BuiltinPredicateSchema,
          ...pluginPredicates.map((name) =>
            // Ветвь плагинного предиката: ключ известен, а форму значения
            // проверяет JSON Schema вклада при раскрытии (`expand.ts`), потому
            // что zod-модель чужой версии в это объединение не положить.
            z.object({ [name]: z.unknown() }).strict(),
          ),
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

  /**
   * Имя сервера — слаг: из него бэкенд строит имена инструментов
   * (`mcp__<сервер>__<инструмент>` у Claude Code), и пробел или точка в имени
   * дали бы инструмент, который нельзя назвать в `allow` (design.md, решение 3).
   */
  const McpServerNameSchema = z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, 'имя сервера должно состоять из букв, цифр, дефиса и подчёркивания');

  /**
   * Сервер объявляется процессом либо конечной точкой — ровно один транспорт.
   * `command` только списком argv: сервер поднимается без оболочки, и правила
   * разбиения строки на слова у движка нет (design.md, решение 3).
   */
  const McpServerSchema = z.union([
    z
      .object({
        command: z.array(z.string()).min(1),
        env: z.record(z.string(), z.string()).optional(),
      })
      .strict(),
    z
      .object({
        url: z.string(),
        headers: z.record(z.string(), z.string()).optional(),
      })
      .strict(),
  ]);

  const McpSchema = z.record(McpServerNameSchema, McpServerSchema);

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
      ...SelectionShape,
      session: z.string().optional(),
      prompt: z.string(),
      output_schema: z.string().optional(),
      permissions: PermissionsSchema.optional(),
      mcp: McpSchema.optional(),
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

  /**
   * Шаг `script`: файл со своим кодом, а не команда (`docs/pipeline-format.md`).
   * Строковой формы нет — оболочка в исполнении не участвует, и `args`
   * поэтому только список. `input` — объявленный вход контракта файлов
   * (`docs/pipeline-format.md`, раздел script): отображение, значения полей —
   * любой JSON. `output_schema` означает проверку файла выхода шага, а не
   * разбор `stdout`, как у `run` (design.md, решение 1, решение 6).
   *
   * Пустое значение `script` отклоняется здесь, а не разрешением пути: пустая
   * строка внутри слоя даёт сам каталог слоя, и шаг молча указал бы на него
   * вместо файла. Требование записано парой `.min(1).regex(/\S/)` — образец
   * переносится в публикуемую JSON Schema, где `.trim()` выразить нечем.
   */
  const ScriptStepSchema = z
    .object({
      ...StepCommonShape,
      script: z.string().min(1).regex(/\S/),
      args: z.array(z.string()).optional(),
      runner: z.string().optional(),
      on_fail: z.object({ analyze: z.string(), prompt: z.string() }).strict().optional(),
      input: z.record(z.string(), z.unknown()).optional(),
      output_schema: z.string().optional(),
    })
    .strict();

  /**
   * Шаг `uses`: имя переиспользуемого шага, а не путь (design.md, решение 2).
   * `script`, `args`, `runner`, `input` и `output_schema` объявляет манифест, и
   * место вызова их не переопределяет (design.md, решение 10). Объявлены они
   * здесь `declaredByManifest`, а не просто отсечены строгим объектом:
   * «неизвестный ключ runner» звучит так, будто ключа нет во всём формате, —
   * тогда как он есть, просто объявляется в другом месте, и сказать нужно
   * именно это. `with` — отображение, значения любые представимые в JSON, как
   * `input` шага `script`: главный случай — объект из выхода работы выше по
   * графу.
   */
  const UsesStepSchema = z
    .object({
      ...StepCommonShape,
      uses: UsesNameSchema,
      with: z.record(z.string(), z.unknown()).optional(),
      on_fail: z.object({ analyze: z.string(), prompt: z.string() }).strict().optional(),
      script: declaredByManifest('script'),
      args: declaredByManifest('args'),
      runner: declaredByManifest('runner'),
      input: declaredByManifest('input'),
      output_schema: declaredByManifest('output_schema'),
    })
    .strict();

  const StepSchema = z.union([AgentStepSchema, RunStepSchema, ScriptStepSchema, UsesStepSchema]);

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
    ...SelectionShape,
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
    // Ключи данных, которые работа вправе опубликовать. Список именной, а не
    // шаблонный: форма ключа не отличает объявленную публикацию от случайной
    // (см. design.md решение 2), значит нужно именно перечисление. Каждое имя
    // проверяется тем же разбором, что и ключ при записи (`assertDataKey`).
    data: z.array(z.string()).optional(),
    budget: BudgetSchema.optional(),
    until: UntilSchema.optional(),
    permissions: PermissionsSchema.optional(),
    mcp: McpSchema.optional(),
    steps: z.array(StepSchema).min(1),
  };

  const JobDocumentSchema = z
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
    /**
     * Имя сессии, общей нескольким работам. Ключ обвязки, а не поля работы:
     * работа не знает, с кем её поставят в один диалог, — это решает тот, кто
     * собирает пайплайн. Отдельное имя, а не строка на `session`: там уже живёт
     * перечисление `shared | per_step`, и два вида значения на одном ключе
     * различались бы только формой.
     */
    session_group: z.string().optional(),
    /**
     * Освобождение от потолка прогона. Ключ обвязки, а не поля работы: «тратит
     * ли эта работа деньги прогона» решает тот, кто собирает пайплайн, а не
     * автор работы — та же работа в другом пайплайне может быть обычной.
     * Допустимость только при `on: always`/`on: failure` проверяет линт, не
     * схема: здесь она не видна без соседнего поля `on`.
     */
    budget_exempt: z.boolean().optional(),
  };

  const JobUseSchema = z
    .object({
      ...SelectionShape,
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

  const JobEntrySchema = z.union([JobUseSchema, JobInlineSchema]);

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
   * форму запуска — по событию GitHub. В этом изменении внутри него
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
      knowledge: RawKnowledgeSchema.optional(),
      edit_paths: z.array(RelativeRepoPathSchema).min(1).optional(),
    })
    .strict();

  const PipelineDocumentSchema = z
    .object({
      version: z.literal(1).optional(),
      kind: z.literal('pipeline').optional(),
      ...SelectionShape,
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
          ...SelectionShape,
          session: z.enum(['shared', 'per_step']).optional(),
          workspace: WorkspaceSchema.optional(),
        })
        .strict()
        .optional(),
      budget: BudgetSchema.optional(),
      mcp: McpSchema.optional(),
      concurrency: count.optional(),
      fail_fast: z.boolean().optional(),
      jobs: z.record(z.string(), JobEntrySchema),
    })
    .strict();
  return {
    PredicateSchema,
    AgentStepSchema,
    UsesStepSchema,
    StepSchema,
    BudgetSchema,
    McpSchema,
    ParamSchema,
    ScheduleTriggerEntrySchema,
    TriggersSchema,
    ProjectSchema,
    JobDocumentSchema,
    JobEntrySchema,
    PipelineDocumentSchema,
  };
}

/**
 * Схемы для одних встроенных предикатов. Ими пользуются генерация публикуемых
 * JSON Schema и все места, куда реестр не доходит; разбор документа берёт
 * схемы от действующего реестра.
 */
const BUILTIN_SCHEMAS = buildDocumentSchemas();

export const StepSchema = BUILTIN_SCHEMAS.StepSchema;
export const JobDocumentSchema = BUILTIN_SCHEMAS.JobDocumentSchema;
export const JobEntrySchema = BUILTIN_SCHEMAS.JobEntrySchema;
export const PipelineDocumentSchema = BUILTIN_SCHEMAS.PipelineDocumentSchema;
// Типы документов выводятся из схем встроенного набора: плагинная ветвь
// добавляет ключ, но не меняет формы остальных полей.
type BuiltinSchemas = typeof BUILTIN_SCHEMAS;

export type PipelineDocument = z.infer<BuiltinSchemas['PipelineDocumentSchema']>;
export type JobDocument = z.infer<BuiltinSchemas['JobDocumentSchema']>;
export type JobEntry = z.infer<BuiltinSchemas['JobEntrySchema']>;
export type RawStep = z.infer<BuiltinSchemas['StepSchema']>;
export type RawAgentStep = z.infer<BuiltinSchemas['AgentStepSchema']>;
export type RawUsesStep = z.infer<BuiltinSchemas['UsesStepSchema']>;
/** Предикат в документе: встроенная ветвь либо ключ, внесённый плагином. */
export type RawBuiltinPredicate = z.infer<typeof BuiltinPredicateSchema>;
export type RawPredicate = RawBuiltinPredicate | Readonly<Record<string, unknown>>;
export type RawContextEntry = z.infer<typeof ContextEntrySchema>;
export type RawBudget = z.infer<BuiltinSchemas['BudgetSchema']>;
export type RawMcp = z.infer<BuiltinSchemas['McpSchema']>;
export type RawParam = z.infer<BuiltinSchemas['ParamSchema']>;
export type RawScheduleTrigger = z.infer<BuiltinSchemas['ScheduleTriggerEntrySchema']>;
export type RawTriggers = z.infer<BuiltinSchemas['TriggersSchema']>;
export type RawProject = z.infer<BuiltinSchemas['ProjectSchema']>;

/** Ключи обвязки, недопустимые внутри документа работы. */
export const WIRING_KEYS = [
  'needs',
  'on',
  'if',
  'with',
  'triggers',
  'lane',
  'display',
  'session_group',
  'budget_exempt',
] as const;
