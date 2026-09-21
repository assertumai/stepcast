import { withCurrentOption, type FilterOption } from './filters.js';

/**
 * Раскладка очереди по колонкам доски и расчёт места вставки при переносе.
 *
 * Живёт рядом с `backlogView.ts` и по той же причине: `.tsx` в этом
 * репозитории не тестируется вовсе, а что в какой колонке лежит и куда
 * встанет перетащенная карточка — смысл экрана, а не его вёрстка.
 *
 * Node-модулей здесь нет намеренно: модуль собирается в браузер
 * (`vite.config.ts`, `ui/tsconfig.json`) наравне с `backlogView.ts`.
 */

/**
 * Встроенные колонки доски. Три — состояния формата очереди
 * (`BACKLOG_STATUSES`), четвёртая — не состояние, а файл: архив
 * (`archived.md`) хранит пункты с их исходом, каким он был.
 *
 * Отдельной колонки `failed` по умолчанию нет: отказ — не место в работе, а
 * исход, и показывается он меткой на карточке в колонке `done`. Колонок,
 * различающих два конца одной и той же завершённости, на доске было бы две
 * почти пустых вместо одной читаемой.
 *
 * Прочие колонки проект заводит сам — по одной на свой статус, в файле
 * `.stepcast/board.yml` (`src/parts/ui/boardFile.ts`). Встроенные в этом
 * файле обязаны быть все: без `todo` некуда было бы положить новый пункт, без
 * `archive` — вынести решённый.
 */
export const SCRUM_COLUMNS = ['todo', 'in_progress', 'done', 'archive'] as const;
export type BuiltinScrumColumn = (typeof SCRUM_COLUMNS)[number];

/** Колонка доски: встроенная либо заведённая проектом под свой статус. */
export type ScrumColumn = string;

export const COLUMN_TITLES: Readonly<Record<BuiltinScrumColumn, string>> = {
  todo: 'К работе',
  in_progress: 'В работе',
  done: 'Сделано',
  archive: 'Архив',
};

const ARCHIVE_COLUMN = 'archive';

/**
 * Форма статуса — копия `BACKLOG_STATUS_PATTERN`
 * (`src/parts/pipeline/domain/backlog/schema.ts`), не импортированная оттуда
 * по той же причине, что `BACKLOG_STATUSES` в `backlogView.ts`: схема тянет
 * `node:path`. Сверку держит `test/ui-scrum-view.test.ts`.
 */
export const STATUS_PATTERN = /^[a-z][a-z0-9_]*$/;

/** Колонка в раскладке проекта: имя статуса (либо `archive`) и необязательное название. */
export interface BoardColumnSpec {
  readonly id: string;
  readonly title?: string;
}

export const DEFAULT_BOARD_COLUMNS: readonly BoardColumnSpec[] = SCRUM_COLUMNS.map((id) => ({ id }));

function isBuiltin(id: string): id is BuiltinScrumColumn {
  return (SCRUM_COLUMNS as readonly string[]).includes(id);
}

export function columnTitle(spec: BoardColumnSpec): string {
  if (spec.title !== undefined && spec.title !== '') return spec.title;
  return isBuiltin(spec.id) ? COLUMN_TITLES[spec.id] : spec.id;
}

/** Колонка, в которую доска вправе перенести карточку: в работу переводит запуск пайплайна, а не перенос. */
export function isDroppable(id: ScrumColumn): boolean {
  return id !== 'in_progress';
}

/**
 * Изъян раскладки колонок либо `undefined`, если раскладка годна. Одна и та
 * же проверка стоит и на чтении файла, и перед его записью.
 */
export function columnsProblem(columns: readonly BoardColumnSpec[]): string | undefined {
  const seen = new Set<string>();
  for (const column of columns) {
    if (!STATUS_PATTERN.test(column.id)) {
      return `колонка «${column.id}» названа не словом из строчных латинских букв, цифр и _`;
    }
    if (seen.has(column.id)) return `колонка «${column.id}» объявлена дважды`;
    seen.add(column.id);
  }
  const missing = SCRUM_COLUMNS.filter((id) => !seen.has(id));
  if (missing.length > 0) return `нет встроенных колонок: ${missing.join(', ')}`;
  return undefined;
}

/**
 * Раскладка с новой колонкой на месте `index` (0 — самой левой). Отказ — текст
 * причины: вызывающий показывает его человеку, а не падает.
 */
export function withColumn(
  columns: readonly BoardColumnSpec[],
  column: BoardColumnSpec,
  index: number,
): readonly BoardColumnSpec[] | string {
  if (column.id === ARCHIVE_COLUMN) return 'имя archive занято колонкой архива';
  if (!Number.isInteger(index) || index < 0 || index > columns.length) {
    return `место ${index} вне доски из ${columns.length} колонок`;
  }
  const next = [...columns.slice(0, index), column, ...columns.slice(index)];
  return columnsProblem(next) ?? next;
}

/** То немногое из пункта очереди, что нужно раскладке: остальное вид не смотрит. */
export interface BoardItemLike {
  readonly slug: string;
  readonly status: string;
  readonly sourceFile: string;
}

export interface BoardProjectLike<Item extends BoardItemLike, Failure> {
  readonly projectKey: string;
  readonly projectPath: string;
  readonly items: readonly Item[];
  readonly failures: readonly Failure[];
  /** Раскладка колонок проекта; отсутствие — встроенная (`DEFAULT_BOARD_COLUMNS`). */
  readonly columns?: readonly BoardColumnSpec[];
}

