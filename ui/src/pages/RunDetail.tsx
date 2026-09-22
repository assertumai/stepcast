import { useEffect, useState, type JSX } from 'react';

import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  statusBadgeVariant,
} from '@stepcast/ui';
import { fetchRun, type JobSnapshot, type JournalProblem, type RunSnapshot, type StepSnapshot } from '../api';
import { fmtDuration, fmtMoney, fmtSpan, fmtTime, fmtTokens } from '../format';
import { FileView } from '../components/FileView';
import { JobGraph } from '../components/JobGraph';
import { StepOutput } from '../components/StepOutput';
import { TargetLink } from '../routeLink';
import { DECISIONS_TARGET } from '../screens/decisions';
import './runDetail.css';

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
 * Демон присылает событие `run` сразу при подписке (`src/parts/ui/server.ts`), так
 * что в обычной жизни этот срок не истекает и лишнего круга по сети не
 * возникает вовсе. Он нужен на случаи, когда события не будет: прогона нет,
 * поток не установился, демон занят, — там читателю нужен внятный ответ, а не
 * вечное «Loading…».
 */
const FALLBACK_DELAY_MS = 400;

const PAGE_DESCRIPTION =
  'Job graph on top — click a job to see its inputs, outputs, steps and their live output below.';

/**
 * Расхождение объявленной и исполнявшейся моделей — либо `undefined`, когда
 * его называть незачем: сводки нет, или все попытки прошли объявленной
 * моделью (design.md, Решение 5).
 *
 * Попытка без названной модели входит в сравнение как отдельное значение, а
 * не как объявленная: движок не подменяет одно другим, и карточка не должна
 * подменять их тоже (ui-dashboard: «Модель попытки не назначалась»).
 *
 * Схлопываются только подряд идущие повторы, а не значение целиком: экран
 * показывает факт по порядку попыток, и возврат к прежней модели (opus →
 * sonnet → opus) — это событие, а не дубль. Множество на его месте показало бы
 * «opus → sonnet», то есть эскалацию, которой не было.
 */
function attemptModelsNote(step: StepSnapshot): string | undefined {
  if (step.attemptModels.length === 0) return undefined;
  const NO_MODEL = 'model not named';
  const executed: string[] = [];
  for (const attempt of step.attemptModels) {
    const label = attempt.model ?? NO_MODEL;
    if (executed[executed.length - 1] !== label) executed.push(label);
  }
  if (executed.length === 1 && executed[0] === step.model) return undefined;

  const executedLabel = executed.join(' → ');
  return step.model === undefined
    ? `executed with: ${executedLabel} (no model declared)`
    : `declared ${step.model} · executed with: ${executedLabel}`;
}

