import { useEffect, useMemo, useRef, useState, type JSX } from 'react';

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
  runDuration,
  viewRuns,
  DEFAULT_SORT,
  EMPTY_FILTERS,
  type RunFilters,
  type SortMetric,
  type SortOrder,
} from '../../../src/parts/ui/runsView';
import { SortHeader } from '../SortHeader';

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
 * «1 прогон записан», «2 прогона записаны», «5 прогонов записаны». Склонение
 * числа — общий с подтверждением группового удаления `pluralRuns`; форма
 * сказуемого («записан» / «записаны») нужна только этой полосе и остаётся
 * здесь (design.md изменения ui-runs-list-controls, Решение 13).
 */
function affectedRuns(count: number): string {
  const teens = count % 100;
  const last = count % 10;
  const one = last === 1 && teens !== 11;
  return `${pluralRuns(count)} ${one ? 'записан' : 'записаны'}`;
}

function VersionSkewBanner({ overview }: { readonly overview: Overview }): JSX.Element | null {
  const summary = versionSkewSummary(overview);
  if (summary === undefined) return null;

  const journal = summary.journalFormat === undefined ? 'новее' : `версии ${summary.journalFormat}`;
  return (
    <p className="notice">
      {affectedRuns(summary.count)} журналом {journal}, а витрина знает версию{' '}
      {summary.readerFormat}: читатель устарел. Перезапустите демон командой{' '}
      <code>stepcast down && stepcast up</code>.
    </p>
  );
}

