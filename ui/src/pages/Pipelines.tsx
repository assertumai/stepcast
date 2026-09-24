import { useEffect, useState, type JSX } from 'react';

import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  statusBadgeVariant,
} from '@stepcast/ui';
import { groupProjects } from '../../../src/parts/ui/grouping';
import { lastPathSegment, unknownPathLabel } from '../../../src/parts/ui/runsView';
import {
  fetchPipelines,
  type Overview,
  type PipelineEffortOrigin,
  type PipelineJobView,
  type PipelineModelOrigin,
  type PipelineView,
  type RunOverview,
} from '../api';
import { fmtTime } from '../format';
import { JobGraph } from '../components/JobGraph';
import { TargetLink } from '../routeLink';
import { RUN_TARGET } from '../screens/run';
import './pipelines.css';

/**
 * Пайплайны проектов — их устройство, а не их прогоны.
 *
 * Экран отвечает на вопрос «что этот пайплайн делает и в каком порядке»:
 * граф работ по зависимостям, условия перехода, шаги каждой работы с агентом
 * или командой. Вопрос «чем кончился очередной заход» задают экрану
 * «Прогоны», и повторять там таблицу прогонов здесь незачем — от неё
 * остаётся одна строка со счётом и ссылкой.
 *
 * Инвентарь приходит из `GET /api/pipelines` (демон читает файлы проектов),
 * счёт прогонов — из живого обзора; сводит их `src/parts/ui/grouping.ts` по файлу,
 * которым прогон запущен.
 */

const PAGE_TITLE = 'Pipelines';
const PAGE_DESCRIPTION =
  'How each project’s pipelines are wired: the job graph, transitions and steps. Click a job in the graph to inspect it.';

/**
 * Подпись под именем работы в графе: первый шаг и счёт остальных.
 *
 * Полный список шагов в рамку узла не помещается, а обрезанный на середине
 * второго имени сообщает меньше, чем честное «и ещё сколько-то».
 */
function stepsOf(job: PipelineJobView): string {
  const [first, ...rest] = job.steps;
  if (first === undefined) return 'no steps';
  return rest.length === 0 ? first.id : `${first.id} +${rest.length}`;
}

/**
 * Слой модели словами: карточка не должна заставлять читателя сравнивать
 * значения самому, чтобы понять, что `opus` шага и `opus` настроек — не одно
 * и то же решение (design.md, «Экран пайплайна показывает значение, не
 * называя слоя»).
 */
function modelOriginLabel(origin: PipelineModelOrigin): string {
  switch (origin.layer) {
    case 'job':
      return 'job model';
    case 'tier':
      return `tier ${origin.tier} (${origin.tierLayer}, ${origin.backend})${origin.fallback ? ' → agent default model' : ''}`;
    case 'step':
      return 'declared by the step';
    case 'pipeline':
      return 'pipeline default';
    case 'config':
      return `settings · ${origin.file}`;
    case 'backend':
      return `backend model ${origin.backend}`;
    case 'none':
      return 'no model set — the backend picks one';
  }
}

function effortOriginLabel(origin: PipelineEffortOrigin): string {
  switch (origin.layer) {
    case 'job':
      return 'job effort';
    case 'tier':
      return `tier ${origin.tier} effort (${origin.tierLayer}, ${origin.backend})`;
    case 'step':
      return 'effort declared by the step';
    case 'pipeline':
      return 'pipeline effort';
    case 'config':
      return `effort settings · ${origin.file}`;
    case 'none':
      return 'model default effort';
  }
}

