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
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  statusBadgeVariant,
} from '@stepcast/ui';
import './proposals.css';

/**
 * Экран «Proposals» (`ui-proposals`, design.md Решение 8, 15; `ui-overhaul`):
 * правки файлов кабинета, предложенные агентом, дифом — по проектам и по
 * прогону-источнику. Открытые записи развёрнуты с кнопками решения, решённые
 * собраны таблицей на своей вкладке. Диф считает браузер построчным LCS
 * (`src/parts/pipeline/domain/textDiff.ts`) из содержимого цели на диске сейчас
 * и предложенного текста — оба уже пришли с `GET /api/proposals`.
 *
 * Проект без единой записи не показывается: раздел «queue is empty» на
 * каждый известный демону каталог превращал экран в перечень хэшей.
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

export function projectName(path: string | undefined, projectKey: string): string {
  if (path === undefined) return projectKey;
  const parts = path.split('/').filter((part) => part.length > 0);
  return parts.length === 0 ? path : (parts[parts.length - 1] as string);
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
      <Button size="sm" disabled={busy} onClick={() => decide('accept')}>
        Accept
      </Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => decide('reject')}>
        Reject
      </Button>
      {error === undefined ? null : (
        <Alert variant="destructive" className="proposal-error">
          {error}
        </Alert>
      )}
    </div>
  );
}

function OriginLabel({
  projectKey,
  runId,
  navigate,
}: {
  readonly projectKey: string;
  readonly runId: string | undefined;
  readonly navigate: (href: string) => void;
}): JSX.Element {
  if (runId === undefined) return <span className="dim">proposed manually</span>;
  return (
    <TargetLink target={RUN_TARGET} params={{ projectKey, runId }} navigate={navigate}>
      run {runId}
    </TargetLink>
  );
}

function PendingCard({
  projectKey,
  record,
  onDecided,
}: {
  readonly projectKey: string;
  readonly record: ProposalApiRecord;
  readonly onDecided: () => void;
}): JSX.Element {
  return (
    <div className="proposal-card open">
      <div className="proposal-head">
        <code>{record.target}</code>
        <Badge variant="secondary">{record.action}</Badge>
        <span className="proposal-time dim small">{fmtTime(record.createdAt)}</span>
      </div>
      {record.reason === undefined ? null : <p className="proposal-reason">{record.reason}</p>}
      <DiffView before={record.currentContent ?? ''} after={record.content} />
      <ProposalActions projectKey={projectKey} record={record} onDecided={onDecided} />
    </div>
  );
}

function ResolvedTable({
  projectKey,
  records,
  navigate,
}: {
  readonly projectKey: string;
  readonly records: readonly ProposalApiRecord[];
  readonly navigate: (href: string) => void;
}): JSX.Element {
  return (
    <Table className="proposals-resolved">
      <TableHeader>
        <TableRow>
          <TableHead>Target</TableHead>
          <TableHead>Decision</TableHead>
          <TableHead>Origin</TableHead>
          <TableHead>Decided</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {records.map((record) => (
          <TableRow key={record.id}>
            <TableCell>
              <code>{record.target}</code>
            </TableCell>
            <TableCell>
              <Badge variant={statusBadgeVariant(record.state)}>{record.state}</Badge>
            </TableCell>
            <TableCell>
              <OriginLabel projectKey={projectKey} runId={record.origin.run} navigate={navigate} />
            </TableCell>
            <TableCell className="dim">{record.decidedAt === undefined ? '—' : fmtTime(record.decidedAt)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
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
  const pending = project.records.filter((record) => record.state === 'pending');
  const resolved = project.records.filter((record) => record.state !== 'pending');
  const groups = groupByRun(pending);
  const path: string | undefined = project.projectPath;

  return (
    <Card className="proposals-project">
      <CardHeader className="proposals-project-head">
        <div>
          <CardTitle title={path}>{projectName(path, project.projectKey)}</CardTitle>
          {path === undefined ? null : <CardDescription className="mono">{path}</CardDescription>}
        </div>
        <Badge variant={project.mode === 'direct' ? 'running' : 'outline'} title="Delivery mode: proposals are written straight to disk (direct) or wait for a decision here (queue)">
          {project.mode === 'direct' ? 'direct write' : 'queue'}
        </Badge>
      </CardHeader>
      <CardContent>
        {project.invalid.map((item) => (
          <Alert variant="destructive" key={item.file}>
            Invalid entry {item.file}: {item.reason}
          </Alert>
        ))}
        <Tabs defaultValue={pending.length > 0 || resolved.length === 0 ? 'pending' : 'resolved'}>
          <TabsList>
            <TabsTrigger value="pending">Pending ({pending.length})</TabsTrigger>
            <TabsTrigger value="resolved">Resolved ({resolved.length})</TabsTrigger>
          </TabsList>
          <TabsContent value="pending">
            {groups.length === 0 ? <p className="dim small proposals-empty">Nothing is waiting for a decision.</p> : null}
            {groups.map((group) => (
              <div className="proposal-group" key={group.runId ?? 'manual'}>
                <div className="proposal-group-head small">
                  <OriginLabel projectKey={project.projectKey} runId={group.runId} navigate={navigate} />
                </div>
                {group.records.map((record) => (
                  <PendingCard key={record.id} projectKey={project.projectKey} record={record} onDecided={onDecided} />
                ))}
              </div>
            ))}
          </TabsContent>
          <TabsContent value="resolved">
            {resolved.length === 0 ? (
              <p className="dim small proposals-empty">No decisions yet.</p>
            ) : (
              <ResolvedTable projectKey={project.projectKey} records={resolved} navigate={navigate} />
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
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
  const header = (
    <PageHeader
      title="Proposals"
      description={
        <>
          Changes an agent proposed to a project’s <code>.stepcast/</code> files — widgets, dashboards, plugins.
          Nothing is written until you accept. Agents queue a change with{' '}
          <code>stepcast propose &lt;target&gt; --from &lt;file&gt;</code>.
        </>
      }
    />
  );
  if (overview === undefined) {
    return (
      <>
        {header}
        <p className="dim">Loading…</p>
      </>
    );
  }
  const projects = overview.projects.filter((project) => project.records.length > 0 || project.invalid.length > 0);
  if (projects.length === 0) {
    return (
      <>
        {header}
        <EmptyState
          title="No proposals yet"
          description="When an agent proposes a change to a project’s .stepcast/ files, it shows up here with a diff and Accept / Reject buttons."
        />
      </>
    );
  }
  return (
    <>
      {header}
      <div className="proposals-screen">
        {projects.map((project) => (
          <ProjectProposals key={project.projectKey} project={project} navigate={navigate} onDecided={onDecided} />
        ))}
      </div>
    </>
  );
}
