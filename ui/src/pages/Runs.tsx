import { useEffect, useMemo, useRef, useState, type JSX } from 'react';

import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  EmptyState,
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
  statusBadgeVariant,
} from '@stepcast/ui';
import {
  deleteRun,
  deleteRuns,
  selectRunsByAddresses,
  type Overview,
  type RemovalSummary,
  type RunOverview,
  type RunSelection,
  type StatsOutcome,
} from '../api';
import { fmtBytes, fmtDuration, fmtMoney, fmtTime, fmtTokens, pluralRuns } from '../format';
import { TargetLink } from '../routeLink';
import { RUN_TARGET } from '../screens/run';
import { withCurrentOption } from '../../../src/parts/ui/filters';
import {
  collectFilterValues,
  describePipelineFilterValue,
  lastPathSegment,
  runDuration,
  unknownPathLabel,
  viewRuns,
  DEFAULT_SORT,
  EMPTY_FILTERS,
  type RunFilters,
  type SortMetric,
  type SortOrder,
} from '../../../src/parts/ui/runsView';
import { SortHeader } from '../SortHeader';
import './runs.css';

/**
 * Прогоны таблицей — всех проектов разом.
 *
 * Колонки — то, по чему заходы сравнивают между собой: проект, имя, статус,
 * начало, продолжительность, деньги, токены. Расход стоит рядом с исходом
 * намеренно: вопрос «во что обошёлся неудачный заход» задаётся о той же
 * строке. Проект — колонка, а не заголовок секции: секции и общая сортировка
 * несовместимы (design.md изменения ui-runs-list-controls, Решение 1).
 *
 * Отбор, порядок и состав значений фильтров считает чистый модуль
 * `src/parts/ui/runsView.ts` — здесь только состояние экрана (что выбрано) и
 * отрисовка.
 *
 * Настоящая `<table>`, а не сетка из блоков: у таблицы есть шапка, которую
 * читает и глаз, и программа чтения с экрана, а колонки здесь именно колонки
 * данных, а не приём вёрстки.
 */

interface VersionSkewSummary {
  readonly count: number;
  readonly journalFormat?: number;
  readonly readerFormat: number;
}

/**
 * Расхождение версий — состояние витрины, а не отдельного прогона: шесть
 * прогонов об одной беде складываются в одну полосу с одним числом и одной
 * командой, а не повторяют объяснение в каждой строке. Считает по всему
 * обзору, а не по показанному списку: включённый фильтр не должен превращать
 * «шесть прогонов» в «два» (Решение 12).
 */
function versionSkewSummary(overview: Overview): VersionSkewSummary | undefined {
  let count = 0;
  let journalFormat: number | undefined;
  let readerFormat: number | undefined;
  for (const project of overview.projects) {
    for (const run of project.runs) {
      if (run.problem?.kind !== 'version-skew') continue;
      count += 1;
      readerFormat ??= run.problem.readerFormat;
      if (run.problem.journalFormat !== undefined) {
        journalFormat = Math.max(journalFormat ?? 0, run.problem.journalFormat);
      }
    }
  }
  if (count === 0 || readerFormat === undefined) return undefined;
  return { count, readerFormat, ...(journalFormat === undefined ? {} : { journalFormat }) };
}

/**
 * «1 run was written», «2 runs were written». Число — общий с подтверждением
 * группового удаления `pluralRuns`; форма сказуемого нужна только этой полосе
 * и остаётся здесь (design.md изменения ui-runs-list-controls, Решение 13).
 */
function affectedRuns(count: number): string {
  return `${pluralRuns(count)} ${count === 1 ? 'was' : 'were'} written`;
}

function VersionSkewBanner({ overview }: { readonly overview: Overview }): JSX.Element | null {
  const summary = versionSkewSummary(overview);
  if (summary === undefined) return null;

  const journal = summary.journalFormat === undefined ? 'a newer journal format' : `journal format ${summary.journalFormat}`;
  return (
    <Alert variant="warning" className="notice">
      <AlertTitle>Reader is out of date</AlertTitle>
      <AlertDescription>
        {affectedRuns(summary.count)} with {journal}, but this dashboard only knows format{' '}
        {summary.readerFormat}. Restart the daemon with <code>stepcast down && stepcast up</code>.
      </AlertDescription>
    </Alert>
  );
}

