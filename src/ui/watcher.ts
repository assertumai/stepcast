import { existsSync, statSync } from 'node:fs';

import { listProjects, listRunsByKey } from '../core/journal/reader.js';
import { runPaths } from '../core/journal/paths.js';
import { buildOverview, type Overview } from './overview.js';

/**
 * Наблюдатель за корнем прогонов.
 *
 * Один на демон, слушателей много: свой опрос на каждое SSE-соединение
 * умножал бы работу на число открытых вкладок при том, что данные у всех одни
 * и те же.
 *
 * Опрос по таймеру, а не уведомления файловой системы, — по той же причине,
 * по которой так устроен `follow()`: уведомления приходят не на всех файловых
 * системах, включая сетевые, и пропущенный прогон хуже секундной задержки.
 */

/** Каталоги меняются редко — куда реже, чем строки в логе у `follow()`. */
const DEFAULT_INTERVAL_MS = 1_000;

export interface WatcherOptions {
  readonly runsRoot: string;
  readonly intervalMs?: number;
}

export interface Watcher {
  /** Текущий обзор без ожидания следующего опроса. */
  current(): Overview;
  /** Подписаться на обновления. Возвращает функцию отписки. */
  subscribe(listener: (overview: Overview) => void): () => void;
  /** Проверить корень прогонов немедленно, не дожидаясь таймера. */
  poll(): void;
  dispose(): void;
}

/**
 * Отпечаток состояния корня: какие прогоны есть, когда каждый последний раз
 * менялся и убран ли он. Сравнение отпечатков дешевле разбора всех
 * `status.json` — их приходится читать только когда отпечаток разошёлся.
 *
 * Отпечаток обязан покрывать всё, что показывает обзор, иначе изменение
 * останется невидимым навсегда. Признак уборки входит сюда именно поэтому:
 * `stepcast gc` сносит содержимое прогона, не трогая `status.json`, и по
 * одному лишь mtime состояния уборка неотличима от её отсутствия.
 */
function fingerprint(runsRoot: string): string {
  const parts: string[] = [];
  for (const project of listProjects(runsRoot)) {
    for (const runId of listRunsByKey(runsRoot, project.key)) {
      const paths = runPaths(runsRoot, project.key, runId);
      let mtime = 0;
      try {
        mtime = statSync(paths.status).mtimeMs;
      } catch {
        // Прогон без состояния: он всё равно должен попасть в отпечаток, иначе
        // его появление останется незамеченным до первой записи состояния.
      }
      parts.push(`${project.key}/${runId}:${mtime}:${existsSync(paths.jobs) ? '1' : '0'}`);
    }
  }
  return parts.join('|');
}

export function createWatcher(options: WatcherOptions): Watcher {
  const { runsRoot } = options;
  const listeners = new Set<(overview: Overview) => void>();

  let mark = fingerprint(runsRoot);
  let overview = buildOverview(runsRoot);

  const poll = (): void => {
    const next = fingerprint(runsRoot);
    if (next === mark) return;
    mark = next;
    overview = buildOverview(runsRoot);
    for (const listener of listeners) listener(overview);
  };

  const timer = setInterval(poll, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  // Таймер не должен удерживать процесс: демон живёт своим сервером.
  timer.unref();

  return {
    current: () => overview,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    poll,
    dispose() {
      clearInterval(timer);
      listeners.clear();
    },
  };
}
