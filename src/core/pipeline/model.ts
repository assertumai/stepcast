/**
 * Раскрытая модель пайплайна: то, что получается после подстановок, раскрытия
 * `uses` и применения умолчаний. Дальше по конвейеру движок работает только с
 * ней и никогда не возвращается к исходным документам.
 */

export type WorkspaceMode = 'cwd' | 'worktree' | 'copy';

export interface Workspace {
  readonly mode: WorkspaceMode;
  readonly path?: string;
  /**
   * Источник наследования рабочего дерева: идентификатор работы-зависимости
   * либо `none`. Осмыслен только на работе, только в изолирующем режиме, и
   * только при нескольких зависимостях — при одной источник очевиден.
   */
  readonly inherit?: string;
}

export interface Budget {
  readonly tokens?: number;
  readonly costMicroUsd?: number;
  readonly wallclockMs?: number;
  readonly rateLimitPct?: number;
  /** Действующее значение: умолчание `stop` уже применено. */
  readonly onExceed: 'wait' | 'stop';
  /**
   * Значение, написанное в документе, — без умолчания. Нужно там, где режим
   * ищется у ближайшей объявившей его области: бюджет без `on_exceed` не
   * должен перекрывать режим внешней области своим умолчанием.
   */
  readonly declaredOnExceed?: 'wait' | 'stop';
}

export type ContextMode = 'inline' | 'reference' | 'auto';

export type ContextEntry =
  | { readonly kind: 'path'; readonly path: string; readonly mode: ContextMode }
  | { readonly kind: 'text'; readonly text: string };

export type ContextUpstream = 'all' | 'none' | readonly string[];

export type Predicate =
  | { readonly kind: 'exit_code'; readonly value: number }
  | { readonly kind: 'file_exists'; readonly path: string }
  | { readonly kind: 'schema'; readonly path: string }
  | { readonly kind: 'matches'; readonly pattern: string }
  | { readonly kind: 'not_matches'; readonly pattern: string }
  | { readonly kind: 'changed_only'; readonly globs: readonly string[] }
  | { readonly kind: 'cmd'; readonly command: string }
  | {
      readonly kind: 'judge';
      readonly claim: string;
      readonly hard: boolean;
      readonly agent?: string;
      readonly model?: string;
    };

export interface EscalationStep {
  readonly includeFailure: boolean;
  readonly model?: string;
}

export interface Attempts {
  readonly max: number;
  readonly escalation: readonly EscalationStep[];
}

export interface StepCommon {
  readonly id: string;
  /** Позиция шага в работе, с 1. Задаёт числовой префикс каталога в журнале. */
  readonly index: number;
  readonly env: Readonly<Record<string, string>>;
  readonly context: readonly ContextEntry[];
  readonly contextInherit: boolean;
  readonly contextExclude: readonly string[];
  readonly contextMaxTokens?: number;
  readonly timeoutMs: number;
  readonly budget?: Budget;
  readonly expect: readonly Predicate[];
  readonly attempts: Attempts;
}

export interface Permissions {
  readonly mode?: string;
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
}

export interface AgentStep extends StepCommon {
  readonly kind: 'agent';
  readonly agent: string;
  readonly model?: string;
  /** Псевдоним сессии. Шаги с одинаковым псевдонимом продолжают один диалог. */
  readonly session: string;
  /** Текст промпта, уже прочитанный из файла и раскрытый. */
  readonly prompt: string;
  /** Откуда прочитан промпт — для диагностики. */
  readonly promptSource?: string;
  readonly outputSchemaPath?: string;
  readonly permissions?: Permissions;
}

export interface RunStep extends StepCommon {
  readonly kind: 'run';
  /** Список argv либо строка для оболочки. */
  readonly command: readonly string[] | string;
  readonly onFail?: { readonly analyze: string; readonly prompt: string };
}

export type Step = AgentStep | RunStep;

export interface JobOutput {
  readonly from?: string;
  readonly schemaPath?: string;
}

export interface Until {
  readonly maxIterations: number;
  readonly check: readonly Predicate[];
}

export type NeedsAll = 'all';

export interface Job {
  readonly id: string;
  readonly description?: string;
  /** Файл, из которого пришло определение. Нужен для разрешения путей и ошибок. */
  readonly source: string;
  readonly needs: readonly string[] | NeedsAll;
  readonly on: 'success' | 'failure' | 'always';
  readonly if?: string;
  readonly session: 'shared' | 'per_step';
  readonly workspace: Workspace;
  readonly env: Readonly<Record<string, string>>;
  readonly context: readonly ContextEntry[];
  readonly contextUpstream: ContextUpstream;
  readonly output?: JobOutput;
  /**
   * Объявленные входы работы. Пусто — отпечаток считается по всему дереву;
   * заполнено — только по этим путям, и пропущенный файл означает пропущенную
   * инвалидацию.
   */
  readonly inputs: readonly string[];
  readonly budget?: Budget;
  readonly until?: Until;
  readonly steps: readonly Step[];
}

/**
 * Одна запись расписания: cron-выражение и необязательный часовой пояс.
 *
 * `cron` может отсутствовать: незаполненную запись ловит линт, называя её
 * номер, — схема о ней молчит намеренно (см. `ScheduleTriggerEntrySchema`).
 */
export interface ScheduleTrigger {
  readonly cron?: string;
  readonly timezone?: string;
}

/**
 * Триггеры пайплайна. Единственный признанный вид на сегодня — `schedule`;
 * ключ заведён с запасом на вторую объявленную форму запуска (GitHub).
 */
export interface Triggers {
  readonly schedule: readonly ScheduleTrigger[];
}

export interface Pipeline {
  readonly name: string;
  readonly file: string;
  readonly inputs: Readonly<Record<string, string | number | boolean>>;
  readonly workspace: Workspace;
  readonly env: Readonly<Record<string, string>>;
  readonly envFiles: readonly string[];
  readonly envDeny: readonly string[];
  readonly context: readonly ContextEntry[];
  readonly contextUpstream: ContextUpstream;
  readonly budget?: Budget;
  readonly concurrency: number;
  readonly failFast: boolean;
  readonly triggers?: Triggers;
  /** Порядок объявления сохраняется: он задаёт детерминированный порядок работ. */
  readonly jobs: readonly Job[];
}

/** Ссылка на подстановку, оставшуюся в значении до времени исполнения. */
export interface Substitution {
  readonly expression: string;
  readonly namespace: string;
  readonly path: string;
  readonly deferred: boolean;
}

/** Где в документе какие подстановки применялись. Ключ — точечный путь. */
export type SubstitutionMap = ReadonlyMap<string, readonly Substitution[]>;

export interface ExpandedPipeline {
  readonly pipeline: Pipeline;
  readonly substitutions: SubstitutionMap;
}

/** Файлы, из которых собрано определение прогона: пайплайн и работы. */
export function definitionFiles(pipeline: Pipeline): readonly string[] {
  return [...new Set([pipeline.file, ...pipeline.jobs.map((job) => job.source)])];
}
