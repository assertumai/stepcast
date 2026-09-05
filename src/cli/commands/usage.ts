import { resolveConfig } from '../../core/config/resolve.js';
import { findProjectRoot, shortRunId } from '../../core/journal/paths.js';
import {
  isRunAlive,
  readStatus,
  readUsageSoft,
  resolveRun,
  type UsageSummaryUnavailable,
} from '../../core/journal/reader.js';
import type { AttemptRecord, UsageAttemptReport, UsageReport } from '../../core/journal/schema.js';
import { formatDuration, formatMoney, formatTokens } from '../../core/units.js';
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
  'пик',
  'цена',
] as const;

const TIME_COLUMN = COLUMNS.indexOf('время');
const BILLABLE_COLUMN = COLUMNS.indexOf('списано');
const PEAK_COLUMN = COLUMNS.indexOf('пик');
const COST_COLUMN = COLUMNS.indexOf('цена');

function totalCells(
  billable: number | undefined,
  wallclockMs: number | undefined,
  costUsd: number | undefined,
): string[] {
  const cells = COLUMNS.map(() => '');
  cells[TIME_COLUMN] = timeCell(wallclockMs);
  cells[BILLABLE_COLUMN] = tokensCell(billable);
  cells[COST_COLUMN] = costCell(costUsd);
  return cells;
}

/**
 * Строка шага дополнительно несёт пик — максимум по попыткам из сводки. У
 * работы своего пика нет (см. `UsageAccumulator.report`): «наибольшее
 * обращение за работу» не указывает, в каком шаге оно случилось, а столбец
 * там остаётся пустым, как и у сырых токенов.
 */
function stepCells(
  billable: number | undefined,
  wallclockMs: number | undefined,
  costUsd: number | undefined,
  peak: number | undefined,
): string[] {
  const cells = totalCells(billable, wallclockMs, costUsd);
  cells[PEAK_COLUMN] = tokensCell(peak);
  return cells;
}

/**
 * Расход прогона: работа → шаг → попытка.
 *
 * Источники — `status.json` (всегда, переживает `gc`, несёт бэкенд, модель,
 * сырые токены и время каждой попытки) и `usage.json` (взвешенный
 * billable-токен по попытке, шагу, работе и прогону, и список несообщённых
 * измерений — величины, которых `status.json` не считает). Сводка идущего
 * прогона накоплена на текущий момент, а не подведена (`partial: true`), и
 * строится разбивка по ней так же, как по завершённому прогону. Сводки может
 * не быть вовсе — окно до первой записи или формат устарел, — тогда отчёт
 * всё равно строится, а недоступное помечается явно, а не молчит нулём.
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
  const costTotal = summary?.total.cost_usd ?? status.budget.cost_used_usd;
  write(
    `расход: ${formatTokens(summary?.total.billable_tokens ?? status.budget.tokens_used)} токенов, ${formatDuration(summary?.total.wallclock_ms ?? status.budget.wallclock_ms)}, ${costTotal === undefined ? DASH : formatMoney(Math.round(costTotal * 1_000_000))}`,
  );

  const rows: string[][] = [['', ...COLUMNS]];
  // Группировка по lane включается, только если хоть одна работа её несёт:
  // прогон без объявленных дорожек печатается ровно как прежде.
  const hasLanes = status.jobs.some((job) => job.lane !== undefined);
  const printedLanes = new Set<string>();

  for (const job of status.jobs) {
    if (hasLanes && job.lane !== undefined && !printedLanes.has(job.lane)) {
      printedLanes.add(job.lane);
      const laneReports = status.jobs
        .filter((entry) => entry.lane === job.lane)
        .map((entry) => summary?.jobs[entry.id]);
      rows.push([
        job.lane,
        ...totalCells(
          sumOrUnreported(laneReports.map((report) => report?.billable_tokens)),
          sumOrUnreported(laneReports.map((report) => report?.wallclock_ms)),
          sumOrUnreported(laneReports.map((report) => report?.cost_usd)),
        ),
      ]);
    }

    const jobReport = summary?.jobs[job.id];
    rows.push([`  ${job.id}`, ...totalCells(jobReport?.billable_tokens, jobReport?.wallclock_ms, jobReport?.cost_usd)]);
    for (const step of job.steps) {
      const stepReport = jobReport?.steps[step.id];
      rows.push([
        `    ${step.id}`,
        ...stepCells(
          stepReport?.billable_tokens,
          stepReport?.wallclock_ms,
          stepReport?.cost_usd,
          stepReport?.peak_prefix_tokens,
        ),
      ]);
      for (const attempt of step.attempts) {
        rows.push([`      #${attempt.attempt}`, ...attemptCells(attempt, stepReport?.attempts)]);
      }
    }
  }
  for (const line of formatColumns(rows)) write(line);

  // Живость спрашивается только у незаконченной сводки: у подведённой она
  // ничего не меняет, а лишний обход файлов прогона не бесплатен.
  const alive = summary?.partial === true && isRunAlive(paths);
  for (const line of incompleteness(summary, unavailable, status.budget.cost_unreported_attempts, alive)) {
    write(line);
  }

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
    // Сначала сводка, и только потом status.json: в status.json попытки лежит
    // пик одного агента, а «списано» слева от него и пик строки шага уже
    // включают вызванного шагом судью. Взять здесь агентский пик значило бы
    // печатать в строке шага величину больше, чем в любой её строке попытки,
    // — расхождение, которое таблица ничем не объясняет. Значение из
    // status.json остаётся запасным: оно переживает gc сводки.
    tokensCell(billable?.peak_prefix_tokens ?? usage.peak_prefix_tokens),
    costCell(billable?.cost_usd ?? usage.reported_cost_usd),
  ];
}

/** Сумма измерения по дорожке: одна несообщённая работа делает итог несообщённым, не нулевым. */
function sumOrUnreported(values: readonly (number | undefined)[]): number | undefined {
  if (values.some((value) => value === undefined)) return undefined;
  return (values as number[]).reduce((sum, value) => sum + value, 0);
}

