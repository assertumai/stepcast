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
} from '../../../src/ui/backlogView';

/**
 * Экран очереди улучшений: раздел на проект, внутри — пункты в порядке
 * файла, с полосой фильтров по статусу и проекту и выбираемым направлением
 * планового порядка (design.md изменения ui-backlog-filters-sort). Данные
 * приходят живым потоком (`live.ts`, событие `backlog`) — отдельного запроса
 * экран не делает: первый кадр потока и есть первая загрузка.
 *
 * Отбор, нумерация и порядок считает чистый модуль `src/ui/backlogView.ts` —
 * здесь только состояние экрана (что выбрано) и отрисовка, тем же разделением,
 * что у списка прогонов (`Runs.tsx`).
 */

// Единственная сортируемая величина очереди (design.md, Решение 2): имя
// метрики нужно только затем, что `SortHeader` — общий с прогонами компонент.
const PLAN_METRIC = 'plan';

/**
 * Отказы разбора раздела — по одному на не разобравшийся файл: текст, файл и
 * место, тем же приёмом, каким показана карточка неразбираемого пайплайна
 * (`src/ui/pipelines.ts`, `PipelineError`). Подсказки в этом составе нет: ядро
 * очереди её не заполняет (`src/ui/backlog.ts`).
 */
function BacklogFailures({ failures }: { readonly failures: readonly BacklogFailure[] }): JSX.Element {
  return (
    <>
      {failures.map((failure) => (
        <div key={failure.sourceFile}>
          <p className="error">{failure.error}</p>
          <p className="note dim">
            где: <span className="mono">{failure.sourceFile}</span>
            {failure.errorAt === undefined ? null : (
              <>
                {' · '}
                <span className="mono">{failure.errorAt}</span>
              </>
            )}
          </p>
        </div>
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
    <details>
      <summary>{item.title}</summary>
      <p className="note">{item.why}</p>
      <p className="note dim">готово, когда: {item.doneWhen}</p>
    </details>
  );
}

/** Момент взятия у идущего пункта, причина отказа у отказавшего — остальным сказать нечего. */
function OutcomeCell({ item }: { readonly item: BacklogItemView }): JSX.Element | null {
  if (item.status === 'in_progress' && item.startedAt !== undefined) {
    return <span className="small dim">взят {fmtTime(item.startedAt)}</span>;
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
    <section>
      <h2 className="project">{section.projectPath}</h2>

      {section.failures.length > 0 ? <BacklogFailures failures={section.failures} /> : null}

      {section.items.length === 0 ? (
        // Файл(ы) очереди есть, но пунктов в них нет — например, все разобраны
        // в архив. Раздел с отказом уже объяснил себя выше и второго сообщения
        // не получает — «пусто» верно только когда ни один файл не отказал.
        section.failures.length === 0 ? (
          <p className="empty">Очередь пуста: в файле нет ни одного пункта.</p>
        ) : null
      ) : (
        <div className="table-scroll">
          <table className="runs">
            <thead>
              <tr>
                <SortHeader
                  label="План"
                  metric={PLAN_METRIC}
                  order={{ metric: PLAN_METRIC, direction: order }}
                  onSort={onSort}
                  className="num plan-no"
                />
                <th>Слаг</th>
                <th>Файл</th>
                <th>Статус</th>
                <th>Заголовок</th>
                <th>Группа</th>
                <th>Дорожка</th>
                <th>Взятие / причина</th>
              </tr>
            </thead>
            <tbody>
              {section.items.map(({ planNumber, item }) => (
                <tr key={item.slug}>
                  <td className="num mono small plan-no">{planNumber}</td>
                  <td className="mono small">{item.slug}</td>
                  <td className="mono small dim">{item.sourceFile}</td>
                  <td>
                    <span className={`badge ${item.status}`}>{item.status}</span>
                  </td>
                  <td>
                    <TitleCell item={item} />
                  </td>
                  <td className="mono small dim">{item.group}</td>
                  <td className="mono small dim">{item.track}</td>
                  <td>
                    <OutcomeCell item={item} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// Поле фильтра не пишет `undefined` явно (`exactOptionalPropertyTypes`):
// пустой выбор убирает ключ через деструктуризацию, а не обнуляет значение.
function setStatusFilter(filters: BacklogFilters, value: string): BacklogFilters {
  if (value === '') {
    const { status: _status, ...rest } = filters;
    return rest;
  }
  return { ...filters, status: value };
}

function setProjectFilter(filters: BacklogFilters, value: string): BacklogFilters {
  if (value === '') {
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

  if (backlog === undefined) return <p className="empty">Загрузка…</p>;

  if (backlog.projects.length === 0) {
    return (
      <p className="empty">
        Очередей не найдено. Демон ищет файл <code>backlog.md</code> в корне каждого проекта, чьи прогоны
        он видит.
      </p>
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
      <h1>Бэклог</h1>

      <div className="filters">
        <select
          aria-label="Статус"
          value={filters.status ?? ''}
          onChange={(event) => setFilters((current) => setStatusFilter(current, event.target.value))}
        >
          <option value="">все статусы</option>
          {view.statusCounts.map((entry) => (
            <option key={entry.status} value={entry.status}>
              {entry.status} ({entry.count})
            </option>
          ))}
        </select>
        <select
          aria-label="Проект"
          value={filters.project ?? ''}
          onChange={(event) => setFilters((current) => setProjectFilter(current, event.target.value))}
        >
          <option value="">все проекты</option>
          {view.projectOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {isDefaultView ? null : (
          <>
            {/* Сброс стоит, пока вид не умолчание; числа — пока список и вправду
                сужен: «показано 73 из 73» при одном лишь обратном порядке не
                сообщает ничего (design.md, Решение 6). */}
            {view.shown === view.total ? null : (
              <span className="small dim">
                показано {view.shown} из {view.total}
              </span>
            )}
            <button className="plain" onClick={resetView} title="Снять фильтры и вернуть порядок файла">
              сбросить
            </button>
          </>
        )}
      </div>

      {view.sections.length === 0 ? (
        <p className="empty">
          Под фильтры не подошёл ни один пункт.{' '}
          <button className="plain" onClick={resetView}>
            Сбросить фильтры
          </button>
        </p>
      ) : (
        view.sections.map((section) => (
          <ProjectSection key={section.projectKey} section={section} order={order} onSort={onSort} />
        ))
      )}
    </>
  );
}
