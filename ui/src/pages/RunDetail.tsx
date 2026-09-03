import { useEffect, useState, type JSX } from 'react';

import { fetchRun, type JobSnapshot, type RunSnapshot, type StepSnapshot } from '../api';
import { fmtDuration, fmtMoney, fmtSpan, fmtTokens } from '../format';
import { FileView } from '../components/FileView';
import { JobGraph } from '../components/JobGraph';
import { StepOutput } from '../components/StepOutput';

/**
 * Страница прогона: граф связей в шапке, под ним — выбранная работа.
 *
 * Граф отвечает на вопрос «почему эта работа не выполнилась», список шагов —
 * на вопрос «что именно она делала». Раньше оба ответа приходилось собирать
 * из плоского списка работ.
 */

/**
 * Сколько ждать снимка из живого потока, прежде чем спросить его запросом.
 *
 * Демон присылает событие `run` сразу при подписке (`src/ui/server.ts`), так
 * что в обычной жизни этот срок не истекает и лишнего круга по сети не
 * возникает вовсе. Он нужен на случаи, когда события не будет: прогона нет,
 * поток не установился, демон занят, — там читателю нужен внятный ответ, а не
 * вечное «Загрузка…».
 */
const FALLBACK_DELAY_MS = 400;

function Step({
  address,
  jobId,
  step,
}: {
  readonly address: string;
  readonly jobId: string;
  readonly step: StepSnapshot;
}): JSX.Element {
  return (
    <div className="step">
      <div className="step-head">
        <span className="job-name">{step.id}</span>
        <span className="kind">{step.kind}</span>
        {step.status === undefined ? null : (
          <span className={`badge ${step.status}`}>{step.status}</span>
        )}
        {step.agent === undefined ? null : (
          <span className="kind">
            {step.agent}
            {step.model === undefined ? '' : ` · ${step.model}`}
          </span>
        )}
        {step.attempts > 1 ? <span className="kind">попыток: {step.attempts}</span> : null}
        {/*
          Длительность шага и его расход — разные величины: первая говорит,
          сколько шаг занял часов, второй — сколько за него заплачено.
        */}
        {fmtSpan(step.startedAt, step.finishedAt) === undefined ? null : (
          <span className="kind">{fmtSpan(step.startedAt, step.finishedAt)}</span>
        )}
        <span className="kind">
          {fmtTokens(step.usage.billableTokens)} · {fmtDuration(step.usage.wallclockMs)} ·{' '}
          {fmtMoney(step.usage.costUsd)}
        </span>
      </div>

      {step.reason === undefined ? null : <div className="desc">{step.reason}</div>}
      {step.command === undefined ? null : <div className="ctx">$ {step.command}</div>}

      {step.contextBreakdown === undefined ? null : (
        <div className="ctx">
          предшественники {step.contextBreakdown.levels.upstream} · пайплайн{' '}
          {step.contextBreakdown.levels.pipeline} · работа {step.contextBreakdown.levels.job} · шаг{' '}
          {step.contextBreakdown.levels.step} · <b>итого {step.contextBreakdown.total} ток.</b>
        </div>
      )}

      {step.files.length === 0 ? null : (
        <div className="row">
          <span className="label">файлы</span>
          {step.files.map((file) => (
            <FileView key={file.path} address={address} file={file} />
          ))}
        </div>
      )}

      <StepOutput address={address} jobId={jobId} stepId={step.id} kind={step.kind} />
    </div>
  );
}

/**
 * Пары «ключ — значение» построчно.
 *
 * Склеенные в одну строку через разделитель, они нечитаемы уже на трёх полях:
 * значения здесь — целые фразы, а не короткие метки. Пара занимает строку
 * поля: ключ встаёт в колонку подписей, значение — в колонку значений, и
 * длинное значение переносится там же, не растягивая карточку.
 */
function Pairs({
  label,
  pairs,
}: {
  readonly label: string;
  readonly pairs: Readonly<Record<string, string>>;
}): JSX.Element {
  return (
    <>
      <div className="row">
        <span className="label">{label}</span>
      </div>
      {Object.entries(pairs).map(([key, value]) => (
        <div className="row" key={key}>
          <span className="label mono">{key}</span>
          <span className="desc">{value}</span>
        </div>
      ))}
    </>
  );
}

