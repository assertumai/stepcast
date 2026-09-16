/**
 * Публичная поверхность для авторов плагинов: `import … from 'stepcast/plugin'`.
 *
 * Здесь ровно то, без чего вклад не написать, — и ничего сверх. Что
 * экспортировано, то и обещано: остальное ядро остаётся внутренним, и его
 * перестановка не ломает чужой плагин. Контракт описан в `docs/plugins.md`.
 */

export type {
  BackendContribution,
  CommandContribution,
  CommandEnv,
  ContextPlugin,
  ContextPluginFunction,
  ContextPluginObject,
  DecisionEffect,
  DecisionOutcome,
  LintSite,
  LoadedPlugin,
  PluginDiagnostic,
  PredicateContribution,
  StepcastPlugin,
  StepKindContribution,
  StepKindDecisionRequest,
  StepKindDecisionResult,
  StepKindDecisions,
  StepKindDocumentForm,
  StepKindInput,
  StepKindLog,
  StepKindOutcome,
} from './core/plugins/contract.js';

/**
 * Хелперы объявления вклада — необязательная надстройка над контрактом выше
 * (design.md изменения `plugin-typed-helpers`, Решение 1): каждый в рантайме
 * тождество, ни один не проверяет вклад и не регистрирует его. Ценность
 * `definePlugin`/`defineBackend` — в проверке литерала на лишние и
 * опечатанные поля (схема загрузки объявлена `.loose()` и опечатку пропускает
 * молча); `definePredicate<T>` и `defineStepKind<F>` сверх этого типизируют
 * вход вычислителя объявленным типом `T`/`F`, снимая приведение
 * (`as …`), которое иначе писал бы каждый вклад. Плагин, не знающий об этих
 * хелперах — объектный литерал с прежней аннотацией типа, — загружается и
 * работает как прежде.
 */
export { definePlugin, defineBackend, definePredicate, defineStepKind } from './core/plugins/define.js';

/**
 * Разбор длительностей — единственный диалог для полей полей длительности в
 * документе, будь то поле конфигурации или поле вклада (design.md изменения
 * `user-decision-steps`, решение 7): второй диалект длительностей был бы
 * худшим из возможных расширений.
 */
export { parseDuration } from './core/units.js';

/** Строка дерева плагинов: то, что команда получает в `CommandEnv.pluginTree`. */
export type { TreeRow, TreeRowSource } from './core/plugins/tree.js';

/**
 * Контекст ядра: то, без чего плагин контекста не написать. Служебные сервисы
 * типизированы на нём — `ctx.backends.register(имя, вклад)` и симметричные
 * вызовы для прочих видов, — но принадлежат они не ядру: `commands` заводит
 * само ядро, а `backends`, `predicates` и `steps` — строка состава `pipeline`
 * (`pipeline-owns-services`, Решение 1). Отсюда правило: плагин, тянущийся к
 * любому из трёх, обязан объявить `inject` с его именем; поля объявлены здесь
 * как всегда доступные именно потому, что до тела, объявившего зависимость,
 * дело доходит только с разрешённым сервисом, а состав без строки `pipeline`
 * такого тела не зовёт вовсе (docs/plugins.md, «Контекст, область и сервис»).
 *
 * Объявлен степкастом целиком и на `cordis` не ссылается: плагину не нужна ни
 * библиотека, ни её типы, и объявлять собственную зависимость от неё не
 * следует — два экземпляра означают два разных хранилища сервисов, не видящих
 * друг друга (docs/plugins.md, граница единственного экземпляра).
 */
export type { Context, ContributionRegistrar, Inject, PredicateRegistrar, StepKindRegistrar } from './core/plugins/context.js';

export type { CliIo, CommandSpec, FlagKind, FlagSpec, ParsedArgs } from './core/plugins/cli-types.js';

export type {
  AgentInvocation,
  BackendAdapter,
  BackendCapabilities,
  BackendEvent,
  BackendModel,
  BackendRefusal,
  BackendRefusalClass,
  LaunchSpec,
  ModelDiscovery,
  PermissionDenial,
  ProbeOutput,
} from './core/backend/types.js';

export { describeRefusal, emptyUsage, mergeUsage, sumUsage } from './core/backend/types.js';

/**
 * Правила слияния политики доступа шага с политикой из конфигурации бэкенда.
 * Понадобились адаптеру Codex: без экспорта плагин переписал бы их у себя, и
 * второй бэкенд применял бы `enforce` иначе, чем встроенный.
 */
export { effectivePermissions } from './core/backend/permissions.js';
/** Формы объявлений, которые `AgentInvocation` несёт адаптеру: политика и MCP-серверы. */
export type { McpServer, McpServers, Permissions } from './core/pipeline/model.js';

export type { BackendConfig, Config } from './core/config/resolve.js';
export type { EvaluationInput } from './core/expect/evaluate.js';
export type { PredicateResult, Usage } from './core/journal/schema.js';

/** Запуск дочернего процесса под надзором: то же, чем движок исполняет шаги. */
export { runProcess, DEFAULT_GRACE_MS } from './core/exec/process.js';
export type { ProcessOptions, ProcessResult, ProcessOutcome } from './core/exec/process.js';

export { ExitCode, StepcastError, isStepcastError } from './core/errors.js';
export type { ExitCodeValue } from './core/errors.js';
