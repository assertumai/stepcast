import { formatDuration, formatTokens } from '../units.js';
import type { Budget } from '../pipeline/model.js';
import type { Usage, UsageReport } from '../journal/schema.js';

/**
 * Учёт расхода и применение бюджета.
 *
 * Расход снимается по мере поступления, а не по завершении попытки: у
 * агентского шага он виден только в потоке, и проверка постфактум означала бы
 * нарушение потолка ровно на величину одного шага.
 */

/**
 * Область бюджета задаётся не строкой, а разобранной ссылкой: сопоставление
 * областей по имени однажды уже привело к тому, что потолок шага молча не
 * срабатывал, потому что попытки хранятся с суффиксом номера.
 */
export type BudgetScope =
  | { readonly kind: 'run'; readonly name: string; readonly budget: Budget | undefined }
  | {
      readonly kind: 'job';
      readonly name: string;
      readonly jobId: string;
      readonly budget: Budget | undefined;
    }
  | {
      readonly kind: 'step';
      readonly name: string;
      readonly jobId: string;
      readonly stepId: string;
      readonly budget: Budget | undefined;
    };

export interface Exceeded {
  readonly scope: string;
  readonly dimension: 'tokens' | 'wallclock' | 'rate_limit';
  readonly used: number;
  readonly limit: number;
}

interface Counters {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  billable: number;
  wallclockMs: number;
  attempts: number;
}

function emptyCounters(): Counters {
  return {
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    billable: 0,
    wallclockMs: 0,
    attempts: 0,
  };
}

export class UsageAccumulator {
  private readonly run = emptyCounters();
  private readonly jobs = new Map<string, Counters>();
  private readonly steps = new Map<string, Counters>();
  /** Измерения, которых бэкенд не сообщил: учёт по ним заведомо неполон. */
  private readonly unreported = new Set<string>();
  private readonly startedAt = Date.now();

  constructor(private readonly cacheReadWeight: (backend: string) => number) {}

  /** Заменить накопленное по попытке: расход приходит нарастающим итогом. */
  record(jobId: string, stepId: string, attempt: number, usage: Usage): void {
    const key = `${jobId}/${stepId}#${attempt}`;
    const previous = this.steps.get(key) ?? emptyCounters();
    const current = toCounters(usage, this.cacheReadWeight(usage.backend));

    for (const field of ['tokens_in', 'tokens_out', 'cache_read', 'cache_write'] as const) {
      if (usage[field] === null) this.unreported.add(field);
    }

    this.apply(this.run, previous, current);
    this.apply(this.jobOf(jobId), previous, current);
    this.steps.set(key, { ...current, attempts: 1 });
  }

  private apply(target: Counters, previous: Counters, current: Counters): void {
    target.tokensIn += current.tokensIn - previous.tokensIn;
    target.tokensOut += current.tokensOut - previous.tokensOut;
    target.cacheRead += current.cacheRead - previous.cacheRead;
    target.cacheWrite += current.cacheWrite - previous.cacheWrite;
    target.billable += current.billable - previous.billable;
    target.wallclockMs += current.wallclockMs - previous.wallclockMs;
    target.attempts += 1 - previous.attempts;
  }

  private jobOf(jobId: string): Counters {
    const existing = this.jobs.get(jobId);
    if (existing !== undefined) return existing;
    const created = emptyCounters();
    this.jobs.set(jobId, created);
    return created;
  }

  runTokens(): number {
    return this.run.billable;
  }

  jobTokens(jobId: string): number {
    return this.jobs.get(jobId)?.billable ?? 0;
  }

