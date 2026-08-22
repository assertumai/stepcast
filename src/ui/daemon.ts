import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { StepcastError } from '../core/errors.js';

/**
 * Жизненный цикл демона витрины.
 *
 * Демон — первый фоновый процесс в инструменте, поэтому его состояние описано
 * файлом, а не догадками: pid-файл говорит, кто и на каком порту слушает.
 * Осиротевший файл после `SIGKILL` или перезагрузки не должен требовать
 * ручной уборки — это ровно тот случай, где инструмент обязан справиться сам.
 */

export interface DaemonRecord {
  readonly pid: number;
  readonly port: number;
  readonly started_at: string;
}

export interface DaemonPaths {
  readonly pidFile: string;
  readonly logFile: string;
}

export function daemonPaths(home: string = homedir()): DaemonPaths {
  const dir = join(home, '.stepcast');
  return { pidFile: join(dir, 'ui.pid'), logFile: join(dir, 'ui.log') };
}

export function readRecord(paths: DaemonPaths): DaemonRecord | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(paths.pidFile, 'utf8'));
  } catch {
    return undefined;
  }

  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.pid !== 'number' || typeof record.port !== 'number') return undefined;

  return {
    pid: record.pid,
    port: record.port,
    started_at: typeof record.started_at === 'string' ? record.started_at : '',
  };
}

/**
 * Жив ли процесс. Сигнал 0 ничего не посылает, а только сообщает, есть ли
 * такой процесс и доступен ли он.
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM означает «процесс есть, но чужой» — для нас он всё равно жив.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Запись о живом демоне. Осиротевшая запись стирается и не считается. */
export function runningDaemon(paths: DaemonPaths): DaemonRecord | undefined {
  const record = readRecord(paths);
  if (record === undefined) return undefined;
  if (isAlive(record.pid)) return record;
  rmSync(paths.pidFile, { force: true });
  return undefined;
}

export function writeRecord(paths: DaemonPaths, record: DaemonRecord): void {
  mkdirSync(join(paths.pidFile, '..'), { recursive: true });
  writeFileSync(paths.pidFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

export function clearRecord(paths: DaemonPaths): void {
  rmSync(paths.pidFile, { force: true });
}

export interface StartOptions {
  readonly paths: DaemonPaths;
  /** Аргументы запуска фонового процесса: та же команда с `--foreground`. */
  readonly argv: readonly string[];
  readonly execPath?: string;
}

/**
 * Отсоединённый запуск.
 *
 * Порождается та же команда с `--foreground`, а не отдельный скрипт: иначе
 * «как оно работает в фоне» и «как оно работает при отладке» однажды
 * разойдутся.
 */
export function startDetached(options: StartOptions): number {
  mkdirSync(join(options.paths.logFile, '..'), { recursive: true });
  // Вывод демона некуда девать: его stdout отвязан от терминала.
  const log = openSync(options.paths.logFile, 'a', 0o600);

  const child = spawn(options.execPath ?? process.execPath, [...options.argv], {
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();

  if (child.pid === undefined) {
    throw new StepcastError('Не удалось запустить демон витрины');
  }
  return child.pid;
}

export type StopOutcome = 'stopped' | 'not-running';

/** Остановить демон. Отсутствие демона — не ошибка: останавливать нечего. */
export function stopDaemon(paths: DaemonPaths): StopOutcome {
  const record = runningDaemon(paths);
  if (record === undefined) {
    clearRecord(paths);
    return 'not-running';
  }

  try {
    process.kill(record.pid, 'SIGTERM');
  } catch {
    // Процесс исчез между проверкой и сигналом — результат тот же.
  }
  clearRecord(paths);
  return 'stopped';
}

/** Внятный отказ на занятый порт: молча уезжать на соседний нельзя. */
export function portBusyError(port: number, cause?: unknown): StepcastError {
  return new StepcastError(`Порт ${port} занят другим процессом`, {
    hint: `Освободите порт или укажите другой в настройке ui.port`,
    ...(cause === undefined ? {} : { cause }),
  });
}

export function isAddressInUse(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE';
}

/** Признак того, что демон существует и слушает: показывается пользователю. */
export function describeDaemon(record: DaemonRecord): string[] {
  return [
    `витрина: http://127.0.0.1:${record.port}`,
    `процесс: ${record.pid}${record.started_at === '' ? '' : `, запущен ${record.started_at}`}`,
  ];
}
