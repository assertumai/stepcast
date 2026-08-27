import { readFileSync } from 'node:fs';

import type { BackendConfig } from '../config/resolve.js';
import { StepcastError } from '../errors.js';
import { effectivePermissions } from './permissions.js';
import type {
  AgentInvocation,
  BackendAdapter,
  BackendEvent,
  BackendRefusal,
  BackendRefusalClass,
  LaunchSpec,
  PermissionDenial,
} from './types.js';

/**
 * Режимы, разрешающие неназванное по умолчанию. Закрытый перечень: словарь
 * режимов принадлежит бэкенду, и `enforce: strict` рядом с любым из них —
 * объявление, обе половины которого требуют противоположного.
 */
export const PERMISSIVE_MODES = ['auto', 'acceptEdits', 'dontAsk', 'bypassPermissions'] as const;

/**
 * Адаптер Claude Code.
 *
 * Запуск неинтерактивный, через каналы, с потоковым структурированным
 * выводом. Промпт уходит на stdin. Политика доступа транслируется в флаги:
 * без неё шаг упрётся в отказ на первой же записи файла, потому что
 * неинтерактивный режим разрешений не спрашивает и не выдаёт.
 */
export function createClaudeAdapter(config: BackendConfig): BackendAdapter {
  return {
    name: 'claude',
    capabilities: {
      sessions: config.sessions,
      structuredOutput: config.structuredOutput,
      strictPermissions: config.strictPermissions,
    },

    launch(invocation: AgentInvocation): LaunchSpec {
      const command = [config.command, '--print', '--output-format', 'stream-json', '--verbose'];

      const model = invocation.model ?? config.defaultModel;
      if (model !== undefined) command.push('--model', model);

      if (invocation.sessionId !== undefined && config.sessions) {
        command.push(invocation.resumeSession ? '--resume' : '--session-id', invocation.sessionId);
      }

      if (invocation.outputSchemaPath !== undefined && config.structuredOutput) {
        command.push('--json-schema', prepareSchema(invocation.outputSchemaPath));
      }

      const permissions = effectivePermissions(invocation.permissions, config.permissions);
      // Жёсткий режим — две части разом: источники настроек ограничены
      // репозиторием, а режим по умолчанию не разрешает, а отклоняет. Ни
      // одной по отдельности не хватает (см. design.md): без первой действует
      // правило пользовательского уровня, без второй разрешает сам режим.
      if (permissions?.enforce === 'strict') {
        command.push('--setting-sources', 'project');
        if (permissions.mode === undefined) command.push('--permission-mode', 'manual');
        // Каталог черновиков объявляется доступным только здесь: вне жёсткого
        // режима settings обычные, и добавлять исключение туда, где отсечения
        // ещё нет, было бы менять поведение шага, который strict не объявлял.
        if (invocation.scratchDir !== undefined) command.push('--add-dir', invocation.scratchDir);
      }
      if (permissions?.mode !== undefined) command.push('--permission-mode', permissions.mode);
      if (permissions?.allow !== undefined && permissions.allow.length > 0) {
        command.push('--allowedTools', permissions.allow.join(' '));
      }
      if (permissions?.deny !== undefined && permissions.deny.length > 0) {
        command.push('--disallowedTools', permissions.deny.join(' '));
      }

      return { command, stdin: invocation.prompt, env: config.env };
    },

    parseLine(line: string): BackendEvent {
      const trimmed = line.trim();
      if (trimmed === '') return { kind: 'ignored' };

      let record: Record<string, unknown>;
      try {
        record = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return { kind: 'unparsed', line: trimmed };
      }

      const type = record.type;

      if (type === 'system' && record.subtype === 'init') {
        return { kind: 'init', data: record };
      }

      if (type === 'assistant') {
        const message = record.message as Record<string, unknown> | undefined;
        const tool = firstToolUse(message);
        const usage = readUsage(message?.usage);
        const messageId = typeof message?.id === 'string' ? message.id : undefined;
        if (tool !== undefined) {
          return {
            ...tool,
            ...(usage === undefined ? {} : { usage }),
            ...(messageId === undefined ? {} : { messageId }),
          };
        }
        if (usage !== undefined) {
          return { kind: 'usage', usage, ...(messageId === undefined ? {} : { messageId }) };
        }
        return { kind: 'ignored' };
      }

      if (type === 'result') {
        const usage = readUsage(record.usage);
        const refusal = readRefusal(record);
        const permissionDenials = readPermissionDenials(record);
        return {
          kind: 'result',
          ...(typeof record.result === 'string' ? { text: record.result } : {}),
          ...(record.structured_output === undefined
            ? {}
            : { structured: record.structured_output }),
          ...(usage === undefined
            ? {}
            : {
                usage: {
                  ...usage,
                  ...(typeof record.total_cost_usd === 'number'
                    ? { reported_cost_usd: record.total_cost_usd }
                    : {}),
                  ...readRateLimits(record),
                },
              }),
          ...(record.is_error === true || record.subtype === 'error' ? { failed: true } : {}),
          ...(refusal === undefined ? {} : { refusal }),
          ...(permissionDenials === undefined ? {} : { permissionDenials }),
        };
      }

      return { kind: 'ignored' };
    },
  };
}

