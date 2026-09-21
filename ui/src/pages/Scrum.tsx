import { useEffect, useMemo, useState, type JSX } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import {
  columnOf,
  insertionBefore,
  isDroppable,
  viewBoard,
  type ScrumColumn,
} from '../../../src/parts/ui/scrumView';
import {
  addBoardColumn,
  editBacklogItem,
  fetchPipelines,
  launchRun,
  moveBacklogItem,
  type BacklogItemView,
  type BacklogOverview,
  type PipelineView,
} from '../api';
import { fmtTime } from '../format';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from '@stepcast/ui';
import './scrum.css';

/**
 * Доска очереди: встроенные колонки плюс заведённые проектом
 * (`.stepcast/board.yml`), карточки перетаскиваются.
 *
 * Пункт со статусом, под который колонки нет, доску не ломает и в чужую
 * колонку не подкладывается: он показан полосой над доской с предложением
 * завести колонку, и место новой колонки выбирает человек.
 *
 * Данные — тот же живой поток, что у экрана «Бэклог» (событие `backlog`):
 * своего запроса доска не делает, и после правки файла в редакторе карточки
 * встают на новые места сами.
 *
 * Перетаскивание пишет файл: колонка задаёт `status`, место в колонке —
 * положение пункта в `backlog.md`, а колонка «Архив» — перенос в `archived.md`
 * (`POST /api/backlog/move`). Оптимистичного состояния доска не держит:
 * карточка встаёт на новое место, когда его подтвердил файл, — иначе экран
 * показывал бы порядок, которого на диске нет.
 *
 * Колонка «В работе» — единственная, в которую доска не пишет: пункт берёт в
 * работу запуск пайплайна (`backlog pick --only`), проставляя статус и момент
 * взятия одним вызовом. Поэтому бросок на неё открывает выбор пайплайна, а
 * состояние меняет уже прогон.
 */

/** Название входа, которым пайплайн принимает слаг пункта: доска ищет именно его. */
const ITEM_INPUT = 'item';

function Card({
  item,
  dragging,
  selected,
}: {
  readonly item: BacklogItemView;
  readonly dragging?: boolean;
  readonly selected?: boolean;
}): JSX.Element {
  return (
    <article
      className={`scrum-card${dragging === true ? ' dragging' : ''}${selected === true ? ' selected' : ''}`}
    >
      <header className="scrum-card-head">
        <span className="mono small dim">{item.slug}</span>
        {item.track === '' ? null : <span className="scrum-track mono small">{item.track}</span>}
      </header>
      <p className="scrum-card-title">{item.title}</p>
      <footer className="scrum-card-foot small dim">
        {item.status === 'failed' ? <span className="badge failed">failed</span> : null}
        {item.status === 'in_progress' && item.startedAt !== undefined ? (
          <span>взят {fmtTime(item.startedAt)}</span>
        ) : null}
        {item.group === item.slug ? null : <span className="mono">{item.group}</span>}
      </footer>
    </article>
  );
}

/**
 * Карточка, которую можно и перетащить, и выбрать щелчком.
 *
 * Одно другому не мешает: сенсор начинает перетаскивание только после
 * нескольких пикселей движения (`activationConstraint`), и щелчок на месте до
 * него не доходит — иначе выбрать карточку было бы нечем.
 */
function SortableCard({
  item,
  selected,
  onSelect,
}: {
  readonly item: BacklogItemView;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.slug });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
      {...attributes}
      {...listeners}
      onClick={onSelect}
    >
      <Card item={item} selected={selected} />
    </div>
  );
}

