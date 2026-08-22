import { evaluate, parseExpression } from '../expr/parse.js';
import { buildGraph, type Graph } from '../graph.js';
import { isFailure, type PredicateResult, type StatusValue } from '../journal/schema.js';
import type { Job, Pipeline } from '../pipeline/model.js';
import { HaltCause, type HaltCauseValue } from './halt.js';

/**
 * Планировщик работ.
 *
 * Исполнение последовательное, но модель множественная: на каждом обороте
 * берётся множество готовых работ и из него выбирается одна. Параллелизм
 * позже станет снятием ограничения на размер выборки, а не переписыванием.
 *
 * Ввода-вывода здесь нет намеренно — это делает поведение графа проверяемым
 * без процессов, файлов и бэкендов.
 */

export interface JobOutcome {
  readonly status: StatusValue;
  readonly reason?: string;
  /** Причина неуспеха из закрытого перечня `halt.ts`. */
  readonly cause?: HaltCauseValue;
  /** Результаты check последней итерации, когда причина — until_not_met. */
  readonly lastCheck?: readonly PredicateResult[];
  /** Опубликованный структурированный выход, если работа его произвела. */
  readonly output?: unknown;
}

export interface SettledJob extends JobOutcome {
  readonly id: string;
}

export interface ScheduleOptions {
  readonly pipeline: Pipeline;
  readonly graph?: Graph;
  /**
   * Исполнить работу. Планировщик не знает, что происходит внутри, но отдаёт
   * ту же область видимости, которой сам проверяет условия: иначе
   * `if: "jobs.plan.status == 'success'"` и `${jobs.plan.status}` начнут
   * отвечать по-разному, и объяснить это будет нечем.
   */
  readonly execute: (job: Job, scope: Record<string, unknown>) => Promise<JobOutcome>;
  /** Дополнительные значения для условий и подстановок: `run`, `env`. */
  readonly scopeExtras?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
  readonly onSettled?: (job: Job, outcome: JobOutcome) => void | Promise<void>;
}

export interface ScheduleResult {
  readonly settled: readonly SettledJob[];
  readonly status: StatusValue;
}

export async function schedule(options: ScheduleOptions): Promise<ScheduleResult> {
  const { pipeline } = options;
  const graph = options.graph ?? buildGraph(pipeline).graph;
  const settled = new Map<string, JobOutcome>();
  const order: string[] = [];

  let stopping = false;

  const settle = async (job: Job, outcome: JobOutcome): Promise<void> => {
    settled.set(job.id, outcome);
    order.push(job.id);
    await options.onSettled?.(job, outcome);
    if (isFailure(outcome.status) && pipeline.failFast) stopping = true;
  };

  const decide = (job: Job, dependencies: readonly string[]): JobOutcome | undefined => {
    const outcomes = dependencies.map((id) => settled.get(id)).filter((item) => item !== undefined);

    // Пропущенная зависимость не блокирует: иначе один флаг, отключающий
    // ревью, тихо отменял бы и архивацию.
    const failed = outcomes.filter((outcome) => isFailure(outcome.status));
    const skipped = outcomes.filter((outcome) => outcome.status === 'skipped');

    if (dependencies.length > 0 && skipped.length === outcomes.length && outcomes.length > 0) {
      return { status: 'skipped', reason: 'все зависимости пропущены' };
    }

    if (job.on === 'success' && failed.length > 0) {
      return { status: 'skipped', reason: `on: success, зависимость завершилась отказом` };
    }
    if (job.on === 'failure' && failed.length === 0) {
      return { status: 'skipped', reason: 'on: failure, отказов не было' };
    }

    if (job.if !== undefined && !evaluate(parseExpression(job.if), conditionScope())) {
      return { status: 'skipped', reason: `if: ${job.if}` };
    }

    return undefined;
  };

  const conditionScope = (): Record<string, unknown> => {
    const jobs: Record<string, unknown> = {};
    for (const [id, outcome] of settled) {
      jobs[id] = {
        status: outcome.status,
        // Выход упавшей работы не публикуется: обращение к нему делает
        // условие ложным, а не роняет прогон.
        ...(outcome.status === 'success' && outcome.output !== undefined
          ? { output: outcome.output }
          : {}),
      };
    }
    return { inputs: pipeline.inputs, jobs, ...(options.scopeExtras ?? {}) };
  };

  const runPhase = async (jobs: readonly Job[], phase: 'main' | 'terminal'): Promise<void> => {
    for (;;) {
      const ready = jobs.filter((job) => {
        if (settled.has(job.id)) return false;
        const dependencies = graph.dependencies.get(job.id) ?? [];
        return dependencies.every((id) => settled.has(id));
      });

      if (ready.length === 0) break;

      // Из множества готовых берём одну: порядок объявления делает выбор
      // детерминированным при любом составе множества.
      const job = ready[0] as Job;
      const dependencies = graph.dependencies.get(job.id) ?? [];

      if (options.signal?.aborted === true && phase === 'main') {
        await settle(job, {
          status: 'canceled',
          reason: 'прогон отменён',
          cause: HaltCause.canceled,
        });
        continue;
      }

      // Условия проверяются раньше fail_fast по двум причинам. Во-первых,
      // «зависимость упала» объясняет пропуск точнее, чем «остановлено после
      // отказа». Во-вторых, остановка касается продолжения работы, а не её
      // разбора: работы с on: failure и on: always должны выполниться и после
      // отказа, иначе разбирать его будет нечем.
      const decision = decide(job, dependencies);
      if (decision !== undefined) {
        await settle(job, decision);
        continue;
      }

      if (stopping && phase === 'main' && job.on === 'success') {
        await settle(job, { status: 'skipped', reason: 'остановлено после отказа (fail_fast)' });
        continue;
      }

      await settle(job, await options.execute(job, conditionScope()));
    }

    // Работы, до которых очередь не дошла: при неразрешимом графе линт бы уже
    // сообщил, здесь это страховка от бесконечного ожидания.
    for (const job of jobs) {
      if (!settled.has(job.id)) {
        await settle(job, { status: 'skipped', reason: 'зависимости не разрешились' });
      }
    }
  };

  await runPhase(graph.main, 'main');
  await runPhase(graph.terminal, 'terminal');

  const results: SettledJob[] = order.map((id) => ({
    id,
    ...(settled.get(id) as JobOutcome),
  }));

  return { settled: results, status: overallStatus(results) };
}

/**
 * Итог прогона. Отмена важнее исчерпания бюджета, а бюджет — важнее обычного
 * отказа: пользователю нужно знать самую внешнюю причину остановки.
 */
export function overallStatus(settled: readonly SettledJob[]): StatusValue {
  if (settled.some((job) => job.status === 'canceled')) return 'canceled';
  if (settled.some((job) => job.status === 'budget_exceeded')) return 'budget_exceeded';
  if (settled.some((job) => job.status === 'failed')) return 'failed';
  return 'success';
}
