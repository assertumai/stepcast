import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@stepcast/ui';

/**
 * Виджет «Проекты» — что демон видит прямо сейчас: карточка на проект, с
 * прогрессом его очереди и ссылкой на экран «Очередь».
 *
 * Данных виджету витрина не даёт (`docs/widgets.md`, «Чего в спайке нет»),
 * поэтому он берёт их сам — из потока `GET /api/events`, того же, на котором
 * живут экраны. Оба нужных события (`overview` и `backlog`) приходят сразу
 * при подключении, так что начального `fetch` здесь нет: лишний запрос дал бы
 * ту же картинку на такт раньше и вторую ветку разбора ответа.
 *
 * Состав проектов берётся из `overview`, а не из `backlog`: проект без
 * единого пункта очереди — законное состояние, и пропасть из списка он не
 * должен.
 *
 * Вёрстка — компонентами витрины (`@stepcast/ui`), а не своей: карточка и
 * кнопка приходят теми же, что у встроенных экранов, вместе со своим CSS в
 * бандле страницы (`ui-components`, «Плагин рисует кнопку витрины»). Свой
 * стиль остаётся только у того, чего в наборе нет, — полосы прогресса и
 * подписей к ней.
 */

interface OverviewRun {
  readonly status: string;
  readonly running: boolean;
  readonly startedAt: string;
}

interface OverviewProject {
  readonly key: string;
  readonly path: string;
  readonly runs: readonly OverviewRun[];
}

interface BacklogItem {
  readonly slug: string;
  readonly status: string;
  readonly title: string;
  /** Имя файла внутри проекта: `backlog.md` либо `archived.md`. */
  readonly sourceFile: string;
}

interface BacklogProject {
  readonly projectKey: string;
  readonly projectPath: string;
  readonly items: readonly BacklogItem[];
  readonly failures: readonly unknown[];
}

/** Строка виджета: проект обзора, дополненный подсчётом его очереди. */
interface ProjectRow {
  readonly key: string;
  readonly path: string;
  readonly name: string;
  readonly backlogFile: string | undefined;
  readonly total: number;
  readonly done: number;
  readonly pending: number;
  readonly failed: number;
  readonly other: number;
  readonly running: number;
  readonly lastRunAt: string | undefined;
  /** Почему строка не показана по умолчанию; `undefined` — настоящий проект. */
  readonly hidden: HiddenReason | undefined;
}

/**
 * Проектом демон считает любой каталог, откуда шёл прогон, — включая
 * рабочий каталог другого прогона и каталог под пробу в `/tmp`. Признака
 * «каталог жив» обзор не несёт (`filesGone` говорит о файлах прогона, а не о
 * проекте), поэтому шум отделяется по пути — единственному, что здесь есть, —
 * и не выбрасывается, а прячется за переключателем: правило это догадка о
 * намерении, и человеку оставлена возможность её опровергнуть.
 */
type HiddenReason = 'run-workspace' | 'temp';

const TEMP_PREFIXES = ['/tmp/', '/private/tmp/', '/var/folders/', '/private/var/folders/'];

function hiddenReasonOf(path: string): HiddenReason | undefined {
  if (path.includes('/.stepcast/runs/')) return 'run-workspace';
  if (TEMP_PREFIXES.some((prefix) => path.startsWith(prefix))) return 'temp';
  return undefined;
}

const HIDDEN_TEXT: Readonly<Record<HiddenReason, string>> = {
  'run-workspace': 'рабочий каталог прогона',
  temp: 'временный каталог',
};

function baseName(path: string): string {
  const parts = path.split('/').filter((part) => part.length > 0);
  return parts.length === 0 ? path : parts[parts.length - 1]!;
}

/**
 * Файл очереди проекта — по пункту, а не догадкой: пункты несут имя своего
 * файла (`backlog.md` либо `archived.md`), и открывать пользователю надо тот,
 * куда пишутся незакрытые. Если очередь пуста, файла нет вовсе — угадывать
 * несуществующий путь виджет не станет.
 */
function backlogFileOf(project: BacklogProject | undefined): string | undefined {
  if (project === undefined) return undefined;
  const names = new Set(project.items.map((item) => item.sourceFile));
  const name = names.has('backlog.md') ? 'backlog.md' : [...names][0];
  return name === undefined ? undefined : `${project.projectPath}/${name}`;
}

