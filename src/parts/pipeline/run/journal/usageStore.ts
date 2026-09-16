import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';

import { USAGE_STORE_FORMAT } from './format.js';
import { runPaths, usageStorePath } from './paths.js';
import { listProjects, listRunsByKey, readManifest, readStatus, readUsageSoft } from './reader.js';
import {
  UsageRecordSchema,
  isFailure,
  type RunManifest,
  type RunStatus,
  type UsageRecord,
  type UsageReport,
} from './schema.js';
import { breakdownReport } from './usageSpread.js';

/**
 * Хранилище расхода: построчный журнал `<корень прогонов>/usage.ndjson`, по
 * строке JSON на прогон (design.md изменения run-stats-retention, Решение 1).
 *
 * Дозапись (`appendUsageRecord`) — единственный горячий путь и не переписывает
 * накопленного никогда; переписывание случается только при явном снятии
 * записей (`removeUsageRecords`), редко и не в состязании с дозаписью.
 */

/** Те же права, что у прочих файлов журнала (`journal/writer.ts`). */
const FILE_MODE = 0o600;

/** Адрес записи в хранилище — тот же вид, что у адреса каталога прогона. */
export function usageRecordAddress(record: UsageRecord): string {
  return `${record.project.key}/${record.run_id}`;
}

/**
 * Собрать запись хранилища из манифеста, состояния и сводки расхода прогона —
 * единственная точка сборки, общая для движка (в конце прогона, минуя диск) и
 * переноса накопленного (читая те же три документа с диска). Расхождение
 * счёта между «живым» и «переносящим» путём было бы негде заметить: записи
 * прошлых прогонов уже не с чем сверить (Решение 2).
 *
 * `key` передаётся явно, а не вычисляется из `manifest.project_root`: ключ
 * проекта — необратимый хеш пути (`projectKey` в `paths.ts`), и его
 * пересчёт потребовал бы, чтобы путь проекта существовал на диске прямо
 * сейчас, — а вызывающие (движок, перенос, удаление прогона) уже знают ключ
 * из собственной раскладки, без обращения к файловой системе.
 */
export function usageRecord(
  key: string,
  manifest: RunManifest,
  status: RunStatus,
  report: UsageReport,
): UsageRecord {
  const { models, costUnreportedAttempts } = breakdownReport(report);

  return {
    format: USAGE_STORE_FORMAT,
    project: { key, path: manifest.project_root },
    pipeline: { name: manifest.pipeline, file: manifest.pipeline_file },
    run_id: manifest.run_id,
    started_at: manifest.started_at,
    ...(manifest.finished_at === undefined ? {} : { finished_at: manifest.finished_at }),
    status: status.status,
    total: { ...report.total },
    unreported: report.unreported,
    cost_unreported_attempts: costUnreportedAttempts,
    models: Object.fromEntries(
      [...models].map(([model, delta]) => [
        model,
        {
          billable_tokens: delta.billableTokens,
          ...(delta.costUsd === undefined ? {} : { cost_usd: delta.costUsd }),
        },
      ]),
    ),
    jobs: Object.fromEntries(
      Object.entries(report.jobs).map(([jobId, job]) => [
        jobId,
        {
          billable_tokens: job.billable_tokens,
          wallclock_ms: job.wallclock_ms,
          ...(job.cost_usd === undefined ? {} : { cost_usd: job.cost_usd }),
          steps: Object.fromEntries(
            Object.entries(job.steps).map(([stepId, step]) => [
              stepId,
              {
                billable_tokens: step.billable_tokens,
                wallclock_ms: step.wallclock_ms,
                ...(step.cost_usd === undefined ? {} : { cost_usd: step.cost_usd }),
              },
            ]),
          ),
        },
      ]),
    ),
  };
}

/** Дозаписать одну запись — не переписывая накопленного (Решение 8). */
export function appendUsageRecord(runsRoot: string, record: UsageRecord): void {
  appendFileSync(usageStorePath(runsRoot), `${JSON.stringify(record)}\n`, { mode: FILE_MODE });
}

export interface UsageStoreReadResult {
  /** Ключ — адрес записи (`usageRecordAddress`); поздняя строка вытесняет раннюю. */
  readonly records: ReadonlyMap<string, UsageRecord>;
  /** Строки, не прошедшие разбор JSON или схему, — хвост обрыва и тому подобное. */
  readonly corrupted: number;
  /** Записи версии новее этого читателя — прочитаны по известным полям. */
  readonly versionSkew: number;
}

