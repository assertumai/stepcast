import { readUsageSoft } from '../core/journal/reader.js';
import { runPaths } from '../core/journal/paths.js';
import type { StatusValue, UsageAttemptReport, UsageReport } from '../core/journal/schema.js';
import type { Overview, ProjectOverview, RunOverview } from './overview.js';

/**
 * Расход поперёк прогонов: итог за период, дни с разбивкой по моделям,
 * пайплайны с их заходами.
 *
 * Итог каждого прогона берётся из `RunOverview.usage` — той же величины, что
 * уже показывает экран «Прогоны» (`src/ui/overview.ts`), — а `usage.json`
 * перечитывается лишь затем, чтобы разложить этот известный итог по моделям
 * (design.md, Решение 1). Недостача между итогом прогона и суммой его попыток
 * уходит в долю `UNKNOWN_MODEL`: прогон без сводки, сводка прежней формы без
 * перечня попыток и попытка без поля `model` — три случая одной причины
 * (Решение 2). Излишек — сумма попыток больше итога прогона — ужимается
 * пропорционально: см. `spread`. Попытка без `cost_usd` не входит в денежные
 * суммы и не подставляет нуля, но её токены считаются наравне с прочими;
 * число таких попыток названо на уровнях итога, пайплайна и захода.
 *
 * Модуль читает диск (`readUsageSoft`) и живёт только в демоне — в отличие от
 * `routes.ts` и `grouping.ts`, витрина его не импортирует.
 */

export interface UsageMeasure {
  readonly billableTokens: number;
  readonly costUsd: number;
}

export interface UsageModelSlice extends UsageMeasure {
  readonly model: string;
}

export interface UsageDaySlice {
  readonly day: string;
  readonly models: readonly UsageModelSlice[];
}

export interface UsagePipelineRun {
  readonly runId: string;
  readonly shortId: string;
  readonly startedAt?: string;
  /**
   * Календарный день захода, `YYYY-MM-DD`, — тот же, под которым он вошёл в
   * `days`. Считает демон в своём поясе (Решение 3): браузер день не
   * пересчитывает, иначе витрина с другой машины разметила бы заходы по
   * своему поясу и не нашла бы им дня в готовом ряду.
   */
  readonly day: string;
  readonly status?: StatusValue;
  readonly billableTokens: number;
  /** `null` — цена прогона ни разу не сообщена, а не «потрачено ноль». */
  readonly costUsd: number | null;
  readonly costUnreportedAttempts: number;
  /** Ложно — прогон без сводки или со сводкой прежней формы: разреза нет вовсе. */
  readonly breakdownAvailable: boolean;
}

export interface UsagePipelineSlice extends UsageMeasure {
  readonly projectKey: string;
  readonly projectPath?: string;
  readonly pipeline: string;
  readonly pipelineFile?: string;
  readonly costUnreportedAttempts: number;
  /** Новейшими первыми. */
  readonly runs: readonly UsagePipelineRun[];
}

export interface UsageTotal extends UsageMeasure {
  readonly costUnreportedAttempts: number;
  readonly runs: number;
}

export interface UsageResult {
  readonly from: string;
  readonly to: string;
  readonly generatedAt: string;
  readonly total: UsageTotal;
  /** По убыванию расхода деньгами, при равенстве — токенами. */
  readonly models: readonly UsageModelSlice[];
  /** Подряд, по календарю, включая дни без единого прогона. */
  readonly days: readonly UsageDaySlice[];
  /** По убыванию расхода деньгами, при равенстве — токенами. */
  readonly pipelines: readonly UsagePipelineSlice[];
  readonly runsWithoutBreakdown: number;
  readonly undated: number;
}

export interface UsageOptions {
  readonly days?: number;
  readonly now?: Date;
}

/**
 * Наибольший период, который маршрут берётся считать, — десять лет.
 *
 * Предел нужен не расходу, а ряду дней: `days` приходит из запроса, а ряд
 * строится подряд по календарю, и период в сто миллионов дней встал бы
 * массивом на сто миллионов строк в единственном потоке демона. Отклонить
 * такой запрос честнее, чем считать его или молча подменить умолчанием.
 */
