import { useState, type JSX } from 'react';

import { decideRun, fetchRun, type AwaitingDecision, type Overview, type RunOverview } from '../api';
import { fmtTime } from '../format';
import { TargetLink } from '../routeLink';
import { RUN_TARGET } from '../screens/run';
import {
  Alert,
  AlertDescription,
  Button,
  EmptyState,
  Input,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@stepcast/ui';
import './decisions.css';

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
          <Button
            key={name}
            variant="outline"
            size="sm"
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
          </Button>
        ))}
        <TargetLink
          target={RUN_TARGET}
          params={{ projectKey: row.projectKey, runId: row.run.runId }}
          navigate={navigate}
          className="decision-run-link small"
        >
          open run
        </TargetLink>
      </div>

      {showReject === undefined ? null : (
        <div className="decision-form">
          <Input
            type="text"
            placeholder="rejection reason"
            aria-label="Rejection reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <Button variant="destructive" size="sm" disabled={busy || !canSubmit(reason)} onClick={() => submit(showReject, { reason })}>
            reject
          </Button>
        </div>
      )}

      {showRestart === undefined ? null : (
        <div className="decision-form">
          <Select value={restartFrom} onValueChange={setRestartFrom}>
            <SelectTrigger aria-label="Restart from step" className="decision-step-select">
              <SelectValue placeholder="— choose a step —" />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((candidate) => (
                <SelectItem key={candidate.address} value={candidate.address}>
                  {candidate.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" disabled={busy || !canSubmit(restartFrom)} onClick={() => submit(showRestart, { from: restartFrom })}>
            restart
          </Button>
        </div>
      )}

      {error === undefined ? null : (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
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

  const header = (
    <PageHeader
      title="Decisions"
      description="Runs paused at a step that waits for a human answer; pick one of the outcomes the step declared, or open the run for context."
    />
  );

  if (list.length === 0) {
    return (
      <>
        {header}
        <EmptyState title="Nothing to decide" description="No run is waiting for a decision." />
      </>
    );
  }

  return (
    <>
      {header}
      <Table className="decisions-table">
        <TableHeader>
          <TableRow>
            <TableHead>Project</TableHead>
            <TableHead>Pipeline</TableHead>
            <TableHead>Run</TableHead>
            <TableHead>Job / step</TableHead>
            <TableHead>Question</TableHead>
            <TableHead>Deadline</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.map((row) => (
            <TableRow key={`${row.projectKey}/${row.run.runId}/${row.awaiting.wait_id}`}>
              <TableCell className="mono small">{row.projectKey}</TableCell>
              <TableCell>{row.run.pipeline || 'unnamed'}</TableCell>
              <TableCell className="mono small">{row.run.shortId}</TableCell>
              <TableCell>
                <span className="mono small">
                  {row.awaiting.job}/{row.awaiting.step}
                </span>
                {row.run.abandoned ? (
                  <Alert variant="warning" className="decision-abandoned">
                    <AlertDescription>
                      process is not responding — the decision applies on resume:{' '}
                      <code>stepcast resume {row.run.shortId} --from {row.awaiting.job}/{row.awaiting.step}</code>
                    </AlertDescription>
                  </Alert>
                ) : null}
              </TableCell>
              <TableCell>{row.awaiting.prompt ?? ''}</TableCell>
              <TableCell className="small dim">{row.awaiting.deadline === undefined ? '—' : fmtTime(row.awaiting.deadline)}</TableCell>
              <TableCell>
                <RowActions row={row} navigate={navigate} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}
