import { createWriteStream } from 'node:fs';
import { execa, type Subprocess } from 'execa';

import { createScope } from '../run/scope.js';

/**
 * Запуск дочернего процесса под надзором.
 *
 * Встроенный таймаут библиотеки не подходит: нужен мягкий сигнал с отсрочкой,
 * нужно отдельно ловить молчание при живом процессе, и нужно убивать всё
 * дерево — агент запускает собственные подпроцессы, и убийство одного
 * родителя оставляет сирот.
 */

export const DEFAULT_GRACE_MS = 30_000;

export interface ProcessOptions {
  /** Список argv исполняется без оболочки, строка — через оболочку платформы. */
  readonly command: readonly string[] | string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly stallTimeoutMs?: number;
  readonly graceMs?: number;
  readonly stdoutPath?: string;
  readonly stderrPath?: string;
  /** Текст, который уйдёт процессу на stdin. Без него stdin закрыт. */
  readonly stdin?: string;
  readonly onStdout?: (chunk: string) => void;
  readonly onStderr?: (chunk: string) => void;
  readonly onStall?: (silentMs: number) => void;
  readonly maxCapturedBytes?: number;
  readonly signal?: AbortSignal;
}

export type ProcessOutcome = 'exited' | 'timeout' | 'canceled' | 'spawn_failed';

export interface ProcessResult {
  readonly outcome: ProcessOutcome;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly wallclockMs: number;
  /** Пришлось ли добивать процесс после отсрочки. */
  readonly forceKilled: boolean;
}

const DEFAULT_CAPTURE_BYTES = 1_000_000;

export async function runProcess(options: ProcessOptions): Promise<ProcessResult> {
  const started = Date.now();
  const grace = options.graceMs ?? DEFAULT_GRACE_MS;
  const capture = options.maxCapturedBytes ?? DEFAULT_CAPTURE_BYTES;

  const useShell = typeof options.command === 'string';
  const [file, ...args] = useShell
    ? [options.command as string]
    : (options.command as readonly string[]);

  if (file === undefined || file === '') {
    throw new Error('Пустая команда шага');
  }

  const subprocess = execa(file, args, {
    cwd: options.cwd,
    env: options.env,
    extendEnv: false,
    // Отдельная группа процессов: только так убийство достаёт до внуков.
    detached: process.platform !== 'win32',
    reject: false,
    buffer: false,
    shell: useShell,
    stdin: options.stdin === undefined ? 'ignore' : 'pipe',
    stripFinalNewline: false,
  }) as Subprocess;

  if (options.stdin !== undefined && subprocess.stdin !== null) {
    subprocess.stdin.end(options.stdin);
  }

  const stdout = collect(subprocess.stdout, options.stdoutPath, capture, options.onStdout);
  const stderr = collect(subprocess.stderr, options.stderrPath, capture, options.onStderr);

  let outcome: ProcessOutcome = 'exited';
  let forceKilled = false;
  let killTimer: NodeJS.Timeout | undefined;

  const terminate = (reason: ProcessOutcome): void => {
    if (outcome !== 'exited') return;
    outcome = reason;
    killGroup(subprocess, 'SIGTERM');
    killTimer = setTimeout(() => {
      forceKilled = true;
      killGroup(subprocess, 'SIGKILL');
    }, grace);
    killTimer.unref();
  };

  /**
   * Область запуска: таймеры и слушатель снимаются одним `finally` вокруг
   * ожидания процесса. Журнала здесь нет — и не нужно: `clearTimeout` и
   * `removeEventListener` не отказывают, а исключение из них означало бы
   * дефект, который обязан быть виден, а не проглочен.
   */
  const resources = createScope();

  const timeoutTimer = setTimeout(() => terminate('timeout'), options.timeoutMs);
  timeoutTimer.unref();
  resources.defer('снятие таймера предельного времени шага', () => {
    clearTimeout(timeoutTimer);
  });

  const onAbort = (): void => terminate('canceled');
  options.signal?.addEventListener('abort', onAbort, { once: true });
  resources.defer('снятие слушателя отмены процесса', () => {
    options.signal?.removeEventListener('abort', onAbort);
  });
  // Таймер добивания заводит `terminate` уже после этой регистрации, поэтому
  // операция читает переменную, а не её сегодняшнее значение.
  resources.defer('снятие таймера добивания процесса', () => {
    clearTimeout(killTimer);
  });

  // Молчание — не отказ: шаг может думать. Сообщаем и продолжаем ждать
  // таймаут, чтобы «непонятно, работает ли оно» стало наблюдаемым.
  let stallTimer: NodeJS.Timeout | undefined;
  const armStall = (): void => {
    if (options.stallTimeoutMs === undefined || options.onStall === undefined) return;
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      options.onStall?.(options.stallTimeoutMs as number);
      armStall();
    }, options.stallTimeoutMs);
    stallTimer.unref();
  };
  stdout.onData(armStall);
  stderr.onData(armStall);
  // Таймер молчания перезаводится на каждом куске вывода: снимается тот, что
  // взведён к моменту снятия области.
  resources.defer('снятие таймера молчания шага', () => {
    clearTimeout(stallTimer);
  });
  armStall();

  let result: Awaited<Subprocess>;
  try {
    result = await subprocess;
  } finally {
    // Процесс, не сумевший стартовать, доходит сюда исключением: без снятия
    // области его таймеры остались бы взведёнными.
    await resources.dispose();
  }

  await Promise.all([stdout.done(), stderr.done()]);

  // Процесс, не сумевший стартовать, не имеет ни кода, ни сигнала. Отличать
  // это от обычного отказа нужно, чтобы причина остановки называла отсутствие
  // команды, а не непройденный предикат кода возврата.
  if (
    outcome === 'exited' &&
    result.failed === true &&
    typeof result.exitCode !== 'number' &&
    (result.signal ?? null) === null
  ) {
    outcome = 'spawn_failed';
  }

  return {
    outcome,
    exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
    signal: (result.signal as string | undefined) ?? null,
    stdout: stdout.text(),
    stderr: stderr.text(),
    wallclockMs: Date.now() - started,
    forceKilled,
  };
}