export const MAX_USAGE_DAYS = 3650;

/** Доля расхода, чью модель назвать нечем (Решение 2). */
export const UNKNOWN_MODEL = 'модель не сообщена';

/** Строка разреза для прогонов, чей пайплайн назвать нечем (Решение 6). */
export const NO_PIPELINE = 'без пайплайна';

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Календарный день в часовом поясе демона, а не UTC (Решение 3). */
function dayKeyOf(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, delta: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + delta);
  return next;
}

function parseDayKey(day: string): Date {
  const parts = day.split('-');
  return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}

/** Дни от `from` до `to` включительно, подряд по календарю. */
function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  const end = parseDayKey(to).getTime();
  let cursor = parseDayKey(from);
  while (cursor.getTime() <= end) {
    days.push(dayKeyOf(cursor));
    cursor = addDays(cursor, 1);
  }
  return days;
}

/** Календарный день старта прогона; `undefined` — время не читается. */
function runDay(startedAt: string | undefined): string | undefined {
  if (startedAt === undefined) return undefined;
  const date = new Date(startedAt);
  return Number.isNaN(date.getTime()) ? undefined : dayKeyOf(date);
}

interface ModelDelta {
  tokens: number;
  cost: number;
}

function addDelta(map: Map<string, ModelDelta>, model: string, delta: ModelDelta): void {
  const current = map.get(model) ?? { tokens: 0, cost: 0 };
  current.tokens += delta.tokens;
  current.cost += delta.cost;
  map.set(model, current);
}

function* iterateAttempts(report: UsageReport): Generator<UsageAttemptReport> {
  for (const job of Object.values(report.jobs)) {
    for (const step of Object.values(job.steps)) {
      yield* step.attempts;
    }
  }
}

interface RunDecomposition {
  readonly modelDeltas: ReadonlyMap<string, ModelDelta>;
  readonly costUnreportedAttempts: number;
  readonly breakdownAvailable: boolean;
}

/**
 * Разложить известный итог прогона по долям его попыток — по одной мере.
 *
 * Пока сумма попыток не больше итога, доли равны самим величинам попыток, а
 * недостача уходит в `UNKNOWN_MODEL`: разреза на неё нет (Решение 2).
 *
 * Обратный случай — сумма попыток БОЛЬШЕ итога прогона — не выдуман: у шага,
 * продолжившего оборванную сессию, перенесённая попытка входит в перечень
 * попыток сводки, но не в итог работы и не в итог прогона (`docs/run-layout.md`,
 * раздел «Возобновление»; `carried` в `src/core/budget/accumulator.ts`). Тогда
 * доли ужимаются пропорционально: итог прогона на всех экранах один и тот же
 * (Решение 1), а разрез — его разложение, и сумма долей обязана с ним
 * сходиться, иначе столбцы графика перерастают собственный итог периода.
 *
 * `integral` — мера считается целыми (токены): доли берутся разностями
 * округлённых частичных сумм, поэтому и целы, и складываются ровно в итог.
 */
function spread(shares: ReadonlyMap<string, number>, total: number, integral: boolean): Map<string, number> {
  const sum = [...shares.values()].reduce((acc, value) => acc + value, 0);
  const result = new Map<string, number>();

  if (sum <= total) {
    for (const [model, value] of shares) if (value > 0) result.set(model, value);
    const remainder = total - sum;
    if (remainder > 0) result.set(UNKNOWN_MODEL, (result.get(UNKNOWN_MODEL) ?? 0) + remainder);
    return result;
  }

  let exact = 0;
  let given = 0;
  for (const [model, value] of shares) {
    exact += (value / sum) * total;
    const upto = integral ? Math.round(exact) : exact;
    const share = upto - given;
    given = upto;
    if (share > 0) result.set(model, share);
  }
  return result;
}

/**
 * Разложение известного итога прогона по моделям.
 *
 * Итог не пересчитывается: он приходит извне (`run.usage`, обзор
 * наблюдателя). `usage.json` читается лишь ради перечня попыток, а доли
 * приводятся к итогу правилом `spread` — по каждой мере отдельно.
 */
