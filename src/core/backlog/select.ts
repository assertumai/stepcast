import { effectiveGroup, type BacklogEntry } from './parse.js';

/**
 * Отбор свободных пунктов очереди по действующим группам.
 *
 * Часы приходят аргументом (`nowMs`), а не из `Date.now()` внутри: иначе
 * правило зависшего пункта было бы нечем проверить без подмены глобального
 * времени, а вызывающий (CLI) и так уже знает текущий момент.
 */

export const DEFAULT_STALE_HOURS = 6;

/**
 * Свободен ли пункт для взятия в работу.
 *
 * Пункт `in_progress` старше порога считается зависшим и снова свободен:
 * прогон, оборванный по сигналу, крашу или бюджету, иначе заблокировал бы его
 * навсегда. Отсутствие `started_at` у `in_progress` толкуется так же — момент
 * взятия неизвестен, и ждать нечего.
 */
export function isFree(entry: BacklogEntry, nowMs: number, staleMs: number): boolean {
  const { status, started_at: startedAt } = entry.data;
  if (status === 'pending') return true;
  if (status !== 'in_progress') return false;

  if (startedAt === undefined || startedAt === '') return true;

  const startedMs = Date.parse(startedAt);
  if (Number.isNaN(startedMs)) return true;
  return nowMs - startedMs >= staleMs;
}

/**
 * Держит ли пункт свою группу занятой: только `in_progress` и не протухший.
 *
 * `done` и `failed` не свободны для взятия (см. `isFree`), но это состояния
 * терминальные — они не должны запирать группу от других её пунктов.
 */
function isBusy(entry: BacklogEntry, nowMs: number, staleMs: number): boolean {
  return entry.data.status === 'in_progress' && !isFree(entry, nowMs, staleMs);
}

/**
 * Отобрать до `slots` пунктов сверху вниз, по одному на действующую группу.
 *
 * Занятые группы собираются заранее по всей очереди (занятый пункт держит
 * свою группу, даже если сам он ниже места отбора), а затем пополняются по
 * ходу отбора — так пункт одной группы с уже выбранным не берётся в том же
 * проходе.
 */
export function selectItems(
  entries: readonly BacklogEntry[],
  slots: number,
  nowMs: number,
  staleMs: number,
): readonly BacklogEntry[] {
  const busyGroups = new Set(
    entries.filter((entry) => isBusy(entry, nowMs, staleMs)).map(effectiveGroup),
  );

  const chosen: BacklogEntry[] = [];
  for (const entry of entries) {
    if (chosen.length >= slots) break;
    if (!isFree(entry, nowMs, staleMs)) continue;
    const group = effectiveGroup(entry);
    if (busyGroups.has(group)) continue;
    chosen.push(entry);
    busyGroups.add(group);
  }
  return chosen;
}
