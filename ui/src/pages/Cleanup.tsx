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
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  statusBadgeVariant,
} from '@stepcast/ui';
import './cleanup.css';

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
  { id: 'abandoned', title: 'abandoned', hint: 'state still says running, but the process is dead' },
  { id: 'failed', title: 'failed', hint: 'failed, canceled, budget_exceeded' },
];

const OUTCOME_TITLE: Readonly<Record<string, string>> = {
  removed: 'removed',
  skipped_missing: 'already gone',
  skipped_alive: 'running — left alone',
  failed: 'failed',
};

/** Судьба записи хранилища у прогона: третий исход — «записи и не было». */
const STATS_TITLE: Readonly<Record<StatsOutcome, string>> = {
  kept: 'kept',
  removed: 'removed',
  missing: 'no record',
};

/**
 * Значение пункта «все проекты» в выпадающем списке: у Radix пункт с пустой
 * строкой запрещён, а вернуться к «всем» после выбора проекта нужно уметь —
 * поэтому пустой фильтр представлен своим ключом, который наружу уходит
 * пустой строкой, как и раньше.
 */
const ALL_PROJECTS = '__all__';

/** Прогон в адресе `<проект>/<прогон>`: на экране проекта достаточно один раз. */
function runIdOf(address: string): string {
  return address.slice(address.indexOf('/') + 1);
}