  stepTokens(jobId: string, stepId: string, attempt: number): number {
    return this.steps.get(`${jobId}/${stepId}#${attempt}`)?.billable ?? 0;
  }

  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  /** Первый потолок, который упёрся. Связывает тот, что ближе. */
  check(scopes: readonly BudgetScope[], usage?: Usage): Exceeded | undefined {
    for (const scope of scopes) {
      const budget = scope.budget;
      if (budget === undefined) continue;

      const used = this.usedFor(scope);
      if (budget.tokens !== undefined && used > budget.tokens) {
        return { scope: scope.name, dimension: 'tokens', used, limit: budget.tokens };
      }

      if (budget.wallclockMs !== undefined && this.elapsedMs() > budget.wallclockMs) {
        return {
          scope: scope.name,
          dimension: 'wallclock',
          used: this.elapsedMs(),
          limit: budget.wallclockMs,
        };
      }

      if (budget.rateLimitPct !== undefined && usage?.rate_limits !== undefined) {
        for (const window of Object.values(usage.rate_limits)) {
          if (window.used_pct > budget.rateLimitPct) {
            return {
              scope: scope.name,
              dimension: 'rate_limit',
              used: window.used_pct,
              limit: budget.rateLimitPct,
            };
          }
        }
      }
    }
    return undefined;
  }

  private usedFor(scope: BudgetScope): number {
    switch (scope.kind) {
      case 'run':
        return this.run.billable;
      case 'job':
        return this.jobs.get(scope.jobId)?.billable ?? 0;
      case 'step':
        // Область шага — все его попытки: иначе повторы обходили бы потолок.
        return this.stepTotal(scope.jobId, scope.stepId);
    }
  }

  private stepTotal(jobId: string, stepId: string): number {
    let total = 0;
    for (const [key, counters] of this.steps) {
      if (key.startsWith(`${jobId}/${stepId}#`)) total += counters.billable;
    }
    return total;
  }

  report(runId: string): UsageReport {
    const jobs: UsageReport['jobs'] = {};

    for (const [jobId, counters] of this.jobs) {
      const steps: Record<string, { billable_tokens: number; wallclock_ms: number; attempts: number }> = {};
      for (const [key, step] of this.steps) {
        if (!key.startsWith(`${jobId}/`)) continue;
        const stepId = key.slice(jobId.length + 1, key.lastIndexOf('#'));
        const existing = steps[stepId] ?? { billable_tokens: 0, wallclock_ms: 0, attempts: 0 };
        steps[stepId] = {
          billable_tokens: existing.billable_tokens + step.billable,
          wallclock_ms: existing.wallclock_ms + step.wallclockMs,
          attempts: existing.attempts + 1,
        };
      }
      jobs[jobId] = {
        billable_tokens: counters.billable,
        wallclock_ms: counters.wallclockMs,
        steps,
      };
    }

    return {
      run_id: runId,
      total: {
        tokens_in: this.run.tokensIn,
        tokens_out: this.run.tokensOut,
        cache_read: this.run.cacheRead,
        cache_write: this.run.cacheWrite,
        billable_tokens: this.run.billable,
        wallclock_ms: this.elapsedMs(),
      },
      unreported: [...this.unreported].sort(),
      jobs,
    };
  }
}

/**
 * В потолок идут входные, выходные и записанные в кеш токены; чтение кеша —
 * с весом. Чтение дешевле обычного ввода примерно вдесятеро, и считать его
 * наравне значило бы объявлять катастрофой то, что на деле экономия.
 */
function toCounters(usage: Usage, cacheReadWeight: number): Counters {
  const tokensIn = usage.tokens_in ?? 0;
  const tokensOut = usage.tokens_out ?? 0;
  const cacheRead = usage.cache_read ?? 0;
  const cacheWrite = usage.cache_write ?? 0;

  return {
    tokensIn,
    tokensOut,
    cacheRead,
    cacheWrite,
    billable: Math.round(tokensIn + tokensOut + cacheWrite + cacheRead * cacheReadWeight),
    wallclockMs: usage.wallclock_ms,
    attempts: 1,
  };
}

export function describeExceeded(exceeded: Exceeded): string {
  switch (exceeded.dimension) {
    case 'tokens':
      return `${exceeded.scope}: израсходовано ${formatTokens(exceeded.used)} при потолке ${formatTokens(exceeded.limit)}`;
    case 'wallclock':
      return `${exceeded.scope}: прошло ${formatDuration(exceeded.used)} при потолке ${formatDuration(exceeded.limit)}`;
    case 'rate_limit':
      return `${exceeded.scope}: окно лимитов израсходовано на ${exceeded.used}% при потолке ${exceeded.limit}%`;
  }
}
