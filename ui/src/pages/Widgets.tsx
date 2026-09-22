import { useEffect, useState, type JSX } from 'react';

import {
  BUILTIN_WIDGETS_KEY,
  fetchWidgetCatalog,
  installWidget,
  launchRun,
  type BuiltinWidgetView,
  type Overview,
  type WidgetsOverview,
} from '../api';
import { WidgetHost } from '../widgetHost';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@stepcast/ui';
import './widgets.css';

/**
 * Экран «Widgets» (`ui-overhaul`): каталог образцов поставки, которые можно
 * добавить в проект одной кнопкой, и установленные виджеты проектов с их
 * живой отрисовкой и миграцией устаревших импортов.
 */

function projectPath(overview: Overview | undefined, projectKey: string): string | undefined {
  return overview?.projects.find((project) => project.key === projectKey)?.path;
}

export function projectName(path: string | undefined, projectKey: string): string {
  if (path === undefined) return projectKey;
  const parts = path.split('/').filter((part) => part.length > 0);
  return parts.length === 0 ? path : (parts[parts.length - 1] as string);
}

/** Пайплайн поставки, запускаемый кнопкой «Migrate» (`widget-migration`, «Пакет поставляет пайплайн миграции виджетов»). */
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
 * Действие «Migrate»: подтверждает приём запуска, а не обещает результат
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
      <Button variant="outline" size="sm" disabled={status === 'busy'} onClick={run}>
        Migrate
      </Button>
      {status === 'done' ? (
        <span className="small dim">Launch accepted — the run will appear on Runs, its proposals on Proposals</span>
      ) : null}
      {status === 'error' && error !== undefined ? (
        <Alert variant="destructive" className="widget-migrate-error">
          {error}
        </Alert>
      ) : null}
    </div>
  );
}

export type InstallStatus = 'idle' | 'busy' | 'done' | 'error';

/**
 * Установка образца в проект — той же чистой функцией, что и миграция:
 * исход вместо брошенного отказа, показанный на месте карточки.
 */
export async function startInstall(
  projectKey: string,
  id: string,
  install: (payload: { readonly projectKey: string; readonly id: string }) => Promise<unknown> = installWidget,
): Promise<{ readonly status: 'done' } | { readonly status: 'error'; readonly error: string }> {
  try {
    await install({ projectKey, id });
    return { status: 'done' };
  } catch (cause) {
    return { status: 'error', error: cause instanceof Error ? cause.message : String(cause) };
  }
}

export interface ProjectOption {
  readonly key: string;
  readonly path: string;
}

/** Проекты с известным путём — только в них есть куда положить файл. */
export function installableProjects(overview: Overview | undefined): readonly ProjectOption[] {
  return (overview?.projects ?? [])
    .filter((project): project is typeof project & { readonly path: string } => project.path !== undefined)
    .map((project) => ({ key: project.key, path: project.path }));
}

