import { restorable, type Anchor } from '../anchor/index.js';
import type { Graph } from '../graph.js';
import type { Diagnostic } from '../lint.js';
import type { ExpandedPipeline, Job } from '../pipeline/model.js';

/**
 * Разрешение источника наследования рабочего дерева и правила его объявления.
 *
 * Чистый модуль: без файловой системы и процессов, ровно как у планировщика
 * работ (`scheduler.ts`) — чтобы его можно было проверить без якорей и без
 * подготовки директорий. Вызывающая сторона (`runner.ts`) отвечает за то,
 * чтобы `completed` содержал только уже завершившиеся к этому моменту работы:
 * функция не знает и не проверяет порядок исполнения.
 *
 * Статические правила (`workspaceInheritanceDiagnostics`) живут здесь же, а не
 * в `lint.ts`: их применяют и `stepcast lint`, и предстартовая проверка
 * прогона (`run/workspace.ts`), и держать общее правило в модуле, который
 * импортирует один из его потребителей, значило бы замкнуть импорты в кольцо.
 */

/** Итог завершившейся работы, нужный наследованию. */
export interface CompletedJob {
  /** Рабочая директория, в которой работа исполнялась. */
  readonly dir: string;
  /** Последний зафиксированный якорь. Отсутствует, если работа не дошла до первого шага. */
  readonly anchor?: Anchor;
}

export type InheritSource =
  /** Работа продолжает каталог предшественника: ничего не готовится и не восстанавливается. */
  | { readonly kind: 'continue'; readonly job: string; readonly dir: string }
  /** Работа получает собственный каталог, засеваемый якорем источника. */
  | { readonly kind: 'seed'; readonly job: string; readonly anchor: Anchor }
  /** Источника нет: работа начинает с исходного состояния, как без наследования. */
  | { readonly kind: 'none' };

/**
 * Раскладка, объявленная графом: продолжает ли работа каталог предшественника
 * или заводит собственный, засеваемый его состоянием.
 *
 * Считается по одному лишь документу — исходы работ сюда не входят
 * сознательно: раскладка каталогов не должна зависеть от того, отказала ли
 * бухгалтерия якорей на предыдущей работе.
 */
export type DeclaredInheritance =
  | { readonly kind: 'continue'; readonly source: string }
  | { readonly kind: 'seed'; readonly source: string }
  | { readonly kind: 'none' };

export function declaredInheritance(graph: Graph, job: Job): DeclaredInheritance {
  // В режиме cwd дерево одно на прогон — наследовать нечего, и `lint`
  // запрещает `inherit` здесь же.
  if (job.workspace.mode === 'cwd') return { kind: 'none' };

  const source = chosenSourceId(graph, job);
  if (source === undefined) return { kind: 'none' };

  const dependencies = graph.dependencies.get(job.id) ?? [];
  const predecessor = graph.byId.get(source);
  const soleChainLink =
    dependencies.length === 1 &&
    dependencies[0] === source &&
    (graph.dependents.get(source) ?? []).length === 1 &&
    predecessor?.workspace.mode === job.workspace.mode;

  return soleChainLink ? { kind: 'continue', source } : { kind: 'seed', source };
}

export function resolveInheritSource(
  graph: Graph,
  job: Job,
  completed: ReadonlyMap<string, CompletedJob>,
): InheritSource {
  const declared = declaredInheritance(graph, job);
  if (declared.kind === 'none') return { kind: 'none' };

  if (declared.kind === 'continue') {
    // Продолжение каталога якоря не требует вовсе: файлы предшественника уже
    // лежат на месте. Достаточно, чтобы каталог был, — то есть чтобы работа
    // исполнялась. Пропущенная по `if` работа каталога не заводит, и цепочка
    // на ней обрывается: источник дальше ищется, как при развилке.
    const predecessor = completed.get(declared.source);
    if (predecessor !== undefined) {
      return { kind: 'continue', job: declared.source, dir: predecessor.dir };
    }
  }

  const seed = walkForAnchor(graph, declared.source, completed);
  return seed === undefined ? { kind: 'none' } : { kind: 'seed', job: seed.job, anchor: seed.anchor };
}

/**
 * Работа, чьим деревом каталог этой работы был бы засеян, если бы все работы
 * цепочки исполнились и зафиксировали состояние.
 *
 * Статический двойник `walkForAnchor`: по одному лишь графу отвечает, требует
 * ли раскладка приведения каталога к чужому состоянию вообще. Нужен
 * предстартовой проверке — способ фиксации известен до запуска, и если он
 * восстанавливать не умеет, отказывать надо там, а не подготовкой директории
 * посреди прогона.
 */