/**
 * Подготовить схему к передаче бэкенду.
 *
 * Поле `$schema` — метаданные для редакторов, а не ограничение, и валидатор
 * Claude Code отклоняет ссылку на мета-схему 2020-12. Убираем его здесь:
 * причуды конкретного CLI — забота адаптера, а не автора пайплайна, который
 * пишет схему по общему стандарту.
 */
function prepareSchema(path: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    throw new StepcastError(`Схема вывода не разбирается как JSON: ${(error as Error).message}`, {
      file: path,
      cause: error,
    });
  }

  const { $schema: _meta, ...rest } = parsed;
  return JSON.stringify(rest);
}

function firstToolUse(
  message: Record<string, unknown> | undefined,
): Extract<BackendEvent, { readonly kind: 'tool_use' }> | undefined {
  const content = message?.content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    const item = block as Record<string, unknown>;
    if (item.type === 'tool_use' && typeof item.name === 'string') {
      return { kind: 'tool_use', name: item.name, input: item.input };
    }
  }
  return undefined;
}

/** Привести расход к общему виду. Несообщённое поле остаётся отсутствующим. */
function readUsage(raw: unknown): Record<string, number> | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const source = raw as Record<string, unknown>;

  const mapping: Array<readonly [string, string]> = [
    ['input_tokens', 'tokens_in'],
    ['output_tokens', 'tokens_out'],
    ['cache_read_input_tokens', 'cache_read'],
    ['cache_creation_input_tokens', 'cache_write'],
  ];

  const out: Record<string, number> = {};
  for (const [from, to] of mapping) {
    const value = source[from];
    if (typeof value === 'number') out[to] = value;
  }

  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * Отказы в разрешении из конверта результата.
 *
 * Отсутствие поля значит «отказов не было», а не ошибку разбора: поле
 * появилось в конверте позже остальных, и старый CLI его не пишет вовсе.
 * Запись неожиданной формы (не объект, без строкового имени инструмента)
 * пропускается — один сломанный элемент не должен уронить разбор остальных.
 */
function readPermissionDenials(record: Record<string, unknown>): PermissionDenial[] | undefined {
  const raw = record.permission_denials;
  if (!Array.isArray(raw)) return undefined;

  const out: PermissionDenial[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const tool = item.tool_name ?? item.name;
    if (typeof tool !== 'string') continue;
    out.push({ tool, input: item.tool_input ?? item.input });
  }
  return out;
}

