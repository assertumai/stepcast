import { useState, type JSX } from 'react';

import {
  deleteRuns,
  selectRuns,
  type CleanupTrait,
  type Overview,
  type RemovalSummary,
  type RunCandidate,
  type RunSelection,
} from '../api';
import { fmtBytes, fmtDuration, fmtTime } from '../format';

/**
 * Уборка: отбор прогонов по признаку и удаление группой.
 *
 * Два шага, а не один: отбор (`GET /api/runs`) ничего не трогает на диске и
 * отвечает списком с числом и объёмом, удаление (`DELETE /api/runs`) идёт по
 * явному списку адресов, увиденных в этом ответе. Признак между показом и
 * подтверждением мог захватить новый прогон — удалиться должно ровно то, что
 * человек видел, а не то, что признак значит сейчас.
 *
 * Исход приходит на каждый адрес отдельно: живой прогон из группы
 * отклоняется, остальные удаляются, и молчать об отклонённом нельзя — иначе
 * «удалено 12 из 13» выглядит как полный успех.
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

/** Прогон в адресе `<проект>/<прогон>`: на экране проекта достаточно один раз. */
function runIdOf(address: string): string {
  return address.slice(address.indexOf('/') + 1);
}

function Candidate({ run }: { readonly run: RunCandidate }): JSX.Element {
  return (
    <div className="run-row" title={run.address}>
      <span className="run-id">{runIdOf(run.address)}</span>
      <span className="marks">{run.unreadable ? <span className="badge">не читается</span> : null}</span>
      <span className="small dim mono">{fmtBytes(run.sizeBytes)}</span>
      <span className="small dim">{run.endedAt === undefined ? '—' : fmtTime(run.endedAt)}</span>
      <span className="small dim mono">{fmtDuration(run.ageMs)} назад</span>
    </div>
  );
}

export function Cleanup({ overview }: { readonly overview: Overview | undefined }): JSX.Element {
  const [traits, setTraits] = useState<readonly CleanupTrait[]>([]);
  const [olderThan, setOlderThan] = useState('');
  const [project, setProject] = useState('');

  const [selection, setSelection] = useState<RunSelection | undefined>(undefined);
  const [summary, setSummary] = useState<RemovalSummary | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const projects = overview?.projects ?? [];

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
    selectRuns({
      traits,
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
    deleteRuns(selection.runs.map((run) => run.address))
      .then((result) => {
        setSummary(result);
        setSelection(undefined);
      })
      .catch((failure: Error) => setError(failure.message))
      .finally(() => setBusy(false));
  };

  const nothingAsked = traits.length === 0 && olderThan === '';

  return (
    <>
      <h1>Уборка</h1>

      <div className="card">
        <div className="card-head">
          <span className="card-title">Отбор</span>
          <span className="small dim">признаки объединяются по «или»</span>
        </div>

        <div className="field">
          <span className="label">признак</span>
          <div className="field-body wrap">
            {TRAITS.map((trait) => (
              <label key={trait.id} className="check" title={trait.hint}>
                <input
                  type="checkbox"
                  checked={traits.includes(trait.id)}
                  onChange={() => toggle(trait.id)}
                />
                {trait.title}
              </label>
            ))}
          </div>
        </div>

        <div className="field">
          <label className="label" htmlFor="cleanup-age">
            старше
          </label>
          <div className="field-body">
            <input
              id="cleanup-age"
              className="mono narrow"
              value={olderThan}
              placeholder="7d, 12h, 30m"
              onChange={(event) => {
                setOlderThan(event.target.value);
                setSelection(undefined);
                setSummary(undefined);
              }}
            />
            <span className="small dim">пусто — без ограничения по сроку</span>
          </div>
        </div>

        <div className="field">
          <label className="label" htmlFor="cleanup-project">
            проект
          </label>
          <div className="field-body">
            <select
              id="cleanup-project"
              value={project}
              onChange={(event) => {
                setProject(event.target.value);
                setSelection(undefined);
                setSummary(undefined);
              }}
            >
              <option value="">все проекты</option>
              {projects.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.path ?? item.key}
                </option>
              ))}
            </select>
          </div>
        </div>

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
      </div>

      {selection === undefined ? null : (
        <div className="card">
          <div className="card-head">
            <span className="card-title">
              К удалению: {selection.count} · {fmtBytes(selection.totalBytes)}
            </span>
          </div>

          {selection.count === 0 ? (
            <p className="note dim">Под условия не подошёл ни один прогон. Ничего не удалено.</p>
          ) : (
            <>
              <div className="run-list cleanup-list">
                {selection.runs.map((run) => (
                  <Candidate key={run.address} run={run} />
                ))}
              </div>
              <div className="field">
                <span className="label" />
                <div className="field-body">
                  <button className="danger" disabled={busy} onClick={confirm}>
                    {busy ? 'удаление…' : `удалить ${selection.count} и освободить ${fmtBytes(selection.totalBytes)}`}
                  </button>
                  <button className="plain" disabled={busy} onClick={() => setSelection(undefined)}>
                    отменить
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {summary === undefined ? null : (
        <div className="card">
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
                    {OUTCOME_TITLE[item.outcome] ?? item.outcome}
                  </span>
                </span>
                <span className="small dim">{item.reason ?? ''}</span>
                <span className="small dim mono">
                  {item.sizeBytes === undefined ? '' : fmtBytes(item.sizeBytes)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
