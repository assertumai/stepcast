import {
  catchUpUsageStore,
  removeUsageRecords,
  selectUsageRecords,
  readUsageStore,
  type UsageRecordSelectTraits,
} from '../../../pipeline/run/journal/usageStore.js';
import { isStepcastError } from '../../../../kernel/errors.js';
import { parseDuration } from '../../../../kernel/units.js';
import { readBody, sendJson } from '../../daemon/http.js';
import { parseRunAddress } from '../../runAddress.js';
import { isSafeSegment } from '../../routes.js';
import { screenRow, type ApiHandler } from '../registry.js';
import { declaration } from './declaration.js';

/** Потолок числа адресов в групповом удалении — тот же, что и у уборки файлов прогонов. */
const MAX_USAGE_RECORD_ADDRESSES = 500;

const KNOWN_USAGE_RECORD_TRAITS = new Set(['failed']);

/**
 * Отбор записей хранилища расхода к снятию — только отчёт, файлов прогонов
 * не касается (design.md изменения `run-stats-retention`, Решение 14). Те же
 * признаки, что у отбора прогонов (`screen-runs`), кроме «оборванного»: он не
 * применим к записи (`selectUsageRecords`).
 */
const handleSelectUsageRecords: ApiHandler = (req, res, env) => {
  const url = new URL(req.url ?? '/', 'http://internal');
  const traits: { -readonly [K in keyof UsageRecordSelectTraits]: UsageRecordSelectTraits[K] } = {};

  for (const trait of url.searchParams.getAll('trait')) {
    if (!KNOWN_USAGE_RECORD_TRAITS.has(trait)) {
      sendJson(res, 400, { error: `Неизвестный признак отбора: ${trait}`, hint: 'Допустимые признаки: failed' });
      return;
    }
    traits.failed = true;
  }

  const olderThan = url.searchParams.get('older-than');
  if (olderThan !== null) {
    try {
      traits.olderThanMs = parseDuration(olderThan, 'older-than');
    } catch (error) {
      const message = isStepcastError(error) ? error.message : 'Не удалось разобрать срок';
      sendJson(res, 400, { error: message });
      return;
    }
  }

  const project = url.searchParams.get('project');
  if (project !== null && !isSafeSegment(project)) {
    sendJson(res, 400, { error: 'Ключ проекта должен быть одним сегментом раскладки' });
    return;
  }

  // Догон перед отбором: отбор по хранилищу обязан отвечать за диск сейчас, а
  // не за снимок, перенесённый при старте демона (design.md, Решение 2).
  const narrowing = traits.failed === true || traits.olderThanMs !== undefined;
  if (narrowing || project !== null) {
    catchUpUsageStore(env.runsRoot, project === null ? {} : { project });
  }
  const selected = selectUsageRecords(env.runsRoot, traits, project === null ? {} : { project });

  sendJson(res, 200, {
    records: selected.map((entry) => ({
      address: entry.address,
      ageMs: entry.ageMs,
      endedAt: entry.record.finished_at ?? entry.record.started_at,
      status: entry.record.status,
    })),
    count: selected.length,
  });
};

/**
 * Снятие записей хранилища расхода по явному списку адресов — та же схема,
 * что у удаления прогонов: список пришёл с отбора, увиденного пользователем,
 * а не с признака, и файлов прогонов вызов не трогает вовсе.
 */
const handleDeleteUsageRecords: ApiHandler = async (req, res, env) => {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 413, { error: 'Тело запроса слишком велико' });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body === '' ? '{}' : body);
  } catch {
    sendJson(res, 400, { error: 'Тело запроса не разбирается как JSON' });
    return;
  }

  const list = (parsed as { records?: unknown }).records;
  if (!Array.isArray(list) || list.some((item) => typeof item !== 'string')) {
    sendJson(res, 400, { error: 'Тело запроса должно нести список адресов: { "records": string[] }' });
    return;
  }

  if (list.length > MAX_USAGE_RECORD_ADDRESSES) {
    sendJson(res, 413, { error: `Список адресов превышает предел в ${MAX_USAGE_RECORD_ADDRESSES}` });
    return;
  }

  const addresses: string[] = [];
  for (const value of list as string[]) {
    const address = parseRunAddress(value);
    if (address === undefined) {
      sendJson(res, 400, { error: `Адрес записи должен иметь вид <проект>/<прогон>: ${value}` });
      return;
    }
    addresses.push(`${address.key}/${address.runId}`);
  }

  // Исход по каждому адресу отдельно: адрес, у которого записи уже не было,
  // не должен выглядеть снятым этим вызовом.
  const existedBefore = readUsageStore(env.runsRoot).records;
  const removed = removeUsageRecords(env.runsRoot, addresses);
  // Одна пересборка на всю группу — как и у снятия файлов: прогон без файлов,
  // чья запись снята этим вызовом, обязан пропасть из обзора немедленно.
  env.watcher.poll();
  sendJson(res, 200, {
    outcomes: addresses.map((address) => ({
      address,
      outcome: existedBefore.has(address) ? ('removed' as const) : ('skipped_missing' as const),
    })),
    removed,
  });
};

export const row = screenRow(declaration.id, ['screens', 'api'], (ctx) => {
  ctx.screens.register(declaration);
  ctx.api.register('GET', '/api/usage-records', handleSelectUsageRecords);
  ctx.api.register('DELETE', '/api/usage-records', handleDeleteUsageRecords);
});