function rowsOf(overview: readonly OverviewProject[], backlog: readonly BacklogProject[]): readonly ProjectRow[] {
  const byKey = new Map(backlog.map((project) => [project.projectKey, project]));
  const rows = overview.map((project): ProjectRow => {
    const items = byKey.get(project.key)?.items ?? [];
    const count = (status: string): number => items.filter((item) => item.status === status).length;
    const done = count('done');
    const pending = count('pending');
    const failed = count('failed');
    const runs = project.runs;
    const started = runs.map((run) => run.startedAt).sort();
    return {
      key: project.key,
      path: project.path,
      name: baseName(project.path),
      backlogFile: backlogFileOf(byKey.get(project.key)),
      total: items.length,
      done,
      pending,
      failed,
      other: items.length - done - pending - failed,
      running: runs.filter((run) => run.running).length,
      lastRunAt: started.length === 0 ? undefined : started[started.length - 1],
      hidden: hiddenReasonOf(project.path),
    };
  });
  // Сначала проекты с незакрытыми пунктами — то, что просит внимания; затем
  // остальные, внутри каждой группы по имени. Служебные каталоги — всегда
  // последними, даже если очередь у них длиннее.
  return [...rows].sort((a, b) => {
    if ((a.hidden === undefined) !== (b.hidden === undefined)) return a.hidden === undefined ? -1 : 1;
    const openA = a.pending + a.failed;
    const openB = b.pending + b.failed;
    if (openA !== openB) return openB - openA;
    return a.name.localeCompare(b.name, 'ru');
  });
}

function formatWhen(iso: string | undefined): string {
  if (iso === undefined) return 'прогонов нет';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'прогонов нет';
  return at.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}

/** Кнопка «скопировать путь»: подтверждает копирование, а не обещает его. */
function CopyPath({ path }: { readonly path: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);
  return (
    <Button
      variant="outline"
      size="sm"
      title={path}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(path)
          .then(() => setCopied(true))
          .catch(() => setCopied(false));
      }}
    >
      {copied ? 'скопировано' : 'скопировать путь'}
    </Button>
  );
}

function ProgressBar({ row }: { readonly row: ProjectRow }) {
  const part = (value: number): string => `${(value / row.total) * 100}%`;
  return (
    <div className="scw-bar">
      <span className="scw-seg scw-done" style={{ width: part(row.done) }} />
      <span className="scw-seg scw-pending" style={{ width: part(row.pending) }} />
      <span className="scw-seg scw-failed" style={{ width: part(row.failed) }} />
      <span className="scw-seg scw-other" style={{ width: part(row.other) }} />
    </div>
  );
}

function ProjectCard({ row }: { readonly row: ProjectRow }) {
  const percent = row.total === 0 ? undefined : Math.round((row.done / row.total) * 100);
  return (
    <Card>
      <CardHeader className="scw-head">
        <CardTitle className="scw-title">
          {row.name}
          {row.running > 0 ? <span className="scw-live">идёт {row.running}</span> : null}
          {row.hidden === undefined ? null : <span className="scw-tag">{HIDDEN_TEXT[row.hidden]}</span>}
          <span className="scw-when">{formatWhen(row.lastRunAt)}</span>
        </CardTitle>
        <CardDescription className="scw-path">{row.path}</CardDescription>
      </CardHeader>

      <CardContent>
        {row.total === 0 ? (
          <p className="scw-none">очереди нет: ни одного пункта в backlog.md и archived.md</p>
        ) : (
          <>
            <ProgressBar row={row} />
            <div className="scw-counts">
              <span className="scw-percent">{percent}%</span>
              <span>
                {row.done} из {row.total} закрыто
              </span>
              {row.pending > 0 ? <span className="scw-tag">{row.pending} в очереди</span> : null}
              {row.failed > 0 ? <span className="scw-tag scw-t-failed">{row.failed} с отказом</span> : null}
              {row.other > 0 ? <span className="scw-tag">{row.other} прочих</span> : null}
            </div>
          </>
        )}
      </CardContent>

      <CardFooter className="scw-links">
        <Button variant="link" size="sm" onClick={() => window.location.assign('/backlog')}>
          Очередь →
        </Button>
        {row.backlogFile === undefined ? null : (
          <>
            <code className="scw-file">{row.backlogFile}</code>
            <CopyPath path={row.backlogFile} />
          </>
        )}
      </CardFooter>
    </Card>
  );
}

