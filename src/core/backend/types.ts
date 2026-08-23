import type { Permissions } from '../pipeline/model.js';
import type { Usage } from '../journal/schema.js';

/**
 * Контракт адаптера агентского бэкенда.
 *
 * Ни одна строка движка не знает про флаги конкретного CLI. Это не чистота
 * ради чистоты: если флаги протекут наружу, поддержка второго бэкенда
 * превратится в ветвления по всему коду.
 */

export interface BackendCapabilities {
  /** Умеет продолжать сессию по идентификатору. */
  readonly sessions: boolean;
  /** Умеет отдавать структурированный вывод по переданной схеме. */
  readonly structuredOutput: boolean;
}

export interface AgentInvocation {
  readonly prompt: string;
  readonly cwd: string;
  readonly model?: string;
  readonly sessionId?: string;
  /** true — продолжить существующую сессию, false — начать с этим идентификатором. */
  readonly resumeSession: boolean;
  readonly outputSchemaPath?: string;
  readonly permissions?: Permissions;
}

export interface LaunchSpec {
  readonly command: readonly string[];
  /** Промпт уходит через stdin: контекст легко перерастает предел аргументов. */
  readonly stdin: string;
  readonly env?: Readonly<Record<string, string>>;
}

export type BackendEvent =
  | { readonly kind: 'init'; readonly data: Record<string, unknown> }
  | { readonly kind: 'tool_use'; readonly name: string; readonly input: unknown }
  | { readonly kind: 'usage'; readonly usage: Partial<Usage> }
  | {
      readonly kind: 'result';
      readonly text?: string;
      readonly structured?: unknown;
      readonly usage?: Partial<Usage>;
      readonly failed?: boolean;
    }
  | { readonly kind: 'unparsed'; readonly line: string }
  | { readonly kind: 'ignored' };

export interface BackendAdapter {
  readonly name: string;
  readonly capabilities: BackendCapabilities;
  /** Собрать запуск. Здесь и только здесь живут флаги конкретного CLI. */
  launch(invocation: AgentInvocation): LaunchSpec;
  /**
   * Разобрать одну строку потока. Неизвестная запись возвращает `ignored`,
   * неразбираемая — `unparsed`: бэкенды обновляются сами и добавляют поля,
   * и падать от нового поля недопустимо.
   */
  parseLine(line: string): BackendEvent;
}

/** Пустой расход: несообщаемые поля остаются null, а не нулём. */
export function emptyUsage(backend: string, model: string | undefined, wallclockMs: number): Usage {
  return {
    backend,
    ...(model === undefined ? {} : { model }),
    tokens_in: null,
    tokens_out: null,
    cache_read: null,
    cache_write: null,
    wallclock_ms: wallclockMs,
  };
}

/** Слить частичные сведения о расходе, не подменяя отсутствующее нулём. */
export function mergeUsage(base: Usage, patch: Partial<Usage> | undefined): Usage {
  if (patch === undefined) return base;
  const out: Usage = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/**
 * Сложить расход двух независимых вызовов — шага и вызванного им судьи.
 * В отличие от `mergeUsage` (патч поверх того же потока), здесь складываются
 * показания двух разных процессов: несообщаемое поле остаётся несообщаемым,
 * только если оно таким было у обоих, иначе за него считается то, что есть.
 */
export function sumUsage(base: Usage, addition: Usage): Usage {
  return {
    backend: base.backend,
    ...(base.model === undefined ? {} : { model: base.model }),
    tokens_in: sumNullable(base.tokens_in, addition.tokens_in),
    tokens_out: sumNullable(base.tokens_out, addition.tokens_out),
    cache_read: sumNullable(base.cache_read, addition.cache_read),
    cache_write: sumNullable(base.cache_write, addition.cache_write),
    wallclock_ms: base.wallclock_ms + addition.wallclock_ms,
  };
}

function sumNullable(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}
