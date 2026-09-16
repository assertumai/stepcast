import { useState, type JSX } from 'react';

import { diffLines, type DiffLine } from '../../../src/parts/pipeline/domain/textDiff.ts';
import {
  decideProposal,
  type ProjectProposalsPayload,
  type ProposalApiRecord,
  type ProposalsOverview,
} from '../api';
import { fmtTime } from '../format';
import { TargetLink } from '../routeLink';
import { RUN_TARGET } from '../screens/run';

/**
 * Экран «Предложения» (`ui-proposals`, design.md Решение 8, 15): очередь всех
 * проектов дифом, сгруппированная по прогону-источнику; открытые записи
 * развёрнуты, решённые свёрнуты. Диф считает браузер построчным LCS
 * (`src/parts/pipeline/domain/textDiff.ts`) из содержимого цели на диске сейчас и предложенного
 * текста — оба уже пришли с `GET /api/proposals`.
 */

export interface ProposalGroup {
  /** `undefined` — записи, поставленные вручную, вне прогона. */
  readonly runId: string | undefined;
  readonly records: readonly ProposalApiRecord[];
}

/** Группировка записей проекта по прогону-источнику, в порядке появления первой записи группы. */
export function groupByRun(records: readonly ProposalApiRecord[]): readonly ProposalGroup[] {
  const order: (string | undefined)[] = [];
  const byRun = new Map<string | undefined, ProposalApiRecord[]>();
  for (const record of records) {
    const key = record.origin.run;
    if (!byRun.has(key)) {
      byRun.set(key, []);
      order.push(key);
    }
    (byRun.get(key) as ProposalApiRecord[]).push(record);
  }
  return order.map((runId) => ({ runId, records: byRun.get(runId) as ProposalApiRecord[] }));
}

const DIFF_MARKER: Record<DiffLine['kind'], string> = { added: '+', removed: '-', same: ' ' };

export function DiffView({ before, after }: { readonly before: string; readonly after: string }): JSX.Element {
  const lines = diffLines(before, after);
  return (
    <pre className="proposal-diff">
      {lines.map((line, index) => (
        <div key={index} className={`diff-line diff-${line.kind}`}>
          <span className="diff-marker">{DIFF_MARKER[line.kind]}</span>
          <span className="diff-text">{line.text}</span>
        </div>
      ))}
    </pre>
  );
}

export function ProposalActions({
  projectKey,
  record,
  onDecided,
  initialError,
}: {
  readonly projectKey: string;
  readonly record: ProposalApiRecord;
  readonly onDecided: () => void;
  /** Отказ, показанный сразу при первом рендере — только для проверки без имитации клика (`ui/test/proposals.test.tsx`). */
  readonly initialError?: string;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(initialError);

  const decide = (decision: 'accept' | 'reject'): void => {
    setBusy(true);
    setError(undefined);
    decideProposal({ project: projectKey, id: record.id, decision })
      .then(() => {
        setBusy(false);
        onDecided();
      })
      .catch((cause: unknown) => {
        setBusy(false);
        // Отказ решения показан на месте этой записи, не гася остальные
        // (`ui-proposals`, «Отказ решения локален»).
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  };

  return (
    <div className="proposal-actions">
      <button disabled={busy} onClick={() => decide('accept')}>
        принять
      </button>
      <button disabled={busy} onClick={() => decide('reject')}>
        отклонить
      </button>
      {error === undefined ? null : <p className="notice error">{error}</p>}
    </div>
  );
}

function ProposalCard({
  projectKey,
  record,
  onDecided,
}: {
  readonly projectKey: string;
  readonly record: ProposalApiRecord;
  readonly onDecided: () => void;
}): JSX.Element {
  const open = record.state === 'pending';
  return (
    <div className={`proposal-card ${open ? 'open' : 'decided'}`}>
      <div className="proposal-head">
        <code>{record.target}</code>
        <span className={`badge state-${record.state}`}>{record.state}</span>
        <span className="proposal-time">{fmtTime(record.createdAt)}</span>
      </div>
      {record.reason === undefined ? null : <p className="proposal-reason">{record.reason}</p>}
      {open ? (
        <>
          <DiffView before={record.currentContent ?? ''} after={record.content} />
          <ProposalActions projectKey={projectKey} record={record} onDecided={onDecided} />
        </>
      ) : (
        <p className="note dim">решено{record.decidedAt === undefined ? '' : ` ${fmtTime(record.decidedAt)}`}</p>
      )}
    </div>
  );
}

function ProjectProposals({
  project,
  navigate,
  onDecided,
}: {
  readonly project: ProjectProposalsPayload;
  readonly navigate: (href: string) => void;
  readonly onDecided: () => void;
}): JSX.Element {
  const groups = groupByRun(project.records);
  return (
    <section className="proposals-project">
      <header className="proposals-project-head">
        <h3>{project.projectKey}</h3>
        <span className={`badge mode-${project.mode}`}>
          {project.mode === 'direct' ? 'прямая запись' : 'очередь'}
        </span>
      </header>
      {groups.length === 0 ? <p className="note dim">Очередь пуста.</p> : null}
      {groups.map((group) => (
        <div className="proposal-group" key={group.runId ?? 'manual'}>
          <div className="proposal-group-head">
            {group.runId === undefined ? (
              <span>вручную</span>
            ) : (
              <TargetLink
                target={RUN_TARGET}
                params={{ projectKey: project.projectKey, runId: group.runId }}
                navigate={navigate}
              >
                прогон {group.runId}
              </TargetLink>
            )}
          </div>
          {group.records.map((record) => (
            <ProposalCard key={record.id} projectKey={project.projectKey} record={record} onDecided={onDecided} />
          ))}
        </div>
      ))}
      {project.invalid.map((item) => (
        <p className="notice error" key={item.file}>
          негодная запись {item.file}: {item.reason}
        </p>
      ))}
    </section>
  );
}

export function Proposals({
  overview,
  navigate,
  onDecided = () => {},
}: {
  readonly overview: ProposalsOverview | undefined;
  readonly navigate: (href: string) => void;
  readonly onDecided?: () => void;
}): JSX.Element {
  if (overview === undefined) {
    return <p className="note dim">Загрузка…</p>;
  }
  if (overview.projects.length === 0) {
    return <p className="note dim">Ни один проект не предлагал правок.</p>;
  }
  return (
    <div className="proposals-screen">
      {overview.projects.map((project) => (
        <ProjectProposals key={project.projectKey} project={project} navigate={navigate} onDecided={onDecided} />
      ))}
    </div>
  );
}
