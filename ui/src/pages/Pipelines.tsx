import { useEffect, useState, type JSX } from 'react';

import { groupProjects, type PipelineGroup } from '../../../src/ui/grouping';
import { fetchPipelines, type Overview, type PipelineView, type RunOverview } from '../api';
import { fmtDuration, fmtTime } from '../format';
import { runHref } from '../router';

/**
 * Первый экран: пайплайны проектов с их прогонами.
 *
 * Пайплайны и прогоны приходят из двух разных источников — `GET
 * /api/pipelines` читает файлы проектов, обзор идёт живым потоком — и
 * складываются вместе в `src/ui/grouping.ts`: правило склейки общее с тестами
 * (`test/ui-grouping.test.ts`), потому что оно и есть смысл экрана. Прогон,
 * чьего пайплайна среди найденных нет — файл удалён, переименован или лежит
 * вне известных мест, — с экрана не пропадает: он показан отдельной группой
 * своего проекта.
 */

function RunRow({
  projectKey,
  run,
  navigate,
}: {
  readonly projectKey: string;
  readonly run: RunOverview;
  readonly navigate: (href: string) => void;
}): JSX.Element {
  const href = runHref(projectKey, run.runId);
  return (
    <div className="run-row">
      <a
        href={href}
        onClick={(event) => {
          // Средняя кнопка и Cmd/Ctrl-клик должны открывать вкладку: перехватывается только обычный переход.
          if (event.metaKey || event.ctrlKey || event.button !== 0) return;
          event.preventDefault();
          navigate(href);
        }}
      >
        <span className="run-id">{run.shortId}</span>
      </a>
      <span className={`badge ${run.status ?? ''}`}>{run.status ?? 'неизвестно'}</span>
      {run.swept ? <span className="badge">убран</span> : null}
      {run.unreadable ? <span className="badge">не читается</span> : null}
      {run.abandoned ? <span className="badge">оборван</span> : null}
      <span className="small dim">{fmtTime(run.startedAt)}</span>
      <span className="small dim mono">{fmtDuration(run.durationMs)}</span>
    </div>
  );
}

function PipelineCard({
  group,
  runsKnown,
  navigate,
}: {
  readonly group: PipelineGroup<PipelineView, RunOverview>;
  /** Обзор уже пришёл: только тогда пустой список значит «прогонов нет». */
  readonly runsKnown: boolean;
  readonly navigate: (href: string) => void;
}): JSX.Element {
  const { pipeline, runs } = group;
  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">{pipeline.name}</span>
        <span className="mono small dim">{pipeline.file}</span>
      </div>

      {pipeline.error === undefined ? (
        <div className="meta">
          <span>
            работ <b>{pipeline.jobs.length}</b>
          </span>
          {pipeline.jobs.length === 0 ? null : (
            <span className="mono small dim">{pipeline.jobs.map((job) => job.id).join(', ')}</span>
          )}
          <span className="mono">stepcast run {pipeline.file}</span>
        </div>
      ) : (
        <p className="error">{pipeline.error}</p>
      )}

      {runs.length === 0 ? (
        // «Прогонов нет» и «обзор ещё не пришёл» — разные вещи: обзор идёт
        // живым потоком и на первой отрисовке его ещё нет, а если поток не
        // установился, не будет вовсе. Выдавать второе за первое — врать.
        <p className="note dim">{runsKnown ? 'прогонов пока нет' : 'прогоны ещё не загружены'}</p>
      ) : (
        <div className="run-list">
          {runs.map((run) => (
            <RunRow key={run.runId} projectKey={group.pipeline.projectKey} run={run} navigate={navigate} />
          ))}
        </div>
      )}
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

  if (groups.length === 0) {
    // Пусто по обоим источникам, но обзора ещё нет: заключать из этого, что
    // показывать нечего, рано.
    if (overview === undefined) return <p className="empty">Загрузка…</p>;
    return (
      <p className="empty">
        Пайплайнов и прогонов пока не найдено. Демон ищет <code>stepcast.yml</code> и{' '}
        <code>.stepcast/pipelines/*.yml</code> у проектов, чьи прогоны он видит.
      </p>
    );
  }

  return (
    <>
      <h1>Пайплайны</h1>
      {groups.map((group) => (
        <section key={group.projectKey}>
          <h2 className={group.projectPath === undefined ? 'project unknown-path' : 'project'}>
            {group.projectPath ?? `${group.projectKey} — путь неизвестен`}
          </h2>

          {group.pipelines.map((pipelineGroup) => (
            <PipelineCard
              key={`${pipelineGroup.pipeline.projectKey}/${pipelineGroup.pipeline.file}`}
              group={pipelineGroup}
              runsKnown={overview !== undefined}
              navigate={navigate}
            />
          ))}

          {group.orphanRuns.length === 0 ? null : (
            <div className="card">
              <div className="card-head">
                <span className="card-title">Прогоны без найденного пайплайна</span>
              </div>
              <div className="run-list">
                {group.orphanRuns.map((run) => (
                  <RunRow key={run.runId} projectKey={group.projectKey} run={run} navigate={navigate} />
                ))}
              </div>
            </div>
          )}
        </section>
      ))}
    </>
  );
}