function TokenCell({ run }: { readonly run: RunOverview }): JSX.Element {
  const [open, setOpen] = useState(false);
  const usage = run.usage;

  if (usage === undefined) return <span className="dim">не сообщено</span>;

  const breakdown = usage.breakdown;
  return (
    <>
      <button
        className="tokens"
        onClick={() => setOpen(!open)}
        disabled={breakdown === undefined}
        title={
          breakdown === undefined
            ? 'Разрез по видам токенов появится, когда сводка расхода будет прочитана'
            : usage.partial
              ? 'Разрез по видам токенов (накоплено на текущий момент, прогон идёт)'
              : 'Разрез по видам токенов'
        }
      >
        {fmtTokens(usage.billableTokens)}
      </button>
      {open && breakdown !== undefined ? (
        <div className="breakdown">
          ввод {fmtTokens(breakdown.tokensIn)}
          <br />
          вывод {fmtTokens(breakdown.tokensOut)}
          <br />
          чтение кеша {fmtTokens(breakdown.cacheRead)}
          <br />
          запись кеша {fmtTokens(breakdown.cacheWrite)}
          {usage.unreported.length > 0 ? (
            <>
              <br />
              не сообщено: {usage.unreported.length}
            </>
          ) : null}
          {usage.partial ? (
            <>
              <br />
              накоплено на текущий момент — прогон идёт
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
      <span className="dim small" title="Идущий прогон сначала останавливают">
        —
      </span>
    );
  }

  if (run.filesGone) {
    return (
      <span
        className="dim small"
        title="Файлов у прогона уже нет: осталась запись хранилища расхода — снять её можно на вкладке «Уборка»"
      >
        —
      </span>
    );
  }

  if (!asking) {
    return (
      <>
        <button
          className="plain danger"
          title={`Удалить прогон ${run.shortId} из истории`}
          onClick={() => setAsking(true)}
        >
          🗑
        </button>
        {error === undefined ? null : <div className="error small">{error}</div>}
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
      <span className="question" title="Статистика расхода останется в истории — снять её можно на вкладке «Уборка»">
        удалить файлы?
      </span>
      <button className="danger" disabled={busy} onClick={remove}>
        да
      </button>
      <button disabled={busy} onClick={() => setAsking(false)}>
        нет
      </button>
    </div>
  );
}

/** Последний сегмент пути — для колонки проекта: полный путь остаётся в `title`. */
function lastSegment(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
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

const OUTCOME_TITLE: Readonly<Record<string, string>> = {
  removed: 'удалён',
  skipped_missing: 'уже исчез',
  skipped_alive: 'идёт — не тронут',
  failed: 'не удалось',
};

/** Судьба записи хранилища расхода — тот же словарь, что на экране уборки. */
const STATS_TITLE: Readonly<Record<StatsOutcome, string>> = {
  kept: 'сохранена',
  removed: 'снята',
  missing: 'записи не было',
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
 * идёт без снятия статистики (Решение 11), и «сохранена» в каждой строке —
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
    <div className="card selected-bar">
      <div className="card-head">
        <span className="card-title">Освобождено {fmtBytes(summary.freedBytes)}</span>
        <span className="small dim">
          удалено {summary.outcomes.filter((item) => item.outcome === 'removed').length} из{' '}
          {summary.outcomes.length}
        </span>
        <button className="plain" onClick={onClose}>
          закрыть
        </button>
      </div>
      <div className="run-list outcome-list">
        {summary.outcomes.map((item) => (
          <div key={item.address} className="run-row" title={item.address}>
            <span className="run-id">{runIdOf(item.address)}</span>
            <span className="marks">
              <span className={item.outcome === 'removed' ? 'badge success' : 'badge'}>
                файлы: {OUTCOME_TITLE[item.outcome] ?? item.outcome}
              </span>
              {item.stats === undefined ? null : (
                <span className={item.stats === 'kept' ? 'badge success' : 'badge'}>
                  статистика: {STATS_TITLE[item.stats]}
                </span>
              )}
            </span>
            <span className="small dim">{item.reason ?? ''}</span>
            <span className="small dim mono">{item.sizeBytes === undefined ? '' : fmtBytes(item.sizeBytes)}</span>
          </div>
        ))}
      </div>
      <p className="small dim">
        Сводка расхода этих прогонов сохранена: снять её можно на вкладке «Уборка».
      </p>
    </div>
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
      <span>{pluralRuns(addresses.length)} отмечено</span>
      {error === undefined ? null : <span className="error small">{error}</span>}
      {selection === undefined ? (
        <button disabled={busy} onClick={askVolume}>
          {busy ? 'подсчёт…' : 'удалить отмеченные'}
        </button>
      ) : (
        <div className="confirm">
          <span className="question">
            удалить {pluralRuns(selection.count)} и освободить {fmtBytes(selection.totalBytes)}?
          </span>
          <button className="danger" disabled={busy} onClick={confirmDelete}>
            да
          </button>
          <button disabled={busy} onClick={() => setSelection(undefined)}>
            нет
          </button>
        </div>
      )}
    </div>
  );
}

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

  if (overview === undefined) return <p className="empty">Загрузка…</p>;
  if (total === 0) {
    return (
      <p className="empty">
        Прогонов пока нет. Запустите <code>stepcast run</code>.
      </p>
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
      <h1>Прогоны</h1>
      <VersionSkewBanner overview={overview} />

      <div className="filters">
        <select
          aria-label="Проект"
          value={filters.project ?? ''}
          onChange={(event) => setFilters((current) => setProjectFilter(current, event.target.value))}
        >
          <option value="">все проекты</option>
          {projectOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Пайплайн"
          value={filters.pipeline ?? ''}
          onChange={(event) => setFilters((current) => setPipelineFilter(current, event.target.value))}
        >
          <option value="">все пайплайны</option>
          {pipelineOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Статус"
          value={filters.status ?? ''}
          onChange={(event) => setFilters((current) => setStatusFilter(current, event.target.value))}
        >
          <option value="">все статусы</option>
          {statusOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {isDefaultView ? null : (
          <>
            {/* Число показанных — про сужение: при одном лишь ином порядке
                состав списка тот же, и «показано 12 из 12» ничего не сообщает. */}
            {rows.length === total ? null : (
              <span className="small dim">
                показано {rows.length} из {total}
              </span>
            )}
            <button className="plain" onClick={resetView} title="Снять фильтры и вернуть порядок новейшими первыми">
              сбросить
            </button>
          </>
        )}
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
        <p className="empty">
          Под фильтры не подошёл ни один прогон.{' '}
          <button className="plain" onClick={resetView}>
            Сбросить фильтры
          </button>
        </p>
      ) : (
        <div className="table-scroll">
          <table className="runs">
            <thead>
              <tr>
                <th className="check-cell">
                  <input
                    ref={headerCheckboxRef}
                    type="checkbox"
                    checked={allSelected}
                    disabled={selectableAddresses.length === 0}
                    onChange={toggleAll}
                    aria-label="Отметить все видимые прогоны"
                  />
                </th>
                <th>Проект</th>
                <th>Имя</th>
                <th>Статус</th>
                <SortHeader label="Начало" metric="startedAt" order={order} onSort={onSort} />
                <SortHeader label="Длительность" metric="duration" order={order} onSort={onSort} className="num" />
                <SortHeader label="Стоимость" metric="cost" order={order} onSort={onSort} className="num" />
                <SortHeader label="Токены" metric="tokens" order={order} onSort={onSort} className="num" />
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const run = row.run;
                return (
                  <tr key={row.address}>
                    <td className="check-cell">
                      {canRemove(run) ? (
                        <input
                          type="checkbox"
                          checked={selected.has(row.address)}
                          onChange={() => toggleOne(row.address)}
                          aria-label={`Отметить прогон ${run.shortId}`}
                        />
                      ) : null}
                    </td>
                    <td
                      className={row.projectPath === undefined ? 'project unknown-path' : 'project'}
                      title={row.projectPath ?? `${row.projectKey} — путь неизвестен`}
                    >
                      {/* Сокращение живёт на блоке внутри ячейки, а не на самой
                          ячейке: ширину колонки таблица считает по содержимому,
                          и `max-width` на `td` она не соблюдает — длинная
                          подпись растянула бы колонку вместо многоточия. */}
                      <span className="clip">
                        {row.projectPath === undefined
                          ? `${row.projectKey} — путь неизвестен`
                          : lastSegment(row.projectPath)}
                      </span>
                    </td>
                    <td>
                      {/* Маршрут страницы прогона отключён — строка остаётся
                          на месте не-ссылкой с названной причиной, общим видом
                          витрины (`ui-routes`, Решение 8). */}
                      <TargetLink
                        target={RUN_TARGET}
                        params={{ projectKey: row.projectKey, runId: run.runId }}
                        navigate={navigate}
                      >
                        <div className="run-name">{run.pipeline || 'без имени'}</div>
                        {run.problem === undefined ? null : (
                          <div className="run-problem">
                            {run.problem.file}
                            {run.problem.at === undefined ? '' : `, ${run.problem.at}`}: {run.problem.detail}
                          </div>
                        )}
                        <div className="run-id">{run.shortId}</div>
                      </TargetLink>
                    </td>
                    <td>
                      <div className="marks">
                        <span className={`badge ${run.status ?? ''}`}>
                          {run.status ?? 'неизвестно'}
                        </span>
                        {run.swept ? <span className="badge">убран</span> : null}
                        {run.filesGone ? <span className="badge">файлов нет</span> : null}
                        {run.problem?.kind === 'version-skew' ? (
                          <span className="badge">читатель устарел</span>
                        ) : run.problem?.kind === 'legacy-journal' ? (
                          <span className="badge">журнал прежней формы</span>
                        ) : run.unreadable ? (
                          <span className="badge">не читается</span>
                        ) : null}
                        {run.abandoned ? <span className="badge">оборван</span> : null}
                        {run.wakeAt === undefined ? null : (
                          <span className="badge" title={`сон до ${fmtTime(run.wakeAt)}`}>
                            спит
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="small">{fmtTime(run.startedAt)}</td>
                    <td className="num">{fmtDuration(runDuration(run, now))}</td>
                    <td className="num">{fmtMoney(run.usage?.costUsd ?? null)}</td>
                    <td className="num">
                      <TokenCell run={run} />
                    </td>
                    <td className="num">
                      <DeleteCell address={row.address} run={run} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