/** Убить всю группу процессов, а не только прямого потомка. */
function killGroup(subprocess: Subprocess, signal: NodeJS.Signals): void {
  const pid = subprocess.pid;
  if (pid === undefined) return;

  try {
    if (process.platform === 'win32') {
      subprocess.kill(signal);
      return;
    }
    process.kill(-pid, signal);
  } catch {
    // Процесс уже завершился — гонка между таймером и выходом обычна.
    try {
      subprocess.kill(signal);
    } catch {
      // И этого уже нет.
    }
  }
}

interface Collector {
  readonly onData: (listener: () => void) => void;
  readonly text: () => string;
  readonly done: () => Promise<void>;
}

/**
 * Копить вывод в память с ограничением и одновременно писать в файл.
 * Ограничение нужно, чтобы бесконечно болтливый шаг не съел память процесса;
 * файл при этом получает всё.
 */
function collect(
  stream: NodeJS.ReadableStream | null,
  path: string | undefined,
  limit: number,
  onChunk?: (chunk: string) => void,
): Collector {
  const listeners: Array<() => void> = [];
  const chunks: string[] = [];
  let size = 0;
  let truncated = false;

  const file = path === undefined ? undefined : createWriteStream(path, { mode: 0o600 });
  const finished =
    file === undefined
      ? Promise.resolve()
      : new Promise<void>((resolve) => file.on('close', () => resolve()));

  if (stream !== null) {
    stream.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      file?.write(text);
      onChunk?.(text);
      for (const listener of listeners) listener();

      if (size >= limit) {
        truncated = true;
        return;
      }
      const room = limit - size;
      chunks.push(text.length > room ? text.slice(0, room) : text);
      size += Math.min(text.length, room);
      if (text.length > room) truncated = true;
    });
    stream.on('end', () => file?.end());
    stream.on('error', () => file?.end());
  } else {
    file?.end();
  }

  return {
    onData: (listener) => listeners.push(listener),
    text: () => chunks.join('') + (truncated ? '\n[вывод обрезан]' : ''),
    done: () => finished,
  };
}
