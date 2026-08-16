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

  return { graph: { main, terminal, dependencies, upstream, byId }, problems };
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
