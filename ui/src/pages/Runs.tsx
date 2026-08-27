import { useState, type JSX } from 'react';

import { deleteRun, type Overview, type RunOverview } from '../api';
import { fmtDuration, fmtMoney, fmtTime, fmtTokens } from '../format';
import { runHref } from '../router';

/**
 * Прогоны таблицей.
 *
 * Колонки — то, по чему заходы сравнивают между собой: имя, статус, начало,
 * продолжительность, деньги, токены. Расход стоит рядом с исходом намеренно:
 * вопрос «во что обошёлся неудачный заход» задаётся о той же строке.
 *
 * Настоящая `<table>`, а не сетка из блоков: у таблицы есть шапка, которую
 * читает и глаз, и программа чтения с экрана, а колонки здесь именно колонки
 * данных, а не приём вёрстки.
 */

/** Идущий прогон считает продолжительность сам: обзор пересчитывается по событию. */
function durationOf(run: RunOverview, now: number): number | undefined {
  if (!run.running || run.startedAt === undefined) return run.durationMs;
  const started = new Date(run.startedAt).getTime();
  return Number.isNaN(started) ? run.durationMs : Math.max(0, now - started);
}

function TokenCell({ run }: { readonly run: RunOverview }): JSX.Element {
  const [open, setOpen] = useState(false);
  const usage = run.usage;

  if (usage === undefined) return <span className="dim">не сообщено</span>;

  const breakdown = usage.breakdown;
  return (
    <>
      <button
        className="tokens"
        onClick={() => setOpen(!open)}
        disabled={breakdown === undefined}
        title={
          breakdown === undefined
            ? 'Разрез появится, когда прогон запишет сводку расхода'
            : 'Разрез по видам токенов'
        }
      >
        {fmtTokens(usage.billableTokens)}
      </button>
      {open && breakdown !== undefined ? (
        <div className="breakdown">
          ввод {fmtTokens(breakdown.tokensIn)}
          <br />
          вывод {fmtTokens(breakdown.tokensOut)}
          <br />
          чтение кеша {fmtTokens(breakdown.cacheRead)}
          <br />
          запись кеша {fmtTokens(breakdown.cacheWrite)}
          {usage.unreported.length > 0 ? (
            <>
              <br />
              не сообщено: {usage.unreported.length}
            </>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/**
 * Корзинка. Спрашивает до удаления, а не показывает содеянное после: прогон
 * стирается с диска целиком и обратно не собирается.
 *
 * Идущий прогон кнопки не получает вовсе: демон его удалить откажется
 * (`409`), и предлагать действие, заведомо кончающееся отказом, — врать
 * кнопкой. Оборванный при этом удаляется наравне с завершённым, и «идёт» тут
 * значит живой процесс, а не статус `running`.
 */
function DeleteCell({
  address,
  run,
}: {
  readonly address: string;
  readonly run: RunOverview;
}): JSX.Element {
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  if (run.running && !run.abandoned) {
    return (
      <span className="dim small" title="Идущий прогон сначала останавливают">
        —
      </span>
    );
  }

  if (!asking) {
    return (
      <>
        <button
          className="plain danger"
          title={`Удалить прогон ${run.shortId} из истории`}
          onClick={() => setAsking(true)}
        >
          🗑
        </button>
        {error === undefined ? null : <div className="error small">{error}</div>}
      </>
    );
  }

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
    <div className="confirm">
      <span className="question">удалить?</span>
      <button className="danger" disabled={busy} onClick={remove}>
        да
      </button>
      <button disabled={busy} onClick={() => setAsking(false)}>
        нет
      </button>
    </div>
  );
}

export function Runs({
  overview,
  navigate,
}: {
  readonly overview: Overview | undefined;
  readonly navigate: (href: string) => void;
}): JSX.Element {
  const now = Date.now();

  if (overview === undefined) return <p className="empty">Загрузка…</p>;
  if (overview.projects.length === 0) {
    return (
      <p className="empty">
        Прогонов пока нет. Запустите <code>stepcast run</code>.
      </p>
    );
  }

  return (
    <>
      <h1>Прогоны</h1>
      {overview.projects.map((project) => (
        <section key={project.key}>
          <h2 className={project.path === undefined ? 'project unknown-path' : 'project'}>
            {project.path ?? `${project.key} — путь неизвестен`}
          </h2>
          <div className="table-scroll">
            <table className="runs">
              <thead>
                <tr>
                  <th>Имя</th>
                  <th>Статус</th>
                  <th>Начало</th>
                  <th className="num">Длительность</th>
                  <th className="num">Стоимость</th>
                  <th className="num">Токены</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {project.runs.map((run) => {
                  const href = runHref(project.key, run.runId);
                  return (
                    <tr key={run.runId}>
                      <td>
                        <a
                          href={href}
                          onClick={(event) => {
                            // Средняя кнопка и Cmd/Ctrl-клик должны открывать вкладку:
                            // перехватывается только обычный переход.
                            if (event.metaKey || event.ctrlKey || event.button !== 0) return;
                            event.preventDefault();
                            navigate(href);
                          }}
                        >
                          <div className="run-name">{run.pipeline || 'без имени'}</div>
                          <div className="run-id">{run.shortId}</div>
                        </a>
                      </td>
                      <td>
                        <div className="marks">
                          <span className={`badge ${run.status ?? ''}`}>
                            {run.status ?? 'неизвестно'}
                          </span>
                          {run.swept ? <span className="badge">убран</span> : null}
                          {run.unreadable ? <span className="badge">не читается</span> : null}
                          {run.abandoned ? <span className="badge">оборван</span> : null}
                          {run.wakeAt === undefined ? null : (
                            <span className="badge" title={`сон до ${fmtTime(run.wakeAt)}`}>
                              спит
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="small">{fmtTime(run.startedAt)}</td>
                      <td className="num">{fmtDuration(durationOf(run, now))}</td>
                      <td className="num">{fmtMoney(run.usage?.costUsd ?? null)}</td>
                      <td className="num">
                        <TokenCell run={run} />
                      </td>
                      <td className="num">
                        <DeleteCell address={`${project.key}/${run.runId}`} run={run} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </>
  );
}
