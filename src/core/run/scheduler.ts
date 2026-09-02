import { evaluate, parseExpression } from '../expr/parse.js';
import { buildGraph, type Graph } from '../graph.js';
import { isFailure, type PredicateResult, type SkipKind, type StatusValue } from '../journal/schema.js';
import type { Job, Pipeline } from '../pipeline/model.js';
import { HaltCause, type HaltCauseValue } from './halt.js';

/**
 * Планировщик работ.
 *
 * На каждом обороте берётся множество готовых работ, и из него запускается
 * столько, сколько позволяет предел одновременности; освободившееся место
 * занимает следующая готовая. Выбор на запуск идёт по порядку объявления —
 * порядок завершения зависит от длительности работ, и от него не зависит
 * ничего: ни решение о запуске, ни состав контекста, ни ключ шага.
 *
 * Ввода-вывода здесь нет намеренно — это делает поведение графа проверяемым
 * без процессов, файлов и бэкендов.
 */

export interface JobOutcome {
  readonly status: StatusValue;
  readonly reason?: string;
  /** Причина неуспеха из закрытого перечня `halt.ts`. */
  readonly cause?: HaltCauseValue;
  /** Происхождение пропуска: решение графа либо остановка прогона. */
  readonly skip?: SkipKind;
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
  /**
   * Данные, опубликованные завершившейся работой (`stepcast data`). Приходят
   * запросом, а не полем исхода: их пишет посторонний процесс по ходу
   * работы, и владелец их накопления — журнал прогона, а не планировщик,
   * который файлов не касается вовсе.
   */
  readonly jobData?: (jobId: string) => Readonly<Record<string, string>> | undefined;
  /**
   * Предел числа одновременно идущих работ. Приходит уже сведённым с потолком
   * конфигурации: планировщик знает граф, а не конфигурацию, и читать её здесь
   * значило бы завести второй источник истины о том же числе. Отсутствие —
   * единица: последовательное исполнение в порядке объявления.
   */
  readonly concurrency?: number;
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
  // Предел не меньше единицы: ноль или отрицательное означали бы прогон, в
  // котором ни одна работа не может начаться.
  const limit = Math.max(1, Math.floor(options.concurrency ?? 1));

  let stopping = false;
  /** Ошибка исполнителя, придержанная до завершения идущих работ. */
  let failure: unknown;

  const settle = async (job: Job, outcome: JobOutcome): Promise<void> => {
    settled.set(job.id, outcome);
    order.push(job.id);
    await options.onSettled?.(job, outcome);
    // Неустранимый отказ бэкенда останавливает прогон и мимо `fail_fast:
    // false` — следующая работа упёрлась бы в тот же самый упор.
    if (isFailure(outcome.status) && (pipeline.failFast || isUnrunnable(outcome.cause))) {
      stopping = true;
    }
  };

  const decide = (job: Job, dependencies: readonly string[]): JobOutcome | undefined => {
    const outcomes = dependencies.map((id) => settled.get(id)).filter((item) => item !== undefined);

    // Пропущенная зависимость не блокирует: иначе один флаг, отключающий
    // ревью, тихо отменял бы и архивацию.
    const failed = outcomes.filter((outcome) => isFailure(outcome.status));
    const skipped = outcomes.filter((outcome) => outcome.status === 'skipped');

    if (dependencies.length > 0 && skipped.length === outcomes.length && outcomes.length > 0) {
      return { status: 'skipped', reason: 'все зависимости пропущены', skip: 'condition' };
    }

    if (job.on === 'success' && failed.length > 0) {
      return { status: 'skipped', reason: `on: success, зависимость завершилась отказом`, skip: 'condition' };
    }
    if (job.on === 'failure' && failed.length === 0) {
      return { status: 'skipped', reason: 'on: failure, отказов не было', skip: 'condition' };
    }

    if (job.if !== undefined && !evaluate(parseExpression(job.if), conditionScope())) {
      return { status: 'skipped', reason: `if: ${job.if}`, skip: 'condition' };
    }

    return undefined;
  };

