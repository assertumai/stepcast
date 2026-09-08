import { useState, type JSX } from 'react';

import {
  deleteRuns,
  deleteUsageRecords,
  selectRuns,
  selectUsageRecords,
  type CleanupTrait,
  type Overview,
  type RemovalSummary,
  type RunCandidate,
  type RunSelection,
  type StatsOutcome,
  type UsageRecordCandidate,
  type UsageRecordRemovalSummary,
  type UsageRecordSelection,
} from '../api';
import { fmtBytes, fmtDuration, fmtTime } from '../format';

/**
 * Уборка: две отдельные цели, и один запрос не смешивает их (design.md
 * изменения run-stats-retention, Решение 14) — файлы прогонов (этот раздел, в
 * основном как раньше) и записи хранилища расхода (раздел ниже). Отбор
 * (`GET`) ничего не трогает на диске и отвечает списком с числом и объёмом,
 * удаление (`DELETE`) идёт по явному списку адресов, увиденных в этом ответе:
 * признак между показом и подтверждением мог захватить новый прогон —
 * удалиться должно ровно то, что человек видел.
 *
 * Снятие статистики вместе с файлами — отдельная, отдельно вооружаемая
 * кнопка: умолчание «сохранить» отвечает и на вопрос, что происходит, когда
 * человек про статистику вообще не думал (Решение 10, 11).
 */

const TRAITS: readonly { readonly id: CleanupTrait; readonly title: string; readonly hint: string }[] = [
  { id: 'abandoned', title: 'оборванные', hint: 'состояние осталось running, а процесс мёртв' },
  { id: 'failed', title: 'отказавшие', hint: 'failed, canceled, budget_exceeded' },
];

const OUTCOME_TITLE: Readonly<Record<string, string>> = {
  removed: 'удалён',
  skipped_missing: 'уже исчез',
  skipped_alive: 'идёт — не тронут',
  failed: 'не удалось',
};

/** Судьба записи хранилища у прогона: третий исход — «записи и не было». */
const STATS_TITLE: Readonly<Record<StatsOutcome, string>> = {
  kept: 'сохранена',
  removed: 'снята',
  missing: 'записи не было',
};

/** Прогон в адресе `<проект>/<прогон>`: на экране проекта достаточно один раз. */
function runIdOf(address: string): string {
  return address.slice(address.indexOf('/') + 1);
}

function Candidate({ run }: { readonly run: RunCandidate }): JSX.Element {
  return (
    <div className="run-row" title={run.address}>
      <span className="run-id">{runIdOf(run.address)}</span>
      <span className="marks">
        {run.unreadable ? <span className="badge">не читается</span> : null}
        {run.hasUsageRecord ? null : <span className="badge">записи нет</span>}
      </span>
      <span className="small dim mono">{fmtBytes(run.sizeBytes)}</span>
      <span className="small dim">{run.endedAt === undefined ? '—' : fmtTime(run.endedAt)}</span>
      <span className="small dim mono">{fmtDuration(run.ageMs)} назад</span>
    </div>
  );
}

/**
 * Строка карандаша записи хранилища: та же сетка `.cleanup-list .run-row`,
 * что и у каталогов (Решение — не заводить отдельного класса ради одной
 * колонки; у записи нет объёма на диске, и её место в разметке остаётся
 * пустым, а не сдвигает остальные колонки).
 */
function RecordCandidate({ record }: { readonly record: UsageRecordCandidate }): JSX.Element {
  return (
    <div className="run-row" title={record.address}>
      <span className="run-id">{runIdOf(record.address)}</span>
      <span className="marks">
        <span className={`badge ${record.status}`}>{record.status}</span>
      </span>
      <span />
      <span className="small dim">{fmtTime(record.endedAt)}</span>
      <span className="small dim mono">{fmtDuration(record.ageMs)} назад</span>
    </div>
  );
}

/**
 * Поле «старше» и «проект» — общий вид для обоих разделов уборки.
 *
 * `idPrefix` строит собственные `id` для каждого раздела (`files-cleanup-age`,
 * `stats-cleanup-age`): без него оба вызова компонента называли бы поля
 * одинаковым `id`, и подпись нижнего раздела ставила бы курсор в поле
 * верхнего (design.md, Решение 5).
 */
