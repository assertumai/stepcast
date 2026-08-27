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

/**
 * Неустранимый отказ бэкенда: упор в окно лимита подписки или отказ
 * аутентификации. Классов ровно два — большего перечень намеренно не несёт,
 * потому что остальное движок обрабатывает как обычный отказ шага.
 */
export type BackendRefusalClass = 'rate_limit' | 'unauthenticated';

export interface BackendRefusal {
  readonly class: BackendRefusalClass;
  /** Сообщение бэкенда как есть, без пересказа: причина шага должно быть его показывать. */
  readonly message: string;
  /** Код состояния ответа, если бэкенд его назвал. */
  readonly statusCode?: number;
  /** Разобранный момент сброса окна лимита, миллисекунды эпохи. */
  readonly resetAt?: number;
}

export type BackendEvent =
  | { readonly kind: 'init'; readonly data: Record<string, unknown> }
  | {
      readonly kind: 'tool_use';
      readonly name: string;
      readonly input: unknown;
      /** Claude attaches usage to the same assistant message as the tool call. */
      readonly usage?: Partial<Usage>;
      /** Stable within duplicate stream records of one Claude model turn. */
      readonly messageId?: string;
    }
  | { readonly kind: 'usage'; readonly usage: Partial<Usage>; readonly messageId?: string }
  | {
      readonly kind: 'result';
      readonly text?: string;
      readonly structured?: unknown;
      readonly usage?: Partial<Usage>;
      readonly failed?: boolean;
      readonly refusal?: BackendRefusal;
    }
  | { readonly kind: 'unparsed'; readonly line: string }
  | { readonly kind: 'ignored' };

/** Имя предиката, которым отказ бэкенда попадает в результаты предикатов. */
export const BACKEND_REFUSAL_PREDICATE = 'backend_refusal';

/**
 * Человекочитаемая причина отказа — одна на все места, где отказ виден
 * пользователю: запись попытки, причина шага и работы, вывод `stepcast
 * status`. Способ починки живёт здесь же: иначе он доходит только до той
 * записи, где его написали, а до остальных — нет.
 */
export function describeRefusal(refusal: BackendRefusal): string {
  if (refusal.class === 'unauthenticated') {
    return `отказ аутентификации бэкенда: ${refusal.message}. Обновите аутентификацию бэкенда и возобновите прогон командой stepcast resume.`;
  }
  const resets =
    refusal.resetAt === undefined ? '' : `; окно сбросится ${new Date(refusal.resetAt).toISOString()}`;
  return `упор в окно лимита подписки бэкенда: ${refusal.message}${resets}`;
}

/**
 * Достать классификацию отказа из результатов предикатов попытки. Работает
 * одинаково для отказа самого шага и отказа судьи внутри него: оба кладут
 * классификацию в `actual` записи с этим именем предиката.
 */
export function extractRefusal(
  results: readonly { readonly predicate: string; readonly actual?: unknown }[],
): BackendRefusal | undefined {
  const found = results.find((item) => item.predicate === BACKEND_REFUSAL_PREDICATE);
  return found?.actual as BackendRefusal | undefined;
}

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

/**
 * Слить частичные сведения о расходе, не подменяя отсутствующее нулём.
 *
 * `peak_prefix_tokens` — исключение из общего правила «патч перезаписывает
 * поле»: он копится максимумом, а не последним значением. Итоговая запись
 * `result` бэкенда не несёт пика вовсе (его считает только код движка), но
 * если когда-нибудь понесёт — меньшее значение не должно затереть уже
 * накопленный больший пик попытки.
 */
export function mergeUsage(base: Usage, patch: Partial<Usage> | undefined): Usage {
  if (patch === undefined) return base;
  const out: Usage = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key === 'peak_prefix_tokens') {
      out.peak_prefix_tokens = maxOptional(base.peak_prefix_tokens, value as number);
      continue;
    }
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
  const cost = sumOptional(base.reported_cost_usd, addition.reported_cost_usd);
  const peak = maxOptional(base.peak_prefix_tokens, addition.peak_prefix_tokens);
  return {
    backend: base.backend,
    ...(base.model === undefined ? {} : { model: base.model }),
    tokens_in: sumNullable(base.tokens_in, addition.tokens_in),
    tokens_out: sumNullable(base.tokens_out, addition.tokens_out),
    cache_read: sumNullable(base.cache_read, addition.cache_read),
    cache_write: sumNullable(base.cache_write, addition.cache_write),
    wallclock_ms: base.wallclock_ms + addition.wallclock_ms,
    ...(cost === undefined ? {} : { reported_cost_usd: cost }),
    // Пик — максимум одного обращения, а не сумма: два независимых вызова
    // (шаг и вызванный им судья) не складывают своих префиксов.
    ...(peak === undefined ? {} : { peak_prefix_tokens: peak }),
    // rate_limits намеренно не складывается: у окна лимитов нечего суммировать
    // — значение последнего сообщения и есть текущее состояние окна.
  };
}

function sumNullable(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

/** Как `sumNullable`, но для необязательного поля (не сообщено — undefined, а не null). */
function sumOptional(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

/** Максимум двух необязательных величин: несообщённое не участвует и не выигрывает как ноль. */
function maxOptional(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

/**
 * Объём одного обращения к API — сумма `tokens_in + cache_read + cache_write`
 * той дельты, что бэкенд сообщил для одного сообщения потока. Отсутствует,
 * если ни одно из трёх полей не пришло: считать пик нулём в этом случае
 * означало бы выдать отсутствие данных за факт маленького обращения.
 */
export function messagePrefix(delta: Partial<Usage> | undefined): number | undefined {
  if (delta === undefined) return undefined;
  const { tokens_in, cache_read, cache_write } = delta;
  if (tokens_in == null && cache_read == null && cache_write == null) return undefined;
  return (tokens_in ?? 0) + (cache_read ?? 0) + (cache_write ?? 0);
}
