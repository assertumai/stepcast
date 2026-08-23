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
    permissions: undefined,
    env: {},
  });

  const adapter: BackendAdapter = {
    name: 'fake',
    capabilities: {
      sessions: options.capabilities?.sessions ?? true,
      structuredOutput: options.capabilities?.structuredOutput ?? true,
    },
    launch(invocation): LaunchSpec {
      const index = invocations.length;
      invocations.push(invocation);
      // Печатаем заготовленный поток и выходим с заданным кодом: движок
      // работает с настоящим процессом, но без настоящей модели.
      const lines = typeof options.lines === 'function' ? options.lines(index) : options.lines;
      const script = lines.map((line) => `printf '%s\\n' ${shellQuote(line)}`).join('\n');
      // `sleep` реагирует на SIGTERM сам — этого достаточно, чтобы проверить
      // прерывание по таймауту без настоящего висящего процесса.
      const hang = options.hangMs === undefined ? '' : `sleep ${options.hangMs / 1000}\n`;
      return {
        command: ['sh', '-c', `${script}\n${hang}exit ${options.exitCode ?? 0}`],
        stdin: invocation.prompt,
      };
    },
    parseLine: (line) => parser.parseLine(line),
  };

  return { adapter, invocations };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Готовая строка результата с расходом — самый частый случай в тестах. */
export function resultLine(options: {
  readonly text?: string;
  readonly structured?: unknown;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  /** Окна лимитов подписки: имя окна → процент и, опционально, момент сброса. */
  readonly rateLimits?: Readonly<Record<string, { readonly usedPct: number; readonly resetsAt?: number }>>;
}): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    ...(options.text === undefined ? {} : { result: options.text }),
    ...(options.structured === undefined ? {} : { structured_output: options.structured }),
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

export function initLine(data: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'system', subtype: 'init', ...data });
}

export function toolUseLine(name: string, input: unknown): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name, input }] },
  });
}
