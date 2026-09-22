import { useEffect, useState } from 'react';
import { Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@stepcast/ui';

/**
 * Projects the daemon knows about, with their run counts and the time of the
 * last run — a compact table for a dashboard.
 */

interface OverviewRun {
  readonly runId: string;
  readonly shortId: string;
  readonly pipeline: string;
  readonly status?: string;
  readonly running: boolean;
  readonly startedAt?: string;
  readonly usage?: { readonly billableTokens: number; readonly costUsd: number | null };
}

interface OverviewProject {
  readonly key: string;
  readonly path?: string;
  readonly runs: readonly OverviewRun[];
}

/**
 * Данных виджету витрина не даёт (docs/widgets.md, «Чего в спайке нет»),
 * поэтому он берёт их сам — из потока `GET /api/events`, того же, на котором
 * живут экраны: событие `overview` приходит сразу при подключении.
 */
function useOverview(): { readonly projects: readonly OverviewProject[] | undefined; readonly offline: boolean } {
  const [projects, setProjects] = useState<readonly OverviewProject[] | undefined>(undefined);
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    const source = new EventSource('/api/events');
    source.addEventListener('overview', (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as { readonly projects: readonly OverviewProject[] };
      setProjects(data.projects);
      setOffline(false);
    });
    source.addEventListener('error', () => setOffline(true));
    return () => source.close();
  }, []);
  return { projects, offline };
}

function baseName(path: string): string {
  const parts = path.split('/').filter((part) => part.length > 0);
  return parts.length === 0 ? path : parts[parts.length - 1]!;
}

function lastRunAt(runs: readonly OverviewRun[]): string | undefined {
  const started = runs.map((run) => run.startedAt).filter((at): at is string => at !== undefined).sort();
  return started[started.length - 1];
}

export default function Projects() {
  const { projects, offline } = useOverview();
  if (projects === undefined) return <p style={{ color: 'var(--muted-foreground)' }}>{offline ? 'Daemon unreachable' : 'Loading…'}</p>;
  const rows = projects.filter((project) => project.path !== undefined);
  if (rows.length === 0) return <p style={{ color: 'var(--muted-foreground)' }}>No projects yet — run a pipeline first.</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Project</TableHead>
          <TableHead>Runs</TableHead>
          <TableHead>Last run</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((project) => {
          const running = project.runs.filter((run) => run.running).length;
          const last = lastRunAt(project.runs);
          return (
            <TableRow key={project.key}>
              <TableCell title={project.path}>{baseName(project.path as string)}</TableCell>
              <TableCell>
                {project.runs.length}
                {running > 0 ? <Badge variant="running" style={{ marginLeft: '.4rem' }}>{running} running</Badge> : null}
              </TableCell>
              <TableCell style={{ color: 'var(--muted-foreground)' }}>{last === undefined ? '—' : new Date(last).toLocaleString()}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
