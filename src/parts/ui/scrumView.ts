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
 * Колонки доски слева направо. Три из четырёх — состояния формата очереди
 * (`BACKLOG_STATUSES`), четвёртая — не состояние, а файл: архив
 * (`archived.md`) хранит пункты с их исходом, каким он был.
 *
 * Отдельной колонки `failed` нет: отказ — не место в работе, а исход, и
 * показывается он меткой на карточке в колонке `done`. Колонок, различающих
 * два конца одной и той же завершённости, на доске было бы две почти пустых
 * вместо одной читаемой.
 */
export const SCRUM_COLUMNS = ['todo', 'in_progress', 'done', 'archive'] as const;
export type ScrumColumn = (typeof SCRUM_COLUMNS)[number];

export const COLUMN_TITLES: Readonly<Record<ScrumColumn, string>> = {
  todo: 'К работе',
  in_progress: 'В работе',
  done: 'Сделано',
  archive: 'Архив',
};

/** Колонки, в которые доска вправе перенести карточку: в работу переводит запуск пайплайна, а не перенос. */
export const DROPPABLE_COLUMNS: readonly ScrumColumn[] = ['todo', 'done', 'archive'];

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
}

export interface BoardColumn<Item> {
  readonly id: ScrumColumn;
  readonly title: string;
  readonly items: readonly Item[];
}

export interface BoardView<Item, Failure> {
  /** Ключ показанного проекта; пусто — ни одного проекта с очередью не видно. */
  readonly projectKey: string;
  readonly projectPath: string;
  readonly projectOptions: readonly FilterOption[];
  readonly columns: readonly BoardColumn<Item>[];
  readonly failures: readonly Failure[];
  /** Порядок слагов в `backlog.md` — им считается место вставки при переносе между колонками. */
  readonly tasksOrder: readonly string[];
  /** Порядок слагов в `archived.md` — тем же назначением, что и `tasksOrder`. */
  readonly archiveOrder: readonly string[];
}

const ARCHIVE_FILE = 'archived.md';

/**
 * Колонка, в которой пункт виден.
 *
 * Файл решает раньше статуса: пункт, вынесенный в архив, показывается в
 * архиве, каким бы ни был его исход, — иначе доска противоречила бы файлу,
 * который человек видит в редакторе.
 */
export function columnOf(item: BoardItemLike): ScrumColumn {
  if (item.sourceFile === ARCHIVE_FILE) return 'archive';
  switch (item.status) {
    case 'in_progress':
      return 'in_progress';
    case 'done':
    case 'failed':
      return 'done';
    default:
      return 'todo';
  }
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
  const columns = SCRUM_COLUMNS.map((id) => ({
    id,
    title: COLUMN_TITLES[id],
    items: items.filter((item) => columnOf(item) === id),
  }));

  return {
    projectKey: current?.projectKey ?? '',
    projectPath: current?.projectPath ?? '',
    // Выбранный проект не исчезает из меню, даже когда его очередь пропала из
    // кадра, — тем же правилом, что у прочих фильтров витрины.
    projectOptions: withCurrentOption(options, selected, (value) => `${value} (очередь не видна)`),
    columns,
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