function Job({ address, job }: { readonly address: string; readonly job: JobSnapshot }): JSX.Element {
  return (
    <div className="job">
      <div className="job-head">
        <span className="job-name">{job.id}</span>
        {job.status === undefined ? null : <span className={`badge ${job.status}`}>{job.status}</span>}
        {job.needs.length === 0 ? null : <span className="kind">needs: {job.needs.join(', ')}</span>}
        {job.on === 'success' ? null : <span className="kind">on: {job.on}</span>}
        {job.if === undefined ? null : <span className="kind">if: {job.if}</span>}
        {fmtSpan(job.startedAt, job.finishedAt) === undefined ? null : (
          <span className="kind">{fmtSpan(job.startedAt, job.finishedAt)}</span>
        )}
        <span className="kind">
          {fmtTokens(job.usage.billableTokens)} · {fmtDuration(job.usage.wallclockMs)} ·{' '}
          {fmtMoney(job.usage.costUsd)}
        </span>
      </div>
      {job.description === undefined ? null : <div className="desc">{job.description}</div>}
      {job.reason === undefined ? null : <div className="desc">{job.reason}</div>}

      <div className="row">
        <span className="label">вход</span>
        {job.inputs.length > 0 ? (
          job.inputs.map((file) => <FileView key={file.path} address={address} file={file} />)
        ) : (
          <span className="desc">
            {job.needs.length > 0 ? 'предшественники ничего не опубликовали' : 'предшественников нет'}
          </span>
        )}
      </div>

      <div className="row">
        <span className="label">выход</span>
        {job.output !== undefined ? (
          <FileView address={address} file={job.output} />
        ) : (
          <span className="desc">
            {job.outputDeclared ? 'объявлен, ещё не опубликован' : 'не объявлен'}
          </span>
        )}
      </div>

      {/*
        Подпись работы — раскрытая, как её видит граф; данные — то, что
        работа опубликовала сама. Обе строки показываются здесь целиком:
        в узле графа умещается один ключ и одна строка.
      */}
      {job.display === undefined ? null : <Pairs label="подпись" pairs={job.display} />}

      {job.data === undefined ? null : <Pairs label="данные" pairs={job.data} />}

      {job.steps.map((step) => (
        <Step key={step.id} address={address} jobId={job.id} step={step} />
      ))}
    </div>
  );
}

export function RunDetail({
  projectKey,
  runId,
  snapshot,
  navigate,
}: {
  readonly projectKey: string;
  readonly runId: string;
  /** Снимок из живого потока (`live.ts`), подписанного на `?run=<адрес>`. */
  readonly snapshot: RunSnapshot | undefined;
  readonly navigate: (href: string) => void;
}): JSX.Element {
  const address = `${projectKey}/${runId}`;
  // Запасная загрузка — только когда поток снимка не дал. Снимок прогона
  // приходит событием `run` того же потока, что и обзор, и спрашивать его
  // ещё и запросом значило бы держать ровно тот перезапрос, ради снятия
  // которого страница и переводилась на поток.
  const [fallback, setFallback] = useState<RunSnapshot | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<string | undefined>(undefined);

  const live = snapshot !== undefined;

  useEffect(() => {
    // Пришедший снимок обрывает ожидание: эффект перезапускается с `live`,
    // и таймер снимается, не дойдя до запроса.
    if (live) return undefined;

    let alive = true;
    const timer = setTimeout(() => {
      fetchRun(address)
        .then((data) => {
          if (alive) setFallback(data);
        })
        .catch((failure: Error) => {
          if (alive) setError(failure.message);
        });
    }, FALLBACK_DELAY_MS);

    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [address, live]);

  const current = snapshot ?? fallback;

  if (current === undefined) {
    if (error !== undefined) {
      return (
        <>
          <p className="error">{error}</p>
          <p>
            <a
              href="/"
              onClick={(event) => {
                event.preventDefault();
                navigate('/');
              }}
            >
              ← к прогонам
            </a>
          </p>
        </>
      );
    }
    return <p className="empty">Загрузка…</p>;
  }

  const job = current.jobs.find((item) => item.id === selected) ?? current.jobs[0];

  return (
    <>
      <p>
        <a
          href="/"
          onClick={(event) => {
            event.preventDefault();
            navigate('/');
          }}
        >
          ← к прогонам
        </a>
      </p>
      <h1>
        {current.pipeline || 'прогон'}{' '}
        <span className="run-id">{runId.slice(runId.lastIndexOf('-') + 1)}</span>{' '}
        {current.status === undefined ? null : (
          <span className={`badge ${current.status}`}>{current.status}</span>
        )}
      </h1>

      {current.swept ? (
        <p className="note dim">
          Прогон убран: остались только манифест, состояние и расход. Подробностей больше нет.
        </p>
      ) : null}

      <JobGraph
        graph={current.graph}
        {...(job === undefined ? {} : { selected: job.id })}
        onSelect={setSelected}
        subtitle={(node) =>
          node.blockedBy.length > 0
            ? `отменена: ${node.blockedBy.join(', ')}`
            : (node.status ?? 'не начиналась')
        }
      />

      {job === undefined ? (
        <p className="note dim">Работ в этом прогоне не записано.</p>
      ) : (
        <div className="card">
          <Job address={address} job={job} />
        </div>
      )}
    </>
  );
}