/** Окон лимитов у подписки несколько, и ночной прогон упирается в недельное. */
function readRateLimits(record: Record<string, unknown>): {
  rate_limits?: Record<string, { used_pct: number; resets_at?: number }>;
} {
  const raw = record.rate_limits;
  if (typeof raw !== 'object' || raw === null) return {};

  const out: Record<string, { used_pct: number; resets_at?: number }> = {};
  for (const [window, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const item = value as Record<string, unknown>;
    const used = item.used_percentage ?? item.used_pct;
    if (typeof used !== 'number') continue;
    out[window] = {
      used_pct: used,
      ...(typeof item.resets_at === 'number' ? { resets_at: item.resets_at } : {}),
    };
  }

  return Object.keys(out).length === 0 ? {} : { rate_limits: out };
}

/**
 * Классификация неустранимого отказа бэкенда.
 *
 * Кандидат — только запись `is_error: true`, несущая признак ошибки бэкенда:
 * код состояния ответа либо `terminal_reason: "api_error"`. Оба настоящих
 * конверта отказа (прогоны 2dc340 и 18f9fc) несут этот признак; `subtype` в
 * обоих равен `success` и в классификации не участвует.
 *
 * Перед финальной записью `result` поток может нести запись `assistant` с
 * `is_api_error_message: true` (видно в 2dc340 непосредственно перед
 * отказом) — но `is_error` у неё нет, и как кандидат она не рассматривается:
 * классифицировать есть смысл только по финальной записи.
 */
function readRefusal(record: Record<string, unknown>): BackendRefusal | undefined {
  if (record.is_error !== true) return undefined;

  const statusCode = typeof record.api_error_status === 'number' ? record.api_error_status : undefined;
  if (statusCode === undefined && record.terminal_reason !== 'api_error') return undefined;

  const message = typeof record.result === 'string' ? record.result : '';
  const refusalClass = classifyRefusal(statusCode, message);
  if (refusalClass === undefined) return undefined;

  const resetAt = refusalClass === 'rate_limit' ? parseResetAt(message) : undefined;

  return {
    class: refusalClass,
    message,
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(resetAt === undefined ? {} : { resetAt }),
  };
}

/**
 * Класс отказа сначала решает код состояния; тело ответа смотрится только
 * тогда, когда кода нет вовсе — код, не входящий в узнаваемые (429, 401,
 * 403), не классифицируется в обход текста: бэкенд его уже назвал, и
 * угадывать поверх названного нельзя.
 */
function classifyRefusal(statusCode: number | undefined, message: string): BackendRefusalClass | undefined {
  if (statusCode !== undefined) {
    if (statusCode === 429) return 'rate_limit';
    if (statusCode === 401 || statusCode === 403) return 'unauthenticated';
    return undefined;
  }

  // Закрытый перечень формулировок. Расширять его — как менять коды возврата:
  // такое же по весу решение, а не удобство разбора одного лога.
  if (/session limit|usage limit/i.test(message)) return 'rate_limit';
  if (/failed to authenticate|authentication failed|oauth session/i.test(message)) return 'unauthenticated';
  return undefined;
}

const RESET_ISO = /resets?\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/i;
const RESET_WALLCLOCK = /resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i;

/**
 * Момент сброса окна лимита из текста ответа. Распознаются ровно две формы:
 * настенное время с часовым поясом и метка ISO 8601 со смещением или `Z`.
 * Нераспознанная форма, неизвестный часовой пояс и отсутствие упоминания
 * сброса дают `undefined` — момент не угадывается.
 */
export function parseResetAt(message: string, now: number = Date.now()): number | undefined {
  const iso = RESET_ISO.exec(message);
  if (iso?.[1] !== undefined) {
    const parsed = Date.parse(iso[1]);
    // Момент в прошлом — не момент сброса: ожидание по нему длится нуль
    // миллисекунд, и прогон крутил бы «переисполнить шаг → тот же отказ»
    // без сна, а значит и без предела `defaults.max_wait`. Настенная форма
    // от этого защищена сама (разрешается в ближайшее будущее наступление).
    return Number.isNaN(parsed) || parsed <= now ? undefined : parsed;
  }

  const wall = RESET_WALLCLOCK.exec(message);
  if (wall === null) return undefined;

  const hour12 = Number(wall[1]);
  const minute = wall[2] === undefined ? 0 : Number(wall[2]);
  const meridiem = (wall[3] ?? '').toLowerCase();
  const zone = wall[4] ?? '';
  if (hour12 < 1 || hour12 > 12) return undefined;

  const hour24 = meridiem === 'pm' ? (hour12 % 12) + 12 : hour12 % 12;
  return nextOccurrenceInZone(zone, hour24, minute, now);
}

/** Ближайшее будущее наступление настенного времени в названном поясе. */
function nextOccurrenceInZone(
  zone: string,
  hour: number,
  minute: number,
  now: number,
): number | undefined {
  let today: { year: number; month: number; day: number };
  try {
    today = zonedDateParts(zone, now);
  } catch {
    // Часовой пояс не входит в базу ICU — движок его не знает так же, как не
    // знал бы пользователь, и угадывать момент сброса не вправе.
    return undefined;
  }

  const candidate = zonedTimeToUtc(zone, today.year, today.month, today.day, hour, minute);
  if (candidate > now) return candidate;

  const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
  return zonedTimeToUtc(
    zone,
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate(),
    hour,
    minute,
  );
}

function zonedDateParts(zone: string, utcMs: number): { year: number; month: number; day: number } {
  const map = formatZonedParts(zone, utcMs, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day) };
}

/** Настенное время в поясе, приведённое к моменту UTC им же. */
function zonedTimeToUtc(
  zone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  // Приближение: смещение берётся в точке-кандидате, а не в искомой. У
  // подавляющего большинства поясов оно не меняется в пределах одних суток,
  // и переход летнего времени ровно на границе часа сброса — случай,
  // которым здесь можно пренебречь.
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offsetMs = timeZoneOffsetMs(zone, guess);
  return guess - offsetMs;
}

/** Смещение пояса от UTC в момент `utcMs`, в миллисекундах — положительное к востоку. */
function timeZoneOffsetMs(zone: string, utcMs: number): number {
  const map = formatZonedParts(zone, utcMs, {
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const asIfUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second),
  );
  return asIfUtc - utcMs;
}

function formatZonedParts(
  zone: string,
  utcMs: number,
  options: Intl.DateTimeFormatOptions,
): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-US', { ...options, timeZone: zone }).formatToParts(
    new Date(utcMs),
  );
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}