function Candidate({ run }: { readonly run: RunCandidate }): JSX.Element {
  return (
    <div className="run-row" title={run.address}>
      <span className="run-id">{runIdOf(run.address)}</span>
      <span className="marks">
        {run.unreadable ? <Badge>unreadable</Badge> : null}
        {run.hasUsageRecord ? null : <Badge>no record</Badge>}
      </span>
      <span className="small dim mono">{fmtBytes(run.sizeBytes)}</span>
      <span className="small dim">{run.endedAt === undefined ? '—' : fmtTime(run.endedAt)}</span>
      <span className="small dim mono">{fmtDuration(run.ageMs)} ago</span>
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
        <Badge variant={statusBadgeVariant(record.status)}>{record.status}</Badge>
      </span>
      <span />
      <span className="small dim">{fmtTime(record.endedAt)}</span>
      <span className="small dim mono">{fmtDuration(record.ageMs)} ago</span>
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
        <Label className="label" htmlFor={ageId}>
          older than
        </Label>
        <div className="field-body">
          <Input
            id={ageId}
            className="mono cleanup-age"
            value={olderThan}
            placeholder="7d, 12h, 30m"
            onChange={(event) => onOlderThan(event.target.value)}
          />
          <span className="small dim">empty — no age limit</span>
        </div>
      </div>

      <div className="field">
        <Label className="label" htmlFor={projectId}>
          project
        </Label>
        <div className="field-body">
          <Select
            value={project === '' ? ALL_PROJECTS : project}
            onValueChange={(value) => onProject(value === ALL_PROJECTS ? '' : value)}
          >
            <SelectTrigger id={projectId} className="cleanup-project" aria-label="Project">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
              {projects.map((item) => (
                <SelectItem key={item.key} value={item.key}>
                  {item.path ?? item.key}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
    <Card className="cleanup-card">
      <CardHeader>
        <CardTitle>Run files</CardTitle>
        <CardDescription>traits combine with “or”</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="field">
          <span className="label">trait</span>
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
            <Button disabled={busy || nothingAsked} onClick={runSelect}>
              {busy && selection === undefined ? 'Selecting…' : 'Show selection'}
            </Button>
            {nothingAsked ? (
              <span className="small dim">
                pick a trait or an age: a selection without conditions would delete everything
              </span>
            ) : null}
          </div>
        </div>

        {error === undefined ? null : (
          <Alert variant="destructive" className="cleanup-subhead">
            {error}
          </Alert>
        )}

        {selection === undefined ? null : (
          <>
            <CardHeader className="cleanup-subhead">
              <CardTitle>
                To delete: {selection.count} · {fmtBytes(selection.totalBytes)}
                {selection.count === 0 ? '' : ` · usage records: ${recordCount}`}
              </CardTitle>
            </CardHeader>

            {/* Прогоны, которых отбор не назвал и проверить не смог: у отбора по
                сроку таких нет — срок берёт их по времени каталога, и они уже в
                списке (`uncheckedCount` в `src/parts/pipeline/run/cleanup.ts`). */}
            {selection.uncheckedCount === 0 ? null : (
              <p className="note dim">
                {selection.uncheckedCount} more run(s) are not listed — the journal is unreadable and the
                status could not be checked. Traits say nothing about them; they are selected by age (the
                “older than” field).
              </p>
            )}

            {selection.count === 0 ? (
              <p className="note dim">No run matches the conditions. Nothing was deleted.</p>
            ) : (
              <>
                <div className="run-list cleanup-list">
                  {selection.runs.map((run) => (
                    <Candidate key={run.address} run={run} />
                  ))}
                </div>
                <p className="note dim">
                  Deleting removes files only: the usage summary of{' '}
                  {recordCount === selection.count
                    ? 'every run stays'
                    : `${recordCount} of ${selection.count} is already stored and stays`}{' '}
                  in history.
                </p>
                <div className="field">
                  <span className="label" />
                  <div className="field-body">
                    <Button variant="destructive" disabled={busy} onClick={() => confirm('keep')}>
                      {busy
                        ? 'Deleting…'
                        : `Delete ${selection.count} run files and free ${fmtBytes(selection.totalBytes)}`}
                    </Button>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => setSelection(undefined)}>
                      Cancel
                    </Button>
                  </div>
                </div>
                <div className="field">
                  <span className="label" />
                  <div className="field-body">
                    <label className="check" title="Destructive: the usage summary of these runs will be gone for good">
                      <input type="checkbox" checked={dropStats} onChange={(event) => setDropStats(event.target.checked)} />
                      {/* Уйдут записи, а не прогоны: снятие ничего не дописывает,
                          и у прогона без записи уносить нечего. */}
                      together with usage statistics ({recordCount} records)
                    </label>
                    <Button variant="destructive" disabled={busy || !dropStats} onClick={() => confirm('drop')}>
                      Delete files and statistics
                    </Button>
                  </div>
                </div>
              </>
            )}
          </>
        )}

        {summary === undefined ? null : (
          <>
            <CardHeader className="cleanup-subhead">
              <CardTitle>Freed {fmtBytes(summary.freedBytes)}</CardTitle>
              <CardDescription>
                removed {summary.outcomes.filter((item) => item.outcome === 'removed').length} of{' '}
                {summary.outcomes.length}
              </CardDescription>
            </CardHeader>
            <div className="run-list outcome-list">
              {summary.outcomes.map((item) => (
                <div key={item.address} className="run-row" title={item.address}>
                  <span className="run-id">{runIdOf(item.address)}</span>
                  <span className="marks">
                    <Badge variant={item.outcome === 'removed' ? 'success' : 'outline'}>
                      files: {OUTCOME_TITLE[item.outcome] ?? item.outcome}
                    </Badge>
                    {item.stats === undefined ? null : (
                      <Badge variant={item.stats === 'kept' ? 'success' : 'outline'}>
                        statistics: {STATS_TITLE[item.stats]}
                      </Badge>
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
      </CardContent>
    </Card>
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
  // `parts/pipeline/run/journal/usageStore.ts`), и запрещать такой отбор нечем.
  const nothingAsked = !failed && olderThan === '' && project === '';

  return (
    <Card className="cleanup-card">
      <CardHeader>
        <CardTitle>Usage records</CardTitle>
        <CardDescription>removes the usage summary; run files are untouched</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="field">
          <span className="label">trait</span>
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
              failed
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
            <Button disabled={busy || nothingAsked} onClick={runSelect}>
              {busy && selection === undefined ? 'Selecting…' : 'Show selection'}
            </Button>
            {nothingAsked ? (
              <span className="small dim">
                pick a trait, an age or a project: a selection without conditions removes no records
              </span>
            ) : null}
          </div>
        </div>

        {error === undefined ? null : (
          <Alert variant="destructive" className="cleanup-subhead">
            {error}
          </Alert>
        )}

        {selection === undefined ? null : (
          <>
            <CardHeader className="cleanup-subhead">
              <CardTitle>To remove: {selection.count} records</CardTitle>
            </CardHeader>

            {selection.count === 0 ? (
              <p className="note dim">No record matches the conditions. Nothing was removed.</p>
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
                    <Button variant="destructive" disabled={busy} onClick={confirm}>
                      {busy ? 'Removing…' : `Remove ${selection.count} records`}
                    </Button>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => setSelection(undefined)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              </>
            )}
          </>
        )}

        {summary === undefined ? null : (
          <>
            <CardHeader className="cleanup-subhead">
              <CardTitle>Records removed: {summary.removed}</CardTitle>
            </CardHeader>
            <div className="run-list outcome-list">
              {summary.outcomes.map((item) => (
                <div key={item.address} className="run-row" title={item.address}>
                  <span className="run-id">{runIdOf(item.address)}</span>
                  <span className="marks">
                    <Badge variant={item.outcome === 'removed' ? 'success' : 'outline'}>
                      {OUTCOME_TITLE[item.outcome] ?? item.outcome}
                    </Badge>
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function Cleanup({ overview }: { readonly overview: Overview | undefined }): JSX.Element {
  const projects = overview?.projects ?? [];

  return (
    <>
      <PageHeader
        title="Cleanup"
        description="Free disk space by deleting run files, or trim the usage history by removing its records; every deletion is previewed first and applies only to the rows you saw."
      />
      <Alert className="cleanup-intro">
        <AlertTitle>Vanished projects are cleaned up on their own</AlertTitle>
        <AlertDescription>
          Projects whose directory no longer exists are forgotten automatically when the daemon starts: their
          run directories and usage records are removed.
        </AlertDescription>
      </Alert>
      <FilesSection projects={projects} />
      <StatsSection projects={projects} />
    </>
  );
}