function Step({
  address,
  jobId,
  step,
  navigate,
}: {
  readonly address: string;
  readonly jobId: string;
  readonly step: StepSnapshot;
  readonly navigate: (href: string) => void;
}): JSX.Element {
  return (
    <div className="step">
      <div className="step-head">
        <span className="job-name">{step.id}</span>
        {/* Шаг плагинного вида называется именем своего вида — тем же, каким
            он объявлен в документе, — а не словом «plugin». */}
        <span className="kind">{step.pluginKindName ?? step.kind}</span>
        {step.pluginPlugin === undefined ? null : <Badge>plugin: {step.pluginPlugin}</Badge>}
        {step.status === undefined ? null : <Badge variant={statusBadgeVariant(step.status)}>{step.status}</Badge>}
        {step.agent === undefined ? null : (
          <span className="kind">
            {step.agent}
            {step.model === undefined ? '' : ` · ${step.model}`}
          </span>
        )}
        {step.scriptRunner === undefined ? null : <span className="kind">{step.scriptRunner}</span>}
        {step.usesName === undefined ? null : (
          <Badge>
            uses: {step.usesName}
            {step.usesLayer === undefined ? '' : ` · ${step.usesLayer}`}
          </Badge>
        )}
        {attemptModelsNote(step) === undefined ? null : (
          <span className="kind dim">{attemptModelsNote(step)}</span>
        )}
        {step.attempts > 1 ? <span className="kind">attempts: {step.attempts}</span> : null}
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
      {/*
        Ожидание и принятое решение (`user-decision-steps`, design.md решение
        11): здесь только состояние и ссылка на экран «Решения» — кнопки
        исходов живут там же, где и таблица прочих ожидающих прогонов
        (open question design.md: два места с одним диалогом лишние).
      */}
      {step.awaiting === undefined ? null : (
        <div className="ctx">
          awaiting a decision: {step.awaiting.prompt ?? Object.keys(step.awaiting.outcomes).join(', ')}
          {step.awaiting.deadline === undefined ? '' : ` · deadline: ${fmtTime(step.awaiting.deadline)}`}
          {' — '}
          <TargetLink target={DECISIONS_TARGET} navigate={navigate}>
            decide
          </TargetLink>
        </div>
      )}
      {step.decision === undefined ? null : (
        <div className="ctx dim">
          decision: {step.decision.outcome} ({step.decision.effect}
          {step.decision.by === 'deadline' ? ', by deadline' : ''})
          {step.decision.reason === undefined ? '' : ` — ${step.decision.reason}`}
        </div>
      )}
      {step.command === undefined ? null : <div className="ctx">$ {step.command}</div>}
      {step.scriptPath === undefined ? null : <div className="ctx">script: {step.scriptPath}</div>}
      {step.usesParams === undefined ? null : (
        <div className="ctx dim">with: {JSON.stringify(step.usesParams)}</div>
      )}
      {step.hasScriptInput !== true ? null : <div className="ctx dim">input declared</div>}
      {step.scriptOutputSchemaPath === undefined ? null : (
        <div className="ctx dim">output_schema: {step.scriptOutputSchemaPath}</div>
      )}
      {step.pluginFields === undefined ? null : (
        <div className="ctx">{JSON.stringify(step.pluginFields)}</div>
      )}
      {step.pluginNote === undefined ? null : <div className="ctx dim">{step.pluginNote}</div>}

      {step.contextBreakdown === undefined ? null : (
        <div className="ctx">
          upstream {step.contextBreakdown.levels.upstream} · pipeline{' '}
          {step.contextBreakdown.levels.pipeline} · job {step.contextBreakdown.levels.job} · step{' '}
          {step.contextBreakdown.levels.step} · <b>total {step.contextBreakdown.total} tokens</b>
        </div>
      )}

      {step.files.length === 0 ? null : (
        <div className="row">
          <span className="label">files</span>
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

/**
 * Объяснение беды чтения журнала — вместо пустого имени пайплайна и пустого
 * списка работ. Три беды называются тремя разными словами: у расхождения
 * версий лекарство есть, у журнала прежней формы и у порчи файла — нет, и
 * предлагать перезапуск там, где он не поможет, значит врать подсказкой.
 */
function ProblemNotice({ problem }: { readonly problem: JournalProblem }): JSX.Element {
  const at = problem.at === undefined ? '' : `, ${problem.at}`;
  const place = `${problem.file}${at}: ${problem.detail}`;

  if (problem.kind === 'version-skew') {
    const journal =
      problem.journalFormat === undefined ? 'a newer journal format than known' : `journal format ${problem.journalFormat}`;
    return (
      <Alert variant="warning" className="notice">
        <AlertTitle>Reader is out of date</AlertTitle>
        <AlertDescription>
          This run was written with {journal}, but this dashboard only knows format {problem.readerFormat} (
          {place}). Restart the daemon with <code>stepcast down && stepcast up</code>.
        </AlertDescription>
      </Alert>
    );
  }

  if (problem.kind === 'legacy-journal') {
    return (
      <Alert variant="warning" className="notice">
        <AlertTitle>Legacy journal</AlertTitle>
        <AlertDescription>
          This run was written with journal format {problem.journalFormat}, but this dashboard knows format{' '}
          {problem.readerFormat}: that record no longer exists in the current schemas ({place}). The run was
          written by an older build — restarting the daemon will not make it readable.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert variant="destructive">
      <AlertTitle>{problem.kind === 'missing' ? 'File not found' : 'File is corrupted'}</AlertTitle>
      <AlertDescription>{place}</AlertDescription>
    </Alert>
  );
}

function Job({
  address,
  job,
  navigate,
}: {
  readonly address: string;
  readonly job: JobSnapshot;
  readonly navigate: (href: string) => void;
}): JSX.Element {
  return (
    <div className="job">
      <div className="job-head">
        <span className="job-name">{job.id}</span>
        {job.status === undefined ? null : <Badge variant={statusBadgeVariant(job.status)}>{job.status}</Badge>}
        {job.needs.length === 0 ? null : <span className="kind">needs: {job.needs.join(', ')}</span>}
        {job.on === 'success' ? null : <span className="kind">on: {job.on}</span>}
        {job.if === undefined ? null : <span className="kind">if: {job.if}</span>}
        {job.lane === undefined ? null : <span className="kind">lane: {job.lane}</span>}
        {job.sessionGroup === undefined ? null : (
          <span className="kind">session_group: {job.sessionGroup}</span>
        )}
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
        <span className="label">input</span>
        {job.inputs.length > 0 ? (
          job.inputs.map((file) => <FileView key={file.path} address={address} file={file} />)
        ) : (
          <span className="desc">
            {job.needs.length > 0 ? 'upstream jobs published nothing' : 'no upstream jobs'}
          </span>
        )}
      </div>

      <div className="row">
        <span className="label">output</span>
        {job.output !== undefined ? (
          <FileView address={address} file={job.output} />
        ) : (
          <span className="desc">{job.outputDeclared ? 'declared, not published yet' : 'not declared'}</span>
        )}
      </div>

      {/*
        Подпись работы — раскрытая, как её видит граф; данные — то, что
        работа опубликовала сама. Обе строки показываются здесь целиком:
        в узле графа умещается один ключ и одна строка.
      */}
      {job.display === undefined ? null : <Pairs label="display" pairs={job.display} />}

      {job.data === undefined ? null : <Pairs label="data" pairs={job.data} />}

      {job.steps.map((step) => (
        <Step key={step.id} address={address} jobId={job.id} step={step} navigate={navigate} />
      ))}
    </div>
  );
}

function BackToRuns({ navigate }: { readonly navigate: (href: string) => void }): JSX.Element {
  return (
    <Button
      variant="link"
      size="sm"
      onClick={() => navigate('/')}
    >
      ← Back to runs
    </Button>
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
          <PageHeader title="Run" description={PAGE_DESCRIPTION} actions={<BackToRuns navigate={navigate} />} />
          <Alert variant="destructive">
            <AlertTitle>Could not load the run</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </>
      );
    }
    return (
      <>
        <PageHeader title="Run" description={PAGE_DESCRIPTION} actions={<BackToRuns navigate={navigate} />} />
        <EmptyState title="Loading…" />
      </>
    );
  }

  const job = current.jobs.find((item) => item.id === selected) ?? current.jobs[0];

  return (
    <>
      <PageHeader
        title={
          <>
            {current.pipeline || 'run'} <span className="run-id">{runId.slice(runId.lastIndexOf('-') + 1)}</span>{' '}
            {current.status === undefined ? null : (
              <Badge variant={statusBadgeVariant(current.status)}>{current.status}</Badge>
            )}
          </>
        }
        description={PAGE_DESCRIPTION}
        actions={<BackToRuns navigate={navigate} />}
      />

      {current.swept ? (
        <Alert className="run-note">
          <AlertTitle>Run was swept</AlertTitle>
          <AlertDescription>
            Only the manifest, state and usage remain — there are no further details.
          </AlertDescription>
        </Alert>
      ) : null}

      {current.filesGone ? (
        <>
          <Alert className="run-note">
            <AlertTitle>Run files were deleted</AlertTitle>
            <AlertDescription>
              Showing the usage summary kept in the store: logs, prompts and diffs cannot be recovered — the
              store never promised that.
            </AlertDescription>
          </Alert>
          {current.total === undefined ? null : (
            <Card className="run-card">
              <CardHeader>
                <CardTitle>Saved totals</CardTitle>
                <span className="kind">
                  {fmtTokens(current.total.billableTokens)} · {fmtDuration(current.total.wallclockMs)} ·{' '}
                  {fmtMoney(current.total.costUsd)}
                </span>
              </CardHeader>
              {current.models === undefined || current.models.length === 0 ? null : (
                <CardContent>
                  <div className="row">
                    <span className="label">models</span>
                    <span className="desc">
                      {current.models
                        .map((slice) => `${slice.model}: ${fmtTokens(slice.billableTokens)} · ${fmtMoney(slice.costUsd)}`)
                        .join('; ')}
                    </span>
                  </div>
                </CardContent>
              )}
            </Card>
          )}
        </>
      ) : null}

      {current.problem === undefined ? null : <ProblemNotice problem={current.problem} />}

      <JobGraph
        graph={current.graph}
        {...(job === undefined ? {} : { selected: job.id })}
        onSelect={setSelected}
        subtitle={(node) =>
          node.blockedBy.length > 0
            ? `canceled: ${node.blockedBy.join(', ')}`
            : (node.status ?? 'not started')
        }
      />

      {job === undefined ? (
        <EmptyState title="No jobs recorded" description="This run has no jobs in its journal." />
      ) : (
        <Card className="run-card">
          <CardContent>
            <Job address={address} job={job} navigate={navigate} />
          </CardContent>
        </Card>
      )}
    </>
  );
}
