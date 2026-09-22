import { useMemo, useState, type JSX } from 'react';

import type { BacklogFailure, BacklogItemView, BacklogOverview } from '../api';
import { fmtTime } from '../format';
import { SortHeader } from '../SortHeader';
import {
  viewBacklog,
  DEFAULT_ORDER,
  EMPTY_BACKLOG_FILTERS,
  type BacklogFilters,
  type BacklogOrderDirection,
  type BacklogSectionView,
} from '../../../src/parts/ui/backlogView';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  EmptyState,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  statusBadgeVariant,
} from '@stepcast/ui';
import './backlog.css';

/**
 * Экран очереди улучшений: раздел на проект, внутри — пункты в порядке
 * файла, с полосой фильтров по статусу и проекту и выбираемым направлением
 * планового порядка (design.md изменения ui-backlog-filters-sort). Данные
 * приходят живым потоком (`live.ts`, событие `backlog`) — отдельного запроса
 * экран не делает: первый кадр потока и есть первая загрузка.
 *
 * Отбор, нумерация и порядок считает чистый модуль `src/parts/ui/backlogView.ts` —
 * здесь только состояние экрана (что выбрано) и отрисовка, тем же разделением,
 * что у списка прогонов (`Runs.tsx`).
 */

// Единственная сортируемая величина очереди (design.md, Решение 2): имя
// метрики нужно только затем, что `SortHeader` — общий с прогонами компонент.
const PLAN_METRIC = 'plan';

/**
 * Значение «все» у меню Radix: пустая строка там запрещена (она значит
 * «ничего не выбрано»), поэтому «все статусы» и «все проекты» несут своё
 * служебное значение, которое обратно превращается в снятый фильтр.
 */
const ALL = '__all__';

/** Последний сегмент пути проекта — короткое имя для меню и заголовка; полный путь остаётся подсказкой. */
function projectName(path: string): string {
  const segments = path.split('/').filter((segment) => segment !== '');
  return segments[segments.length - 1] ?? path;
}

/**
 * Отказы разбора раздела — по одному на не разобравшийся файл: текст, файл и
 * место, тем же приёмом, каким показана карточка неразбираемого пайплайна
 * (`src/parts/ui/pipelines.ts`, `PipelineError`). Подсказки в этом составе нет: ядро
 * очереди её не заполняет (`src/parts/ui/backlog.ts`).
 */
function BacklogFailures({ failures }: { readonly failures: readonly BacklogFailure[] }): JSX.Element {
  return (
    <>
      {failures.map((failure) => (
        <Alert variant="destructive" key={failure.sourceFile}>
          <AlertTitle>{failure.error}</AlertTitle>
          <AlertDescription>
            at <span className="mono">{failure.sourceFile}</span>
            {failure.errorAt === undefined ? null : (
              <>
                {' · '}
                <span className="mono">{failure.errorAt}</span>
              </>
            )}
          </AlertDescription>
        </Alert>
      ))}
    </>
  );
}

/**
 * Заголовок — сворачиваемая подробность: `why` и `done_when` — абзацы текста,
 * которые список из многих пунктов сделали бы нечитаемым, будь они колонкой
 * (design.md изменения ui-backlog-view, Решение 3). Раскрытие держится в самой
 * ячейке заголовка, а не отдельной строкой списка.
 */
function TitleCell({ item }: { readonly item: BacklogItemView }): JSX.Element {
  return (
    <details className="backlog-title">
      <summary>{item.title}</summary>
      <p className="note">{item.why}</p>
      <p className="note dim">done when: {item.doneWhen}</p>
    </details>
  );
}

/** Момент взятия у идущего пункта, причина отказа у отказавшего — остальным сказать нечего. */
function OutcomeCell({ item }: { readonly item: BacklogItemView }): JSX.Element | null {
  if (item.status === 'in_progress' && item.startedAt !== undefined) {
    return <span className="small dim">picked up {fmtTime(item.startedAt)}</span>;
  }
  if (item.status === 'failed' && item.reason !== undefined) {
    return <span className="small dim">{item.reason}</span>;
  }
  return null;
}