function AgeAndProjectFields({
  idPrefix,
  olderThan,
  onOlderThan,
  project,
  onProject,
  projects,
}: {
  readonly idPrefix: string;
  readonly olderThan: string;
  readonly onOlderThan: (value: string) => void;
  readonly project: string;
  readonly onProject: (value: string) => void;
  readonly projects: readonly { readonly key: string; readonly path?: string }[];
}): JSX.Element {
  const ageId = `${idPrefix}-cleanup-age`;
  const projectId = `${idPrefix}-cleanup-project`;
  return (
    <>
      <div className="field">
        <label className="label" htmlFor={ageId}>
          старше
        </label>
        <div className="field-body">
          <input
            id={ageId}
            className="mono narrow"
            value={olderThan}
            placeholder="7d, 12h, 30m"
            onChange={(event) => onOlderThan(event.target.value)}
          />
          <span className="small dim">пусто — без ограничения по сроку</span>
        </div>
      </div>

      <div className="field">
        <label className="label" htmlFor={projectId}>
          проект
        </label>
        <div className="field-body">
          <select id={projectId} value={project} onChange={(event) => onProject(event.target.value)}>
            <option value="">все проекты</option>
            {projects.map((item) => (
              <option key={item.key} value={item.key}>
                {item.path ?? item.key}
              </option>
            ))}
          </select>
        </div>
      </div>
    </>
  );
}