function JobCard({ job }: { readonly job: PipelineJobView }): JSX.Element {
  return (
    <div className="job">
      <div className="job-head">
        <span className="job-name">{job.id}</span>
        {job.needs.length === 0 ? (
          <span className="kind">no upstream jobs</span>
        ) : (
          <span className="kind">needs: {job.needs.join(', ')}</span>
        )}
        {job.on === 'success' ? null : <span className="kind">on: {job.on}</span>}
        {job.if === undefined ? null : <span className="kind">if: {job.if}</span>}
        {job.publishesOutput ? <Badge>publishes output</Badge> : null}
      </div>
      {job.description === undefined ? null : <div className="desc">{job.description}</div>}

      {job.steps.map((step) => (
        <div key={step.id} className="step">
          <div className="step-head">
            <span className="job-name">{step.id}</span>
            {/* Вид шага плагинного вида называется своим именем, а не словом
                «plugin»: именно им шаг и объявлен в документе. */}
            <span className="kind">{step.pluginKindName ?? step.kind}</span>
            {step.pluginKindTitle === undefined ? null : (
              <span className="kind">{step.pluginKindTitle}</span>
            )}
            {step.pluginHasOutput !== true ? null : (
              <span className="kind dim">has output</span>
            )}
            {step.agent === undefined ? null : (
              <span className="kind">
                {step.agent}
                {step.model === undefined ? '' : ` · ${step.model}`}
                {step.effort === undefined ? '' : ` · effort ${step.effort}`}
              </span>
            )}
            {step.scriptRunner === undefined ? null : <span className="kind">{step.scriptRunner}</span>}
            {step.usesName === undefined ? null : (
              <Badge>
                uses: {step.usesName}
                {step.usesLayer === undefined ? '' : ` · ${step.usesLayer}`}
              </Badge>
            )}
            {step.modelOrigin === undefined ? null : (
              <span className="kind dim model-origin">{modelOriginLabel(step.modelOrigin)}</span>
            )}
            {step.effortOrigin === undefined ? null : (
              <span className="kind dim model-origin">{effortOriginLabel(step.effortOrigin)}</span>
            )}
          </div>
          {step.command === undefined ? null : <div className="ctx">$ {step.command}</div>}
          {/* Имя занимает место пути на карточке (design.md, решение 13); путь и
              раннер остаются доступны рядом, а не пропадают. */}
          {step.scriptPath === undefined ? null : <div className="ctx">script: {step.scriptPath}</div>}
          {step.usesParams === undefined ? null : (
            <div className="ctx dim">with: {JSON.stringify(step.usesParams)}</div>
          )}
          {step.hasScriptInput !== true ? null : <div className="ctx dim">input declared</div>}
          {step.scriptOutputSchemaPath === undefined ? null : (
            <div className="ctx dim">output_schema: {step.scriptOutputSchemaPath}</div>
          )}
          {/* Вид шага, которого действующий реестр не знает, показывается
              причиной, а не пустой карточкой: имя вида уже названо в шапке. */}
          {step.pluginUnknownReason === undefined ? null : (
            <div className="ctx dim">{step.pluginUnknownReason}</div>
          )}
          {step.pluginFields === undefined || step.pluginFields.length === 0 ? null : (
            <ul className="ctx-list">
              {step.pluginFields.map((field) => (
                <li key={field.name}>
                  <span className="job-name">{field.name}</span>
                  {field.type === undefined ? null : <span className="kind">{field.type}</span>}
                  {field.required ? <Badge>required</Badge> : null}
                  {field.description === undefined ? null : (
                    <div className="dim">{field.description}</div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Отказ разбора: текст, место и подсказка — так же, как их печатает CLI.
 *
 * Место идёт отдельной строкой, а не приклеено к тексту: файл ошибки не
 * обязан совпадать с файлом карточки (работа подключается по `uses` из
 * своего файла), а путь внутри документа — единственное, что отвечает на
 * вопрос «где именно», ради которого карточка и заводится.
 */
function PipelineError({ pipeline }: { readonly pipeline: PipelineView }): JSX.Element {
  // Файл ошибки повторяется, только если он не тот, что назван в шапке карточки.
  const where =
    pipeline.errorFile === undefined || pipeline.errorFile === pipeline.file
      ? undefined
      : pipeline.errorFile;
  return (
    <Alert variant="destructive">
      <AlertTitle>{pipeline.error}</AlertTitle>
      {where === undefined && pipeline.errorAt === undefined ? null : (
        <AlertDescription>
          where: {where === undefined ? null : <span className="mono">{where}</span>}
          {where === undefined || pipeline.errorAt === undefined ? null : ' · '}
          {pipeline.errorAt === undefined ? null : <span className="mono">{pipeline.errorAt}</span>}
        </AlertDescription>
      )}
      {pipeline.errorHint === undefined ? null : <AlertDescription>{pipeline.errorHint}</AlertDescription>}
    </Alert>
  );
}

function PipelineCard({
  pipeline,
  runs,
  runsKnown,
  navigate,
}: {
  readonly pipeline: PipelineView;
  readonly runs: readonly RunOverview[];
  /** Обзор уже пришёл: только тогда пустой список значит «прогонов нет». */
  readonly runsKnown: boolean;
  readonly navigate: (href: string) => void;
}): JSX.Element {
  const [selected, setSelected] = useState<string | undefined>(undefined);

  if (pipeline.error !== undefined) {
    return (
      <Card className="pipeline-card">
        <CardHeader>
          <CardTitle>{pipeline.name}</CardTitle>
          <span className="mono small dim">{pipeline.file}</span>
        </CardHeader>
        <CardContent>
          <PipelineError pipeline={pipeline} />
        </CardContent>
      </Card>
    );
  }

  const job = pipeline.jobs.find((item) => item.id === selected) ?? pipeline.jobs[0];
  const last = runs[0];

  return (
    <Card className="pipeline-card">
      <CardHeader>
        <CardTitle>{pipeline.name}</CardTitle>
        <span className="mono small dim">{pipeline.file}</span>
      </CardHeader>

      <CardContent>
        <div className="meta">
          <span>
            jobs <b>{pipeline.jobs.length}</b>
          </span>
          {pipeline.concurrency === undefined ? null : (
            <span>
              concurrency <b>{pipeline.concurrency}</b>
            </span>
          )}
          {pipeline.failFast === undefined ? null : (
            <span>
              fail_fast <b>{pipeline.failFast ? 'yes' : 'no'}</b>
            </span>
          )}
          <span className="mono">stepcast run {pipeline.file}</span>
        </div>

        {pipeline.graph === undefined ? null : (
          <JobGraph
            graph={pipeline.graph}
            {...(job === undefined ? {} : { selected: job.id })}
            onSelect={setSelected}
            subtitle={(node) => {
              const found = pipeline.jobs.find((item) => item.id === node.id);
              return found === undefined ? undefined : stepsOf(found);
            }}
          />
        )}

        {job === undefined ? <p className="note dim">This pipeline has no jobs.</p> : <JobCard job={job} />}
      </CardContent>

      {/* Прогоны — на своём экране; здесь довольно счёта и последнего исхода. */}
      <CardFooter className="runs-note">
        {!runsKnown ? (
          'runs not loaded yet'
        ) : runs.length === 0 ? (
          'no runs yet'
        ) : (
          <>
            <span>{runs.length === 1 ? '1 run' : `${runs.length} runs`}</span>
            {last === undefined ? null : (
              <>
                <span>· latest</span>
                {/* Маршрут страницы прогона отключён — не-ссылка с названной
                    причиной, общий вид витрины (`ui-routes`, Решение 8). */}
                <TargetLink
                  target={RUN_TARGET}
                  params={{ projectKey: pipeline.projectKey, runId: last.runId }}
                  navigate={navigate}
                >
                  <span className="run-id">{last.shortId}</span>
                </TargetLink>
                <Badge variant={statusBadgeVariant(last.status)}>{last.status ?? 'unknown'}</Badge>
                <span>{fmtTime(last.startedAt)}</span>
              </>
            )}
          </>
        )}
      </CardFooter>
    </Card>
  );
}

export function Pipelines({
  overview,
  navigate,
}: {
  readonly overview: Overview | undefined;
  readonly navigate: (href: string) => void;
}): JSX.Element {
  const [pipelines, setPipelines] = useState<readonly PipelineView[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    // Инвентарь пайплайнов не приходит потоком (демон не следит за файлами
    // проектов): перечитывается заново при каждом входе на экран.
    fetchPipelines()
      .then((data) => setPipelines(data.pipelines))
      .catch((failure: Error) => setError(failure.message));
  }, []);

  if (error !== undefined) {
    return (
      <>
        <PageHeader title={PAGE_TITLE} description={PAGE_DESCRIPTION} />
        <Alert variant="destructive">
          <AlertTitle>Could not load pipelines</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </>
    );
  }
  if (pipelines === undefined) {
    return (
      <>
        <PageHeader title={PAGE_TITLE} description={PAGE_DESCRIPTION} />
        <EmptyState title="Loading…" />
      </>
    );
  }

  const groups = groupProjects(pipelines, overview?.projects ?? []);
  // Прогоны без найденного пайплайна на этом экране не показываются: экран про
  // устройство пайплайнов, а сами прогоны целиком видны на своём экране.
  const withPipelines = groups.filter((group) => group.pipelines.length > 0);

  if (withPipelines.length === 0) {
    return (
      <>
        <PageHeader title={PAGE_TITLE} description={PAGE_DESCRIPTION} />
        <EmptyState
          title="No pipelines found"
          description={
            <>
              The daemon looks for <code>stepcast.yml</code> and <code>.stepcast/pipelines/*.yml</code> in the
              projects whose runs it can see.
            </>
          }
        />
      </>
    );
  }

  return (
    <>
      <PageHeader title={PAGE_TITLE} description={PAGE_DESCRIPTION} />
      {withPipelines.map((group) => (
        <section key={group.projectKey} className="pipelines-project">
          {group.projectPath === undefined ? (
            <>
              <h2 className="pipelines-project-title">{group.projectKey}</h2>
              <div className="pipelines-project-path unknown-path">{unknownPathLabel(group.projectKey)}</div>
            </>
          ) : (
            <>
              <h2 className="pipelines-project-title">{lastPathSegment(group.projectPath)}</h2>
              <div className="pipelines-project-path" title={group.projectPath}>
                {group.projectPath}
              </div>
            </>
          )}

          {group.pipelines.map((pipelineGroup) => (
            <PipelineCard
              key={`${pipelineGroup.pipeline.projectKey}/${pipelineGroup.pipeline.file}`}
              pipeline={pipelineGroup.pipeline}
              runs={pipelineGroup.runs}
              runsKnown={overview !== undefined}
              navigate={navigate}
            />
          ))}
        </section>
      ))}
    </>
  );
}