function tokensCell(value: number | undefined): string {
  return value === undefined ? DASH : formatTokens(value);
}

function timeCell(value: number | undefined): string {
  return value === undefined ? DASH : formatDuration(value);
}

/** Прочерк вместо нуля: несообщённая цена — не то же самое, что нулевая. */
function costCell(usd: number | undefined): string {
  return usd === undefined ? DASH : formatMoney(Math.round(usd * 1_000_000));
}

/**
 * Строки о неполноте отчёта. `alive` — жив ли процесс прогона: сводка с
 * признаком незаконченности остаётся такой навсегда у прогона, чей процесс
 * убит, и обещать там, что величины «ещё вырастут», значило бы соврать дважды
 * — прогон не идёт и ничего к сводке уже не допишет.
 */
function incompleteness(
  summary: UsageReport | undefined,
  unavailable: UsageSummaryUnavailable | undefined,
  costUnreportedAttempts: number | undefined,
  alive: boolean,
): string[] {
  const notes: string[] = [];

  if (unavailable === 'missing') {
    // Живая запись пишет usage.json сразу при старте прогона (writeStatus в
    // runner.ts), поэтому это окно — доли секунды между созданием каталога и
    // первой записью — или прогон прежней формы, чей процесс уже мёртв:
    // обещать «агрегат появится по завершении» здесь было бы неверно в обоих
    // случаях.
    notes.push('сводка расхода ещё не записана');
  } else if (unavailable === 'unreadable') {
    notes.push('сводка расхода не прочитана: usage.json не проходит текущую схему');
  } else if (summary !== undefined) {
    if (summary.partial) {
      notes.push(
        alive
          ? 'сводка накоплена на текущий момент: прогон идёт, величины ещё вырастут'
          : 'сводка не подведена: прогон оборван, величины остались на момент обрыва',
      );
    }
    if (summary.unreported.length > 0) {
      notes.push(`учёт неполон: не сообщено — ${summary.unreported.join(', ')}`);
    }
  }

  if (costUnreportedAttempts !== undefined && costUnreportedAttempts > 0) {
    notes.push(
      `цена неполна: ${costUnreportedAttempts} ${pluralAttempts(costUnreportedAttempts)} без сообщённой цены`,
    );
  }

  return notes.length === 0 ? [] : ['', ...notes];
}

function pluralAttempts(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'попытка';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'попытки';
  return 'попыток';
}
