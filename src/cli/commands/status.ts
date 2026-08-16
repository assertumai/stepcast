import { resolveConfig } from '../../core/config/resolve.js';
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
    const detail =
      job.status === 'failed' && job.steps.length > 0
        ? failureDetail(job.steps)
        : (job.reason ?? '');
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

  return status.status === 'failed' ? ExitCode.jobFailed : ExitCode.ok;
}

function label(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

function failureDetail(steps: ReturnType<typeof readStatus>['jobs'][number]['steps']): string {
  const failed = steps.find((step) => step.status === 'failed');
  if (failed === undefined) return '';
  const attempt = failed.attempts.at(-1);
  const reason = attempt?.reason ?? failed.reason ?? '';
  return `шаг ${failed.id}, попытка ${attempt?.attempt ?? 1}${reason === '' ? '' : `: ${reason}`}`;
}