/**
 * Прочитать хранилище целиком. Отсутствие файла — пустое хранилище, а не
 * ошибка: до первой записи (или на установке без единого перенесённого
 * прогона) файла попросту ещё нет.
 *
 * Строка, не прошедшая разбор, — обрыв процесса на дозаписи или любая другая
 * порча, — пропускается и не роняет чтение остальных (Решение 4): ту же
 * защиту уже даёт `readEventsSoft` для `events.ndjson`.
 */
export function readUsageStore(runsRoot: string): UsageStoreReadResult {
  const path = usageStorePath(runsRoot);
  if (!existsSync(path)) return { records: new Map(), corrupted: 0, versionSkew: 0 };

  const records = new Map<string, UsageRecord>();
  let corrupted = 0;
  let versionSkew = 0;

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;

    const record = parseRecordLine(line);
    if (record === undefined) {
      corrupted += 1;
      continue;
    }
    if (record.format > USAGE_STORE_FORMAT) versionSkew += 1;
    // Поздняя запись прогона вытесняет раннюю (Решение 6): дозапись остаётся
    // идемпотентной, и переносу, повторному завершению и будущей правке
    // формата не нужно искать и править строку на месте.
    records.set(usageRecordAddress(record), record);
  }

  return { records, corrupted, versionSkew };
}

function parseRecordLine(line: string): UsageRecord | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  const parsed = UsageRecordSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** Хранилища, перенос которых уже выполнен в этом процессе (Решение 9). */
const backfilled = new Set<string>();

export interface CatchUpUsageStoreOptions {
  /** Сузить обход до одного проекта — иначе обходятся все проекты корня. */
  readonly project?: string;
}

/**
 * Перенести в хранилище прогоны, которые есть на диске области, но которых в
 * хранилище ещё нет, — без защёлки: вызывать можно на каждый отбор, а не
 * только на открытие хранилища (design.md изменения
 * cleanup-selection-returns-empty, Решение 1).
 *
 * Отличие от `backfillUsageStore` — не в переносе (он тот же), а в том, когда
 * его можно повторить: `backfillUsageStore` защищён множеством `backfilled` и
 * годится для горячих путей (`GET /api/usage`, сборка обзора), где повторный
 * полный обход корня был бы дорог и не нужен — хранилище пополняется редко.
 * Отбор, который человек запросил и ждёт, — не горячий путь: он уже обходит
 * каждый каталог прогона рекурсивно ради размера, и место, где отставание
 * хранилища от диска видно и вредно. Обеим функциям нужны разные имена, чтобы
 * разница была видна в местах вызова, а не только в комментарии здесь.
 *
 * Переносятся и незавершённые прогоны — оборванные, застрявшие в `running`:
 * их расход накоплен и реален, а исход берётся из состояния как есть. Если
 * прогон впоследствии завершится, его запись перезапишется терминальной
 * (Решение 6) — перенос её не защищает от этого и не должен.
 */
export function catchUpUsageStore(runsRoot: string, options: CatchUpUsageStoreOptions = {}): void {
  const present = usageRecordAddresses(runsRoot);
  const keys =
    options.project !== undefined
      ? [options.project]
      : listProjects(runsRoot).map((project) => project.key);

  for (const key of keys) {
    for (const runId of listRunsByKey(runsRoot, key)) {
      if (!catchUpRun(runsRoot, key, runId, present)) return;
    }
  }
}

/**
 * Догон по явному списку прогонов: областью служит сам список, обходить корень
 * незачем. Нужен отбору по названным адресам (`GET /api/runs?run=…`), которому
 * хранилище нужно только ради метки «записи нет» у этих самых прогонов.
 */
export function catchUpUsageRecords(
  runsRoot: string,
  addresses: readonly { readonly key: string; readonly runId: string }[],
): void {
  const present = usageRecordAddresses(runsRoot);
  for (const { key, runId } of addresses) {
    if (!catchUpRun(runsRoot, key, runId, present)) return;
  }
}

