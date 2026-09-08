import { effectivePermissions, StepcastError } from '../../plugin.js';
import type {
  AgentInvocation,
  BackendAdapter,
  BackendConfig,
  BackendEvent,
  BackendRefusal,
  BackendRefusalClass,
  LaunchSpec,
  McpServer,
  McpServers,
  Usage,
} from '../../plugin.js';

/**
 * Адаптер Codex CLI (`codex exec`).
 *
 * Плагин пакета, а не встроенный вклад: берёт только публичную поверхность
 * `stepcast/plugin` — это стерегут `test/plugin-surface.test.ts` и правило
 * линта. Флаги и форма потока сверены с `codex-cli 0.149.0` и записями в
 * `test/fixtures/codex/`; документ изменения — `openspec/changes/
 * codex-backend-adapter/design.md`.
 *
 * Идентификатор нити выдаёт сам CLI и сообщает первой записью потока
 * (`thread.started`), поэтому `sessionIdSource: 'backend'`; продолжение —
 * отдельной формой команды `codex exec resume <id>`.
 */

/** Словарь режимов песочницы CLI — и ровно он принимается в `permissions.mode`. */
export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const;

export function createCodexAdapter(config: BackendConfig): BackendAdapter {
  return {
    name: 'codex',
    capabilities: {
      sessions: config.sessions,
      structuredOutput: config.structuredOutput,
      strictPermissions: config.strictPermissions,
      mcp: config.mcp,
      sessionIdSource: 'backend',
    },

    launch(invocation: AgentInvocation): LaunchSpec {
      // У формы `resume` нет `-s`, `-C` и `--add-dir`, поэтому всё, что можно,
      // передаётся переопределением `-c` — одинаково для новой нити и для
      // продолжения (design.md, решение 2). Рабочий каталог задаёт движок
      // процессом, `-C` не нужен.
      const resume = invocation.resumeSession && invocation.sessionId !== undefined && config.sessions;
      const command: string[] = resume
        ? [config.command, 'exec', 'resume', invocation.sessionId as string]
        : [config.command, 'exec'];
      // `--skip-git-repo-check`: режим `copy` даёт дерево без `.git`, и без
      // флага CLI отказывает ещё до промпта.
      command.push('--json', '--skip-git-repo-check');

      const model = invocation.model ?? config.defaultModel;
      if (model !== undefined) command.push('-m', model);

      if (invocation.outputSchemaPath !== undefined && config.structuredOutput) {
        command.push('--output-schema', invocation.outputSchemaPath);
      }

      // Неинтерактивный запуск не ждёт подтверждений: у CLI это отдельная
      // политика, и её умолчание берётся из пользовательской конфигурации.
      command.push('-c', `approval_policy=${tomlString('never')}`);

      const permissions = effectivePermissions(invocation.permissions, config.permissions);
      if (permissions !== undefined) {
        // Что перевести нельзя — отказ до запуска процесса, а не молчаливое
        // исполнение шире объявленного (спека agent-backend, «Объявленная
        // политика доступа либо исполняется, либо отказывает»).
        if (permissions.enforce === 'strict') {
          throw new StepcastError('Бэкенд codex не умеет применять enforce: strict', {
            hint: 'У Codex нет ни пооперационного запрета, ни отсечения чужих MCP-серверов; уберите enforce или возьмите бэкенд с strict_permissions',
          });
        }
        const lists = [
          ...(permissions.allow?.length ? [`allow: ${permissions.allow.join(', ')}`] : []),
          ...(permissions.deny?.length ? [`deny: ${permissions.deny.join(', ')}`] : []),
        ];
        if (lists.length > 0) {
          throw new StepcastError(`Бэкенд codex не умеет пооперационных списков доступа (${lists.join('; ')})`, {
            hint: `У Codex доступ задаётся режимом песочницы: permissions.mode ∈ ${SANDBOX_MODES.join(' | ')}. Уберите allow/deny у шага, работы или в backends.codex.permissions`,
          });
        }
        if (permissions.mode !== undefined) {
          if (!(SANDBOX_MODES as readonly string[]).includes(permissions.mode)) {
            throw new StepcastError(`Бэкенд codex не знает режима доступа ${permissions.mode}`, {
              hint: `Допустимые значения permissions.mode для codex: ${SANDBOX_MODES.join(', ')}`,
            });
          }
          command.push('-c', `sandbox_mode=${tomlString(permissions.mode)}`);
        }
      }

      if (invocation.mcpServers !== undefined && config.mcp) {
        command.push(...mcpOverrides(invocation.mcpServers));
      }

      // `-` — промпт со stdin: контекст легко перерастает предел аргументов.
      command.push('-');
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

      switch (record.type) {
        case 'thread.started':
          // Одна запись — и начало разговора, и единственное место, где
          // назван идентификатор нити; состав серверов поток не сообщает,
          // поэтому `mcpServers` нет (сличения не будет, design.md, решение 6).
          return {
            kind: 'init',
            data: record,
            ...(typeof record.thread_id === 'string' ? { sessionId: record.thread_id } : {}),
          };
        case 'item.completed':
          return completedItem(record.item);
        case 'turn.completed':
          return { kind: 'usage', usage: readUsage(record.usage) };
        case 'turn.failed':
          return failure((record.error as Record<string, unknown> | undefined)?.message);
        case 'error':
          return failure(record.message);
        default:
          // `turn.started`, `item.started`, `item.updated` и незнакомые записи
          // будущих версий: пропуск, а не отказ — контракт `parseLine`.
          return { kind: 'ignored' };
      }
    },
  };
}