export default function Projects() {
  const [overview, setOverview] = useState<readonly OverviewProject[] | undefined>(undefined);
  const [backlog, setBacklog] = useState<readonly BacklogProject[]>([]);
  const [offline, setOffline] = useState(false);
  const [showHidden, setShowHidden] = useState(false);

  useEffect(() => {
    const source = new EventSource('/api/events');
    source.addEventListener('overview', (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as { readonly projects: readonly OverviewProject[] };
      setOverview(data.projects);
      setOffline(false);
    });
    source.addEventListener('backlog', (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as { readonly projects: readonly BacklogProject[] };
      setBacklog(data.projects);
      setOffline(false);
    });
    source.addEventListener('error', () => setOffline(true));
    return () => source.close();
  }, []);

  const rows = useMemo(() => rowsOf(overview ?? [], backlog), [overview, backlog]);
  const hiddenCount = rows.filter((row) => row.hidden !== undefined).length;
  const shown = showHidden ? rows : rows.filter((row) => row.hidden === undefined);

  return (
    <div className="scw">
      <style>{CSS}</style>
      {offline ? <p className="scw-offline">связь с демоном потеряна — показано последнее, что пришло</p> : null}
      {overview === undefined ? (
        <p className="scw-none">жду обзор от демона…</p>
      ) : shown.length === 0 ? (
        <p className="scw-none">
          {hiddenCount === 0 ? 'демон не видит ни одного проекта' : 'настоящих проектов нет — только рабочие и временные каталоги'}
        </p>
      ) : (
        shown.map((row) => <ProjectCard key={row.key} row={row} />)
      )}
      {hiddenCount === 0 ? null : (
        <Button variant="ghost" size="sm" className="scw-toggle" onClick={() => setShowHidden((value) => !value)}>
          {showHidden ? `скрыть служебные каталоги (${hiddenCount})` : `показать служебные каталоги (${hiddenCount})`}
        </Button>
      )}
    </div>
  );
}

/**
 * Своего CSS ровно столько, сколько не покрывают компоненты витрины: полоса
 * прогресса, подписи к ней и раскладка внутри карточки.
 */
const CSS = `
.scw { display: flex; flex-direction: column; gap: 12px; }
/* sc-card-header кладёт детей в строку (ui/src/ui/card.css) — заголовку и
   пути нужна колонка, иначе путь прилипает к дате. */
.scw-head { flex-direction: column; align-items: stretch; gap: 2px; }
.scw-title { display: flex; align-items: baseline; gap: 8px; }
.scw-when { margin-left: auto; font-size: 12px; font-weight: 400; color: var(--muted-foreground); }
.scw-live { font-size: 12px; font-weight: 400; color: var(--status-running); }
.scw-path { font-family: var(--mono); font-size: 11px; overflow-wrap: anywhere; }
.scw-bar { display: flex; height: 8px; border-radius: 999px; overflow: hidden; background: var(--muted); }
.scw-seg { display: block; height: 100%; }
.scw-done { background: var(--status-success); }
.scw-pending { background: var(--muted-foreground); opacity: 0.5; }
.scw-failed { background: var(--status-failed); }
.scw-other { background: var(--status-running); }
.scw-counts { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; margin-top: 6px; font-size: 12px; color: var(--muted-foreground); }
.scw-percent { font-size: 14px; font-weight: 600; color: var(--foreground); }
.scw-tag { padding: 1px 6px; border-radius: 999px; background: var(--secondary); color: var(--secondary-foreground); font-size: 12px; font-weight: 400; }
.scw-t-failed { background: var(--destructive); color: var(--destructive-foreground); }
.scw-links { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.scw-file { font-family: var(--mono); font-size: 11px; color: var(--muted-foreground); overflow-wrap: anywhere; }
.scw-none { margin: 0; font-size: 12px; color: var(--muted-foreground); }
.scw-offline { margin: 0; font-size: 12px; color: var(--status-failed); }
.scw-toggle { align-self: flex-start; }
`;