export function CatalogCard({
  widget,
  projects,
  initialStatus = 'idle',
  initialError,
}: {
  readonly widget: BuiltinWidgetView;
  readonly projects: readonly ProjectOption[];
  readonly initialStatus?: InstallStatus;
  readonly initialError?: string;
}): JSX.Element {
  const [project, setProject] = useState<string>(projects[0]?.key ?? '');
  const [status, setStatus] = useState<InstallStatus>(initialStatus);
  const [error, setError] = useState<string | undefined>(initialError);

  const run = (): void => {
    if (project === '') return;
    setStatus('busy');
    setError(undefined);
    void startInstall(project, widget.id).then((outcome) => {
      setStatus(outcome.status);
      setError(outcome.status === 'error' ? outcome.error : undefined);
    });
  };

  return (
    <Card className="widget-catalog-card">
      <CardHeader>
        <CardTitle className="mono">{widget.id}</CardTitle>
        <CardDescription>{widget.description === '' ? 'No description' : widget.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="widget-frame widget-preview">
          <WidgetHost projectKey={BUILTIN_WIDGETS_KEY} id={widget.id} version={widget.version} />
        </div>
        <div className="widget-install">
          {projects.length === 0 ? (
            <span className="small dim">No projects to add to — run a pipeline first.</span>
          ) : (
            <>
              <Select value={project} onValueChange={setProject}>
                <SelectTrigger aria-label="Project" className="widget-install-project">
                  <SelectValue placeholder="Project" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((option) => (
                    <SelectItem key={option.key} value={option.key} title={option.path}>
                      {projectName(option.path, option.key)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" disabled={status === 'busy' || project === ''} onClick={run}>
                Add to project
              </Button>
            </>
          )}
          {status === 'done' ? <span className="small dim">Added — it now shows under Installed</span> : null}
        </div>
        {status === 'error' && error !== undefined ? (
          <Alert variant="destructive" className="widget-install-error">
            {error}
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

export interface WidgetsProps {
  readonly overview: Overview | undefined;
  readonly widgets: WidgetsOverview | undefined;
  /** Каталог поставки — приходит своим запросом; `undefined` — ещё не загружен, в тестах задаётся сразу. */
  readonly catalog?: readonly BuiltinWidgetView[];
  readonly catalogError?: string;
}

export function Widgets({ overview, widgets, catalog, catalogError }: WidgetsProps): JSX.Element {
  const projects = installableProjects(overview);
  // Проект без единого виджета — законное состояние (`docs/widgets.md`,
  // «Файл и каталог»), а не пустая секция на экране: перечисляются проекты,
  // которым есть что показать.
  const installed = (widgets?.projects ?? []).filter((project) => project.widgets.length > 0);

  return (
    <>
      <PageHeader
        title="Widgets"
        description={
          <>
            Small React components rendered on this dashboard. Add a bundled one to a project, or drop your own{' '}
            <code>*.tsx</code> into <code>.stepcast/widgets/</code>.
          </>
        }
      />

      <section className="widget-section">
        <h2 className="widget-section-title">Catalog</h2>
        {catalogError !== undefined ? <Alert variant="destructive">{catalogError}</Alert> : null}
        {catalog === undefined && catalogError === undefined ? <p className="dim">Loading…</p> : null}
        {catalog !== undefined && catalog.length === 0 ? (
          <EmptyState title="The catalog is empty" description="This build ships no bundled widgets." />
        ) : null}
        {catalog !== undefined && catalog.length > 0 ? (
          <div className="widget-catalog">
            {catalog.map((widget) => (
              <CatalogCard key={widget.id} widget={widget} projects={projects} />
            ))}
          </div>
        ) : null}
      </section>

      <section className="widget-section">
        <h2 className="widget-section-title">Installed</h2>
        {widgets === undefined ? <p className="dim">Loading…</p> : null}
        {widgets !== undefined && installed.length === 0 ? (
          <EmptyState
            title="No project has widgets yet"
            description={
              <>
                Add one from the catalog above, or put a <code>*.tsx</code> file into the project’s{' '}
                <code>.stepcast/widgets/</code> directory.
              </>
            }
          />
        ) : null}
        {installed.map((project) => {
          const path = projectPath(overview, project.projectKey);
          return (
            <Card key={project.projectKey} className="widget-project">
              <CardHeader>
                <CardTitle title={path}>{projectName(path, project.projectKey)}</CardTitle>
                {path === undefined ? null : <CardDescription className="mono">{path}</CardDescription>}
              </CardHeader>
              <CardContent>
                {project.widgets.map((widget) => (
                  <div className="widget-frame" key={widget.id}>
                    <div className="widget-frame-head">
                      <span className="dim mono widget-frame-title">{widget.id}</span>
                      {widget.deprecated === undefined ? null : <Badge variant="running">outdated</Badge>}
                    </div>
                    {widget.deprecated === undefined ? null : (
                      <Alert variant="warning" className="widget-deprecated">
                        Outdated: the shared module table no longer carries the{' '}
                        {widget.deprecated.kind === 'specifier' ? 'specifier' : 'name'} “{widget.deprecated.name}”
                        {widget.deprecated.noteText === undefined ? '' : ` — ${widget.deprecated.noteText}`}
                      </Alert>
                    )}
                    <WidgetHost projectKey={project.projectKey} id={widget.id} version={widget.version} />
                  </div>
                ))}
                {project.widgets.some((widget) => widget.deprecated !== undefined) ? (
                  <MigrateAction projectKey={project.projectKey} />
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </section>
    </>
  );
}

/** Экран с загрузкой каталога — обёртка над чистым `Widgets`, чтобы статический рендер задавал каталог напрямую. */
export function WidgetsWithCatalog({ overview, widgets }: { readonly overview: Overview | undefined; readonly widgets: WidgetsOverview | undefined }): JSX.Element {
  const [catalog, setCatalog] = useState<readonly BuiltinWidgetView[] | undefined>(undefined);
  const [catalogError, setCatalogError] = useState<string | undefined>(undefined);

  useEffect(() => {
    fetchWidgetCatalog()
      .then((data) => setCatalog(data.widgets))
      .catch((failure: Error) => setCatalogError(failure.message));
  }, []);

  return (
    <Widgets
      overview={overview}
      widgets={widgets}
      {...(catalog === undefined ? {} : { catalog })}
      {...(catalogError === undefined ? {} : { catalogError })}
    />
  );
}