export function potentialSeedSource(graph: Graph, job: Job): string | undefined {
  const declared = declaredInheritance(graph, job);
  if (declared.kind !== 'seed') return undefined;

  const seen = new Set<string>();
  let current: string | undefined = declared.source;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const currentJob: Job | undefined = graph.byId.get(current);
    if (currentJob === undefined) return undefined;
    // Работа в режиме cwd дерева для засева не даёт: наследование проходит её
    // насквозь, как работу без якоря.
    if (currentJob.workspace.mode !== 'cwd') return current;
    current = chosenSourceId(graph, currentJob);
  }
  return undefined;
}

/** Источник, выбранный работой: объявленный `inherit`, единственная зависимость, либо ничего. */
function chosenSourceId(graph: Graph, job: Job): string | undefined {
  const inherit = job.workspace.inherit;
  if (inherit === 'none') return undefined;
  if (inherit !== undefined) return inherit;

  const dependencies = graph.dependencies.get(job.id) ?? [];
  return dependencies.length === 1 ? dependencies[0] : undefined;
}

/**
 * Пройти по цепочке источников в поисках дерева, пригодного для засева.
 *
 * Пропущенная или не дошедшая до первого шага работа не останавливает поиск:
 * наследование переходит к её собственному источнику, и так далее до
 * исходного состояния проекта.
 */
function walkForAnchor(
  graph: Graph,
  start: string,
  completed: ReadonlyMap<string, CompletedJob>,
): { readonly job: string; readonly anchor: Anchor } | undefined {
  const seen = new Set<string>();
  let current: string | undefined = start;

  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const currentJob = graph.byId.get(current);
    // Работа в режиме cwd не даёт дерева для засева: её "директория" — это
    // живой каталог разработчика, а не снимок, который имеет смысл копировать
    // в чужую рабочую копию. Наследование ищет дальше, как если бы у неё не
    // было якоря вовсе.
    const completion = currentJob?.workspace.mode === 'cwd' ? undefined : completed.get(current);
    const anchor = completion?.anchor;
    // Якорь, не хранящий содержимого (хеш-манифест вне git), засеять каталог
    // не может: `restore` у него отказывает по устройству. Пропускаем его так
    // же, как отсутствующий, — иначе отказ пришёлся бы на середину прогона.
    if (anchor !== undefined && restorable(anchor)) return { job: current, anchor };

    current = currentJob === undefined ? undefined : chosenSourceId(graph, currentJob);
  }
  return undefined;
}

/**
 * Проверки источника наследования рабочего дерева.
 *
 * Вынесены отдельной функцией и экспортированы: те же четыре отказа должны
 * останавливать прогон, минующий `lint`, в `checkWorkspaceAvailability` —
 * посреди работы называть работу пятой из семи после сорока минут агента
 * недопустимо, если то же самое было видно на нулевой секунде.
 */
export function workspaceInheritanceDiagnostics(
  pipeline: ExpandedPipeline['pipeline'],
  graph: Graph,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const push = (diagnostic: Diagnostic): void => {
    diagnostics.push(diagnostic);
  };

  for (const job of pipeline.jobs) {
    const at = `jobs.${job.id}.workspace.inherit`;
    const inherit = job.workspace.inherit;
    const dependencies = graph.dependencies.get(job.id) ?? [];

    if (inherit !== undefined && job.workspace.mode === 'cwd') {
      push({
        severity: 'error',
        message: `Работа ${job.id} объявляет workspace.inherit при режиме cwd`,
        file: job.source,
        at,
        hint: 'В режиме cwd рабочее дерево одно на прогон — наследовать нечего',
      });
      continue;
    }

    if (inherit !== undefined && inherit !== 'none') {
      if (!graph.byId.has(inherit)) {
        push({
          severity: 'error',
          message: `Работа ${job.id} наследует дерево несуществующей работы ${inherit}`,
          file: job.source,
          at,
          hint: `Известны: ${[...graph.byId.keys()].sort().join(', ')}`,
        });
      } else if (!dependencies.includes(inherit)) {
        push({
          severity: 'error',
          message: `Работа ${job.id} наследует дерево работы ${inherit}, не входящей в её зависимости`,
          file: job.source,
          at,
          hint:
            dependencies.length === 0
              ? 'У работы нет зависимостей'
              : `Допустимы: ${dependencies.join(', ')}`,
        });
      }
    }

    if (inherit === undefined && job.workspace.mode !== 'cwd' && dependencies.length > 1) {
      push({
        severity: 'error',
        message: `Работа ${job.id} зависит от нескольких работ и не объявляет workspace.inherit`,
        file: job.source,
        at,
        hint: `Выберите источник или none: ${dependencies.join(', ')}`,
      });
    }
  }

  return diagnostics;
}
