import { useState, type JSX } from 'react';

import { decideRun, fetchRun, type AwaitingDecision, type Overview, type RunOverview } from '../api';
import { fmtTime } from '../format';
import { TargetLink } from '../routeLink';
import { RUN_TARGET } from '../screens/run';

/**
 * Экран «Решения» (`user-decision-steps`, design.md решение 11): таблица
 * ожидающих прогонов, собранная из обзора, который витрина уже получает
 * живьём по `GET /api/events` (`overview`) — свой маршрут чтения экран не
 * заводит. Кнопки строятся только по исходам, объявленным самим ожиданием:
 * вклад решает форму, а не эта страница (design.md, решение 1).
 */

export interface Row {
  readonly projectKey: string;
  readonly run: RunOverview;
  readonly awaiting: AwaitingDecision;
}

export function rows(overview: Overview | undefined): readonly Row[] {
  const out: Row[] = [];
  for (const project of overview?.projects ?? []) {
    for (const run of project.runs) {
      for (const awaiting of run.awaiting ?? []) {
        out.push({ projectKey: project.key, run, awaiting });
      }
    }
  }
  return out;
}

/** Шаги, исполнившиеся в прогоне раньше ожидающего, — кандидаты в точку перезапуска. */
export function restartCandidates(
  snapshot: Awaited<ReturnType<typeof fetchRun>> | undefined,
): readonly { readonly address: string; readonly label: string }[] {
  if (snapshot === undefined) return [];
  const out: { address: string; label: string }[] = [];
  for (const job of snapshot.jobs) {
    for (const step of job.steps) {
      if (step.status === undefined) continue;
      out.push({ address: `${job.id}/${step.id}`, label: `${job.id}/${step.id} (${step.status})` });
    }
  }
  return out;
}

/**
 * Может ли форма отправить исход: `reject` без причины и `restart` без
 * выбранного шага не отправляются (design.md, решение 11) — одна и та же
 * проверка непустоты для обоих полей, вынесенная отдельно, чтобы правило и
 * тест на него не разошлись.
 */
export function canSubmit(value: string): boolean {
  return value.trim() !== '';
}

function RowActions({ row, navigate }: { readonly row: Row; readonly navigate: (href: string) => void }): JSX.Element {
  const address = `${row.projectKey}/${row.run.runId}`;
  const [reason, setReason] = useState('');
  const [restartFrom, setRestartFrom] = useState('');
  const [candidates, setCandidates] = useState<readonly { address: string; label: string }[]>([]);
  const [showReject, setShowReject] = useState<string | undefined>(undefined);
  const [showRestart, setShowRestart] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const submit = (outcome: string, extra: { reason?: string; from?: string } = {}): void => {
    setBusy(true);
    setError(undefined);
    decideRun({
      run: address,
      outcome,
      step: `${row.awaiting.job}/${row.awaiting.step}`,
      ...extra,
    })
      .then(() => {
        setBusy(false);
        setShowReject(undefined);
        setShowRestart(undefined);
      })
      .catch((cause: unknown) => {
        setBusy(false);
        // Отказ маршрута показан на месте этой записи, не гася остальные
        // строки таблицы (design.md, решение 11).
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  };

  const openRestart = (outcome: string): void => {
    setShowRestart(outcome);
    setShowReject(undefined);
    fetchRun(address)
      .then((snapshot) => setCandidates(restartCandidates(snapshot)))
      .catch(() => setCandidates([]));
  };

  return (
    <div className="decision-actions">
      <div className="decision-buttons">
        {Object.entries(row.awaiting.outcomes).map(([name, spec]) => (
          <button
            key={name}
            disabled={busy}
            onClick={() => {
              if (spec.effect === 'reject') {
                setShowReject(name);
                setShowRestart(undefined);
                return;
              }
              if (spec.effect === 'restart') {
                openRestart(name);
                return;
              }
              submit(name);
            }}
          >
            {spec.label ?? name}
          </button>
        ))}
        <TargetLink target={RUN_TARGET} params={{ projectKey: row.projectKey, runId: row.run.runId }} navigate={navigate}>
          открыть прогон
        </TargetLink>
      </div>

      {showReject === undefined ? null : (
        <div className="decision-form">
          <input
            type="text"
            placeholder="причина отклонения"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <button disabled={busy || !canSubmit(reason)} onClick={() => submit(showReject, { reason })}>
            отклонить
          </button>
        </div>
      )}

      {showRestart === undefined ? null : (
        <div className="decision-form">
          <select value={restartFrom} onChange={(event) => setRestartFrom(event.target.value)}>
            <option value="">— выбрать шаг —</option>
            {candidates.map((candidate) => (
              <option key={candidate.address} value={candidate.address}>
                {candidate.label}
              </option>
            ))}
          </select>
          <button disabled={busy || !canSubmit(restartFrom)} onClick={() => submit(showRestart, { from: restartFrom })}>
            перезапустить
          </button>
        </div>
      )}

      {error === undefined ? null : <p className="notice error">{error}</p>}
    </div>
  );
}

export function Decisions({
  overview,
  navigate,
}: {
  readonly overview: Overview | undefined;
  readonly navigate: (href: string) => void;
}): JSX.Element {
  const list = rows(overview);

  if (list.length === 0) {
    return <p className="note dim">Ни один прогон решения не ждёт.</p>;
  }

  return (
    <table className="decisions-table">
      <thead>
        <tr>
          <th>проект</th>
          <th>пайплайн</th>
          <th>прогон</th>
          <th>работа/шаг</th>
          <th>вопрос</th>
          <th>срок</th>
          <th>действия</th>
        </tr>
      </thead>
      <tbody>
        {list.map((row) => (
          <tr key={`${row.projectKey}/${row.run.runId}/${row.awaiting.wait_id}`}>
            <td>{row.projectKey}</td>
            <td>{row.run.pipeline || 'без имени'}</td>
            <td>{row.run.shortId}</td>
            <td>
              {row.awaiting.job}/{row.awaiting.step}
              {row.run.abandoned ? (
                <div className="badge">
                  процесс не отвечает — решение применится при возобновлении:{' '}
                  <code>stepcast resume {row.run.shortId} --from {row.awaiting.job}/{row.awaiting.step}</code>
                </div>
              ) : null}
            </td>
            <td>{row.awaiting.prompt ?? ''}</td>
            <td>{row.awaiting.deadline === undefined ? '—' : fmtTime(row.awaiting.deadline)}</td>
            <td>
              <RowActions row={row} navigate={navigate} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
