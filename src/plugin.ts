/**
 * Публичная поверхность для авторов плагинов: `import … from 'stepcast/plugin'`.
 *
 * Здесь ровно то, без чего вклад не написать, — и ничего сверх. Что
 * экспортировано, то и обещано: остальное ядро остаётся внутренним, и его
 * перестановка не ломает чужой плагин. Контракт описан в `docs/plugins.md`.
 *
 * Ядерный, а не единственный подпуть (`plugin-surface-split`, design.md,
 * Решение 1): объявления, знающие о пайплайне — шаге, работе, прогоне,
 * попытке, предикате, бэкенде, журнале, конфигурации движка, — переехали в
 * `stepcast/pipeline` (`src/parts/pipeline/surface.ts`). Реэкспорта с
 * пометкой об устаревании здесь нет и не будет (design.md, Решение 7):
 * половина переехавших имён — значения, и их реэкспорт вернул бы доменные
 * модули в граф загрузки этого подпутя — то есть ровно то, ради чего шаг
 * сделан. Таблица ниже — тот самый переход по первой ссылке на определение,
 * которым автор прежнего импорта попадёт сюда; полная запись выбора и его
 * причина — в `docs/plugins.md`, раздел «Два подпутя».
 *
 * | Прежнее имя (было здесь)                                    | Новый подпуть      |
 * |--------------------------------------------------------------|--------------------|
 * | `BackendContribution`, `PredicateContribution`                | `stepcast/pipeline`|
 * | `StepKindContribution` и вся родня (`StepKindInput`, …)        | `stepcast/pipeline`|
 * | `LintSite`, `DecisionEffect`, `DecisionOutcome`                | `stepcast/pipeline`|
 * | `PredicateRegistrar`, `StepKindRegistrar`                      | `stepcast/pipeline`|
 * | доменные поля контекста (`ctx.backends`, `ctx.predicates`, `ctx.steps`) | `stepcast/pipeline` (`PipelineContext`, `pipelineContext(ctx)`) |
 * | `BackendAdapter`, `BackendEvent`, `BackendModel`, `BackendRefusal*`, `LaunchSpec`, `AgentInvocation`, `ModelDiscovery`, `ProbeOutput`, `PermissionDenial`, `BackendCapabilities` | `stepcast/pipeline` |
 * | `describeRefusal`, `emptyUsage`, `mergeUsage`, `sumUsage`      | `stepcast/pipeline`|
 * | `effectivePermissions`, `Permissions`, `McpServer`, `McpServers`| `stepcast/pipeline`|
 * | `EvaluationInput`, `PredicateResult`, `Usage`                  | `stepcast/pipeline`|
 * | `Config`, `BackendConfig`, `Registry`                          | `stepcast/pipeline`|
 * | `defineBackend`, `definePredicate`, `defineStepKind`           | `stepcast/pipeline`|
 * | доменные ключи `StepcastPlugin` (`backends`, `predicates`, `steps`) — теперь `PipelinePlugin` | `stepcast/pipeline` (`definePipelinePlugin`) |
 *
 * Имена, оставшиеся здесь, импортируются прежним спецификом без единой
 * правки: `StepcastError`, `parseDuration`, `runProcess`, `definePlugin`,
 * контекст ядра, каркас CLI.
 */

export type {
  CommandContribution,
  CommandEnv,
  ContextPlugin,
  ContextPluginFunction,
  ContextPluginObject,
  LoadedPlugin,
  PluginDiagnostic,
  StepcastPlugin,
} from './core/plugins/contract.js';

/**
 * Хелпер объявления ядерного плагина — необязательная надстройка над
 * контрактом выше (design.md изменения `plugin-typed-helpers`, Решение 1):
 * тождество в рантайме, ни проверки вклада, ни регистрации. Ценность —
 * проверка литерала на лишние и опечатанные поля (схема загрузки объявлена
 * `.loose()` и опечатку пропускает молча). Плагин, не знающий об этом
 * хелпере, — объектный литерал с прежней аннотацией типа, — загружается и
 * работает как прежде.
 */
export { definePlugin } from './core/plugins/define.js';

/**
 * Разбор длительностей — единственный диалог для полей длительности в
 * документе, будь то поле конфигурации или поле вклада (design.md изменения
 * `user-decision-steps`, решение 7): второй диалект длительностей был бы
 * худшим из возможных расширений.
 */
export { parseDuration } from './core/units.js';

/** Строка дерева плагинов: то, что команда получает в `CommandEnv.pluginTree`. */
export type { TreeRow, TreeRowSource } from './core/plugins/tree.js';

/**
 * Контекст ядра: то, без чего плагин контекста не написать. Публикует только
 * сервис команд и способности области — `backends`/`predicates`/`steps`
 * называет доменный подпуть `stepcast/pipeline`, чей `PipelineContext`
 * расширяет этот тип (`plugin-surface-split`, design.md, Решение 4): плагин,
 * тянущийся к любому из трёх, берёт `pipelineContext(ctx)` оттуда же.
 *
 * Объявлен степкастом целиком и на `cordis` не ссылается: плагину не нужна ни
 * библиотека, ни её типы, и объявлять собственную зависимость от неё не
 * следует — два экземпляра означают два разных хранилища сервисов, не видящих
 * друг друга (docs/plugins.md, граница единственного экземпляра).
 */
export type { Context, ContributionRegistrar, Inject } from './core/plugins/context.js';

export type { CliIo, CommandSpec, FlagKind, FlagSpec, ParsedArgs } from './core/plugins/cli-types.js';

/** Запуск дочернего процесса под надзором: то же, чем движок исполняет шаги. */
export { runProcess, DEFAULT_GRACE_MS } from './core/exec/process.js';
export type { ProcessOptions, ProcessResult, ProcessOutcome } from './core/exec/process.js';

export { ExitCode, StepcastError, isStepcastError } from './core/errors.js';
export type { ExitCodeValue } from './core/errors.js';
