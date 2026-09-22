import type { UsageAttemptReport, UsageReport } from './schema.js';

/**
 * Приведение долей расхода по моделям к итогу — общее для записи хранилища
 * расхода (`journal/usageStore.ts`, пишется один раз, при завершении прогона)
 * и для разреза расхода поперёк прогонов в демоне (`ui/usage.ts`, читается на
 * каждый запрос экрана). Правило одно и то же, вынесено сюда, чтобы копии в
 * дереве не разошлись при первой же правке (run-stats-retention, Решение 13).
 */

/** Доля расхода, чью модель назвать нечем. */
export const UNKNOWN_MODEL = 'model not reported';

/**
 * Разложить известный итог по долям попыток — по одной мере.
 *
 * Пока сумма долей не больше итога, доли равны самим величинам, а недостача
 * уходит в `UNKNOWN_MODEL`: разреза на неё нет. Обратный случай — сумма долей
 * БОЛЬШЕ итога — не выдуман: у шага, продолжившего оборванную сессию,
 * перенесённая попытка входит в перечень попыток сводки, но не в итог работы
 * и не в итог прогона (`docs/run-layout.md`, раздел «Возобновление»). Тогда
 * доли ужимаются пропорционально: сумма долей обязана сходиться с итогом,
 * иначе столбцы графика расхода перерастают собственный итог периода.
 *
 * `integral` — мера считается целыми (токены): доли берутся разностями
 * округлённых частичных сумм, поэтому и целы, и складываются ровно в итог.
 */
export function spread(
  shares: ReadonlyMap<string, number>,
  total: number,
  integral: boolean,
): Map<string, number> {
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

/** Все попытки сводки, независимо от работы и шага. */
export function* iterateAttempts(report: UsageReport): Generator<UsageAttemptReport> {
  for (const job of Object.values(report.jobs)) {
    for (const step of Object.values(job.steps)) {
      yield* step.attempts;
    }
  }
}

export interface UsageMeasureDelta {
  readonly billableTokens: number;
  readonly costUsd?: number;
}

export interface ReportBreakdown {
  readonly models: ReadonlyMap<string, UsageMeasureDelta>;
  readonly costUnreportedAttempts: number;
  /** Ложно — сводка без единой попытки: разреза по моделям нет вовсе. */
  readonly breakdownAvailable: boolean;
}

/**
 * Разложение сводки расхода по моделям, приведённое к её же итогу
 * (`report.total`). Общая точка для записи хранилища (итог — свой собственный)
 * и для читателя, у которого другого итога для сверки нет (`decomposeRunFromDisk`
 * в `ui/usage.ts`, когда сводка есть, а записи в хранилище — ещё нет).
 */
export function breakdownReport(report: UsageReport): ReportBreakdown {
  const tokensByModel = new Map<string, number>();
  const costByModel = new Map<string, number>();
  let attemptsCount = 0;
  let costUnreportedAttempts = 0;

  for (const attempt of iterateAttempts(report)) {
    attemptsCount += 1;
    const model = attempt.model ?? UNKNOWN_MODEL;
    tokensByModel.set(model, (tokensByModel.get(model) ?? 0) + attempt.billable_tokens);
    if (attempt.cost_usd === undefined) costUnreportedAttempts += 1;
    else costByModel.set(model, (costByModel.get(model) ?? 0) + attempt.cost_usd);
  }

  const tokenShares = spread(tokensByModel, report.total.billable_tokens, true);
  const costShares = spread(costByModel, report.total.cost_usd ?? 0, false);

  const models = new Map<string, UsageMeasureDelta>();
  for (const [model, billableTokens] of tokenShares) models.set(model, { billableTokens });
  for (const [model, costUsd] of costShares) {
    models.set(model, { billableTokens: models.get(model)?.billableTokens ?? 0, costUsd });
  }

  return { models, costUnreportedAttempts, breakdownAvailable: attemptsCount > 0 };
}
