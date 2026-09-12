import { useState, type JSX } from 'react';

import { launchRun, type Overview, type WidgetsOverview } from '../api';
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

/** Пайплайн поставки, запускаемый кнопкой «мигрировать» (`widget-migration`, «Пакет поставляет пайплайн миграции виджетов»). */
export const MIGRATE_PIPELINE = 'stepcast:migrate-widgets';

export type MigrateStatus = 'idle' | 'busy' | 'done' | 'error';

/**
 * Запуск миграции — вынесен из компонента ровно затем, чтобы проверить его без
 * DOM и без имитации клика: у витрины нет инфраструктуры интерактивных проверок
 * (`fireEvent`/`act`), и тем же приёмом живут чистые функции экрана «Решения»
 * (`ui/src/pages/Decisions.tsx`). Возвращается исход, а не бросается отказ:
 * отказ запуска показывается на месте своего проекта, как отказ решения — на
 * месте своей записи.
 */
export async function startMigration(
  projectKey: string,
  launch: (payload: { readonly project: string; readonly pipeline: string }) => Promise<unknown> = launchRun,
): Promise<{ readonly status: 'done' } | { readonly status: 'error'; readonly error: string }> {
  try {
    await launch({ project: projectKey, pipeline: MIGRATE_PIPELINE });
    return { status: 'done' };
  } catch (cause) {
    return { status: 'error', error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/**
 * Действие «мигрировать»: подтверждает приём запуска, а не обещает результат
 * (`ui-widgets`, «Запуск подтверждается, а не обещает результат») — появившийся
 * прогон виден обычным тактом обзора, а его предложения — в очереди
 * (`/proposals`).
 *
 * `initialStatus`/`initialError` — те же швы, что `initialError` у
 * `ProposalActions`: статический рендер проверяет ветки «приём подтверждён» и
 * «запуск отказал», не нажимая кнопку.
 */
export function MigrateAction({
  projectKey,
  initialStatus = 'idle',
  initialError,
}: {
  readonly projectKey: string;
  readonly initialStatus?: MigrateStatus;
  readonly initialError?: string;
}): JSX.Element {
  const [status, setStatus] = useState<MigrateStatus>(initialStatus);
  const [error, setError] = useState<string | undefined>(initialError);

  const run = (): void => {
    setStatus('busy');
    setError(undefined);
    void startMigration(projectKey).then((outcome) => {
      setStatus(outcome.status);
      setError(outcome.status === 'error' ? outcome.error : undefined);
    });
  };

  return (
    <div className="widget-migrate">
      <button disabled={status === 'busy'} onClick={run}>
        мигрировать
      </button>
      {status === 'done' ? (
        <span className="note dim">запуск принят — прогон появится в обзоре, предложения — в очереди</span>
      ) : null}
      {status === 'error' && error !== undefined ? <p className="notice error">{error}</p> : null}
    </div>
  );
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
                {widget.deprecated === undefined ? null : (
                  <p className="notice widget-deprecated">
                    устарел: {widget.deprecated.kind === 'specifier' ? 'спецификатор' : 'имя'} «
                    {widget.deprecated.name}» действующая таблица общих модулей больше не несёт
                    {widget.deprecated.noteText === undefined ? '' : ` — ${widget.deprecated.noteText}`}
                  </p>
                )}
                <WidgetHost projectKey={project.projectKey} id={widget.id} version={widget.version} />
              </div>
            ))
          )}
          {project.widgets.some((widget) => widget.deprecated !== undefined) ? (
            <MigrateAction projectKey={project.projectKey} />
          ) : null}
        </section>
      ))}
    </>
  );
}
