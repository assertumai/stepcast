import { existsSync } from 'node:fs';

import { runPaths } from '../core/journal/paths.js';
import { readUsageStore } from '../core/journal/usageStore.js';
import { isSafeSegment } from './routes.js';
import { buildSnapshot, buildSnapshotFromRecord, type RunSnapshot } from './snapshot.js';

/**
 * Разбор и снимок адреса прогона — общие нескольким строкам витрины:
 * `screen-run` (снимок и события прогона), `screen-runs` (удаление по адресу),
 * `screen-cleanup` (удаление записей хранилища расхода) и `ui-shell` (поток
 * `/api/events` шлёт снимок наблюдаемого прогона). Живёт отдельно от любой из
 * них, а не в одной с копированием в остальные — так у формата адреса одно
 * место, а не четыре разошедшихся.
 */

/** Адрес прогона в API — `<projectKey>/<runId>`: принадлежность проекту часть адреса. */
export function parseRunAddress(value: string | null): { key: string; runId: string } | undefined {
  if (value === null) return undefined;
  const parts = value.split('/').filter((part) => part !== '');
  if (parts.length !== 2) return undefined;
  const [key, runId] = parts as [string, string];
  if (!isSafeSegment(key) || !isSafeSegment(runId)) return undefined;
  return { key, runId };
}

/**
 * Снимок прогона: по каталогу, если он ещё есть; иначе — по записи хранилища
 * расхода, если она сохранена (design.md изменения `run-stats-retention`,
 * Решение 12). Отказ 404 остаётся только тогда, когда нет ни того, ни
 * другого — прогон убран целиком, вместе со статистикой.
 */
export function snapshotOrRecord(runsRoot: string, key: string, runId: string): RunSnapshot | undefined {
  const paths = runPaths(runsRoot, key, runId);
  if (existsSync(paths.dir)) return buildSnapshot(paths, key);

  const record = readUsageStore(runsRoot).records.get(`${key}/${runId}`);
  return record === undefined ? undefined : buildSnapshotFromRecord(record, key);
}
