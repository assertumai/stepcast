import type { StatusValue } from '../core/journal/schema.js';

/**
 * Раскладка работ графом по зависимостям — как стадии в gitlab.
 *
 * Считается на сервере, а не в браузере, по той же причине, по которой там же
 * считается снимок: раскладка — это правило («колонка равна длине
 * длиннейшего пути»), а правила в проекте проверяются тестами, и тесты живут
 * на стороне Node. Браузеру остаётся отрисовка.
 *
 * Семантика `needs: all` повторяет `buildGraph`: такая работа ждёт весь
 * основной граф и в него не входит, поэтому её колонка всегда последняя.
 */

/** Вход раскладки: то немногое из определения работы, что влияет на картину. */
export interface GraphInput {
  readonly id: string;
  /** Как записано в определении: список или `all`. */
  readonly needs: readonly string[];
  readonly on?: 'success' | 'failure' | 'always';
  readonly if?: string;
  readonly status?: StatusValue;
  /** Раскрытая подпись работы: витрина показывает её прямо в узле. */
  readonly display?: Readonly<Record<string, string>>;
}

export interface GraphNode {
  readonly id: string;
  /** Колонка: длина длиннейшего пути от работы без зависимостей. */
  readonly column: number;
  /** Порядок внутри колонки: сохраняет порядок объявления. */
  readonly row: number;
  /** Зависимости, уже раскрытые: `all` превращён в перечень. */
  readonly needs: readonly string[];
  readonly on: 'success' | 'failure' | 'always';
  readonly if?: string;
  /** Работа выполняется не всегда: объявлен `if` или `on` не `success`. */
  readonly conditional: boolean;
  readonly status?: StatusValue;
  /**
   * Подпись работы, уже раскрытая против её данных. Ключ `title` витрина
   * показывает строкой в узле графа; прочие ключи — в карточке работы.
   */
  readonly display?: Readonly<Record<string, string>>;
  /**
   * Предшественники, чей исход отменил эту работу. Заполняется только у
   * пропущенной работы: в разборе неудачного захода это и есть главный вопрос.
   */
  readonly blockedBy: readonly string[];
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  /** Ребро от работы, чей исход отменил зависимую. */
  readonly blocking: boolean;
}

export interface JobGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly columns: number;
}

/** Исход, из-за которого зависимая работа не может выполниться. */
function cancels(status: StatusValue | undefined, on: 'success' | 'failure' | 'always'): boolean {
  if (on === 'always') return false;
  if (status === undefined || status === 'running' || status === 'pending') return false;
  return on === 'success' ? status !== 'success' : status === 'success';
}

export function layoutJobs(jobs: readonly GraphInput[]): JobGraph {
  const known = new Set(jobs.map((job) => job.id));
  const terminal = new Set(jobs.filter((job) => job.needs.includes('all')).map((job) => job.id));
  const mainIds = jobs.map((job) => job.id).filter((id) => !terminal.has(id));

  // Зависимость на несуществующую работу отбрасывается: линт ловит её раньше,
  // а рисовать ребро в пустоту значит показывать связь, которой нет.
  const needsOf = new Map<string, readonly string[]>(
    jobs.map((job) => [
      job.id,
      terminal.has(job.id) ? mainIds : job.needs.filter((id) => known.has(id) && id !== job.id),
    ]),
  );

  const column = new Map<string, number>();
  const depth = (id: string, seen: ReadonlySet<string>): number => {
    const cached = column.get(id);
    if (cached !== undefined) return cached;
    // Цикл линт не пропустит, но раскладка не должна на нём зависать.
    if (seen.has(id)) return 0;

    const inner = new Set(seen).add(id);
    let value = 0;
    for (const need of needsOf.get(id) ?? []) value = Math.max(value, depth(need, inner) + 1);
    column.set(id, value);
    return value;
  };
  for (const job of jobs) depth(job.id, new Set());

  const statusOf = new Map(jobs.map((job) => [job.id, job.status]));
  const onOf = new Map(jobs.map((job) => [job.id, job.on ?? 'success']));

  const rows = new Map<number, number>();
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const job of jobs) {
    const at = column.get(job.id) ?? 0;
    const row = rows.get(at) ?? 0;
    rows.set(at, row + 1);

    const needs = needsOf.get(job.id) ?? [];
    const on = onOf.get(job.id) ?? 'success';
    const blockedBy =
      job.status === 'skipped'
        ? needs.filter((need) => cancels(statusOf.get(need), on))
        : [];

    for (const need of needs) {
      edges.push({ from: need, to: job.id, blocking: blockedBy.includes(need) });
    }

    nodes.push({
      id: job.id,
      column: at,
      row,
      needs,
      on,
      ...(job.if === undefined ? {} : { if: job.if }),
      conditional: job.if !== undefined || on !== 'success',
      ...(job.status === undefined ? {} : { status: job.status }),
      ...(job.display === undefined ? {} : { display: job.display }),
      blockedBy,
    });
  }

  return { nodes, edges, columns: rows.size };
}
