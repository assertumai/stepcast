import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAnchorer, detectAnchorKind, manifestStore } from '../../core/anchor/index.js';
import { resolveConfig, type Config } from '../../core/config/resolve.js';
import { expandPipeline } from '../../core/pipeline/expand.js';
import { serializeLock } from '../../core/pipeline/lock.js';
import {
  buildResumePlan,
  changedSince,
  describePlan,
  finalAnchorOf,
  producedBy,
  readSourceRun,
} from '../../core/run/resumePlan.js';
import type { RunPaths } from '../../core/journal/paths.js';
import { findProjectRoot } from '../../core/journal/paths.js';
import { readStatus, resolveRun } from '../../core/journal/reader.js';
import { shortRunId } from '../../core/journal/paths.js';
import { formatDuration, formatTokens } from '../../core/units.js';
import { ExitCode, type ExitCodeValue } from '../../core/errors.js';
import { formatColumns } from '../output.js';
import type { ParsedArgs } from '../args.js';

const STATUS_LABEL: Record<string, string> = {
  pending: 'ожидает',
  running: 'идёт',
  success: 'успех',
  failed: 'отказ',
  skipped: 'пропущена',
  canceled: 'отменена',
  budget_exceeded: 'бюджет исчерпан',
};

export function runStatusCommand(
  args: ParsedArgs,
  write: (line: string) => void,
  cwd: string,
): ExitCodeValue {
  const { config } = resolveConfig({ cwd });
  const projectRoot = findProjectRoot(cwd);
  const paths = resolveRun(
    config.runs.root,
    projectRoot,
    args.flags.run as string | undefined,
  );
  const status = readStatus(paths);

  write(`прогон ${shortRunId(status.run_id)}  ${status.pipeline}  ${label(status.status)}`);
  write(`каталог: ${paths.dir}`);

  const rows: string[][] = [];
  for (const job of status.jobs) {
    const detail = job.status === 'failed' ? failureDetail(job) : (job.reason ?? '');
    rows.push([`  ${job.id}`, label(job.status), detail]);
  }
  for (const line of formatColumns(rows)) write(line);

  const budget = status.budget;
  const used = formatTokens(budget.tokens_used);
  const limit = budget.tokens_limit === undefined ? '—' : formatTokens(budget.tokens_limit);
  write(`расход: ${used} из ${limit} токенов, ${formatDuration(budget.wallclock_ms)}`);

  if (status.resume !== undefined) {
    write(`продолжить: ${status.resume.command}`);
  }

  // Объяснение инвалидации: почему каждый шаг будет переиспользован или нет.
  // Тот же объект, что ляжет в основание решения при возобновлении, — иначе
  // объяснение и поведение однажды разойдутся.
  if (args.flags.explain === true) {
    write('');
    write('при возобновлении:');
    for (const line of explainInvalidation(paths, config, cwd)) write(`  ${line}`);
  }

  return status.status === 'failed' ? ExitCode.jobFailed : ExitCode.ok;
}

function explainInvalidation(
  paths: RunPaths,
  config: Config,
  cwd: string,
): string[] {
  const source = readSourceRun(paths);
  const expanded = expandPipeline({
    pipelinePath: source.manifest.pipeline_file,
    config,
    inputs: Object.fromEntries(
      Object.entries(source.manifest.inputs).map(([name, value]) => [name, String(value)]),
    ),
  });

  const anchorKind = detectAnchorKind(cwd);
  const stateDir = mkdtempSync(join(tmpdir(), 'stepcast-explain-'));
  const anchorer = createAnchorer({
    dir: cwd,
    stateDir,
    kind: anchorKind,
    scope: 'explain',
    readStores: [manifestStore(source.paths.anchors)],
  });

  let changed: ReturnType<typeof changedSince>;
  try {
    changed = changedSince(anchorer, finalAnchorOf(source.status, anchorKind), anchorer.capture());
  } catch {
    changed = 'all';
  }

  const plan = buildResumePlan({
      expanded,
      config,
      source,
      lockHash: createHash('sha256')
        .update(serializeLock(expanded.pipeline))
        .digest('hex')
        .slice(0, 16),
      changed,
      producedPaths: (step) => producedBy(anchorer, step),
  });
  anchorer.dispose();

  return describePlan(plan);
}

function label(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

function failureDetail(job: ReturnType<typeof readStatus>['jobs'][number]): string {
  const failed = job.steps.find((step) => step.status === 'failed');
  if (failed !== undefined) {
    const attempt = failed.attempts.at(-1);
    const reason = attempt?.reason ?? failed.reason ?? '';
    return `шаг ${failed.id}, попытка ${attempt?.attempt ?? 1}${reason === '' ? '' : `: ${reason}`}`;
  }
  if (job.last_check !== undefined) {
    const names = job.last_check
      .filter((item) => !item.passed && item.hard)
      .map((item) => item.predicate)
      .join(', ');
    if (names !== '') return `check не пройден: ${names}`;
  }
  return job.reason ?? '';
}