function decomposeRun(runsRoot: string, projectKey: string, run: RunOverview): RunDecomposition {
  const paths = runPaths(runsRoot, projectKey, run.runId);
  const { summary } = readUsageSoft(paths);

  const tokensByModel = new Map<string, number>();
  const costByModel = new Map<string, number>();
  let attemptsCount = 0;
  let costUnreportedAttempts = 0;

  if (summary !== undefined) {
    for (const attempt of iterateAttempts(summary)) {
      attemptsCount += 1;
      const model = attempt.model ?? UNKNOWN_MODEL;
      tokensByModel.set(model, (tokensByModel.get(model) ?? 0) + attempt.billable_tokens);
      if (attempt.cost_usd === undefined) costUnreportedAttempts += 1;
      else costByModel.set(model, (costByModel.get(model) ?? 0) + attempt.cost_usd);
    }
  }

  // `costUsd === null` — цена прогона ни разу не сообщена: денег в разрезе нет
  // вовсе, и ноль здесь означает «нечего раскладывать», а не «потрачено ноль».
  const totalTokens = run.usage?.billableTokens ?? 0;
  const totalCost = run.usage?.costUsd ?? 0;

  const deltas = new Map<string, ModelDelta>();
  for (const [model, tokens] of spread(tokensByModel, totalTokens, true)) {
    addDelta(deltas, model, { tokens, cost: 0 });
  }
  for (const [model, cost] of spread(costByModel, totalCost, false)) {
    addDelta(deltas, model, { tokens: 0, cost });
  }

  return { modelDeltas: deltas, costUnreportedAttempts, breakdownAvailable: attemptsCount > 0 };
}

interface PipelineIdentity {
  readonly key: string;
  readonly pipeline: string;
  readonly pipelineFile?: string;
}

/**
 * Ключ разреза по пайплайну: файл, которым запущен прогон, — а при
 * нечитаемом манифесте запасное правило — имя из состояния, и только когда
 * назвать нечем вовсе — общая строка `NO_PIPELINE` (design.md, Решение 6).
 */
function pipelineIdentity(projectKey: string, run: RunOverview): PipelineIdentity {
  if (run.pipelineFile !== undefined) {
    return { key: `${projectKey} file:${run.pipelineFile}`, pipeline: run.pipeline, pipelineFile: run.pipelineFile };
  }
  if (run.pipeline !== '') {
    return { key: `${projectKey} name:${run.pipeline}`, pipeline: run.pipeline };
  }
  return { key: `${projectKey} none`, pipeline: NO_PIPELINE };
}

function sortByCost<T extends UsageMeasure>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => b.costUsd - a.costUsd || b.billableTokens - a.billableTokens);
}

function newestRunsFirst(runs: readonly UsagePipelineRun[]): UsagePipelineRun[] {
  const at = (run: UsagePipelineRun): number => {
    const value = run.startedAt === undefined ? Number.NaN : new Date(run.startedAt).getTime();
    return Number.isNaN(value) ? 0 : value;
  };
  return [...runs].sort((a, b) => at(b) - at(a));
}

function modelSlices(map: ReadonlyMap<string, ModelDelta>): UsageModelSlice[] {
  return sortByCost([...map].map(([model, delta]) => ({ model, billableTokens: delta.tokens, costUsd: delta.cost })));
}

interface PipelineAccum {
  readonly projectKey: string;
  readonly projectPath?: string;
  readonly pipeline: string;
  readonly pipelineFile?: string;
  tokens: number;
  cost: number;
  costUnreportedAttempts: number;
  runs: UsagePipelineRun[];
}

