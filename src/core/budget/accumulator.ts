import { formatDuration, formatMoney, formatTokens } from '../units.js';
import type { Budget } from '../pipeline/model.js';
import type { BudgetDimension, Usage, UsageReport } from '../journal/schema.js';

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
/**
 * Область бюджета. `startedAt` — момент, с которого отсчитывается её
 * `wallclock`: у работы это начало работы, у шага — начало шага. Без него
 * потолок времени у любой области означал бы «прогон идёт дольше N», а не
 * «эта область длится дольше N», и, скажем, завершающая работа с потолком в
 * пять минут была бы обречена в любом прогоне длиннее пяти минут.
 */
export type BudgetScope =
  | { readonly kind: 'run'; readonly name: string; readonly budget: Budget | undefined }
  | {
      readonly kind: 'job';
      readonly name: string;
      readonly jobId: string;
      readonly startedAt?: number;
      readonly budget: Budget | undefined;
    }
  | {
      readonly kind: 'step';
      readonly name: string;
      readonly jobId: string;
      readonly stepId: string;
      readonly startedAt?: number;
      readonly budget: Budget | undefined;
    };

export interface Exceeded {
  readonly scope: string;
  readonly dimension: BudgetDimension;
  readonly used: number;
  readonly limit: number;
  /** Режим области, чей потолок упёрся: решает, ждать или остановиться. */
  readonly onExceed: 'wait' | 'stop';
  /** Момент сброса окна — только для rate_limit, только если бэкенд его сообщил. */
  readonly resetsAt?: number;
  /**
   * Причина, по которой объявленный `wait` не привёл к ожиданию. Задана —
   * заменяет стандартное описание превышения объяснением остановки.
   */
  readonly waitDegeneration?: string;
}

/** Интервал сна: нужен, чтобы вычесть из области только ту его часть, что пришлась на её жизнь. */
interface WaitInterval {
  readonly start: number;
  readonly end: number;
}

interface Counters {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  billable: number;
  costMicroUsd: number;
  /** Число попыток в области, для которых цена известна: 0 отличает молчание от факта. */
  costReportedAttempts: number;
  wallclockMs: number;
  attempts: number;
  backend: string;
  model: string | undefined;
  /**
   * Наибольший префикс одного обращения. Не накапливается через `apply()`:
   * максимум разностями не считается, а на уровнях работы и прогона он не
   * ведётся вовсе (см. `record()`/`report()`) — только на уровне попытки.
   */
  peak: number | undefined;
}

function emptyCounters(): Counters {
  return {
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    billable: 0,
    costMicroUsd: 0,
    costReportedAttempts: 0,
    wallclockMs: 0,
    attempts: 0,
    backend: '',
    model: undefined,
    peak: undefined,
  };
}

