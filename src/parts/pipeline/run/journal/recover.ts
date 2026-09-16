import { appendFileSync, readFileSync } from 'node:fs';

import { ExitCode } from '../../../../kernel/errors.js';
import { JOURNAL_FORMAT } from './format.js';
import { listRunsByKey, readEvents, readManifestSoft, readStatusSoft, readUsageSoft } from './reader.js';
import { runPaths, shortRunId } from './paths.js';
import { atomicWrite } from './writer.js';
import type { EventInput, JobRecord, RunManifest, RunStatus, UsageReport } from './schema.js';

export interface RunnerExit {
  readonly pid: number;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

const INTERRUPTED_DETAIL = 'runner завершился без терминальной записи журнала';

/**
 * Завершить журнал runner, за которым наблюдал демон и который исчез, пока
 * состояние ещё было `running`.
 *
 * PID связывает событие `exit` с конкретным журналом без догадки по `latest`:
 * рядом могут одновременно стартовать несколько прогонов. Функция
 * идемпотентна — уже терминальный журнал не переписывается и повторных
 * событий не получает.
 */
export function finalizeInterruptedRun(
  runsRoot: string,
  projectKey: string,
  exit: RunnerExit,
): boolean {
  for (const runId of listRunsByKey(runsRoot, projectKey)) {
    const paths = runPaths(runsRoot, projectKey, runId);
    const manifest = readManifestSoft(paths).manifest;
    if (manifest?.pid !== exit.pid) continue;

    const status = readStatusSoft(paths).status;
    if (status === undefined) return false;

    const events = readEvents(paths);
    const interrupted = events.find(
      (event) => event.kind === 'run.interrupted' && event.pid === exit.pid,
    );
    // `failed` допускается только как промежуточное состояние уже начатого
    // восстановления. Чужой терминальный отказ без нашего события трогать
    // нельзя: runner успел завершить его штатно.
    if (status.status !== 'running' && interrupted === undefined) return false;

    const now = new Date().toISOString();
    const terminalExitCode = exit.exitCode !== null && exit.exitCode !== 0
      ? exit.exitCode
      : ExitCode.configError;
    const reason = `${INTERRUPTED_DETAIL} (pid ${exit.pid}, ${describeExit(exit)})`;
    const runningJobs = status.jobs.filter((job) => job.status === 'running');
    const jobs = status.jobs.map((job) => finishRunningJob(job, now, reason));
    const blocked = runningJobs[0];

    const { wake_at: _wakeAt, awaiting: _awaiting, ...stableStatus } = status;
    const terminalStatus: RunStatus = {
      ...stableStatus,
      status: 'failed',
      jobs,
      ...(blocked === undefined
        ? {}
        : {
            resume: {
              command: `stepcast resume ${shortRunId(runId)} --from ${blocked.id}`,
              blocked_by: blocked.id,
            },
          }),
      updated_at: now,
    };
    const finishedAt = manifest.finished_at ?? interrupted?.ts ?? now;
    const terminalManifest: RunManifest = {
      ...manifest,
      finished_at: finishedAt,
      status: 'failed',
      exit_code: terminalExitCode,
      format: JOURNAL_FORMAT,
    };

    const usage = readUsageSoft(paths).summary;
    const finished = events.find(
      (event) => event.kind === 'run.finished' && event.status === 'failed',
    );
    const complete =
      interrupted !== undefined &&
      finished !== undefined &&
      status.status === 'failed' &&
      runningJobs.length === 0 &&
      manifest.status === 'failed' &&
      manifest.finished_at !== undefined &&
      manifest.exit_code !== undefined &&
      usage?.partial !== true;
    if (complete) return false;

    // Диагностическое событие служит устойчивым маркером восстановления. Оно
    // разрешает повторному вызову продолжить уже из промежуточного `failed`,
    // но `run.finished` ещё не публикуется: потребитель терминального события
    // должен всегда видеть уже завершённые документы журнала.
    if (interrupted === undefined) appendRecoveryEvent(paths.events, events, {
      kind: 'run.interrupted',
      pid: exit.pid,
      exit_code: exit.exitCode,
      signal: exit.signal,
      detail: INTERRUPTED_DETAIL,
    });
    atomicWrite(paths.status, `${JSON.stringify(terminalStatus, null, 2)}\n`);
    atomicWrite(paths.manifest, `${JSON.stringify(terminalManifest, null, 2)}\n`);
    finalizeUsage(paths.usage, usage);
    if (finished === undefined) appendRecoveryEvent(paths.events, readEvents(paths), {
      kind: 'run.finished',
      status: 'failed',
      exit_code: terminalExitCode,
    });
    return true;
  }
  return false;
}

function finishRunningJob(job: JobRecord, finishedAt: string, reason: string): JobRecord {
  if (job.status !== 'running') return job;
  return { ...job, status: 'failed', reason, finished_at: finishedAt };
}

function describeExit(exit: RunnerExit): string {
  if (exit.signal !== null) return `сигнал ${exit.signal}`;
  return `код ${exit.exitCode ?? 'неизвестен'}`;
}

function finalizeUsage(path: string, usage: UsageReport | undefined): void {
  if (usage === undefined || usage.partial !== true) return;
  const { partial: _partial, ...terminal } = usage;
  atomicWrite(path, `${JSON.stringify(terminal, null, 2)}\n`);
}

function appendRecoveryEvent(
  path: string,
  existing: readonly { readonly seq: number }[],
  input: EventInput,
): void {
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // Журнал может оборваться до первой записи события: восстановление
    // заведёт файл с терминальной парой с нуля.
  }
  const sequence = existing.reduce((maximum, event) => Math.max(maximum, event.seq), -1) + 1;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    seq: sequence,
    ...input,
  });
  const boundary = raw !== '' && !raw.endsWith('\n') ? '\n' : '';
  appendFileSync(path, `${boundary}${line}\n`, {
    mode: 0o600,
  });
}
