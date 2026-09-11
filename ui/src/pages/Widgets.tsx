import type { JSX } from 'react';

import type { Overview, WidgetsOverview } from '../api';
import { WidgetHost } from '../widgetHost';

/**
 * Экран «Виджеты» — леса спайка `ui-runtime-widget-spike` (design.md,
 * Решение 13): пункт меню и страница, перечисляющая виджеты проектов и
 * отрисовывающая каждый своей карточкой, — без него признак выполненности
 * спайка непроверяем глазами. Экран временный: его сменят
 * `builtin-pages-as-plugins` (экраны становятся плагинами) и
 * `dashboards-as-files` (виджеты раскладываются пользователем сам).
 */

function projectLabel(overview: Overview | undefined, projectKey: string): string {
  return overview?.projects.find((project) => project.key === projectKey)?.path ?? projectKey;
}

export interface WidgetsProps {
  readonly overview: Overview | undefined;
  readonly widgets: WidgetsOverview | undefined;
}

export function Widgets({ overview, widgets }: WidgetsProps): JSX.Element {
  if (widgets === undefined) return <p className="empty">Загрузка…</p>;

  const total = widgets.projects.reduce((sum, project) => sum + project.widgets.length, 0);
  if (total === 0) {
    return (
      <>
        <h1>Виджеты</h1>
        <p className="empty">
          Виджетов нет ни у одного проекта. Чтобы завести виджет, положите файл <code>*.tsx</code> в каталог{' '}
          <code>.stepcast/widgets/</code> проекта.
        </p>
      </>
    );
  }

  return (
    <>
      <h1>Виджеты</h1>
      {widgets.projects.map((project) => (
        <section className="card" key={project.projectKey}>
          <div className="card-head">
            <h2 className="card-title">{projectLabel(overview, project.projectKey)}</h2>
          </div>
          {project.widgets.length === 0 ? (
            <p className="empty">Виджетов нет</p>
          ) : (
            project.widgets.map((widget) => (
              <div className="widget-frame" key={widget.id}>
                <div className="dim mono widget-frame-title">{widget.id}</div>
                <WidgetHost projectKey={project.projectKey} id={widget.id} version={widget.version} />
              </div>
            ))
          )}
        </section>
      ))}
    </>
  );
}
