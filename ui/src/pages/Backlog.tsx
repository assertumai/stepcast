import type { JSX } from 'react';

import type { BacklogItemView, BacklogOverview, BacklogProjectView } from '../api';
import { fmtTime } from '../format';

/**
 * Экран очереди улучшений: раздел на проект, внутри — пункты в порядке
 * файла (design.md, Решение 3). Данные приходят живым потоком (`live.ts`,
 * событие `backlog`) — отдельного запроса экран не делает: первый кадр
 * потока и есть первая загрузка.
 */

/**
 * Отказ разбора: текст, файл и место — тем же приёмом, каким показана карточка
 * неразбираемого пайплайна (`src/ui/pipelines.ts`, `PipelineError`). Подсказки
 * в этом составе нет: ядро очереди её не заполняет (`src/ui/backlog.ts`).
 */
function BacklogError({ project }: { readonly project: BacklogProjectView }): JSX.Element {
  return (
    <>
      <p className="error">{project.error}</p>
      {project.errorFile === undefined && project.errorAt === undefined ? null : (
        <p className="note dim">
          где: {project.errorFile === undefined ? null : <span className="mono">{project.errorFile}</span>}
          {project.errorFile === undefined || project.errorAt === undefined ? null : ' · '}
          {project.errorAt === undefined ? null : <span className="mono">{project.errorAt}</span>}
        </p>
      )}
    </>
  );
}

/**
 * Заголовок — сворачиваемая подробность: `why` и `done_when` — абзацы текста,
 * которые список из многих пунктов сделали бы нечитаемым, будь они колонкой
 * (design.md, Решение 3). Раскрытие держится в самой ячейке заголовка, а не
 * отдельной строкой списка.
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

function ProjectSection({ project }: { readonly project: BacklogProjectView }): JSX.Element {
  return (
    <section>
      <h2 className="project">{project.projectPath}</h2>

      {project.error !== undefined ? (
        <BacklogError project={project} />
      ) : project.items.length === 0 ? (
        // Файл очереди есть, но пунктов в нём нет — например, все разобраны в
        // архив. Таблица из одних заголовков колонок об этом не говорит ничего.
        <p className="empty">Очередь пуста: в файле нет ни одного пункта.</p>
      ) : (
        <div className="table-scroll">
          <table className="runs">
            <thead>
              <tr>
                <th>Слаг</th>
                <th>Статус</th>
                <th>Заголовок</th>
                <th>Группа</th>
                <th>Дорожка</th>
                <th>Взятие / причина</th>
              </tr>
            </thead>
            <tbody>
              {project.items.map((item) => (
                <tr key={item.slug}>
                  <td className="mono small">{item.slug}</td>
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

export function Backlog({ backlog }: { readonly backlog: BacklogOverview | undefined }): JSX.Element {
  if (backlog === undefined) return <p className="empty">Загрузка…</p>;

  if (backlog.projects.length === 0) {
    return (
      <p className="empty">
        Очередей не найдено. Демон ищет файл <code>backlog.md</code> в корне каждого проекта, чьи прогоны
        он видит.
      </p>
    );
  }

  return (
    <>
      <h1>Бэклог</h1>
      {backlog.projects.map((project) => (
        <ProjectSection key={project.projectKey} project={project} />
      ))}
    </>
  );
}