export function buildUsage(runsRoot: string, overview: Overview, options: UsageOptions = {}): UsageResult {
  const now = options.now ?? new Date();
  const toDate = startOfDay(now);
  const to = dayKeyOf(toDate);

  interface DatedRun {
    readonly project: ProjectOverview;
    readonly run: RunOverview;
    readonly day: string;
  }

  const dated: DatedRun[] = [];
  let undated = 0;

  for (const project of overview.projects) {
    for (const run of project.runs) {
      const day = runDay(run.startedAt);
      if (day === undefined) undated += 1;
      else dated.push({ project, run, day });
    }
  }

  // Без указанного числа дней — весь период наблюдений: нижняя граница берётся
  // по самому раннему прогону, а не выдумывается (Решение 4).
  const earliest = dated.reduce<string | undefined>(
    (min, entry) => (min === undefined || entry.day < min ? entry.day : min),
    undefined,
  );
  const from = options.days !== undefined ? dayKeyOf(addDays(toDate, -(options.days - 1))) : (earliest ?? to);

  const periodRuns = dated.filter((entry) => entry.day >= from && entry.day <= to);

  const modelTotals = new Map<string, ModelDelta>();
  const dayModelTotals = new Map<string, Map<string, ModelDelta>>();
  const pipelineAccum = new Map<string, PipelineAccum>();
  let totalCostUnreportedAttempts = 0;
  let runsWithoutBreakdown = 0;
  let totalTokens = 0;
  let totalCost = 0;

  for (const { project, run, day } of periodRuns) {
    const { modelDeltas, costUnreportedAttempts, breakdownAvailable } = decomposeRun(runsRoot, project.key, run);
    if (!breakdownAvailable) runsWithoutBreakdown += 1;
    totalCostUnreportedAttempts += costUnreportedAttempts;

    for (const [model, delta] of modelDeltas) {
      addDelta(modelTotals, model, delta);
      const dayMap = dayModelTotals.get(day) ?? new Map<string, ModelDelta>();
      addDelta(dayMap, model, delta);
      dayModelTotals.set(day, dayMap);
    }

    const identity = pipelineIdentity(project.key, run);
    const accum: PipelineAccum = pipelineAccum.get(identity.key) ?? {
      projectKey: project.key,
      ...(project.path === undefined ? {} : { projectPath: project.path }),
      pipeline: identity.pipeline,
      ...(identity.pipelineFile === undefined ? {} : { pipelineFile: identity.pipelineFile }),
      tokens: 0,
      cost: 0,
      costUnreportedAttempts: 0,
      runs: [],
    };
    const runTokens = run.usage?.billableTokens ?? 0;
    const runCost = run.usage?.costUsd ?? null;
    totalTokens += runTokens;
    totalCost += runCost ?? 0;
    accum.tokens += runTokens;
    accum.cost += runCost ?? 0;
    accum.costUnreportedAttempts += costUnreportedAttempts;
    accum.runs.push({
      runId: run.runId,
      shortId: run.shortId,
      ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
      day,
      ...(run.status === undefined ? {} : { status: run.status }),
      billableTokens: runTokens,
      costUsd: runCost,
      costUnreportedAttempts,
      breakdownAvailable,
    });
    pipelineAccum.set(identity.key, accum);
  }

  // Итог периода — сумма итогов прогонов из обзора, а не пересчёт по попыткам
  // (Решение 1): то же число, что показывают экран «Прогоны» и строки
  // пайплайнов ниже. С графиком он не расходится по устройству `spread` —
  // доли моделей складываются ровно в итог своего прогона (Решение 2).
  const total: UsageTotal = {
    billableTokens: totalTokens,
    costUsd: totalCost,
    costUnreportedAttempts: totalCostUnreportedAttempts,
    runs: periodRuns.length,
  };

  const days: UsageDaySlice[] = eachDay(from, to).map((day) => ({
    day,
    models: modelSlices(dayModelTotals.get(day) ?? new Map()),
  }));

  const pipelines: UsagePipelineSlice[] = sortByCost(
    [...pipelineAccum.values()].map((accum) => ({
      projectKey: accum.projectKey,
      ...(accum.projectPath === undefined ? {} : { projectPath: accum.projectPath }),
      pipeline: accum.pipeline,
      ...(accum.pipelineFile === undefined ? {} : { pipelineFile: accum.pipelineFile }),
      billableTokens: accum.tokens,
      costUsd: accum.cost,
      costUnreportedAttempts: accum.costUnreportedAttempts,
      runs: newestRunsFirst(accum.runs),
    })),
  );

  return {
    from,
    to,
    generatedAt: now.toISOString(),
    total,
    models: modelSlices(modelTotals),
    days,
    pipelines,
    runsWithoutBreakdown,
    undated,
  };
}
