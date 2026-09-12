import { useEffect, useState, type JSX } from 'react';

import { groupProjects } from '../../../src/ui/grouping';
import {
  fetchPipelines,
  type Overview,
  type PipelineJobView,
  type PipelineModelOrigin,
  type PipelineView,
  type RunOverview,
} from '../api';
import { fmtTime } from '../format';
import { JobGraph } from '../components/JobGraph';
import { TargetLink } from '../routeLink';
import { RUN_TARGET } from '../screens/run';

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
 * счёт прогонов — из живого обзора; сводит их `src/ui/grouping.ts` по файлу,
 * которым прогон запущен.
 */

/**
 * Подпись под именем работы в графе: первый шаг и счёт остальных.
 *
 * Полный список шагов в рамку узла не помещается, а обрезанный на середине
 * второго имени сообщает меньше, чем честное «и ещё сколько-то».
 */
function stepsOf(job: PipelineJobView): string {
  const [first, ...rest] = job.steps;
  if (first === undefined) return 'шагов нет';
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
      return 'модель работы';
    case 'tier':
      return `tier ${origin.tier} (${origin.tierLayer}, ${origin.backend})${origin.fallback ? ' → модель агента по умолчанию' : ''}`;
    case 'step':
      return 'объявлена шагом';
    case 'pipeline':
      return 'умолчание пайплайна';
    case 'config':
      return `настройки · ${origin.file}`;
    case 'backend':
      return `модель бэкенда ${origin.backend}`;
    case 'none':
      return 'модель не задана — выберет бэкенд';
  }
}

function JobCard({ job }: { readonly job: PipelineJobView }): JSX.Element {
  return (
    <div className="job">
      <div className="job-head">
        <span className="job-name">{job.id}</span>
        {job.needs.length === 0 ? (
          <span className="kind">без предшественников</span>
        ) : (
          <span className="kind">needs: {job.needs.join(', ')}</span>
        )}
        {job.on === 'success' ? null : <span className="kind">on: {job.on}</span>}
        {job.if === undefined ? null : <span className="kind">if: {job.if}</span>}
        {job.publishesOutput ? <span className="badge">публикует выход</span> : null}
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
              <span className="kind dim">есть output</span>
            )}
            {step.agent === undefined ? null : (
              <span className="kind">
                {step.agent}
                {step.model === undefined ? '' : ` · ${step.model}`}
              </span>
            )}
            {step.scriptRunner === undefined ? null : <span className="kind">{step.scriptRunner}</span>}
            {step.usesName === undefined ? null : (
              <span className="badge">
                uses: {step.usesName}
                {step.usesLayer === undefined ? '' : ` · ${step.usesLayer}`}
              </span>
            )}
            {step.modelOrigin === undefined ? null : (
              <span className="kind dim model-origin">{modelOriginLabel(step.modelOrigin)}</span>
            )}
          </div>
          {step.command === undefined ? null : <div className="ctx">$ {step.command}</div>}
          {/* Имя занимает место пути на карточке (design.md, решение 13); путь и
              раннер остаются доступны рядом, а не пропадают. */}
          {step.scriptPath === undefined ? null : <div className="ctx">script: {step.scriptPath}</div>}
          {step.usesParams === undefined ? null : (
            <div className="ctx dim">with: {JSON.stringify(step.usesParams)}</div>
          )}
          {step.hasScriptInput !== true ? null : <div className="ctx dim">input объявлен</div>}
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
                  {field.required ? <span className="badge">обязательно</span> : null}
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
    <>
      <p className="error">{pipeline.error}</p>
      {where === undefined && pipeline.errorAt === undefined ? null : (
        <p className="note dim">
          где: {where === undefined ? null : <span className="mono">{where}</span>}
          {where === undefined || pipeline.errorAt === undefined ? null : ' · '}
          {pipeline.errorAt === undefined ? null : <span className="mono">{pipeline.errorAt}</span>}
        </p>
      )}
      {pipeline.errorHint === undefined ? null : <p className="note dim">{pipeline.errorHint}</p>}
    </>
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
      <div className="card">
        <div className="card-head">
          <span className="card-title">{pipeline.name}</span>
          <span className="mono small dim">{pipeline.file}</span>
        </div>
        <PipelineError pipeline={pipeline} />
      </div>
    );
  }

  const job = pipeline.jobs.find((item) => item.id === selected) ?? pipeline.jobs[0];
  const last = runs[0];

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">{pipeline.name}</span>
        <span className="mono small dim">{pipeline.file}</span>
      </div>

      <div className="meta">
        <span>
          работ <b>{pipeline.jobs.length}</b>
        </span>
        {pipeline.concurrency === undefined ? null : (
          <span>
            параллельно <b>{pipeline.concurrency}</b>
          </span>
        )}
        {pipeline.failFast === undefined ? null : (
          <span>
            fail_fast <b>{pipeline.failFast ? 'да' : 'нет'}</b>
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

      {job === undefined ? <p className="note dim">Работ в этом пайплайне нет.</p> : <JobCard job={job} />}

      {/* Прогоны — на своём экране; здесь довольно счёта и последнего исхода. */}
      <p className="note dim runs-note">
        {!runsKnown ? (
          'прогоны ещё не загружены'
        ) : runs.length === 0 ? (
          'прогонов пока нет'
        ) : (
          <>
            прогонов {runs.length}
            {last === undefined ? null : (
              <>
                {' · последний '}
                {/* Маршрут страницы прогона отключён — не-ссылка с названной
                    причиной, общий вид витрины (`ui-routes`, Решение 8). */}
                <TargetLink
                  target={RUN_TARGET}
                  params={{ projectKey: pipeline.projectKey, runId: last.runId }}
                  navigate={navigate}
                >
                  <span className="run-id">{last.shortId}</span>
                </TargetLink>{' '}
                <span className={`badge ${last.status ?? ''}`}>{last.status ?? 'неизвестно'}</span>{' '}
                {fmtTime(last.startedAt)}
              </>
            )}
          </>
        )}
      </p>
    </div>
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

  if (error !== undefined) return <p className="error">{error}</p>;
  if (pipelines === undefined) return <p className="empty">Загрузка…</p>;

  const groups = groupProjects(pipelines, overview?.projects ?? []);
  // Прогоны без найденного пайплайна на этом экране не показываются: экран про
  // устройство пайплайнов, а сами прогоны целиком видны на своём экране.
  const withPipelines = groups.filter((group) => group.pipelines.length > 0);

  if (withPipelines.length === 0) {
    return (
      <p className="empty">
        Пайплайнов не найдено. Демон ищет <code>stepcast.yml</code> и{' '}
        <code>.stepcast/pipelines/*.yml</code> у проектов, чьи прогоны он видит.
      </p>
    );
  }

  return (
    <>
      <h1>Пайплайны</h1>
      {withPipelines.map((group) => (
        <section key={group.projectKey}>
          <h2 className={group.projectPath === undefined ? 'project unknown-path' : 'project'}>
            {group.projectPath ?? `${group.projectKey} — путь неизвестен`}
          </h2>

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
