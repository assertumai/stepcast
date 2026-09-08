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
  LintSite,
  LoadedPlugin,
  PluginDiagnostic,
  PredicateContribution,
  StepcastPlugin,
} from './core/plugins/contract.js';

export type { CliIo, CommandSpec, FlagKind, FlagSpec, ParsedArgs } from './core/plugins/cli-types.js';

export type {
  AgentInvocation,
  BackendAdapter,
  BackendCapabilities,
  BackendEvent,
  BackendRefusal,
  BackendRefusalClass,
  LaunchSpec,
  PermissionDenial,
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
