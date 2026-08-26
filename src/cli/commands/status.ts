import { resolveConfig, type Config } from '../../core/config/resolve.js';
import { describePlan, planResume, readSourceRun } from '../../core/run/resumePlan.js';
import type { RunPaths } from '../../core/journal/paths.js';
import { findProjectRoot } from '../../core/journal/paths.js';
import { readStatus, resolveRun } from '../../core/journal/reader.js';
import { shortRunId } from '../../core/journal/paths.js';
import { formatDuration, formatMoney, formatTokens } from '../../core/units.js';
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

  const sleeping = status.status === 'running' && status.wake_at !== undefined;
  write(
    `прогон ${shortRunId(status.run_id)}  ${status.pipeline}  ${sleeping ? 'спит' : label(status.status)}`,
  );
  write(`каталог: ${paths.dir}`);
  if (sleeping) write(`проснётся: ${status.wake_at}`);

  const rows: string[][] = [];
  for (const job of status.jobs) {
    const detail = job.status === 'failed' ? failureDetail(job) : (job.reason ?? '');
    rows.push([`  ${job.id}`, label(job.status), detail]);
  }
  for (const line of formatColumns(rows)) write(line);

  const budget = status.budget;
  const used = formatTokens(budget.tokens_used);
  const limit = budget.tokens_limit === undefined ? '—' : formatTokens(budget.tokens_limit);
  const costUsed = formatMoney(Math.round((budget.cost_used_usd ?? 0) * 1_000_000));
  const costLimit =
    budget.cost_limit_usd === undefined ? '—' : formatMoney(Math.round(budget.cost_limit_usd * 1_000_000));
  write(
    `расход: ${used} из ${limit} токенов, ${costUsed} из ${costLimit}, ${formatDuration(budget.wallclock_ms)}`,
  );
  if (budget.cost_unreported_attempts !== undefined && budget.cost_unreported_attempts > 0) {
    write(`цена неполна: ${budget.cost_unreported_attempts} попыток без сообщённой цены`);
  }

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
  // Тот же код, что и у `resume --dry-run`: объяснение и решение не должны
  // расходиться.
  const { plan } = planResume({ cwd, config, source });
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