export interface BoardColumn<Item> {
  readonly id: ScrumColumn;
  readonly title: string;
  readonly items: readonly Item[];
}

/** Пункты со статусом, под который на доске нет колонки. */
export interface UnplacedStatus<Item> {
  readonly status: string;
  readonly items: readonly Item[];
}

export interface BoardView<Item, Failure> {
  /** Ключ показанного проекта; пусто — ни одного проекта с очередью не видно. */
  readonly projectKey: string;
  readonly projectPath: string;
  readonly projectOptions: readonly FilterOption[];
  readonly columns: readonly BoardColumn<Item>[];
  /** Раскладка, по которой построены колонки, — от неё считается место новой. */
  readonly columnSpecs: readonly BoardColumnSpec[];
  /**
   * Статусы без колонки, в порядке первого появления в файле. Пункты с ними не
   * прячутся и не подменяются соседней колонкой: доска показывает их отдельно
   * и предлагает колонку завести.
   */
  readonly unplaced: readonly UnplacedStatus<Item>[];
  readonly failures: readonly Failure[];
  /** Порядок слагов в `backlog.md` — им считается место вставки при переносе между колонками. */
  readonly tasksOrder: readonly string[];
  /** Порядок слагов в `archived.md` — тем же назначением, что и `tasksOrder`. */
  readonly archiveOrder: readonly string[];
}

const ARCHIVE_FILE = 'archived.md';

/**
 * Колонка, в которой пункт виден, либо `undefined`, когда колонки под его
 * статус на доске нет.
 *
 * Файл решает раньше статуса: пункт, вынесенный в архив, показывается в
 * архиве, каким бы ни был его исход, — иначе доска противоречила бы файлу,
 * который человек видит в редакторе. `failed` без собственной колонки
 * показывается в `done` меткой отказа.
 */
export function columnOf(
  item: BoardItemLike,
  columnIds: readonly string[] = SCRUM_COLUMNS,
): ScrumColumn | undefined {
  if (item.sourceFile === ARCHIVE_FILE) return ARCHIVE_COLUMN;
  // Статус `archive` в `backlog.md` колонкой архива не является: архив — файл.
  if (item.status !== ARCHIVE_COLUMN && columnIds.includes(item.status)) return item.status;
  if (item.status === 'failed' && columnIds.includes('done')) return 'done';
  return undefined;
}

/**
 * Доска одного проекта: доска показывает один проект за раз, а не все сразу.
 *
 * Колонка — не список, а место: перетаскивание между досками разных проектов
 * значило бы перенос пункта между файлами разных репозиториев, чего доска не
 * умеет и обещать не должна.
 */
export function viewBoard<Item extends BoardItemLike, Failure>(
  projects: readonly BoardProjectLike<Item, Failure>[],
  selected: string | undefined,
): BoardView<Item, Failure> {
  const options = projects.map((project) => ({ value: project.projectKey, label: project.projectPath }));
  const current = projects.find((project) => project.projectKey === selected) ?? projects[0];

  const items = current?.items ?? [];
  const specs = current?.columns ?? DEFAULT_BOARD_COLUMNS;
  const ids = specs.map((spec) => spec.id);
  const columns = specs.map((spec) => ({
    id: spec.id,
    title: columnTitle(spec),
    items: items.filter((item) => columnOf(item, ids) === spec.id),
  }));

  const unplacedByStatus = new Map<string, Item[]>();
  for (const item of items) {
    if (columnOf(item, ids) !== undefined) continue;
    const bucket = unplacedByStatus.get(item.status);
    if (bucket === undefined) unplacedByStatus.set(item.status, [item]);
    else bucket.push(item);
  }

  return {
    projectKey: current?.projectKey ?? '',
    projectPath: current?.projectPath ?? '',
    // Выбранный проект не исчезает из меню, даже когда его очередь пропала из
    // кадра, — тем же правилом, что у прочих фильтров витрины.
    projectOptions: withCurrentOption(options, selected, (value) => `${value} (очередь не видна)`),
    columns,
    columnSpecs: specs,
    unplaced: [...unplacedByStatus].map(([status, entries]) => ({ status, items: entries })),
    failures: current?.failures ?? [],
    tasksOrder: items.filter((item) => item.sourceFile !== ARCHIVE_FILE).map((item) => item.slug),
    archiveOrder: items.filter((item) => item.sourceFile === ARCHIVE_FILE).map((item) => item.slug),
  };
}

/**
 * Слаг, перед которым встанет карточка, брошенная на место `index` в колонке
 * `column`, — то, что уходит полем `before` в `POST /api/backlog/move`.
 *
 * Внутри колонки ответ очевиден: сосед, стоящий на этом месте сейчас. Бросок
 * в конец колонки отвечает не «в конец файла», а «перед тем, что идёт в файле
 * за последним пунктом колонки»: иначе пункт, переведённый в `todo`, уезжал бы
 * в самый низ `backlog.md`, за все сделанные, и порядок файла переставал бы
 * совпадать с порядком доски.
 *
 * Пустая колонка — единственный случай, когда ответа из неё не выведешь:
 * пункт уходит в конец файла (`undefined`), откуда его подвинет первый же
 * следующий перенос.
 */
export function insertionBefore(
  fileOrder: readonly string[],
  columnSlugs: readonly string[],
  index: number,
): string | undefined {
  const at = columnSlugs[index];
  if (at !== undefined) return at;

  const last = columnSlugs[columnSlugs.length - 1];
  if (last === undefined) return undefined;

  const after = fileOrder.indexOf(last) + 1;
  return after > 0 && after < fileOrder.length ? fileOrder[after] : undefined;
}