/** Удаление файлов прогонов: отбор, подтверждение, отдельная кнопка со статистикой. */
function FilesSection({
  projects,
}: {
  readonly projects: readonly { readonly key: string; readonly path?: string }[];
}): JSX.Element {
  const [traits, setTraits] = useState<readonly CleanupTrait[]>([]);
  const [olderThan, setOlderThan] = useState('');
  const [project, setProject] = useState('');

  const [selection, setSelection] = useState<RunSelection | undefined>(undefined);
  const [dropStats, setDropStats] = useState(false);
  const [summary, setSummary] = useState<RemovalSummary | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const toggle = (trait: CleanupTrait): void => {
    // Всякая правка условий обесценивает прежний отбор: оставить его на экране
    // значило бы предложить подтвердить список, собранный по другим условиям.
    setSelection(undefined);
    setSummary(undefined);
    setTraits((current) =>
      current.includes(trait) ? current.filter((item) => item !== trait) : [...current, trait],
    );
  };

  const runSelect = (): void => {
    setBusy(true);
    setError(undefined);
    setSummary(undefined);
    setDropStats(false);
    selectRuns({
      traits,
      ...(olderThan === '' ? {} : { olderThan }),
      ...(project === '' ? {} : { project }),
    })
      .then(setSelection)
      .catch((failure: Error) => setError(failure.message))
      .finally(() => setBusy(false));
  };

  const confirm = (stats: 'keep' | 'drop'): void => {
    if (selection === undefined) return;
    setBusy(true);
    setError(undefined);
    deleteRuns(
      selection.runs.map((run) => run.address),
      stats,
    )
      .then((result) => {
        setSummary(result);
        setSelection(undefined);
      })
      .catch((failure: Error) => setError(failure.message))
      .finally(() => setBusy(false));
  };

  const nothingAsked = traits.length === 0 && olderThan === '';
  const recordCount = selection?.runs.filter((run) => run.hasUsageRecord).length ?? 0;

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Файлы прогонов</span>
        <span className="small dim">признаки объединяются по «или»</span>
      </div>

      <div className="field">
        <span className="label">признак</span>
        <div className="field-body wrap">
          {TRAITS.map((trait) => (
            <label key={trait.id} className="check" title={trait.hint}>
              <input type="checkbox" checked={traits.includes(trait.id)} onChange={() => toggle(trait.id)} />
              {trait.title}
            </label>
          ))}
        </div>
      </div>

      <AgeAndProjectFields
        idPrefix="files"
        olderThan={olderThan}
        onOlderThan={(value) => {
          setOlderThan(value);
          setSelection(undefined);
          setSummary(undefined);
        }}
        project={project}
        onProject={(value) => {
          setProject(value);
          setSelection(undefined);
          setSummary(undefined);
        }}
        projects={projects}
      />

      <div className="field">
        <span className="label" />
        <div className="field-body">
          <button disabled={busy || nothingAsked} onClick={runSelect}>
            {busy && selection === undefined ? 'отбор…' : 'показать отбор'}
          </button>
          {nothingAsked ? (
            <span className="small dim">
              выберите признак или срок: отбор без условий удалил бы всё подряд
            </span>
          ) : null}
        </div>
      </div>

      {error === undefined ? null : <p className="error">{error}</p>}

      {selection === undefined ? null : (
        <>
          <div className="card-head">
            <span className="card-title">
              К удалению: {selection.count} · {fmtBytes(selection.totalBytes)}
              {selection.count === 0 ? '' : ` · записей хранилища: ${recordCount}`}
            </span>
          </div>

          {/* Прогоны, которых отбор не назвал и проверить не смог: у отбора по
              сроку таких нет — срок берёт их по времени каталога, и они уже в
              списке (`uncheckedCount` в `src/core/run/cleanup.ts`). */}
          {selection.uncheckedCount === 0 ? null : (
            <p className="note dim">
              Ещё {selection.uncheckedCount} прогон(ов) сюда не попали — журнал не читается, статус
              проверить не удалось. Признак о них ничего не говорит; отбираются они сроком (поле
              «старше»).
            </p>
          )}

          {selection.count === 0 ? (
            <p className="note dim">Под условия не подошёл ни один прогон. Ничего не удалено.</p>
          ) : (
            <>
              <div className="run-list cleanup-list">
                {selection.runs.map((run) => (
                  <Candidate key={run.address} run={run} />
                ))}
              </div>
              <p className="note dim">
                Удаление снимает только файлы: сводка расхода {recordCount === selection.count
                  ? 'каждого прогона сохранится'
                  : `${recordCount} из ${selection.count} уже сохранена и сохранится дальше`}
                {' '}
                в истории.
              </p>
              <div className="field">
                <span className="label" />
                <div className="field-body">
                  <button className="danger" disabled={busy} onClick={() => confirm('keep')}>
                    {busy ? 'удаление…' : `удалить файлы ${selection.count} и освободить ${fmtBytes(selection.totalBytes)}`}
                  </button>
                  <button className="plain" disabled={busy} onClick={() => setSelection(undefined)}>
                    отменить
                  </button>
                </div>
              </div>
              <div className="field">
                <span className="label" />
                <div className="field-body">
                  <label className="check" title="Разрушительно: сводку расхода этих прогонов будет неоткуда взять">
                    <input type="checkbox" checked={dropStats} onChange={(event) => setDropStats(event.target.checked)} />
                    {/* Уйдут записи, а не прогоны: снятие ничего не дописывает,
                        и у прогона без записи уносить нечего. */}
                    вместе со статистикой ({recordCount} записей)
                  </label>
                  <button className="danger" disabled={busy || !dropStats} onClick={() => confirm('drop')}>
                    удалить файлы и статистику
                  </button>
                </div>
              </div>
            </>
          )}
        </>
      )}

      {summary === undefined ? null : (
        <>
          <div className="card-head">
            <span className="card-title">Освобождено {fmtBytes(summary.freedBytes)}</span>
            <span className="small dim">
              удалено {summary.outcomes.filter((item) => item.outcome === 'removed').length} из{' '}
              {summary.outcomes.length}
            </span>
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
                <span className="small dim mono">
                  {item.sizeBytes === undefined ? '' : fmtBytes(item.sizeBytes)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Снятие записей хранилища расхода — отдельная цель, файлов не касается. */
function StatsSection({
  projects,
}: {
  readonly projects: readonly { readonly key: string; readonly path?: string }[];
}): JSX.Element {
  const [failed, setFailed] = useState(false);
  const [olderThan, setOlderThan] = useState('');
  const [project, setProject] = useState('');

  const [selection, setSelection] = useState<UsageRecordSelection | undefined>(undefined);
  const [summary, setSummary] = useState<UsageRecordRemovalSummary | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const runSelect = (): void => {
    setBusy(true);
    setError(undefined);
    setSummary(undefined);
    selectUsageRecords({
      failed,
      ...(olderThan === '' ? {} : { olderThan }),
      ...(project === '' ? {} : { project }),
    })
      .then(setSelection)
      .catch((failure: Error) => setError(failure.message))
      .finally(() => setBusy(false));
  };

  const confirm = (): void => {
    if (selection === undefined) return;
    setBusy(true);
    setError(undefined);
    deleteUsageRecords(selection.records.map((record) => record.address))
      .then((result) => {
        setSummary(result);
        setSelection(undefined);
      })
      .catch((failure: Error) => setError(failure.message))
      .finally(() => setBusy(false));
  };

  // Проект — такой же признак отбора, как срок и исход: названный без них, он
  // отбирает свою область целиком (`selectUsageRecords` в
  // `core/journal/usageStore.ts`), и запрещать такой отбор нечем.
  const nothingAsked = !failed && olderThan === '' && project === '';

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Записи хранилища расхода</span>
        <span className="small dim">снимает сводку, файлов прогонов не касается</span>
      </div>

      <div className="field">
        <span className="label">признак</span>
        <div className="field-body wrap">
          <label className="check" title="failed, canceled, budget_exceeded">
            <input
              type="checkbox"
              checked={failed}
              onChange={() => {
                setFailed((value) => !value);
                setSelection(undefined);
                setSummary(undefined);
              }}
            />
            отказавшие
          </label>
        </div>
      </div>

      <AgeAndProjectFields
        idPrefix="stats"
        olderThan={olderThan}
        onOlderThan={(value) => {
          setOlderThan(value);
          setSelection(undefined);
          setSummary(undefined);
        }}
        project={project}
        onProject={(value) => {
          setProject(value);
          setSelection(undefined);
          setSummary(undefined);
        }}
        projects={projects}
      />

      <div className="field">
        <span className="label" />
        <div className="field-body">
          <button disabled={busy || nothingAsked} onClick={runSelect}>
            {busy && selection === undefined ? 'отбор…' : 'показать отбор'}
          </button>
          {nothingAsked ? (
            <span className="small dim">
              выберите признак, срок или проект: отбор без условий не снимает ни одной записи
            </span>
          ) : null}
        </div>
      </div>

      {error === undefined ? null : <p className="error">{error}</p>}

      {selection === undefined ? null : (
        <>
          <div className="card-head">
            <span className="card-title">К снятию: {selection.count} записей</span>
          </div>

          {selection.count === 0 ? (
            <p className="note dim">Под условия не подошла ни одна запись. Ничего не снято.</p>
          ) : (
            <>
              <div className="run-list cleanup-list">
                {selection.records.map((record) => (
                  <RecordCandidate key={record.address} record={record} />
                ))}
              </div>
              <div className="field">
                <span className="label" />
                <div className="field-body">
                  <button className="danger" disabled={busy} onClick={confirm}>
                    {busy ? 'снятие…' : `снять ${selection.count} записей`}
                  </button>
                  <button className="plain" disabled={busy} onClick={() => setSelection(undefined)}>
                    отменить
                  </button>
                </div>
              </div>
            </>
          )}
        </>
      )}

      {summary === undefined ? null : (
        <>
          <div className="card-head">
            <span className="card-title">Снято записей: {summary.removed}</span>
          </div>
          <div className="run-list outcome-list">
            {summary.outcomes.map((item) => (
              <div key={item.address} className="run-row" title={item.address}>
                <span className="run-id">{runIdOf(item.address)}</span>
                <span className="marks">
                  <span className={item.outcome === 'removed' ? 'badge success' : 'badge'}>
                    {OUTCOME_TITLE[item.outcome] ?? item.outcome}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function Cleanup({ overview }: { readonly overview: Overview | undefined }): JSX.Element {
  const projects = overview?.projects ?? [];

  return (
    <>
      <h1>Уборка</h1>
      <FilesSection projects={projects} />
      <StatsSection projects={projects} />
    </>
  );
}