  const conditionScope = (): Record<string, unknown> => {
    const jobs: Record<string, unknown> = {};
    for (const [id, outcome] of settled) {
      // Данные публикуются по ходу работы и переживают её отказ: они
      // рассказывают, что работа успела сделать, — в том числе и о том, на
      // чём она встала. Выход упавшей работы, в отличие от них, не
      // публикуется вовсе.
      const data = options.jobData?.(id);
      jobs[id] = {
        status: outcome.status,
        ...(outcome.status === 'success' && outcome.output !== undefined
          ? { output: outcome.output }
          : {}),
        ...(data === undefined || Object.keys(data).length === 0 ? {} : { data }),
      };
    }
    return { inputs: pipeline.inputs, jobs, ...(options.scopeExtras ?? {}) };
  };

  const runPhase = async (jobs: readonly Job[], phase: 'main' | 'terminal'): Promise<void> => {
    /** Идущие работы: обещание удаляет себя из множества по завершении. */
    const running = new Map<string, Promise<void>>();
    /** Работа взята в оборот: запущена или уже отдала исход. */
    const claimed = new Set<string>();

    for (;;) {
      while (running.size < limit) {
        const job = jobs.find(
          (candidate) =>
            !claimed.has(candidate.id) &&
            (graph.dependencies.get(candidate.id) ?? []).every((id) => settled.has(id)),
        );
        if (job === undefined) break;

        claimed.add(job.id);
        const dependencies = graph.dependencies.get(job.id) ?? [];

        // Отмена, условия и остановка после отказа решаются в момент запуска,
        // а не при сборе множества готовых: работа, ставшая готовой, пока шла
        // соседняя, обязана увидеть её исход — иначе решение зависело бы от
        // того, кто когда попал в выборку.
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
          await settle(job, { status: 'skipped', reason: 'остановлено после отказа (fail_fast)', skip: 'halted' });
          continue;
        }

        const scope = conditionScope();
        const task = (async () => {
          try {
            await settle(job, await options.execute(job, scope));
          } catch (error) {
            // Работа, не отдавшая исхода вовсе, — дефект исполнителя. Ошибка
            // придерживается до завершения остальных идущих: оборвать их на
            // середине хуже, чем сообщить о ней мгновением позже.
            failure ??= error;
            stopping = true;
          }
        })().then(() => {
          running.delete(job.id);
        });
        running.set(job.id, task);
      }

      if (running.size === 0) break;
      // Ждём ближайшего завершения, а не всех: место освобождается по одному,
      // и следующая готовая работа занимает его сразу.
      await Promise.race(running.values());
    }

    // Дефект исполнителя — не исход графа: приписывать работе, упавшей с
    // ошибкой, пропуск «зависимости не разрешились» значило бы записать в
    // состояние прогона неправду, а её соседям по второй фазе — дать
    // основание считать граф исполненным. Ошибка уходит наверх, как только
    // идущие работы отдали исход.
    if (failure !== undefined) return;

    // Работы, до которых очередь не дошла: при неразрешимом графе линт бы уже
    // сообщил, здесь это страховка от бесконечного ожидания.
    for (const job of jobs) {
      if (!settled.has(job.id)) {
        await settle(job, { status: 'skipped', reason: 'зависимости не разрешились', skip: 'halted' });
      }
    }
  };

  // Вторая фаза начинается только после того, как основной граф исполнился
  // весь: работа с `needs: all` зависит от всех разом, и начать её вперемешку
  // с идущими значило бы дать ей неполную картину.
  await runPhase(graph.main, 'main');
  if (failure !== undefined) throw failure;
  await runPhase(graph.terminal, 'terminal');
  if (failure !== undefined) throw failure;

  const results: SettledJob[] = order.map((id) => ({
    id,
    ...(settled.get(id) as JobOutcome),
  }));

  return { settled: results, status: overallStatus(results) };
}

/** Причина, по которой любая следующая работа упёрлась бы в то же самое. */
function isUnrunnable(cause: HaltCauseValue | undefined): boolean {
  return cause === HaltCause.backendRateLimited || cause === HaltCause.backendUnauthenticated;
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