function Column({
  id,
  title,
  items,
  note,
  selected,
  onSelect,
}: {
  readonly id: ScrumColumn;
  readonly title: string;
  readonly items: readonly BacklogItemView[];
  readonly note?: string;
  readonly selected: string | undefined;
  readonly onSelect: (slug: string) => void;
}): JSX.Element {
  // Колонка — сама по себе цель броска: без этого пустую колонку нечем было
  // бы наполнить, ведь сортируемых соседей в ней нет.
  const { setNodeRef, isOver } = useDroppable({ id: `column:${id}` });

  return (
    <section className={`scrum-column${isOver ? ' over' : ''}`} ref={setNodeRef}>
      <header className="scrum-column-head">
        <h2>{title}</h2>
        <span className="small dim">{items.length}</span>
      </header>
      {note === undefined ? null : <p className="small dim scrum-column-note">{note}</p>}
      <SortableContext items={items.map((item) => item.slug)} strategy={verticalListSortingStrategy}>
        <div className="scrum-column-body">
          {items.map((item) => (
            <SortableCard
              key={item.slug}
              item={item}
              selected={item.slug === selected}
              onSelect={() => onSelect(item.slug)}
            />
          ))}
        </div>
      </SortableContext>
    </section>
  );
}

/** Что выбирает диалог запуска: пункт, который берут в работу, и пайплайны, которым его есть куда передать. */
interface LaunchIntent {
  readonly item: BacklogItemView;
  readonly projectKey: string;
}

