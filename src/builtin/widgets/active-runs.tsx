import { useEffect, useState } from 'react';
import { Badge } from '@stepcast/ui';

/**
 * Runs in progress right now across all projects, each linking to its run
 * page — an at-a-glance “what is the daemon doing”.
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

export default function ActiveRuns() {
  const { projects, offline } = useOverview();
  if (projects === undefined) return <p style={{ color: 'var(--muted-foreground)' }}>{offline ? 'Daemon unreachable' : 'Loading…'}</p>;
  const active = projects.flatMap((project) =>
    project.runs.filter((run) => run.running).map((run) => ({ project, run })),
  );
  if (active.length === 0) return <p style={{ color: 'var(--muted-foreground)' }}>Nothing is running.</p>;
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '.4rem' }}>
      {active.map(({ project, run }) => (
        <li key={`${project.key}/${run.runId}`} style={{ display: 'flex', gap: '.6rem', alignItems: 'center' }}>
          <Badge variant="running">running</Badge>
          <a href={`/runs/${project.key}/${run.runId}`} style={{ fontWeight: 600 }}>{run.pipeline}</a>
          <span style={{ fontFamily: 'var(--mono)', color: 'var(--muted-foreground)', fontSize: '.8rem' }}>{run.shortId}</span>
          <span style={{ color: 'var(--muted-foreground)', fontSize: '.8rem' }} title={project.path}>
            {project.path === undefined ? project.key : baseName(project.path)}
          </span>
        </li>
      ))}
    </ul>
  );
}