/** Максимум двух необязательных величин: несообщённое не участвует и не выигрывает как ноль. */
function maxOptional(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

/**
 * Снимок накопленного расхода прогона на момент события: те же величины, что
 * уходят в блок `budget` состояния прогона (`writeStatus` в `run/runner.ts`).
 * `costMicroUsd` отсутствует, а не равен нулю, если ни одна попытка прогона
 * ещё не сообщила цены, — молчание бэкенда не должно выглядеть как бесплатный
 * прогон.
 */
export interface UsageSnapshot {
  readonly tokens: number;
  readonly costMicroUsd?: number;
  readonly elapsedMs: number;
  readonly costUnreportedAttempts: number;
}

/** Снимок, отдаваемый событиям до того, как накопитель прогона создан. */
export const ZERO_USAGE_SNAPSHOT: UsageSnapshot = {
  tokens: 0,
  elapsedMs: 0,
  costUnreportedAttempts: 0,
};

export class UsageAccumulator {
  private readonly run = emptyCounters();
  private readonly jobs = new Map<string, Counters>();
  private readonly steps = new Map<string, Counters>();
  /** Измерения, которых бэкенд не сообщил: учёт по ним заведомо неполон. */
  private readonly unreported = new Set<string>();
  /**
   * Попытки, чей известный на сейчас расход не содержит цены: ключ уходит из
   * множества, как только цена приходит, и остаётся, если попытка завершилась
   * молча — денежные счётчики её не содержат, ноль вместо цены не подставлен.
   */
  private readonly costUnreportedAttempts = new Set<string>();
  /** Событие `budget.cost_unreported` — не чаще одного раза за прогон. */
  private costUnreportedEventEmitted = false;
  private readonly startedAt = Date.now();
  /** Интервалы ожидания сброса окна лимита за весь прогон. */
  private readonly waits: WaitInterval[] = [];
  /** Отличает переисполнения одной и той же попытки в ключах расхода. */
  private sealCounter = 0;
  /**
   * Расход попыток, перенесённых при продолжении оборванной сессии —
   * `<job>/<step>` → расход. Входит в сводку расхода шага (`report()`) как
   * попытка номер 1, наравне с продолженной попыткой того же номера, но не
   * в `usedFor`/`stepTotal`/`usedCostFor`: потолки нового прогона его не
   * считают (design.md, решение 8). Уровни работы и прогона его не несут —
   * `wallclock_ms` там уже занят иным смыслом (у прогона это `elapsedMs()`,
   * реальное время, а не сумма попыток), и раздваивать их семантику ради
   * одного поля не стоит того, что оно добавит за пределами сводки шага.
   */
  private readonly carried = new Map<string, Counters>();

  constructor(private readonly cacheReadWeight: (backend: string) => number) {}

  /**
   * Заменить накопленное по попытке: расход приходит нарастающим итогом —
   * это верно для токенов (стрим одного вызова копит их сообщение за
   * сообщением) и остаётся верным для цены. `total_cost_usd` приходит один
   * раз, в финальной записи `result` (`src/core/backend/claude.ts`), и
   * приходит за сам этот вызов, а не за сессию: `usage` в потоке Claude —
   * посообщённая величина конкретного сообщения, а не накопительный итог
   * сессии (тем же свойством уже пользуется учёт токенов при `session:
   * shared` — иначе он давно бы задвоился). Разностный путь `apply()` от
   * этого не отличается от токенного: цена входит в счётчики как слагаемое.
   *
   * Проверено на живых прогонах: в общей сессии вторая попытка шага стоит
   * заметно меньше первой и соразмерна собственному расходу — $0.9215 против
   * $2.8545 у `implement/write-code` и $1.2912 против $3.2340 у
   * `fix-review/apply-fixes` (прогон 69d707). Накопительный итог дал бы
   * вторую попытку не дешевле первой, поэтому цена — величина вызова, и
   * входит в счётчики слагаемым. Если бэкенд когда-нибудь начнёт сообщать
   * накопительный итог, разойдётся именно денежная сумма при `session:
   * shared`, а не токены, и чинить нужно будет здесь — взяв цену диффом.
   */
  record(jobId: string, stepId: string, attempt: number, usage: Usage): void {
    const key = `${jobId}/${stepId}#${attempt}`;
    const previous = this.steps.get(key) ?? emptyCounters();
    const current = toCounters(usage, this.cacheReadWeight(usage.backend));

    for (const field of ['tokens_in', 'tokens_out', 'cache_read', 'cache_write'] as const) {
      if (usage[field] === null) this.unreported.add(field);
    }
    if (usage.peak_prefix_tokens === undefined) this.unreported.add('peak_prefix_tokens');
    if (usage.reported_cost_usd === undefined) {
      this.costUnreportedAttempts.add(key);
    } else {
      this.costUnreportedAttempts.delete(key);
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
    target.costMicroUsd += current.costMicroUsd - previous.costMicroUsd;
    target.costReportedAttempts += current.costReportedAttempts - previous.costReportedAttempts;
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

  runCostMicroUsd(): number {
    return this.run.costMicroUsd;
  }

  /** Ни одна попытка за весь прогон не сообщила цены. */
  runCostNeverReported(): boolean {
    return this.run.costReportedAttempts === 0;
  }

  /** Число попыток, чей известный на сейчас расход не содержит цены. */
  costUnreportedAttemptCount(): number {
    return this.costUnreportedAttempts.size;
  }

  /**
   * Отдать событие `budget.cost_unreported` не более одного раза за прогон:
   * прогон без единой сообщённой цены при объявленном денежном потолке —
   * это прогон без действующего потолка, и промолчать об этом значит соврать.
   */
  takeCostUnreportedEvent(costDeclared: boolean): boolean {
    if (!costDeclared || this.costUnreportedEventEmitted || this.costUnreportedAttempts.size === 0) {
      return false;
    }
    this.costUnreportedEventEmitted = true;
    return true;
  }

  elapsedMs(): number {
    return Date.now() - this.startedAt - this.sleptMs();
  }

  /** Снимок расхода прогона теми же вызовами, что собирают блок `budget` состояния. */
  snapshot(): UsageSnapshot {
    return {
      tokens: this.runTokens(),
      ...(this.runCostNeverReported() ? {} : { costMicroUsd: this.runCostMicroUsd() }),
      elapsedMs: this.elapsedMs(),
      costUnreportedAttempts: this.costUnreportedAttemptCount(),
    };
  }

  /** Записать интервал сна: вычитается из `elapsedMs()` и из длительности застигнутых им областей. */
  recordWait(start: number, end: number): void {
    this.waits.push({ start, end });
  }

  /** Время, проведённое прогоном в ожидании: объединение интервалов, не сумма. */
  totalWaitMs(): number {
    return this.sleptMs();
  }

  /** Уложится ли ожидание длиной `durationMs` в объявленный предел с учётом уже проспанного. */
  wouldExceedMaxWait(durationMs: number, maxWaitMs: number): boolean {
    return this.totalWaitMs() + durationMs > maxWaitMs;
  }

  /**
   * Зафиксировать расход всех текущих попыток шага перед его переисполнением.
   * Ключи их записей уводятся в сторону: переисполнение начинает счёт заново
   * под теми же именами попыток, а расход оборванной попытки не теряется —
   * он уже вошёл в счётчики прогона и работы и остаётся в собственном счёте
   * шага под новым внутренним именем.
   */
  sealStep(jobId: string, stepId: string): void {
    const prefix = `${jobId}/${stepId}#`;
    for (const [key, counters] of [...this.steps]) {
      if (!key.startsWith(prefix)) continue;
      this.sealCounter += 1;
      const sealedKey = `${key}@seal${this.sealCounter}`;
      this.steps.delete(key);
      this.steps.set(sealedKey, counters);
      if (this.costUnreportedAttempts.delete(key)) this.costUnreportedAttempts.add(sealedKey);
    }
  }

  /**
   * Перенести расход попытки, оборванной отменой в исходном прогоне, в счёт
   * продолжающего шага. Отдельное хранилище: `record()` его не трогает, и
   * потолки прогона, работы и шага остаются точно такими, как если бы
   * продолжение началось с нуля.
   */
  carry(jobId: string, stepId: string, usage: Usage): void {
    this.carried.set(`${jobId}/${stepId}`, toCounters(usage, this.cacheReadWeight(usage.backend)));
    for (const field of ['tokens_in', 'tokens_out', 'cache_read', 'cache_write'] as const) {
      if (usage[field] === null) this.unreported.add(field);
    }
  }

  /**
   * Сон, вычитаемый из области, начавшейся не раньше `sinceMs` (по умолчанию —
   * весь).
   *
   * Интервалы объединяются, а не складываются: две работы, ждавшие сброса окна
   * одновременно, проспали столько же, сколько одна. Сумма длительностей
   * исчерпывала бы `max_wait` вдвое быстрее и вычитала бы из `wallclock`
   * больше, чем прогон действительно проспал.
   */
  private sleptMs(sinceMs?: number): number {
    const clipped = this.waits
      .map((wait) => ({ start: sinceMs === undefined ? wait.start : Math.max(wait.start, sinceMs), end: wait.end }))
      .filter((wait) => wait.end > wait.start)
      .sort((left, right) => left.start - right.start);

    let total = 0;
    let mergedStart: number | undefined;
    let mergedEnd = 0;
    for (const wait of clipped) {
      if (mergedStart === undefined || wait.start > mergedEnd) {
        if (mergedStart !== undefined) total += mergedEnd - mergedStart;
        mergedStart = wait.start;
        mergedEnd = wait.end;
        continue;
      }
      mergedEnd = Math.max(mergedEnd, wait.end);
    }
    if (mergedStart !== undefined) total += mergedEnd - mergedStart;
    return total;
  }

  /**
   * Перевёл ли потолок расход именно этого шага.
   *
   * При одновременном исполнении потолок прогона может упереться из-за
   * соседней работы, пока попытка этого шага идёт. Приписать превышение ей
   * значило бы объявить перерасходом успевшую попытку, которая на потолок
   * ничего не потратила, — и заодно назвать в состоянии прогона две работы
   * там, где превышение произошло на одной.
   *
   * Время и доля окна лимита ничьи: они принадлежат прогону целиком, и
   * вычитать из них чей-то вклад нечего.
   */
  crossedBy(exceeded: Exceeded, jobId: string, stepId: string): boolean {
    switch (exceeded.dimension) {
      case 'tokens':
        return exceeded.used - this.stepTotal(jobId, stepId) <= exceeded.limit;
      case 'cost':
        return exceeded.used - this.stepCostTotal(jobId, stepId) <= exceeded.limit;
      default:
        return true;
    }
  }

  /** Первый потолок, который упёрся. Связывает тот, что ближе. */
  check(scopes: readonly BudgetScope[], usage?: Usage): Exceeded | undefined {
    for (const scope of scopes) {
      const budget = scope.budget;
      if (budget === undefined) continue;

      const used = this.usedFor(scope);
      if (budget.tokens !== undefined && used > budget.tokens) {
        return {
          scope: scope.name,
          dimension: 'tokens',
          used,
          limit: budget.tokens,
          onExceed: budget.onExceed,
        };
      }

      const usedCost = this.usedCostFor(scope);
      if (budget.costMicroUsd !== undefined && usedCost > budget.costMicroUsd) {
        return {
          scope: scope.name,
          dimension: 'cost',
          used: usedCost,
          limit: budget.costMicroUsd,
          // Цена приходит один раз, в финальной записи попытки: денежный
          // потолок не может связывать посреди попытки, и ждать сброса окна
          // лимитов по нему нечего — превышение всегда ведёт в остановку.
          onExceed: 'stop',
        };
      }

      // Область без собственного начала — это прогон: он и начался вместе с
      // учётом.
      const elapsed =
        scope.kind === 'run' || scope.startedAt === undefined
          ? this.elapsedMs()
          : Date.now() - scope.startedAt - this.sleptMs(scope.startedAt);

      if (budget.wallclockMs !== undefined && elapsed > budget.wallclockMs) {
        return {
          scope: scope.name,
          dimension: 'wallclock',
          used: elapsed,
          limit: budget.wallclockMs,
          onExceed: budget.onExceed,
        };
      }

      if (budget.rateLimitPct !== undefined && usage?.rate_limits !== undefined) {
        // Несколько окон могут превысить порог одновременно — берётся более
        // позднее из сообщённых: иначе прогон проснулся бы к сбросу
        // пятичасового окна и немедленно упёрся в недельное.
        let worst: { readonly usedPct: number; readonly resetsAt: number | undefined } | undefined;
        for (const window of Object.values(usage.rate_limits)) {
          if (window.used_pct <= budget.rateLimitPct) continue;
          if (
            worst === undefined ||
            (window.resets_at ?? -Infinity) > (worst.resetsAt ?? -Infinity)
          ) {
            worst = { usedPct: window.used_pct, resetsAt: window.resets_at };
          }
        }
        if (worst !== undefined) {
          return {
            scope: scope.name,
            dimension: 'rate_limit',
            used: worst.usedPct,
            limit: budget.rateLimitPct,
            onExceed: budget.onExceed,
            ...(worst.resetsAt === undefined ? {} : { resetsAt: worst.resetsAt }),
          };
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

  private usedCostFor(scope: BudgetScope): number {
    switch (scope.kind) {
      case 'run':
        return this.run.costMicroUsd;
      case 'job':
        return this.jobs.get(scope.jobId)?.costMicroUsd ?? 0;
      case 'step':
        return this.stepCostTotal(scope.jobId, scope.stepId);
    }
  }

  private stepCostTotal(jobId: string, stepId: string): number {
    let total = 0;
    for (const [key, counters] of this.steps) {
      if (key.startsWith(`${jobId}/${stepId}#`)) total += counters.costMicroUsd;
    }
    return total;
  }

  report(runId: string): UsageReport {
    const jobs: UsageReport['jobs'] = {};

    for (const [jobId, counters] of this.jobs) {
      const steps: Record<
        string,
        {
          billable_tokens: number;
          wallclock_ms: number;
          costMicroUsd: number;
          costReportedAttempts: number;
          /** Максимум по попыткам шага (включая запечатанные) — не сумма. */
          peak: number | undefined;
          attempts: Map<
            number,
            UsageReport['jobs'][string]['steps'][string]['attempts'][number] & {
              costMicroUsd: number;
              costReportedAttempts: number;
            }
          >;
        }
      > = {};
      // Перенесённая попытка синтезирует ключ `<step>#1@carried`: тот же
      // разбор ниже читает её как попытку номер 1 и складывает с продолженной
      // попыткой того же номера — ровно то смешение, которого требует
      // перенос расхода (design.md, решение 8), без отдельной ветки слияния.
      const carriedForJob: (readonly [string, Counters])[] = [];
      for (const [address, counters] of this.carried) {
        if (address.startsWith(`${jobId}/`)) carriedForJob.push([`${address}#1@carried`, counters]);
      }

      for (const [key, step] of [...this.steps, ...carriedForJob]) {
        if (!key.startsWith(`${jobId}/`)) continue;
        // Разбор `stepId#attempt[@sealN]`: суффикс переисполнения роняется —
        // он лишь развёл ключи разных попыток одного номера во времени.
        const rest = key.slice(jobId.length + 1);
        const hashAt = rest.indexOf('#');
        const stepId = rest.slice(0, hashAt);
        const attemptPart = rest.slice(hashAt + 1);
        const sealAt = attemptPart.indexOf('@');
        const attempt = Number(sealAt === -1 ? attemptPart : attemptPart.slice(0, sealAt));

        const existing =
          steps[stepId] ??
          { billable_tokens: 0, wallclock_ms: 0, costMicroUsd: 0, costReportedAttempts: 0, peak: undefined, attempts: new Map() };
        const priorAttempt = existing.attempts.get(attempt);
        // Переисполнение шага запечатывает старую попытку под тем же номером
        // (`sealStep`): её пик не должен теряться, когда новая попытка с тем
        // же номером его не достигла.
        const attemptPeak = maxOptional(priorAttempt?.peak_prefix_tokens, step.peak);
        existing.attempts.set(attempt, {
          attempt,
          backend: step.backend,
          ...(step.model === undefined ? {} : { model: step.model }),
          billable_tokens: (priorAttempt?.billable_tokens ?? 0) + step.billable,
          wallclock_ms: (priorAttempt?.wallclock_ms ?? 0) + step.wallclockMs,
          costMicroUsd: (priorAttempt?.costMicroUsd ?? 0) + step.costMicroUsd,
          costReportedAttempts: (priorAttempt?.costReportedAttempts ?? 0) + step.costReportedAttempts,
          ...(attemptPeak === undefined ? {} : { peak_prefix_tokens: attemptPeak }),
        });
        steps[stepId] = {
          billable_tokens: existing.billable_tokens + step.billable,
          wallclock_ms: existing.wallclock_ms + step.wallclockMs,
          costMicroUsd: existing.costMicroUsd + step.costMicroUsd,
          costReportedAttempts: existing.costReportedAttempts + step.costReportedAttempts,
          peak: maxOptional(existing.peak, step.peak),
          attempts: existing.attempts,
        };
      }
      jobs[jobId] = {
        billable_tokens: counters.billable,
        wallclock_ms: counters.wallclockMs,
        ...(counters.costReportedAttempts > 0 ? { cost_usd: counters.costMicroUsd / 1_000_000 } : {}),
        steps: Object.fromEntries(
          Object.entries(steps).map(([stepId, step]) => [
            stepId,
            {
              billable_tokens: step.billable_tokens,
              wallclock_ms: step.wallclock_ms,
              ...(step.costReportedAttempts > 0 ? { cost_usd: step.costMicroUsd / 1_000_000 } : {}),
              ...(step.peak === undefined ? {} : { peak_prefix_tokens: step.peak }),
              attempts: [...step.attempts.values()]
                .sort((a, b) => a.attempt - b.attempt)
                .map(({ costMicroUsd, costReportedAttempts, ...attempt }) => ({
                  ...attempt,
                  ...(costReportedAttempts > 0 ? { cost_usd: costMicroUsd / 1_000_000 } : {}),
                })),
            },
          ]),
        ),
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
        ...(this.run.costReportedAttempts > 0 ? { cost_usd: this.run.costMicroUsd / 1_000_000 } : {}),
      },
      unreported: [
        ...this.unreported,
        ...(this.costUnreportedAttempts.size > 0 ? ['reported_cost_usd'] : []),
      ].sort(),
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
    costMicroUsd:
      usage.reported_cost_usd === undefined ? 0 : Math.round(usage.reported_cost_usd * 1_000_000),
    costReportedAttempts: usage.reported_cost_usd === undefined ? 0 : 1,
    wallclockMs: usage.wallclock_ms,
    attempts: 1,
    backend: usage.backend,
    model: usage.model,
    peak: usage.peak_prefix_tokens,
  };
}

export function describeExceeded(exceeded: Exceeded): string {
  const base = describeExceededDimension(exceeded);
  return exceeded.waitDegeneration === undefined ? base : `${base}; ${exceeded.waitDegeneration}`;
}

function describeExceededDimension(exceeded: Exceeded): string {
  return `${exceeded.scope}: ${describeBudgetAmounts(exceeded.dimension, exceeded.used, exceeded.limit)}`;
}

/**
 * Израсходованное и потолок в единицах своего измерения.
 *
 * Отдельно от `describeExceeded`, потому что те же величины приходят голыми
 * числами в события `budget.warning`/`budget.exceeded`: микродоллары,
 * миллисекунды и проценты, напечатанные как есть, читаются как токены.
 */
export function describeBudgetAmounts(
  dimension: BudgetDimension,
  used: number,
  limit: number,
): string {
  switch (dimension) {
    case 'tokens':
      // «Трафик», не «размер»/«объём»: потолок считает сумму по всем
      // обращениям к API, а не то, что одновременно лежит в контексте, —
      // см. docs/pipeline-format.md, раздел «Бюджет».
      return `передано ${formatTokens(used)} трафика при потолке ${formatTokens(limit)}`;
    case 'cost':
      return `потрачено ${formatMoney(used)} при потолке ${formatMoney(limit)}`;
    case 'wallclock':
      return `прошло ${formatDuration(used)} при потолке ${formatDuration(limit)}`;
    case 'rate_limit':
      return `окно лимитов израсходовано на ${used}% при потолке ${limit}%`;
  }
}