function TokenCell({ run }: { readonly run: RunOverview }): JSX.Element {
  const [open, setOpen] = useState(false);
  const usage = run.usage;

  if (usage === undefined) return <span className="dim">not reported</span>;

  const breakdown = usage.breakdown;
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="tokens"
        onClick={() => setOpen(!open)}
        disabled={breakdown === undefined}
        title={
          breakdown === undefined
            ? 'Token breakdown appears once the usage summary has been read'
            : usage.partial
              ? 'Token breakdown (accumulated so far, run in progress)'
              : 'Token breakdown'
        }
      >
        {fmtTokens(usage.billableTokens)}
      </Button>
      {open && breakdown !== undefined ? (
        <div className="breakdown">
          input {fmtTokens(breakdown.tokensIn)}
          <br />
          output {fmtTokens(breakdown.tokensOut)}
          <br />
          cache read {fmtTokens(breakdown.cacheRead)}
          <br />
          cache write {fmtTokens(breakdown.cacheWrite)}
          {usage.unreported.length > 0 ? (
            <>
              <br />
              not reported: {usage.unreported.length}
            </>
          ) : null}
          {usage.partial ? (
            <>
              <br />
              accumulated so far — run in progress
            </>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** Идущий живым процессом прогон: демон его не удалит (`409`) — тем же правилом судит и флажок. */
function isAliveRun(run: RunOverview): boolean {
  return run.running && !run.abandoned;
}

/** Прогон, который демон согласится удалить: не живой процесс и не потерявший файлы. */
function canRemove(run: RunOverview): boolean {
  return !isAliveRun(run) && !run.filesGone;
}

/**
 * Корзинка. Спрашивает до удаления, а не показывает содеянное после: прогон
 * стирается с диска целиком и обратно не собирается.
 *
 * Идущий прогон кнопки не получает вовсе: демон его удалить откажется
 * (`409`), и предлагать действие, заведомо кончающееся отказом, — врать
 * кнопкой. Оборванный при этом удаляется наравне с завершённым, и «идёт» тут
 * значит живой процесс, а не статус `running`.
 *
 * По той же причине её не получает и прогон без файлов: удалять у него нечего,
 * `DELETE /api/run` ответит `404`, а снять его из истории — значит снять его
 * запись хранилища, и делается это на вкладке «Уборка», где видно, что именно
 * уходит безвозвратно.
 */
function DeleteCell({
  address,
  run,
}: {
  readonly address: string;
  readonly run: RunOverview;
}): JSX.Element {
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  if (isAliveRun(run)) {
    return (
      <span className="dim small" title="Stop the run before deleting it">
        —
      </span>
    );
  }

  if (run.filesGone) {
    return (
      <span
        className="dim small"
        title="The run's files are already gone: only the usage record remains — remove it on the “Cleanup” tab"
      >
        —
      </span>
    );
  }

  if (!asking) {
    return (
      <>
        <Button
          variant="ghost"
          size="sm"
          className="runs-delete"
          title={`Delete run ${run.shortId} from history`}
          onClick={() => setAsking(true)}
        >
          🗑
        </Button>
        {error === undefined ? null : (
          <Alert variant="destructive" className="small">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </>
    );
  }

  const remove = (): void => {
    setBusy(true);
    setError(undefined);
    // Строка не убирается своей рукой: демон пересобирает обзор сразу после
    // удаления, и прогон уходит с экрана живым потоком — тем же путём, каким
    // появился.
    deleteRun(address)
      .catch((failure: Error) => setError(failure.message))
      .finally(() => {
        setBusy(false);
        setAsking(false);
      });
  };

  return (
    <div className="confirm">
      <span className="question" title="Usage statistics stay in history — remove them on the “Cleanup” tab">
        delete files?
      </span>
      <Button variant="destructive" size="sm" disabled={busy} onClick={remove}>
        yes
      </Button>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => setAsking(false)}>
        no
      </Button>
    </div>
  );
}

// Поле фильтра не пишет `undefined` явно (`exactOptionalPropertyTypes`):
// пустой выбор убирает ключ через деструктуризацию, а не обнуляет значение.
function setProjectFilter(filters: RunFilters, value: string): RunFilters {
  if (value === '') {
    const { project: _project, ...rest } = filters;
    return rest;
  }
  return { ...filters, project: value };
}

function setPipelineFilter(filters: RunFilters, value: string): RunFilters {
  if (value === '') {
    const { pipeline: _pipeline, ...rest } = filters;
    return rest;
  }
  return { ...filters, pipeline: value };
}

function setStatusFilter(filters: RunFilters, value: string): RunFilters {
  if (value === '') {
    const { status: _status, ...rest } = filters;
    return rest;
  }
  return { ...filters, status: value };
}

/**
 * Значение пункта «все» в выпадающем списке: Radix не принимает пустую строку
 * значением пункта, и «все» кодируется своим словом, а в состояние фильтра
 * переводится обратно в пустую строку — ключом ниже.
 */
const ALL = '__all__';

function fromSelectValue(value: string): string {
  return value === ALL ? '' : value;
}

const OUTCOME_TITLE: Readonly<Record<string, string>> = {
  removed: 'removed',
  skipped_missing: 'already gone',
  skipped_alive: 'running — untouched',
  failed: 'failed',
};

/** Судьба записи хранилища расхода — тот же словарь, что на экране уборки. */
const STATS_TITLE: Readonly<Record<StatsOutcome, string>> = {
  kept: 'kept',
  removed: 'removed',
  missing: 'no record',
};

/** Прогон в адресе `<проект>/<прогон>` — короткий вид для строки исхода. */
function runIdOf(address: string): string {
  return address.slice(address.indexOf('/') + 1);
}

/**
 * Исход группового удаления — состояние экрана, а не полосы отметки: удаление
 * кончается снятием отметки, полоса при этом уходит с экрана, и сводка,
 * жившая внутри неё, не показалась бы никогда. Поэтому её держит `Runs`, а
 * закрывает человек, прочитав.
 *
 * Состав строки — тот же, что на экране уборки (`Cleanup.tsx`): исход файлов и
 * судьба статистики. Второй бейдж не украшение: групповое удаление из списка
 * идёт без снятия статистики (Решение 11), и «kept» в каждой строке —
 * единственное, чем экран это доказывает.
 */
function RemovalOutcomes({
  summary,
  onClose,
}: {
  readonly summary: RemovalSummary;
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <Card className="selected-bar">
      <CardHeader>
        <CardTitle>Freed {fmtBytes(summary.freedBytes)}</CardTitle>
        <span className="small dim">
          removed {summary.outcomes.filter((item) => item.outcome === 'removed').length} of{' '}
          {summary.outcomes.length}
        </span>
        <Button variant="ghost" size="sm" onClick={onClose}>
          close
        </Button>
      </CardHeader>
      <CardContent>
        <Table className="outcomes">
          <TableHeader>
            <TableRow>
              <TableHead>Run</TableHead>
              <TableHead>Files</TableHead>
              <TableHead>Statistics</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead className="num">Size</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {summary.outcomes.map((item) => (
              <TableRow key={item.address} title={item.address}>
                <TableCell className="run-id">{runIdOf(item.address)}</TableCell>
                <TableCell>
                  <Badge variant={item.outcome === 'removed' ? 'success' : 'outline'}>
                    {OUTCOME_TITLE[item.outcome] ?? item.outcome}
                  </Badge>
                </TableCell>
                <TableCell>
                  {item.stats === undefined ? null : (
                    <Badge variant={item.stats === 'kept' ? 'success' : 'outline'}>{STATS_TITLE[item.stats]}</Badge>
                  )}
                </TableCell>
                <TableCell className="small dim">{item.reason ?? ''}</TableCell>
                <TableCell className="small dim mono num">
                  {item.sizeBytes === undefined ? '' : fmtBytes(item.sizeBytes)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
      <CardFooter className="small dim">
        The usage summary of these runs was kept — remove it on the “Cleanup” tab.
      </CardFooter>
    </Card>
  );
}

/**
 * Полоса отмеченного: появляется только при непустой отметке (Решение 8).
 * Объём меряется отдельным запросом по нажатию — тем же ходом, что на экране
 * уборки: отбор по явным адресам, подтверждение с числом и объёмом, удаление
 * одним запросом без снятия статистики (Решения 9, 11).
 */
function SelectedBar({
  addresses,
  onDeleted,
}: {
  readonly addresses: readonly string[];
  readonly onDeleted: (summary: RemovalSummary) => void;
}): JSX.Element {
  const [selection, setSelection] = useState<RunSelection | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  // Замер стареет вместе с отметкой: снятый флажок или прогон, ушедший из
  // обзора живым потоком, меняют список адресов — и открытый вопрос «удалить
  // три прогона» перестаёт быть правдой. Подтверждение при этом снимается, а
  // не переписывается молча: удалять по нажатию «да» надо ровно то, что
  // названо рядом с ним.
  const key = addresses.join('\n');
  useEffect(() => {
    setSelection(undefined);
    setError(undefined);
  }, [key]);

  const askVolume = (): void => {
    setBusy(true);
    setError(undefined);
    selectRunsByAddresses(addresses)
      .then(setSelection)
      .catch((failure: Error) => setError(failure.message))
      .finally(() => setBusy(false));
  };

  const confirmDelete = (): void => {
    if (selection === undefined) return;
    setBusy(true);
    setError(undefined);
    // Удаляется весь отмеченный список, а не измеренный демоном: прогон,
    // исчезнувший между замером и подтверждением, в отбор уже не попал (его
    // каталога нет), и, отправляя только измеренное, экран умолчал бы о нём
    // вовсе. Названный явно, он возвращается исходом «уже исчез».
    deleteRuns(addresses)
      .then(onDeleted)
      .catch((failure: Error) => setError(failure.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="selected-bar">
      <span>{pluralRuns(addresses.length)} selected</span>
      {error === undefined ? null : (
        <Alert variant="destructive" className="small">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {selection === undefined ? (
        <Button variant="outline" size="sm" disabled={busy} onClick={askVolume}>
          {busy ? 'measuring…' : 'delete selected'}
        </Button>
      ) : (
        <div className="confirm">
          <span className="question">
            delete {pluralRuns(selection.count)} and free {fmtBytes(selection.totalBytes)}?
          </span>
          <Button variant="destructive" size="sm" disabled={busy} onClick={confirmDelete}>
            yes
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => setSelection(undefined)}>
            no
          </Button>
        </div>
      )}
    </div>
  );
}

const PAGE_TITLE = 'Runs';
const PAGE_DESCRIPTION =
  'Every run across all projects: filter and sort the table, open a run for its jobs and steps, or tick runs to delete their files.';

export function Runs({
  overview,
  navigate,
}: {
  readonly overview: Overview | undefined;
  readonly navigate: (href: string) => void;
}): JSX.Element {
  const now = Date.now();
  const [filters, setFilters] = useState<RunFilters>(EMPTY_FILTERS);
  const [order, setOrder] = useState<SortOrder>(DEFAULT_SORT);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // Сводка исходов переживает снятие отметки: см. `RemovalOutcomes`.
  const [summary, setSummary] = useState<RemovalSummary | undefined>(undefined);
  const headerCheckboxRef = useRef<HTMLInputElement>(null);

  const projects = overview?.projects ?? [];
  const total = useMemo(() => projects.reduce((sum, project) => sum + project.runs.length, 0), [projects]);
  const filterValues = useMemo(() => collectFilterValues(projects), [projects]);
  const rows = useMemo(() => viewRuns(projects, filters, order, now), [projects, filters, order, now]);
  // Путь проекта по ключу — для подписи пункта фильтра: заголовком последний
  // сегмент, полный путь подсказкой (тот же вид, что у колонки).
  const projectPaths = useMemo(
    () => new Map(projects.map((project) => [project.key, project.path] as const)),
    [projects],
  );

  // Прогон, ушедший из обзора или из-под фильтров, выпадает из отметки
  // (Решение 10): удалить можно только то, что человек видит сейчас.
  useEffect(() => {
    const visible = new Set(rows.map((row) => row.address));
    setSelected((current) => {
      let changed = false;
      const next = new Set<string>();
      for (const address of current) {
        if (visible.has(address)) next.add(address);
        else changed = true;
      }
      return changed ? next : current;
    });
  }, [rows]);

  const selectableAddresses = useMemo(
    () => rows.filter((row) => canRemove(row.run)).map((row) => row.address),
    [rows],
  );
  const allSelected = selectableAddresses.length > 0 && selectableAddresses.every((address) => selected.has(address));
  const someSelected = selectableAddresses.some((address) => selected.has(address));

  useEffect(() => {
    if (headerCheckboxRef.current !== null) headerCheckboxRef.current.indeterminate = someSelected && !allSelected;
  }, [someSelected, allSelected]);

  if (overview === undefined) {
    return (
      <>
        <PageHeader title={PAGE_TITLE} description={PAGE_DESCRIPTION} />
        <EmptyState title="Loading…" />
      </>
    );
  }
  if (total === 0) {
    return (
      <>
        <PageHeader title={PAGE_TITLE} description={PAGE_DESCRIPTION} />
        <EmptyState
          title="No runs yet"
          description={
            <>
              Start one with <code>stepcast run</code> — it appears here as soon as the daemon sees it.
            </>
          }
        />
      </>
    );
  }

  // Умолчание экрана — это и пустые фильтры, и порядок новейшими первыми:
  // выбранный порядок по стоимости так же уводит список от того, что человек
  // увидел, открыв вкладку, и вернуться к умолчанию он должен одним действием,
  // а не угадыванием, какой заголовок нажать.
  const isDefaultView =
    filters.project === undefined &&
    filters.pipeline === undefined &&
    filters.status === undefined &&
    order.metric === DEFAULT_SORT.metric &&
    order.direction === DEFAULT_SORT.direction;
  const resetView = (): void => {
    setFilters(EMPTY_FILTERS);
    setOrder(DEFAULT_SORT);
  };

  const toggleOne = (address: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(address)) next.delete(address);
      else next.add(address);
      return next;
    });
  };

  const toggleAll = (): void => {
    setSelected((current) => {
      if (allSelected) {
        const next = new Set(current);
        for (const address of selectableAddresses) next.delete(address);
        return next;
      }
      return new Set([...current, ...selectableAddresses]);
    });
  };

  // `SortHeader` знает величину лишь строкой (она общая с колонкой планового
  // номера очереди); здесь она всегда одно из четырёх значений `SortMetric`.
  const onSort = (metric: string): void => {
    const next = metric as SortMetric;
    setOrder((current) =>
      current.metric === next
        ? { metric: next, direction: current.direction === 'desc' ? 'asc' : 'desc' }
        : { metric: next, direction: 'desc' },
    );
  };

  const projectOptions = withCurrentOption(filterValues.projects, filters.project, (value) => value);
  const pipelineOptions = withCurrentOption(filterValues.pipelines, filters.pipeline, describePipelineFilterValue);
  const statusOptions = withCurrentOption(filterValues.statuses, filters.status, (value) => value);

  return (
    <>
      <PageHeader
        title={PAGE_TITLE}
        description={PAGE_DESCRIPTION}
        actions={
          isDefaultView ? undefined : (
            <>
              {/* Число показанных — про сужение: при одном лишь ином порядке
                  состав списка тот же, и «showing 12 of 12» ничего не сообщает. */}
              {rows.length === total ? null : (
                <span className="small dim">
                  showing {rows.length} of {total}
                </span>
              )}
              <Button variant="ghost" size="sm" onClick={resetView} title="Clear filters and return to newest first">
                reset
              </Button>
            </>
          )
        }
      />
      <VersionSkewBanner overview={overview} />

      <div className="filters">
        <Select
          value={filters.project ?? ALL}
          onValueChange={(value) => setFilters((current) => setProjectFilter(current, fromSelectValue(value)))}
        >
          <SelectTrigger aria-label="Project">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All projects</SelectItem>
            {projectOptions.map((option) => {
              const path = projectPaths.get(option.value);
              return (
                <SelectItem key={option.value} value={option.value} title={path ?? option.label}>
                  {path === undefined ? option.label : lastPathSegment(path)}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        <Select
          value={filters.pipeline ?? ALL}
          onValueChange={(value) => setFilters((current) => setPipelineFilter(current, fromSelectValue(value)))}
        >
          <SelectTrigger aria-label="Pipeline">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All pipelines</SelectItem>
            {pipelineOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filters.status ?? ALL}
          onValueChange={(value) => setFilters((current) => setStatusFilter(current, fromSelectValue(value)))}
        >
          <SelectTrigger aria-label="Status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {statusOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {summary === undefined ? null : (
        <RemovalOutcomes summary={summary} onClose={() => setSummary(undefined)} />
      )}

      {selected.size === 0 ? null : (
        <SelectedBar
          addresses={[...selected]}
          onDeleted={(result) => {
            setSummary(result);
            setSelected(new Set());
          }}
        />
      )}

      {rows.length === 0 ? (
        <EmptyState
          title="No runs match the filters"
          action={
            <Button variant="outline" size="sm" onClick={resetView}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <Table className="runs">
          <TableHeader>
            <TableRow>
              <TableHead className="check-cell">
                <input
                  ref={headerCheckboxRef}
                  type="checkbox"
                  checked={allSelected}
                  disabled={selectableAddresses.length === 0}
                  onChange={toggleAll}
                  aria-label="Select all visible runs"
                />
              </TableHead>
              <TableHead>Project</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <SortHeader label="Started" metric="startedAt" order={order} onSort={onSort} />
              <SortHeader label="Duration" metric="duration" order={order} onSort={onSort} className="num" />
              <SortHeader label="Cost" metric="cost" order={order} onSort={onSort} className="num" />
              <SortHeader label="Tokens" metric="tokens" order={order} onSort={onSort} className="num" />
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const run = row.run;
              return (
                <TableRow key={row.address}>
                  <TableCell className="check-cell">
                    {canRemove(run) ? (
                      <input
                        type="checkbox"
                        checked={selected.has(row.address)}
                        onChange={() => toggleOne(row.address)}
                        aria-label={`Select run ${run.shortId}`}
                      />
                    ) : null}
                  </TableCell>
                  <TableCell
                    className={row.projectPath === undefined ? 'project unknown-path' : 'project'}
                    title={row.projectPath ?? unknownPathLabel(row.projectKey)}
                  >
                    {/* Сокращение живёт на блоке внутри ячейки, а не на самой
                        ячейке: ширину колонки таблица считает по содержимому,
                        и `max-width` на `td` она не соблюдает — длинная
                        подпись растянула бы колонку вместо многоточия. */}
                    <span className="clip">
                      {row.projectPath === undefined
                        ? unknownPathLabel(row.projectKey)
                        : lastPathSegment(row.projectPath)}
                    </span>
                  </TableCell>
                  <TableCell>
                    {/* Маршрут страницы прогона отключён — строка остаётся
                        на месте не-ссылкой с названной причиной, общим видом
                        витрины (`ui-routes`, Решение 8). */}
                    <TargetLink
                      target={RUN_TARGET}
                      params={{ projectKey: row.projectKey, runId: run.runId }}
                      navigate={navigate}
                    >
                      <div className="run-name">{run.pipeline || 'unnamed'}</div>
                      {run.problem === undefined ? null : (
                        <div className="run-problem">
                          {run.problem.file}
                          {run.problem.at === undefined ? '' : `, ${run.problem.at}`}: {run.problem.detail}
                        </div>
                      )}
                      <div className="run-id">{run.shortId}</div>
                    </TargetLink>
                  </TableCell>
                  <TableCell>
                    <div className="marks">
                      <Badge variant={statusBadgeVariant(run.status)}>{run.status ?? 'unknown'}</Badge>
                      {run.swept ? <Badge>swept</Badge> : null}
                      {run.filesGone ? <Badge>files gone</Badge> : null}
                      {run.problem?.kind === 'version-skew' ? (
                        <Badge>reader out of date</Badge>
                      ) : run.problem?.kind === 'legacy-journal' ? (
                        <Badge>legacy journal</Badge>
                      ) : run.unreadable ? (
                        <Badge>unreadable</Badge>
                      ) : null}
                      {run.abandoned ? <Badge>abandoned</Badge> : null}
                      {run.wakeAt === undefined ? null : (
                        <Badge title={`sleeping until ${fmtTime(run.wakeAt)}`}>sleeping</Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="small">{fmtTime(run.startedAt)}</TableCell>
                  <TableCell className="num">{fmtDuration(runDuration(run, now))}</TableCell>
                  <TableCell className="num">{fmtMoney(run.usage?.costUsd ?? null)}</TableCell>
                  <TableCell className="num">
                    <TokenCell run={run} />
                  </TableCell>
                  <TableCell className="num">
                    <DeleteCell address={row.address} run={run} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </>
  );
}
