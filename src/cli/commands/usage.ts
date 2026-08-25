import { resolveConfig } from '../../core/config/resolve.js';
import { findProjectRoot, shortRunId } from '../../core/journal/paths.js';
import { readStatus, readUsageSoft, resolveRun, type UsageSummaryUnavailable } from '../../core/journal/reader.js';
import type { AttemptRecord, UsageAttemptReport, UsageReport } from '../../core/journal/schema.js';
import { formatDuration, formatTokens } from '../../core/units.js';
import { ExitCode, type ExitCodeValue } from '../../core/errors.js';
import { formatColumns } from '../output.js';
import type { ParsedArgs } from '../args.js';

const DASH = '—';

/**
 * Общая разметка столбцов для всех трёх уровней.
 *
 * Работа и шаг заполняют только «время» и «списано» — сырые токены и модель
 * принадлежат попытке и складываться по уровню не должны. Пустые ячейки на
 * их местах держат столбцы на своих позициях: столбец обязан означать одно и
 * то же в любой строке, иначе таблицу нельзя читать по вертикали.
 */
const COLUMNS = [
  'бэкенд',
  'модель',
  'вход',
  'выход',
  'чт. кэша',
  'зап. кэша',
  'время',
  'списано',
  'цена',
] as const;

const TIME_COLUMN = COLUMNS.indexOf('время');
const BILLABLE_COLUMN = COLUMNS.indexOf('списано');

function totalCells(billable: number | undefined, wallclockMs: number | undefined): string[] {
  const cells = COLUMNS.map(() => '');
  cells[TIME_COLUMN] = timeCell(wallclockMs);
  cells[BILLABLE_COLUMN] = tokensCell(billable);
  return cells;
}

/**
 * Расход прогона: работа → шаг → попытка.
 *
 * Источники — `status.json` (всегда, переживает `gc`, несёт бэкенд, модель,
 * сырые токены и время каждой попытки) и `usage.json` (взвешенный
 * billable-токен по попытке, шагу, работе и прогону, и список несообщённых
 * измерений — величины, которых `status.json` не считает). Сводки может не
 * быть — прогон ещё идёт или её формат устарел, — тогда отчёт всё равно
 * строится, а недоступное помечается явно, а не молчит нулём.
 */
export function runUsageCommand(
  args: ParsedArgs,
  write: (line: string) => void,
  cwd: string,
): ExitCodeValue {
  const { config } = resolveConfig({ cwd });
  const projectRoot = findProjectRoot(cwd);
  const paths = resolveRun(config.runs.root, projectRoot, args.positional[0]);
  const status = readStatus(paths);
  const { summary, unavailable } = readUsageSoft(paths);

  write(`прогон ${shortRunId(status.run_id)}  ${status.pipeline}  ${status.status}`);
  write(
    `расход: ${formatTokens(summary?.total.billable_tokens ?? status.budget.tokens_used)} токенов, ${formatDuration(summary?.total.wallclock_ms ?? status.budget.wallclock_ms)}`,
  );

  const rows: string[][] = [['', ...COLUMNS]];
  for (const job of status.jobs) {
    const jobReport = summary?.jobs[job.id];
    rows.push([`  ${job.id}`, ...totalCells(jobReport?.billable_tokens, jobReport?.wallclock_ms)]);
    for (const step of job.steps) {
      const stepReport = jobReport?.steps[step.id];
      rows.push([`    ${step.id}`, ...totalCells(stepReport?.billable_tokens, stepReport?.wallclock_ms)]);
      for (const attempt of step.attempts) {
        rows.push([`      #${attempt.attempt}`, ...attemptCells(attempt, stepReport?.attempts)]);
      }
    }
  }
  for (const line of formatColumns(rows)) write(line);

  for (const line of incompleteness(summary, unavailable)) write(line);

  return ExitCode.ok;
}

function attemptCells(
  attempt: AttemptRecord,
  reported: readonly UsageAttemptReport[] | undefined,
): string[] {
  const usage = attempt.usage;
  const billable = reported?.find((entry) => entry.attempt === attempt.attempt);

  // Ровно столько же ячеек, сколько в ветке ниже: иначе строки без расхода
  // сдвигают колонки соседних, и таблица перестаёт читаться.
  if (usage === undefined) return COLUMNS.map(() => DASH);

  return [
    usage.backend,
    usage.model ?? DASH,
    tokensCell(usage.tokens_in ?? undefined),
    tokensCell(usage.tokens_out ?? undefined),
    tokensCell(usage.cache_read ?? undefined),
    tokensCell(usage.cache_write ?? undefined),
    timeCell(usage.wallclock_ms),
    tokensCell(billable?.billable_tokens),
    usage.reported_cost_usd === undefined ? DASH : `$${usage.reported_cost_usd.toFixed(4)}`,
  ];
}

function tokensCell(value: number | undefined): string {
  return value === undefined ? DASH : formatTokens(value);
}

function timeCell(value: number | undefined): string {
  return value === undefined ? DASH : formatDuration(value);
}

function incompleteness(
  summary: UsageReport | undefined,
  unavailable: UsageSummaryUnavailable | undefined,
): string[] {
  const lines: string[] = [];

  if (unavailable === 'missing') {
    lines.push('', 'сводка расхода ещё не записана: прогон идёт, агрегат появится по завершении');
  } else if (unavailable === 'unreadable') {
    lines.push('', 'сводка расхода не прочитана: usage.json не проходит текущую схему');
  } else if (summary !== undefined && summary.unreported.length > 0) {
    lines.push('', `учёт неполон: не сообщено — ${summary.unreported.join(', ')}`);
  }

  return lines;
}
