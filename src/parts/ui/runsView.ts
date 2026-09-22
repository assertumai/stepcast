/**
 * Отбор, фильтры и порядок списка прогонов на первом экране витрины.
 *
 * Живёт рядом с `grouping.ts` и по той же причине: что показывается и в каком
 * порядке — смысл экрана, а не оформление, и проверяться должно обычным
 * тестом, а не глазами в браузере. Модуль чист: ни React, ни `window`, ни
 * чтения диска — витрина импортирует его относительным путём из `ui/`, тест —
 * как любой модуль `src/`.
 *
 * Типы описаны здесь структурно, а не импортированы из `overview.ts`: между
 * витриной и демоном лежит JSON (см. `ui/src/api.ts`), и модулю нужны от
 * обзора лишь те поля, по которым он фильтрует и сортирует.
 */

import type { FilterOption } from './filters.js';
export type { FilterOption } from './filters.js';

/** Последний сегмент пути проекта — заголовок и подпись колонки; полный путь остаётся в `title`. */
export function lastPathSegment(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/** Подпись проекта, чей путь обзору неизвестен: ключ и пометка, одна на всю витрину. */
export function unknownPathLabel(projectKey: string): string {
  return `${projectKey} (path unknown)`;
}

/** Прогон обзора — в объёме, нужном отбору и порядку. */
export interface RunLike {
  readonly runId: string;
  readonly pipeline: string;
  readonly pipelineFile?: string;
  readonly status?: string;
  readonly running: boolean;
  readonly startedAt?: string;
  readonly durationMs?: number;
  readonly usage?: {
    readonly costUsd: number | null;
    readonly billableTokens: number;
  };
}

/** Проект обзора со своими прогонами — в объёме, нужном отбору. */
export interface ProjectLike<R extends RunLike> {
  readonly key: string;
  readonly path?: string;
  readonly runs: readonly R[];
}

/** Прогон, адресованный парой «проект / прогон», с проектом рядом для колонки и фильтра. */
export interface AddressedRun<R extends RunLike> {
  readonly address: string;
  readonly projectKey: string;
  readonly projectPath?: string;
  readonly run: R;
}

/**
 * Значение фильтра пайплайна опознаётся файлом, которым запущен прогон, а не
 * именем: то же правило, по которому прогон находит свой пайплайн в
 * `grouping.ts`, и по той же причине — два файла проекта могут объявить одно
 * имя, а у неразбираемого файла имени нет вовсе. Прогон без файла отбирается
 * по имени; прогон без файла и без имени — значением «без имени», отдельным
 * от любого настоящего имени.
 */
function pipelineFilterKey(run: RunLike): string {
  if (run.pipelineFile !== undefined) return `file:${run.pipelineFile}`;
  if (run.pipeline !== '') return `name:${run.pipeline}`;
  return 'unnamed';
}

/** Подпись значения фильтра пайплайна: имя с путём файла рядом, когда файл известен. */
function pipelineFilterLabel(run: RunLike): string {
  if (run.pipelineFile !== undefined) return `${run.pipeline || run.pipelineFile} — ${run.pipelineFile}`;
  if (run.pipeline !== '') return run.pipeline;
  return 'unnamed';
}

/**
 * Подпись значения фильтра пайплайна, которого уже нет среди текущих
 * (выбранный пайплайн ушёл из обзора, Решение 6): разбирает то же
 * кодирование, что и `pipelineFilterKey`, не имея под рукой прогона.
 */
export function describePipelineFilterValue(value: string): string {
  if (value === 'unnamed') return 'unnamed';
  const sep = value.indexOf(':');
  return sep === -1 ? value : value.slice(sep + 1);
}

export interface RunFilterValues {
  readonly projects: readonly FilterOption[];
  readonly pipelines: readonly FilterOption[];
  readonly statuses: readonly FilterOption[];
}

/**
 * Значения фильтров, собранные из прогонов обзора: значение, которому не
 * отвечает ни один прогон, в списке не появляется вовсе (Решение 6) — его
 * держит на экране состояние фильтра, а не этот список.
 */
export function collectFilterValues<R extends RunLike>(
  projects: readonly ProjectLike<R>[],
): RunFilterValues {
  const projectOptions = new Map<string, string>();
  const pipelineOptions = new Map<string, string>();
  const statuses = new Set<string>();

  for (const project of projects) {
    if (!projectOptions.has(project.key)) {
      projectOptions.set(project.key, project.path ?? unknownPathLabel(project.key));
    }
    for (const run of project.runs) {
      const key = pipelineFilterKey(run);
      if (!pipelineOptions.has(key)) pipelineOptions.set(key, pipelineFilterLabel(run));
      if (run.status !== undefined) statuses.add(run.status);
    }
  }

  return {
    projects: [...projectOptions].map(([value, label]) => ({ value, label })),
    pipelines: [...pipelineOptions].map(([value, label]) => ({ value, label })),
    statuses: [...statuses].sort().map((value) => ({ value, label: value })),
  };
}

/** Фильтры объединяются по «и»; отсутствующее поле означает «все». */
export interface RunFilters {
  readonly project?: string;
  readonly pipeline?: string;
  readonly status?: string;
}

export const EMPTY_FILTERS: RunFilters = {};

function matchesFilters<R extends RunLike>(row: AddressedRun<R>, filters: RunFilters): boolean {
  if (filters.project !== undefined && row.projectKey !== filters.project) return false;
  if (filters.pipeline !== undefined && pipelineFilterKey(row.run) !== filters.pipeline) return false;
  if (filters.status !== undefined && row.run.status !== filters.status) return false;
  return true;
}

export type SortMetric = 'startedAt' | 'duration' | 'cost' | 'tokens';
export type SortDirection = 'asc' | 'desc';

export interface SortOrder {
  readonly metric: SortMetric;
  readonly direction: SortDirection;
}

/** Умолчание экрана: новейшими первыми (Решение 7). */
export const DEFAULT_SORT: SortOrder = { metric: 'startedAt', direction: 'desc' };

function startedAtValue(run: RunLike): number | undefined {
  if (run.startedAt === undefined) return undefined;
  const value = new Date(run.startedAt).getTime();
  return Number.isNaN(value) ? undefined : value;
}

/**
 * Длительность прогона для порядка — то же правило, что `durationOf` в
 * `Runs.tsx`: у идущего прогона считается от начала до `now`, у завершённого —
 * готовое значение обзора. Строка и порядок обязаны говорить одно (Решение 7).
 */
export function runDuration(run: RunLike, now: number): number | undefined {
  if (!run.running || run.startedAt === undefined) return run.durationMs;
  const started = new Date(run.startedAt).getTime();
  return Number.isNaN(started) ? run.durationMs : Math.max(0, now - started);
}

/** Величина прогона по выбранной колонке порядка; `undefined` — величины нет. */
function metricValue(run: RunLike, metric: SortMetric, now: number): number | undefined {
  switch (metric) {
    case 'startedAt':
      return startedAtValue(run);
    case 'duration':
      return runDuration(run, now);
    case 'cost':
      // `null` — цена ни разу не сообщена, то же самое «неизвестно», что и
      // отсутствие сводки вовсе (Решение 7): обе формы уходят в конец.
      return run.usage === undefined || run.usage.costUsd === null ? undefined : run.usage.costUsd;
    case 'tokens':
      return run.usage?.billableTokens;
  }
}

/** Вторичный порядок — новейшими первыми; прогон без старта уходит в конец и здесь. */
function newestFirstTieBreak<R extends RunLike>(a: AddressedRun<R>, b: AddressedRun<R>): number {
  const av = startedAtValue(a.run) ?? 0;
  const bv = startedAtValue(b.run) ?? 0;
  return bv - av;
}

/**
 * Порядок по выбранной величине. Прогон, у которого величины нет, уходит в
 * конец при обоих направлениях (Решение 7) — сравнение ведётся не разностью
 * `undefined`, а явным правилом «нет величины — в конец». Равные величины и
 * пара «оба без величины» разрешаются новейшими первыми, чтобы порядок не
 * переставлялся между обновлениями обзора с теми же значениями.
 */
export function sortRuns<R extends RunLike>(
  rows: readonly AddressedRun<R>[],
  order: SortOrder,
  now: number,
): AddressedRun<R>[] {
  const sign = order.direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = metricValue(a.run, order.metric, now);
    const bv = metricValue(b.run, order.metric, now);
    if (av === undefined && bv === undefined) return newestFirstTieBreak(a, b);
    if (av === undefined) return 1;
    if (bv === undefined) return -1;
    if (av === bv) return newestFirstTieBreak(a, b);
    return (av - bv) * sign;
  });
}

/** Прогоны обзора одним списком, адресованные своим проектом. */
export function flattenRuns<R extends RunLike>(projects: readonly ProjectLike<R>[]): AddressedRun<R>[] {
  const rows: AddressedRun<R>[] = [];
  for (const project of projects) {
    for (const run of project.runs) {
      rows.push({
        address: `${project.key}/${run.runId}`,
        projectKey: project.key,
        ...(project.path === undefined ? {} : { projectPath: project.path }),
        run,
      });
    }
  }
  return rows;
}

/** Прогоны обзора, отфильтрованные по «и» и упорядоченные по выбранной величине. */
export function viewRuns<R extends RunLike>(
  projects: readonly ProjectLike<R>[],
  filters: RunFilters,
  order: SortOrder,
  now: number = Date.now(),
): AddressedRun<R>[] {
  const rows = flattenRuns(projects).filter((row) => matchesFilters(row, filters));
  return sortRuns(rows, order, now);
}
