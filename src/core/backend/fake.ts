import type { AgentInvocation, BackendAdapter, BackendCapabilities, LaunchSpec } from './types.js';
import { createClaudeAdapter } from './claude.js';

/**
 * Поддельный бэкенд для быстрых тестов.
 *
 * Настоящий CLI в тестах не нужен почти нигде: важно поведение движка вокруг
 * него — сессии, попытки, контекст, учёт расхода. Живые прогоны остаются
 * отдельной, намеренно небольшой группой тестов.
 */
export interface FakeBackendOptions {
  readonly capabilities?: Partial<BackendCapabilities>;
  /**
   * Строки потока, которые «выдаст» бэкенд. Разбираются как у Claude Code.
   * Функцией — чтобы различить переисполнение шага (например, после
   * ожидания сброса окна лимита) от первого запуска: аргумент — номер
   * запуска этого бэкенда, с нуля.
   */
  readonly lines: readonly string[] | ((invocationIndex: number) => readonly string[]);
  readonly exitCode?: number;
  /** Не завершаться самостоятельно это время — для проверки прерывания по таймауту. */
  readonly hangMs?: number;
}

export interface FakeBackend {
  readonly adapter: BackendAdapter;
  /** Запуски, которые запросил движок, — для проверки собранной команды. */
  readonly invocations: AgentInvocation[];
}

export function createFakeBackend(options: FakeBackendOptions): FakeBackend {
  const invocations: AgentInvocation[] = [];
  const parser = createClaudeAdapter({
    command: 'фиктивный',
    enabled: true,
    defaultModel: undefined,
    concurrency: 1,
    cacheReadWeight: 0.1,
    sessions: true,
    structuredOutput: true,
    strictPermissions: true,
    permissions: undefined,
    env: {},
  });

  const adapter: BackendAdapter = {
    name: 'fake',
    capabilities: {
      sessions: options.capabilities?.sessions ?? true,
      structuredOutput: options.capabilities?.structuredOutput ?? true,
      strictPermissions: options.capabilities?.strictPermissions ?? true,
    },
    launch(invocation): LaunchSpec {
      const index = invocations.length;
      invocations.push(invocation);
      // Печатаем заготовленный поток и выходим с заданным кодом: движок
      // работает с настоящим процессом, но без настоящей модели.
      const lines = typeof options.lines === 'function' ? options.lines(index) : options.lines;
      // Вывод уходит до зависания, а не вместе с ним. Прежде строки печатал
      // `sh`, чей builtin буферизует запись в трубу: до движка они доходили
      // лишь при выходе процесса, и проверка прерывания на середине зависела
      // от того, успел ли буфер наполниться. Обратный вызов `write` даёт
      // гарантию — таймер зависания заводится только после того, как данные
      // отданы в трубу.
      const payload = JSON.stringify(lines.map((line) => `${line}\n`).join(''));
      // Узел завершается по SIGTERM умолчательным обработчиком — этого
      // достаточно, чтобы проверить прерывание без настоящего висящего
      // процесса.
      const script = `process.stdout.write(${payload}, () => setTimeout(() => process.exit(${options.exitCode ?? 0}), ${options.hangMs ?? 0}));`;
      return {
        command: [process.execPath, '-e', script],
        stdin: invocation.prompt,
      };
    },
    parseLine: (line) => parser.parseLine(line),
  };

  return { adapter, invocations };
}

/** Готовая строка результата с расходом — самый частый случай в тестах. */
export function resultLine(options: {
  readonly text?: string;
  readonly structured?: unknown;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  /** Долларов США — тем же полем, каким его сообщает настоящий Claude Code. */
  readonly costUsd?: number;
  /** Окна лимитов подписки: имя окна → процент и, опционально, момент сброса. */
  readonly rateLimits?: Readonly<Record<string, { readonly usedPct: number; readonly resetsAt?: number }>>;
  /** Отказы в разрешении, как их сообщает конверт результата Claude Code. */
  readonly permissionDenials?: readonly { readonly tool: string; readonly input?: unknown }[];
}): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    ...(options.text === undefined ? {} : { result: options.text }),
    ...(options.structured === undefined ? {} : { structured_output: options.structured }),
    ...(options.costUsd === undefined ? {} : { total_cost_usd: options.costUsd }),
    ...(options.permissionDenials === undefined
      ? {}
      : {
          permission_denials: options.permissionDenials.map((item) => ({
            tool_name: item.tool,
            tool_input: item.input,
          })),
        }),
    usage: {
      ...(options.tokensIn === undefined ? {} : { input_tokens: options.tokensIn }),
      ...(options.tokensOut === undefined ? {} : { output_tokens: options.tokensOut }),
      ...(options.cacheRead === undefined ? {} : { cache_read_input_tokens: options.cacheRead }),
      ...(options.cacheWrite === undefined
        ? {}
        : { cache_creation_input_tokens: options.cacheWrite }),
    },
    ...(options.rateLimits === undefined
      ? {}
      : {
          rate_limits: Object.fromEntries(
            Object.entries(options.rateLimits).map(([window, value]) => [
              window,
              {
                used_percentage: value.usedPct,
                ...(value.resetsAt === undefined ? {} : { resets_at: value.resetsAt }),
              },
            ]),
          ),
        }),
  });
}

/**
 * Конверт отказа по лимиту подписки — та же форма, что настоящий Claude Code
 * вернул в прогоне 2dc340: `is_error`, `api_error_status`, `terminal_reason`
 * и текст с моментом сброса.
 */
export function rateLimitRefusalLine(
  options: {
    readonly resetText?: string;
    readonly tokensIn?: number;
    readonly tokensOut?: number;
  } = {},
): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: true,
    api_error_status: 429,
    terminal_reason: 'api_error',
    result: `You've hit your session limit · ${options.resetText ?? 'resets 11pm (Asia/Nicosia)'}`,
    usage: {
      ...(options.tokensIn === undefined ? {} : { input_tokens: options.tokensIn }),
      ...(options.tokensOut === undefined ? {} : { output_tokens: options.tokensOut }),
    },
  });
}

/**
 * Конверт отказа аутентификации — та же форма, что прогон 18f9fc: без кода
 * состояния (`api_error_status: null`), класс различим только по тексту.
 */
export function authRefusalLine(): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: true,
    api_error_status: null,
    terminal_reason: 'api_error',
    result: 'Failed to authenticate: OAuth session expired and could not be refreshed',
  });
}

export function initLine(data: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'system', subtype: 'init', ...data });
}

export function toolUseLine(name: string, input: unknown): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name, input }] },
  });
}
