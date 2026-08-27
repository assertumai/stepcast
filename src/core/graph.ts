import type { Job, Pipeline } from './pipeline/model.js';

/**
 * Граф работ. Исполнение в этом срезе последовательное, но модель уже
 * множественная: планировщик берёт работы из множества готовых, и снятие
 * ограничения на размер выборки позже даст параллелизм без переписывания.
 */

export interface Graph {
  /** Работы основного графа в порядке объявления. */
  readonly main: readonly Job[];
  /** Работы с `needs: all` — вторая фаза, после исчерпания основного графа. */
  readonly terminal: readonly Job[];
  /** Прямые зависимости работы. */
  readonly dependencies: ReadonlyMap<string, readonly string[]>;
  /**
   * Прямые потомки работы в основном графе — величина, по которой различается
   * линейная цепочка (один потомок) и развилка (больше одного). Работы
   * `needs: all` в счёт не идут: они зависят от всего графа разом, а не
   * связаны отношением зависимости с конкретной работой, — иначе у любой
   * работы пайплайна с терминальной работой на конце фан-аут был бы не меньше
   * двух, и цепочка не отличалась бы от развилки никогда.
   */
  readonly dependents: ReadonlyMap<string, readonly string[]>;
  /** Все работы выше по графу, включая транзитивные. */
  readonly upstream: ReadonlyMap<string, ReadonlySet<string>>;
  readonly byId: ReadonlyMap<string, Job>;
}

export interface GraphProblem {
  readonly kind: 'unknown_dependency' | 'cycle' | 'unreachable' | 'redundant_dependency';
  readonly job: string;
  readonly detail: readonly string[];
}

export interface GraphResult {
  readonly graph: Graph;
  readonly problems: readonly GraphProblem[];
}

export function buildGraph(pipeline: Pipeline): GraphResult {
  const byId = new Map<string, Job>(pipeline.jobs.map((job) => [job.id, job]));
  const main = pipeline.jobs.filter((job) => job.needs !== 'all');
  const terminal = pipeline.jobs.filter((job) => job.needs === 'all');
  const problems: GraphProblem[] = [];

  const dependencies = new Map<string, readonly string[]>();
  for (const job of pipeline.jobs) {
    if (job.needs === 'all') {
      // Работы второй фазы зависят от всего основного графа, но сами в него
      // не входят и друг друга не ждут.
      dependencies.set(
        job.id,
        main.map((item) => item.id),
      );
      continue;
    }

    const unknown = job.needs.filter((id) => !byId.has(id));
    if (unknown.length > 0) {
      problems.push({ kind: 'unknown_dependency', job: job.id, detail: unknown });
    }
    dependencies.set(
      job.id,
      job.needs.filter((id) => byId.has(id)),
    );
  }

  const cycles = findCycles(main, dependencies);
  for (const cycle of cycles) {
    problems.push({ kind: 'cycle', job: cycle[0] as string, detail: cycle });
  }

  const inCycle = new Set(cycles.flat());
  const upstream = computeUpstream(pipeline.jobs, dependencies, inCycle);

  // Недостижима работа, которая сама не в цикле, но зависит от участника цикла:
  // упорядочить её нельзя, значит она не выполнится никогда.
  for (const job of main) {
    if (inCycle.has(job.id)) continue;
    const blocked = [...(upstream.get(job.id) ?? [])].filter((id) => inCycle.has(id));
    if (blocked.length > 0) {
      problems.push({ kind: 'unreachable', job: job.id, detail: blocked.sort() });
    }
  }

  // Транзитивная зависимость, перечисленная явно, — избыточна: она уже
  // подразумевается, а в списке создаёт впечатление осмысленного выбора.
  for (const job of main) {
    const direct = dependencies.get(job.id) ?? [];
    const redundant = direct.filter((candidate) =>
      direct.some((other) => other !== candidate && (upstream.get(other)?.has(candidate) ?? false)),
    );
    if (redundant.length > 0) {
      problems.push({ kind: 'redundant_dependency', job: job.id, detail: [...new Set(redundant)] });
    }
  }

  const dependents = new Map<string, string[]>(pipeline.jobs.map((job) => [job.id, []]));
  for (const job of main) {
    for (const dependency of dependencies.get(job.id) ?? []) {
      dependents.get(dependency)?.push(job.id);
    }
  }

  return { graph: { main, terminal, dependencies, dependents, upstream, byId }, problems };
}

/**
 * Порядок, в котором работы доходят до исполнения.
 *
 * Повторяет выбор планировщика: из множества готовых берётся первая в порядке
 * объявления, основной граф исчерпывается прежде работ с `needs: all`. Порядок
 * объявления сам по себе таким не является — работа может быть объявлена
 * раньше своей зависимости, а вторая фаза идёт после первой независимо от
 * места в документе.
 *
 * Нужен разбору прогона: решение о переиспользовании опирается на то, что к
 * моменту работы уже завершилось, и обход в порядке объявления отвечал бы на
 * этот вопрос иначе, чем сам прогон.
 */
export function executionOrder(graph: Graph): readonly Job[] {
  const settled = new Set<string>();
  const order: Job[] = [];

  const drain = (jobs: readonly Job[]): void => {
    for (;;) {
      const next = jobs.find(
        (job) =>
          !settled.has(job.id) &&
          (graph.dependencies.get(job.id) ?? []).every((id) => settled.has(id)),
      );
      if (next === undefined) return;
      settled.add(next.id);
      order.push(next);
    }
  };

  drain(graph.main);
  drain(graph.terminal);

  // Работы, до которых очередь не дошла: цикл в `needs` либо зависимость от
  // его участника. Такой пайплайн отклоняется проверкой графа, но обход
  // обязан оставаться полным — иначе разбор молча теряет работу.
  for (const job of [...graph.main, ...graph.terminal]) {
    if (!settled.has(job.id)) order.push(job);
  }

  return order;
}

function findCycles(
  jobs: readonly Job[],
  dependencies: ReadonlyMap<string, readonly string[]>,
): string[][] {
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  const visit = (id: string): void => {
    const current = state.get(id);
    if (current === 'done') return;
    if (current === 'visiting') {
      const start = stack.indexOf(id);
      cycles.push(stack.slice(start === -1 ? 0 : start));
      return;
    }

    state.set(id, 'visiting');
    stack.push(id);
    for (const dependency of dependencies.get(id) ?? []) visit(dependency);
    stack.pop();
    state.set(id, 'done');
  };

  for (const job of jobs) visit(job.id);
  return cycles;
}

function computeUpstream(
  jobs: readonly Job[],
  dependencies: ReadonlyMap<string, readonly string[]>,
  inCycle: ReadonlySet<string>,
): Map<string, ReadonlySet<string>> {
  const upstream = new Map<string, ReadonlySet<string>>();

  const collect = (id: string, seen: Set<string>): Set<string> => {
    const cached = upstream.get(id);
    if (cached !== undefined) return new Set(cached);
    if (seen.has(id)) return new Set();

    seen.add(id);
    const out = new Set<string>();
    for (const dependency of dependencies.get(id) ?? []) {
      out.add(dependency);
      if (inCycle.has(dependency)) continue;
      for (const item of collect(dependency, seen)) out.add(item);
    }
    seen.delete(id);

    upstream.set(id, out);
    return new Set(out);
  };

  for (const job of jobs) collect(job.id, new Set());
  return upstream;
}