function LaunchDialog({
  intent,
  pipelines,
  onClose,
}: {
  readonly intent: LaunchIntent | undefined;
  readonly pipelines: readonly PipelineView[];
  readonly onClose: () => void;
}): JSX.Element {
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  // Пайплайны проекта целиком, как их нашёл обходом каталога плагин пайплайнов
  // (`GET /api/pipelines`): доска своего перечня не ведёт и о расположении
  // файлов не знает. Разбирающиеся идут первыми — сломанный файл виден с
  // причиной, но выбрать его нельзя.
  const own = pipelines.filter((pipeline) => pipeline.projectKey === intent?.projectKey);
  const runnable = own.filter((pipeline) => pipeline.error === undefined);
  const broken = own.filter((pipeline) => pipeline.error !== undefined);

  useEffect(() => {
    // Выбор сбрасывается на каждое открытие: прошлый пайплайн мог исчезнуть, а
    // предвыбранным ставится тот, кому слаг пункта есть куда передать.
    if (intent === undefined) {
      setChosen(undefined);
      return;
    }
    setError(undefined);
    setChosen(
      (runnable.find((pipeline) => pipeline.inputs.includes(ITEM_INPUT)) ?? runnable[0])?.file,
    );
  }, [intent?.item.slug, intent?.projectKey]);

  const selected = runnable.find((pipeline) => pipeline.file === chosen);

  const start = async (): Promise<void> => {
    if (intent === undefined || selected === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      await launchRun({
        project: intent.projectKey,
        pipeline: selected.file,
        // Вход передаётся только объявившему его пайплайну: движок отвергает
        // необъявленный вход целиком («Параметр item не объявлен»), и запуск
        // умер бы на разборе документа вместо того, чтобы просто отобрать
        // очередной свободный пункт сам.
        ...(selected.inputs.includes(ITEM_INPUT)
          ? { inputs: { [ITEM_INPUT]: intent.item.slug } }
          : {}),
      });
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={intent !== undefined} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Взять в работу</DialogTitle>
          <DialogDescription>
            {intent === undefined ? null : (
              <>
                Пункт <span className="mono">{intent.item.slug}</span>: {intent.item.title}
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {own.length === 0 ? (
          <p className="empty">В каталоге пайплайнов этого проекта не найдено ни одного файла.</p>
        ) : (
          <ul className="scrum-pipelines">
            {runnable.map((pipeline) => (
              <li key={pipeline.file}>
                <label className="scrum-pipeline">
                  <input
                    type="radio"
                    name="scrum-pipeline"
                    value={pipeline.file}
                    checked={pipeline.file === chosen}
                    onChange={() => setChosen(pipeline.file)}
                  />
                  <span className="scrum-pipeline-body">
                    <span className="scrum-pipeline-name">{pipeline.name}</span>
                    <span className="small dim mono">{pipeline.file}</span>
                    <span className="small dim">
                      {pipeline.jobs.length} работ
                      {pipeline.inputs.includes(ITEM_INPUT)
                        ? null
                        : // Честнее сказать заранее, чем показать прогон, взявший
                          // не тот пункт: пайплайн без входа отбирает очередной
                          // свободный сам.
                          ' · пункт не принимает: отберёт очередной свободный сам'}
                    </span>
                  </span>
                </label>
              </li>
            ))}
            {broken.map((pipeline) => (
              <li key={pipeline.file}>
                <span className="scrum-pipeline-body">
                  <span className="scrum-pipeline-name dim">{pipeline.name}</span>
                  <span className="small error">{pipeline.error}</span>
                </span>
              </li>
            ))}
          </ul>
        )}

        {error === undefined ? null : <p className="error">{error}</p>}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button disabled={busy || selected === undefined} onClick={() => void start()}>
            Запустить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Статус без колонки, для которого открыт диалог добавления. */
interface ColumnIntent {
  readonly status: string;
  readonly projectKey: string;
}

/**
 * Диалог «завести колонку»: название и место среди колонок доски.
 *
 * Место выбирается промежутком между соседями, а не номером: «между „К
 * работе“ и „В работе“» читается сразу, номер пришлось бы пересчитывать по
 * доске глазами.
 */
function AddColumnDialog({
  intent,
  columns,
  onClose,
}: {
  readonly intent: ColumnIntent | undefined;
  readonly columns: readonly { readonly id: string; readonly title: string }[];
  readonly onClose: () => void;
}): JSX.Element {
  const [title, setTitle] = useState('');
  const [index, setIndex] = useState(1);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (intent === undefined) return;
    setTitle(intent.status);
    setError(undefined);
    // По умолчанию — сразу за «К работе»: незнакомый статус чаще всего
    // открытый («отложено», «ждёт»), и рядом с очередью ему самое место.
    const todo = columns.findIndex((column) => column.id === 'todo');
    setIndex(todo < 0 ? 0 : todo + 1);
  }, [intent?.status, intent?.projectKey]);

  const quote = (text: string): string => `«${text}»`;
  const placeLabel = (at: number): string => {
    const left = columns[at - 1];
    const right = columns[at];
    if (left === undefined && right !== undefined) return `Первой, перед ${quote(right.title)}`;
    if (right === undefined && left !== undefined) return `Последней, после ${quote(left.title)}`;
    if (left !== undefined && right !== undefined) return `Между ${quote(left.title)} и ${quote(right.title)}`;
    return 'Единственной';
  };

  const add = async (): Promise<void> => {
    if (intent === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const trimmed = title.trim();
      await addBoardColumn({
        project: intent.projectKey,
        id: intent.status,
        index,
        ...(trimmed === '' || trimmed === intent.status ? {} : { title: trimmed }),
      });
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={intent !== undefined} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Добавить колонку</DialogTitle>
          <DialogDescription>
            {intent === undefined ? null : (
              <>
                Под статус <span className="mono">{intent.status}</span>. Раскладка запишется в{' '}
                <span className="mono">.stepcast/board.yml</span> проекта.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <label className="scrum-field">
          <span className="small dim">Название колонки</span>
          <Input value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>

        <p className="small dim">На какое место поставить?</p>
        <ul className="scrum-pipelines">
          {Array.from({ length: columns.length + 1 }, (_, at) => (
            <li key={at}>
              <label className="scrum-pipeline">
                <input
                  type="radio"
                  name="scrum-column-place"
                  value={at}
                  checked={at === index}
                  onChange={() => setIndex(at)}
                />
                <span className="scrum-pipeline-body">{placeLabel(at)}</span>
              </label>
            </li>
          ))}
        </ul>

        {error === undefined ? null : <p className="error">{error}</p>}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button disabled={busy} onClick={() => void add()}>
            Добавить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Поля пункта, которые правит панель: те же, что принимает `POST /api/backlog/item`. */
interface ItemFields {
  title: string;
  why: string;
  done_when: string;
  group: string;
  track: string;
  repos: string;
}

/**
 * Значение поля однострочно (`docs/backlog.md`): многострочный ввод сводится к
 * одной строке при сохранении, а не отвергается. Панель показывает текст в
 * области с переносом — иначе абзац `why` читался бы в щёлку, — и перенос,
 * набранный человеком, ценой отказа в сохранении быть не должен.
 */
function oneLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function fieldsOf(item: BacklogItemView): ItemFields {
  return {
    title: item.title,
    why: item.why,
    done_when: item.doneWhen,
    // Действующая группа равна слагу, когда поле не заполнено: показывать её в
    // поле ввода значило бы предлагать записать в файл то, чего человек не
    // писал (`effectiveGroup`, `src/parts/pipeline/domain/backlog/parse.ts`).
    group: item.group === item.slug ? '' : item.group,
    track: item.track,
    repos: '',
  };
}

/**
 * Панель деталей справа от доски: выбранный пункт целиком, с правкой полей.
 *
 * Правится то, что описывает работу; статус задаёт колонка, `started_at` и
 * `reason` пишет движок — они показаны, но не редактируются
 * (`src/parts/ui/screens/scrum/server.ts`, перечень полей).
 *
 * Форма не перечитывается на каждый кадр живого потока: значения набираются
 * заново только при смене выбранного пункта. Иначе такт наблюдателя,
 * пришедший посреди набора, стирал бы недописанную строку.
 */
function ItemDetails({
  item,
  projectKey,
  onClose,
}: {
  readonly item: BacklogItemView;
  readonly projectKey: string;
  readonly onClose: () => void;
}): JSX.Element {
  const [fields, setFields] = useState<ItemFields>(() => fieldsOf(item));
  const [error, setError] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setFields(fieldsOf(item));
    setError(undefined);
    setSaved(false);
    // Слаг, а не сам пункт: объект приходит новым на каждом кадре потока.
  }, [item.slug]);

  const set = (name: keyof ItemFields, value: string): void => {
    setFields((current) => ({ ...current, [name]: value }));
    setSaved(false);
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await editBacklogItem({
        project: projectKey,
        slug: item.slug,
        fields: {
          title: oneLine(fields.title),
          why: oneLine(fields.why),
          done_when: oneLine(fields.done_when),
          group: oneLine(fields.group),
          track: oneLine(fields.track),
          ...(fields.repos === '' ? {} : { repos: oneLine(fields.repos) }),
        },
      });
      setSaved(true);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="scrum-details">
      <header className="scrum-details-head">
        <span className="mono small">{item.slug}</span>
        <button className="plain" onClick={onClose} title="Закрыть детали">
          ×
        </button>
      </header>

      <p className="small dim scrum-details-meta">
        <span className={`badge ${item.status}`}>{item.status}</span>
        <span className="mono">{item.sourceFile}</span>
        {item.startedAt === undefined ? null : <span>взят {fmtTime(item.startedAt)}</span>}
      </p>

      {item.reason === undefined ? null : <p className="small">причина отказа: {item.reason}</p>}

      <label className="scrum-field">
        <span className="small dim">Заголовок</span>
        <Input value={fields.title} onChange={(event) => set('title', event.target.value)} />
      </label>

      <label className="scrum-field">
        <span className="small dim">Зачем</span>
        <textarea className="sc-input" rows={5} value={fields.why} onChange={(event) => set('why', event.target.value)} />
      </label>

      <label className="scrum-field">
        <span className="small dim">Готово, когда</span>
        <textarea
          className="sc-input"
          rows={5}
          value={fields.done_when}
          onChange={(event) => set('done_when', event.target.value)}
        />
      </label>

      <label className="scrum-field">
        <span className="small dim">Группа</span>
        <Input
          value={fields.group}
          placeholder={item.slug}
          onChange={(event) => set('group', event.target.value)}
        />
      </label>

      <label className="scrum-field">
        <span className="small dim">Вес (track)</span>
        <Input value={fields.track} onChange={(event) => set('track', event.target.value)} />
      </label>

      <label className="scrum-field">
        {/* Пустое поле значит «не трогать»: перечень репозиториев вид пункта не
            несёт, и подставить сюда прежнее значение неоткуда. */}
        <span className="small dim">Репозитории (через запятую)</span>
        <Input value={fields.repos} onChange={(event) => set('repos', event.target.value)} />
      </label>

      {error === undefined ? null : <p className="error">{error}</p>}

      <div className="scrum-details-foot">
        <Button disabled={busy} onClick={() => void save()}>
          Сохранить
        </Button>
        {saved ? <span className="small dim">сохранено</span> : null}
      </div>
    </aside>
  );
}

export function Scrum({ backlog }: { readonly backlog: BacklogOverview | undefined }): JSX.Element {
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [openItem, setOpenItem] = useState<string | undefined>(undefined);
  const [dragging, setDragging] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [intent, setIntent] = useState<LaunchIntent | undefined>(undefined);
  const [columnIntent, setColumnIntent] = useState<ColumnIntent | undefined>(undefined);
  const [pipelines, setPipelines] = useState<readonly PipelineView[]>([]);

  // Пайплайны нужны только диалогу и меняются редко — они приходят разовым
  // запросом, а не живым потоком, тем же приёмом, что на экране «Пайплайны».
  useEffect(() => {
    let alive = true;
    void fetchPipelines()
      .then((result) => {
        if (alive) setPipelines(result.pipelines);
      })
      .catch(() => {
        // Отсутствие списка видно в самом диалоге: он скажет, что подходящего
        // пайплайна нет. Гасить доску из-за этого незачем.
      });
    return () => {
      alive = false;
    };
  }, []);

  const projects = backlog?.projects ?? [];
  const view = useMemo(() => viewBoard(projects, selected), [projects, selected]);

  const sensors = useSensors(
    // Порог в несколько пикселей: без него клик по карточке считался бы
    // началом перетаскивания, и раскрыть карточку было бы нечем.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (backlog === undefined) return <p className="empty">Загрузка…</p>;

  if (projects.length === 0) {
    return (
      <p className="empty">
        Очередей не найдено. Демон ищет файл <code>backlog.md</code> в корне каждого проекта, чьи прогоны он
        видит.
      </p>
    );
  }

  const itemBySlug = new Map(
    [...view.columns, ...view.unplaced].flatMap((group) => group.items.map((item) => [item.slug, item] as const)),
  );
  const columnIds = view.columns.map((column) => column.id);
  const draggedItem = dragging === undefined ? undefined : itemBySlug.get(dragging);
  // Выбранный пункт мог уехать из кадра — например, его убрали из файла
  // руками: панель тогда закрывается сама, а не показывает былое значение.
  const detailed = openItem === undefined ? undefined : itemBySlug.get(openItem);

  /** Колонка, на которую пришёлся бросок: либо сама колонка, либо карточка в ней. */
  const columnOfDrop = (id: string): ScrumColumn | undefined => {
    if (id.startsWith('column:')) return id.slice('column:'.length) as ScrumColumn;
    const over = itemBySlug.get(id);
    return over === undefined ? undefined : columnOf(over, columnIds);
  };

  const onDragEnd = (event: DragEndEvent): void => {
    setDragging(undefined);
    const over = event.over;
    if (over === null) return;

    const slug = String(event.active.id);
    const item = itemBySlug.get(slug);
    const target = columnOfDrop(String(over.id));
    if (item === undefined || target === undefined) return;

    if (target === 'in_progress') {
      // Ни строки в файл: взятие в работу — дело запуска.
      if (item.status === 'in_progress') return;
      setIntent({ item, projectKey: view.projectKey });
      return;
    }
    if (!isDroppable(target)) return;
    // Идущую работу доска не трогает: её состояние ведёт прогон, и перенос
    // карточки посреди захода разошёлся бы с тем, что пишет `backlog finish`.
    if (item.status === 'in_progress') {
      setFailure('Пункт в работе: его исход проставит идущий прогон, а не доска');
      return;
    }

    const column = view.columns.find((entry) => entry.id === target);
    const slugs = (column?.items ?? []).map((entry) => entry.slug).filter((entry) => entry !== slug);
    const overIndex = String(over.id).startsWith('column:') ? slugs.length : slugs.indexOf(String(over.id));
    const order = target === 'archive' ? view.archiveOrder : view.tasksOrder;
    const before = insertionBefore(
      order.filter((entry) => entry !== slug),
      slugs,
      overIndex < 0 ? slugs.length : overIndex,
    );

    setFailure(undefined);
    void moveBacklogItem({
      project: view.projectKey,
      slug,
      column: target,
      ...(before === undefined ? {} : { before }),
    }).catch((cause: Error) => setFailure(cause.message));
  };

  const onDragStart = (event: DragStartEvent): void => setDragging(String(event.active.id));

  return (
    <>
      <h1>Доска</h1>

      <div className="filters">
        <select
          aria-label="Проект"
          value={view.projectKey}
          onChange={(event) => setSelected(event.target.value)}
        >
          {view.projectOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="small dim">{view.projectPath}</span>
      </div>

      {view.failures.length > 0 ? (
        <div>
          {view.failures.map((entry) => (
            <p className="error" key={entry.sourceFile}>
              {entry.sourceFile}: {entry.error}
            </p>
          ))}
        </div>
      ) : null}

      {failure === undefined ? null : <p className="error">{failure}</p>}

      {view.unplaced.map((entry) => (
        <div className="scrum-unplaced" key={entry.status}>
          <p className="small">
            Статус <span className="mono">{entry.status}</span> на доске без колонки:{' '}
            {entry.items.map((item, index) => (
              <span key={item.slug}>
                {index === 0 ? null : ', '}
                <button className="plain mono" onClick={() => setOpenItem(item.slug)} title={item.title}>
                  {item.slug}
                </button>
              </span>
            ))}
          </p>
          <Button onClick={() => setColumnIntent({ status: entry.status, projectKey: view.projectKey })}>
            Добавить колонку
          </Button>
        </div>
      ))}

      <div className="scrum-layout">
        <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragEnd={onDragEnd}>
          <div className="scrum-board">
            {view.columns.map((column) => (
              <Column
                key={column.id}
                id={column.id}
                title={column.title}
                items={column.items}
                selected={openItem}
                onSelect={setOpenItem}
                {...(column.id === 'in_progress' ? { note: 'берёт в работу запуск пайплайна' } : {})}
              />
            ))}
          </div>
          <DragOverlay>{draggedItem === undefined ? null : <Card item={draggedItem} dragging />}</DragOverlay>
        </DndContext>

        {/* Панель живёт рядом с доской, а не поверх неё: правка пункта идёт
            вместе с взглядом на колонки, и модальное окно закрывало бы ровно
            то, ради чего пункт открыли. */}
        {detailed === undefined ? null : (
          <ItemDetails item={detailed} projectKey={view.projectKey} onClose={() => setOpenItem(undefined)} />
        )}
      </div>

      <LaunchDialog intent={intent} pipelines={pipelines} onClose={() => setIntent(undefined)} />
      <AddColumnDialog
        intent={columnIntent}
        columns={view.columns}
        onClose={() => setColumnIntent(undefined)}
      />
    </>
  );
}
