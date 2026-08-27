import { useEffect, useState, type JSX } from 'react';

import { groupProjects, type PipelineGroup } from '../../../src/ui/grouping';
import { deleteRun, fetchPipelines, type Overview, type PipelineView, type RunOverview } from '../api';
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

/**
 * Строка прогона — ячейка к ячейке с соседними строками.
 *
 * Колонки заданы сеткой на списке, а не потоком внутри строки: статусы разной
 * длины (`failed` против `budget_exceeded`) на потоке разъезжали, и колонка
 * времени гуляла по горизонтали от строки к строке. Пустые ячейки поэтому
 * остаются в разметке пустыми, а не пропадают.
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
  const address = `${projectKey}/${run.runId}`;
  // Удаление необратимо, поэтому идёт в два нажатия. Подтверждение живёт в
  // строке: модальное окно ради одного прогона отняло бы у списка контекст,
  // из-за которого прогон и удаляют.
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const remove = (): void => {
    setBusy(true);
    setError(undefined);
    // Строка не убирается своей рукой: демон пересобирает обзор сразу после
    // удаления, и прогон уходит с экрана живым потоком — тем же путём, каким
    // появился.
    deleteRun(address)
      .catch((failure: Error) => setError(failure.message))
      .finally(() => {
        setBusy(false);
        setAsking(false);
      });
  };

  return (
    <div className="run-row">
      <a
        className="run-id"
        href={href}
        onClick={(event) => {
          // Средняя кнопка и Cmd/Ctrl-клик должны открывать вкладку: перехватывается только обычный переход.
          if (event.metaKey || event.ctrlKey || event.button !== 0) return;
          event.preventDefault();
          navigate(href);
        }}
      >
        {run.shortId}
      </a>

      <span className={`badge ${run.status ?? ''}`}>{run.status ?? 'неизвестно'}</span>

      <span className="marks">
        {run.swept ? <span className="badge">убран</span> : null}
        {run.unreadable ? <span className="badge">не читается</span> : null}
        {run.abandoned ? <span className="badge">оборван</span> : null}
      </span>

      <span className="small dim">{fmtTime(run.startedAt)}</span>
      <span className="small dim mono">{fmtDuration(run.durationMs)}</span>

      <span className="actions">
        {asking ? (
          <>
            <button className="danger plain" disabled={busy} onClick={remove}>
              {busy ? 'удаление…' : 'да, удалить'}
            </button>
            <button className="plain" disabled={busy} onClick={() => setAsking(false)}>
              нет
            </button>
          </>
        ) : (
          <button
            className="plain quiet"
            title={`Удалить прогон ${run.shortId} из истории`}
            onClick={() => setAsking(true)}
          >
            удалить
          </button>
        )}
      </span>

      {/* Отказ демона — во всю ширину строки, а не в колонке действий: он
          называет причину целой фразой («прогон идёт»), и в колонке шириной с
          кнопку эта фраза легла бы поверх соседних колонок. */}
      {error === undefined ? null : <span className="run-error error small">{error}</span>}
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