/**
 * Один шаг догона. Отвечает, можно ли догону продолжать: `false` — дозапись
 * отказала.
 *
 * Догон дописывает производное (хранилище выводится из каталогов прогонов) и
 * зовётся с путей, которые сами по себе — чтение: отбор, который человек
 * запросил и ждёт. Отказ дозаписи — корень только для чтения, кончилось место,
 * `usage.ndjson` заведён другим пользователем — обязан вырождать догон в
 * «отбор без свежих записей», а не в отказ отбора и не в падение демона:
 * маршруты витрины синхронны, и брошенное отсюда исключение уронило бы весь
 * процесс. Обход при этом прекращается на первом же отказе: причина у всех
 * записей одна, и пятьсот одинаковых отказов подряд — только задержка ответа.
 *
 * Дозапись по просьбе удаления (`ensureUsageRecord`) этой пощады не знает и не
 * должна: там запись обязана лечь на диск до `rmSync`, и молчание стоило бы
 * статистики прогона.
 */
function catchUpRun(runsRoot: string, key: string, runId: string, present: Set<string>): boolean {
  const address = `${key}/${runId}`;
  if (present.has(address)) return true;
  try {
    if (appendIfSummarized(runsRoot, key, runId)) present.add(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Перенести в хранилище прогоны всего корня, не чаще одного раза за время
 * жизни процесса на хранилище (ключ — путь файла хранилища): повторный вызов —
 * дешёвый no-op, поэтому вызывать функцию можно откуда угодно, где хранилище
 * открывается, не думая, кто уже успел его открыть раньше. Однократный вход
 * для старта демона и `gc`; отбор, которому нужен свежий диск на каждый
 * запрос, зовёт догон `catchUpUsageStore` напрямую.
 */
export function backfillUsageStore(runsRoot: string): void {
  const path = usageStorePath(runsRoot);
  if (backfilled.has(path)) return;
  backfilled.add(path);
  catchUpUsageStore(runsRoot);
}

/**
 * Дописать запись прогона из его каталога, если сводка расхода уже есть.
 * Отвечает, дописана ли запись: вызывающий, ведущий набор уже сохранённых
 * адресов, обязан узнать об этом, не перечитывая хранилища.
 */
function appendIfSummarized(runsRoot: string, key: string, runId: string): boolean {
  const paths = runPaths(runsRoot, key, runId);
  let manifest: RunManifest;
  let status: RunStatus;
  try {
    manifest = readManifest(paths);
    status = readStatus(paths);
  } catch {
    // Журнал прогона не читается — переносить с диска нечего.
    return false;
  }

  const { summary } = readUsageSoft(paths);
  // Сводки ещё нет вовсе — окно до первой записи прогона прежней формы,
  // писавшей сводку только в конце и не дожившей до неё. Переносить нечего.
  if (summary === undefined) return false;

  appendUsageRecord(runsRoot, usageRecord(key, manifest, status, summary));
  return true;
}

/**
 * Адреса записей, уже лежащих в хранилище. Отдаётся изменяемым набором: тот,
 * кто обходит список прогонов, читает хранилище один раз на весь список и
 * ведёт этот набор дальше сам (`ensureUsageRecord`), вместо того чтобы
 * разбирать `usage.ndjson` заново на каждый адрес.
 */
export function usageRecordAddresses(runsRoot: string): Set<string> {
  return new Set(readUsageStore(runsRoot).records.keys());
}

/**
 * Дописать запись прогона из его каталога, если её ещё нет в хранилище, — не
 * зная про перенос всего корня и не запуская его. Используется удалением
 * файлов прогона: обязано убедиться, что запись есть, прежде чем каталог
 * уйдёт под `rmSync` (design.md, Решение 10).
 *
 * `present` — набор уже известных адресов: групповое удаление передаёт сюда
 * один набор на весь список и пополняет его дозаписанным, иначе каждый адрес
 * стоил бы полного чтения хранилища (и группа в 500 адресов — 500 чтений).
 */
export function ensureUsageRecord(
  runsRoot: string,
  key: string,
  runId: string,
  present: Set<string> = usageRecordAddresses(runsRoot),
): void {
  const address = `${key}/${runId}`;
  if (present.has(address)) return;
  if (appendIfSummarized(runsRoot, key, runId)) present.add(address);
}

export interface UsageRecordSelectTraits {
  readonly failed?: boolean;
  readonly olderThanMs?: number;
}

export interface UsageRecordSelectOptions {
  /**
   * Ключ проекта: область отбора, за которую он не выходит. Проект — область,
   * а не одно из «или»: «снять записи отказавших прогонов этого проекта»
   * просит именно отказавшие записи этого проекта, а не все записи проекта
   * заодно с чужими отказавшими.
   */
  readonly project?: string;
  readonly now?: Date;
}

export interface SelectedUsageRecord {
  readonly address: string;
  readonly record: UsageRecord;
  readonly ageMs: number;
}

/**
 * Отбор записей к снятию — тем же трём признакам, что и у отбора каталогов
 * (`selectCandidates` в `run/cleanup.ts`), кроме «оборванного»: оборванность —
 * состояние `running` при мёртвом процессе, а `pid` живёт в каталоге, которого
 * у записи может уже не быть (Решение 14).
 *
 * Возраст и исход складываются по «или», проект — область, сужающая отбор по
 * «и». Названный проект при этом сам по себе признак: отбор без возраста и без
 * исхода, но с проектом, отбирает эту область целиком — иначе «снять
 * статистику вот этого проекта» не выражалось бы вовсе. Отбор совсем без
 * признаков не отбирает ничего — так же, как `gc` без `--older-than` только
 * отчитывается.
 */
export function selectUsageRecords(
  runsRoot: string,
  traits: UsageRecordSelectTraits,
  options: UsageRecordSelectOptions = {},
): SelectedUsageRecord[] {
  const narrowing = traits.failed === true || traits.olderThanMs !== undefined;
  if (!narrowing && options.project === undefined) return [];

  const now = options.now ?? new Date();
  const { records } = readUsageStore(runsRoot);
  const selected: SelectedUsageRecord[] = [];

  for (const [address, record] of records) {
    if (options.project !== undefined && record.project.key !== options.project) continue;

    const moment = record.finished_at ?? record.started_at;
    const ageMs = Math.max(0, now.getTime() - new Date(moment).getTime());

    const matches =
      !narrowing ||
      (traits.failed === true && isFailure(record.status)) ||
      (traits.olderThanMs !== undefined && ageMs >= traits.olderThanMs);

    if (!matches) continue;
    selected.push({ address, record, ageMs });
  }

  return selected;
}

function addressOfLine(line: string): string | undefined {
  const record = parseRecordLine(line);
  return record === undefined ? undefined : usageRecordAddress(record);
}

/**
 * Хвост, дописанный в файл хранилища после того, как было прочитано
 * `original`, — или пустая строка, если хвоста нет. Вынесено отдельной чистой
 * функцией: догон хвоста — единственная часть снятия записей, которая имеет
 * дело с состязанием во времени, и её проще проверить как чистое
 * преобразование двух строк, чем воспроизводить настоящую гонку в тесте.
 */
export function mergeAppendedTail(original: string, current: string): string {
  return current.length > original.length && current.startsWith(original)
    ? current.slice(original.length)
    : '';
}

/**
 * Снять записи по явному списку адресов — переписыванием файла, а не
 * дозаписью тумбстоуна (Решение 8): читает файл, отбирает остающиеся, пишет
 * их во временный файл, дочитывает хвост, появившийся с начала чтения (другой
 * прогон мог завершиться, пока шло снятие), и заменяет файл через `rename`.
 *
 * Строка, не прошедшая разбор, сохраняется как есть: снятие отбирает по
 * адресу записи, а адрес неразобранной строки взять неоткуда — надёжнее
 * оставить её, чем стереть данные, о которых нечего сказать.
 */
export function removeUsageRecords(runsRoot: string, addresses: readonly string[]): number {
  const path = usageStorePath(runsRoot);
  if (!existsSync(path)) return 0;

  const toRemove = new Set(addresses);
  const original = readFileSync(path, 'utf8');

  const kept: string[] = [];
  let removedCount = 0;
  for (const line of original.split('\n')) {
    if (line.trim() === '') continue;
    const address = addressOfLine(line);
    if (address !== undefined && toRemove.has(address)) {
      removedCount += 1;
      continue;
    }
    kept.push(line);
  }

  const content =
    (kept.length === 0 ? '' : `${kept.join('\n')}\n`) + mergeAppendedTail(original, readFileSync(path, 'utf8'));

  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode: FILE_MODE });
  renameSync(tmp, path);
  return removedCount;
}