/** Строка в форме TOML для `-c key=value`: JSON-строка — законная basic string TOML. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** Массив строк — тоже совпадает с JSON. */
function tomlArray(values: readonly string[]): string {
  return JSON.stringify(values);
}

/** Плоская таблица строк: у TOML `=` вместо `:`, ключи в кавычках допустимы. */
function tomlTable(entries: Readonly<Record<string, string>>): string {
  const body = Object.entries(entries)
    .map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`)
    .join(', ');
  return `{ ${body} }`;
}

/** Сегмент ключа: голый, если CLI примет его голым, иначе в кавычках. */
function tomlKey(segment: string): string {
  return /^[A-Za-z0-9_-]+$/.test(segment) ? segment : tomlString(segment);
}

/**
 * Объявление серверов — переопределениями `mcp_servers.<имя>.*` конфигурации
 * CLI: у `codex exec` нет флага с файлом конфигурации серверов, а `-c`
 * принимает любой её ключ. Форма ключей — из `config.toml` Codex; проверена
 * записью `test/fixtures/codex/mcp.jsonl`.
 */
function mcpOverrides(servers: McpServers): string[] {
  const out: string[] = [];
  for (const [name, server] of Object.entries(servers)) {
    const prefix = `mcp_servers.${tomlKey(name)}`;
    for (const [key, value] of mcpServerEntries(server)) out.push('-c', `${prefix}.${key}=${value}`);
  }
  return out;
}

function mcpServerEntries(server: McpServer): Array<readonly [string, string]> {
  if ('command' in server) {
    const [command, ...args] = server.command;
    return [
      ['command', tomlString(command ?? '')],
      ...(args.length === 0 ? [] : [['args', tomlArray(args)] as const]),
      ...(server.env === undefined ? [] : [['env', tomlTable(server.env)] as const]),
    ];
  }
  return [
    ['url', tomlString(server.url)],
    ...(server.headers === undefined ? [] : [['http_headers', tomlTable(server.headers)] as const]),
  ];
}

/**
 * Завершённая запись потока. Событие отдаётся на `item.completed`, не на
 * `item.started`: у части типов начала нет вовсе, а двойной учёт одного
 * вызова дал бы лишний `tool_use` (design.md, решение 7).
 */
function completedItem(raw: unknown): BackendEvent {
  if (typeof raw !== 'object' || raw === null) return { kind: 'ignored' };
  const item = raw as Record<string, unknown>;

  switch (item.type) {
    case 'agent_message': {
      // Отдельного поля структурированного вывода нет: при `--output-schema`
      // CLI пишет JSON текстом сообщения. Адаптер не знает, была ли схема
      // запрошена, и разбирает всегда; движок пишет `output.json` только у
      // шага со схемой и берёт последнее сообщение (design.md, решение 3).
      const text = typeof item.text === 'string' ? item.text : undefined;
      const structured = text === undefined ? undefined : parseStructured(text);
      return {
        kind: 'result',
        ...(text === undefined ? {} : { text }),
        ...(structured === undefined ? {} : { structured }),
      };
    }
    case 'mcp_tool_call': {
      // Та же форма имени, что и у Claude Code: `mcp__<сервер>__<инструмент>`
      // — она названа общей в docs/pipeline-format.md.
      const server = typeof item.server === 'string' ? item.server : '?';
      const tool = typeof item.tool === 'string' ? item.tool : '?';
      return { kind: 'tool_use', name: `mcp__${server}__${tool}`, input: item.arguments };
    }
    case 'command_execution':
    case 'file_change':
    case 'web_search':
    case 'collab_tool_call': {
      // Вывод команды — не вход вызова и раздувал бы `step.json`.
      const { aggregated_output: _output, ...input } = item;
      return { kind: 'tool_use', name: item.type, input };
    }
    default:
      // `reasoning`, `todo_list` и предупреждения `error` (в записи —
      // неизвестные метаданные модели) на исход шага не влияют.
      return { kind: 'ignored' };
  }
}

function parseStructured(text: string): unknown {
  const candidate = text.trim();
  if (!candidate.startsWith('{') && !candidate.startsWith('[')) return undefined;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Расход турна — один раз, по его завершении. У OpenAI `input_tokens`
 * включает `cached_input_tokens`, а движок считает трафик как `tokens_in +
 * cache_read × вес`; без вычета кеш считался бы дважды (design.md, решение 4).
 * `reasoning_output_tokens` уже входят в `output_tokens`. Стоимости и окон
 * лимитов поток не несёт — поля остаются несообщёнными.
 */
function readUsage(raw: unknown): Partial<Usage> {
  if (typeof raw !== 'object' || raw === null) return {};
  const source = raw as Record<string, unknown>;
  const num = (key: string): number | undefined =>
    typeof source[key] === 'number' ? (source[key] as number) : undefined;

  const input = num('input_tokens');
  const cached = num('cached_input_tokens');
  const written = num('cache_write_input_tokens');
  const output = num('output_tokens');

  return {
    ...(input === undefined ? {} : { tokens_in: Math.max(0, input - (cached ?? 0)) }),
    ...(cached === undefined ? {} : { cache_read: cached }),
    ...(written === undefined ? {} : { cache_write: written }),
    ...(output === undefined ? {} : { tokens_out: output }),
  };
}

/**
 * Отказ турна. Сообщение CLI — строка, внутри которой JSON ответа API вида
 * `{"type":"error","status":429,"error":{"type":…,"message":…}}`; класс решает
 * код, а формулировка смотрится только когда кода нет (design.md, решение 5).
 * Код, не входящий в узнаваемые, — отказ без класса: бэкенд его назвал, и
 * угадывать поверх названного нельзя.
 */
function failure(rawMessage: unknown): BackendEvent {
  const message = typeof rawMessage === 'string' ? rawMessage : JSON.stringify(rawMessage ?? null);
  const refusal = readRefusal(message);
  return { kind: 'result', text: message, failed: true, ...(refusal === undefined ? {} : { refusal }) };
}

function readRefusal(message: string): BackendRefusal | undefined {
  const parsed = parseApiError(message);
  const statusCode = parsed?.status;
  const refusalClass = classifyRefusal(statusCode, parsed?.text ?? message);
  if (refusalClass === undefined) return undefined;

  const resetAt = refusalClass === 'rate_limit' ? parsed?.resetAt : undefined;
  return {
    class: refusalClass,
    message,
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(resetAt === undefined ? {} : { resetAt }),
  };
}

interface ApiError {
  readonly status?: number;
  readonly text?: string;
  readonly resetAt?: number;
}

function parseApiError(message: string): ApiError | undefined {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(message) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (typeof record !== 'object' || record === null) return undefined;

  const error = (typeof record.error === 'object' && record.error !== null ? record.error : {}) as Record<
    string,
    unknown
  >;
  const status = typeof record.status === 'number' ? record.status : undefined;
  const text = typeof error.message === 'string' ? error.message : undefined;
  return {
    ...(status === undefined ? {} : { status }),
    ...(text === undefined ? {} : { text }),
    ...readResetAt(error) ?? {},
  };
}

/**
 * Момент сброса — только из полей ответа, если они есть. Живой записи 429 у
 * ChatGPT-аккаунта нет (см. README фикстур), поэтому распознаются две
 * очевидные формы и ничего сверх: `resets_at` (секунды эпохи либо ISO 8601) и
 * `resets_in_seconds`.
 */
function readResetAt(error: Record<string, unknown>): { resetAt: number } | undefined {
  const at = error.resets_at;
  if (typeof at === 'number') return { resetAt: at < 1e12 ? at * 1000 : at };
  if (typeof at === 'string') {
    const parsed = Date.parse(at);
    if (!Number.isNaN(parsed)) return { resetAt: parsed };
  }
  const inSeconds = error.resets_in_seconds;
  if (typeof inSeconds === 'number') return { resetAt: Date.now() + inSeconds * 1000 };
  return undefined;
}

function classifyRefusal(statusCode: number | undefined, text: string): BackendRefusalClass | undefined {
  if (statusCode !== undefined) {
    if (statusCode === 429) return 'rate_limit';
    if (statusCode === 401 || statusCode === 403) return 'unauthenticated';
    return undefined;
  }
  // Закрытый перечень формулировок — расширять его по весу равно смене кодов возврата.
  if (/rate limit|usage limit|quota/i.test(text)) return 'rate_limit';
  if (/unauthorized|not logged in|authentication/i.test(text)) return 'unauthenticated';
  return undefined;
}
