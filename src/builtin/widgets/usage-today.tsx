import { useEffect, useState } from 'react';

/**
 * Cost and billable tokens of the runs started today, summed over all
 * projects — a small stat tile for the top of a dashboard.
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


function isToday(iso: string | undefined): boolean {
  if (iso === undefined) return false;
  const at = new Date(iso);
  const now = new Date();
  return at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export default function UsageToday() {
  const { projects, offline } = useOverview();
  if (projects === undefined) return <p style={{ color: 'var(--muted-foreground)' }}>{offline ? 'Daemon unreachable' : 'Loading…'}</p>;
  const runs = projects.flatMap((project) => project.runs).filter((run) => isToday(run.startedAt));
  const cost = runs.reduce((sum, run) => sum + (run.usage?.costUsd ?? 0), 0);
  const tokens = runs.reduce((sum, run) => sum + (run.usage?.billableTokens ?? 0), 0);
  const tile = { display: 'flex', flexDirection: 'column' as const, gap: '.1rem' };
  const value = { fontSize: '1.4rem', fontWeight: 650, fontFamily: 'var(--mono)' };
  const label = { fontSize: '.78rem', color: 'var(--muted-foreground)' };
  return (
    <div style={{ display: 'flex', gap: '2rem' }}>
      <div style={tile}><span style={value}>${cost.toFixed(2)}</span><span style={label}>spent today</span></div>
      <div style={tile}><span style={value}>{formatTokens(tokens)}</span><span style={label}>billable tokens</span></div>
      <div style={tile}><span style={value}>{runs.length}</span><span style={label}>runs started</span></div>
    </div>
  );
}