function ProjectSection({
  section,
  order,
  onSort,
}: {
  readonly section: BacklogSectionView<BacklogItemView, BacklogFailure>;
  readonly order: BacklogOrderDirection;
  readonly onSort: () => void;
}): JSX.Element {
  return (
    <section className="backlog-section">
      <header className="backlog-section-head">
        <h2 className="backlog-section-title">{projectName(section.projectPath)}</h2>
        <span className="mono small dim backlog-section-path">{section.projectPath}</span>
      </header>

      {section.failures.length > 0 ? <BacklogFailures failures={section.failures} /> : null}

      {section.items.length === 0 ? (
        // Файл(ы) очереди есть, но пунктов в них нет — например, все разобраны
        // в архив. Раздел с отказом уже объяснил себя выше и второго сообщения
        // не получает — «пусто» верно только когда ни один файл не отказал.
        section.failures.length === 0 ? (
          <EmptyState title="Queue is empty" description="The backlog file has no items." />
        ) : null
      ) : (
        <Table className="runs backlog-table">
          <TableHeader>
            <TableRow>
              <SortHeader
                label="Plan"
                metric={PLAN_METRIC}
                order={{ metric: PLAN_METRIC, direction: order }}
                onSort={onSort}
                className="sc-table-head num plan-no"
              />
              <TableHead>Slug</TableHead>
              <TableHead>File</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Group</TableHead>
              <TableHead>Track</TableHead>
              <TableHead>Picked up / reason</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {section.items.map(({ planNumber, item }) => (
              <TableRow key={item.slug}>
                <TableCell className="num mono small plan-no">{planNumber}</TableCell>
                <TableCell className="mono small">{item.slug}</TableCell>
                <TableCell className="mono small dim">{item.sourceFile}</TableCell>
                <TableCell>
                  <Badge variant={statusBadgeVariant(item.status)}>{item.status}</Badge>
                </TableCell>
                <TableCell>
                  <TitleCell item={item} />
                </TableCell>
                <TableCell className="mono small dim">{item.group}</TableCell>
                <TableCell className="mono small dim">{item.track}</TableCell>
                <TableCell>
                  <OutcomeCell item={item} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

// Поле фильтра не пишет `undefined` явно (`exactOptionalPropertyTypes`):
// пустой выбор убирает ключ через деструктуризацию, а не обнуляет значение.
function setStatusFilter(filters: BacklogFilters, value: string): BacklogFilters {
  if (value === ALL) {
    const { status: _status, ...rest } = filters;
    return rest;
  }
  return { ...filters, status: value };
}

function setProjectFilter(filters: BacklogFilters, value: string): BacklogFilters {
  if (value === ALL) {
    const { project: _project, ...rest } = filters;
    return rest;
  }
  return { ...filters, project: value };
}

export function Backlog({ backlog }: { readonly backlog: BacklogOverview | undefined }): JSX.Element {
  const [filters, setFilters] = useState<BacklogFilters>(EMPTY_BACKLOG_FILTERS);
  const [order, setOrder] = useState<BacklogOrderDirection>(DEFAULT_ORDER);

  const projects = backlog?.projects ?? [];
  const view = useMemo(() => viewBacklog(projects, filters, order), [projects, filters, order]);

  const header = (
    <PageHeader
      title="Backlog"
      description="Improvement queue of every project the daemon sees, in file order; filter by status or project and click the Plan column to flip the order."
    />
  );

  if (backlog === undefined) {
    return (
      <>
        {header}
        <EmptyState title="Loading…" />
      </>
    );
  }

  if (backlog.projects.length === 0) {
    return (
      <>
        {header}
        <EmptyState
          title="No queues found"
          description={
            <>
              The daemon looks for a <code>backlog.md</code> file in the root of every project whose runs it sees.
            </>
          }
        />
      </>
    );
  }

  // Умолчание экрана — все статусы, все проекты, порядок файла (design.md,
  // Решение 6): тем же правилом, что у списка прогонов, сброс возвращает все
  // три сразу.
  const isDefaultView = filters.status === undefined && filters.project === undefined && order === DEFAULT_ORDER;
  const resetView = (): void => {
    setFilters(EMPTY_BACKLOG_FILTERS);
    setOrder(DEFAULT_ORDER);
  };
  const onSort = (): void => setOrder((current) => (current === 'asc' ? 'desc' : 'asc'));

  return (
    <>
      {header}

      <div className="filters backlog-filters">
        <Select
          value={filters.status ?? ALL}
          onValueChange={(value) => setFilters((current) => setStatusFilter(current, value))}
        >
          <SelectTrigger aria-label="Status" className="backlog-filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>all statuses</SelectItem>
            {view.statusCounts.map((entry) => (
              <SelectItem key={entry.status} value={entry.status}>
                {entry.status} ({entry.count})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filters.project ?? ALL}
          onValueChange={(value) => setFilters((current) => setProjectFilter(current, value))}
        >
          <SelectTrigger aria-label="Project" className="backlog-filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>all projects</SelectItem>
            {view.projectOptions.map((option) => (
              <SelectItem key={option.value} value={option.value} title={option.label}>
                {projectName(option.label)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {isDefaultView ? null : (
          <>
            {/* Сброс стоит, пока вид не умолчание; числа — пока список и вправду
                сужен: «показано 73 из 73» при одном лишь обратном порядке не
                сообщает ничего (design.md, Решение 6). */}
            {view.shown === view.total ? null : (
              <span className="small dim">
                showing {view.shown} of {view.total}
              </span>
            )}
            <Button variant="ghost" size="sm" onClick={resetView} title="Clear filters and restore file order">
              reset
            </Button>
          </>
        )}
      </div>

      {view.sections.length === 0 ? (
        <EmptyState
          title="No items match the filters"
          action={
            <Button variant="outline" size="sm" onClick={resetView}>
              Reset filters
            </Button>
          }
        />
      ) : (
        view.sections.map((section) => (
          <ProjectSection key={section.projectKey} section={section} order={order} onSort={onSort} />
        ))
      )}
    </>
  );
}
