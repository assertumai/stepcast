import { resolveConfig, type Config } from '../../core/config/resolve.js';
import { describePlan, planResume, readSourceRun } from '../../core/run/resumePlan.js';
import type { RunPaths } from '../../core/journal/paths.js';
import { findProjectRoot } from '../../core/journal/paths.js';
import { readManifestSoft, readStatus, resolveRun } from '../../core/journal/reader.js';
import { describeBudgetAmounts } from '../../core/budget/accumulator.js';
import type { RunStatus } from '../../core/journal/schema.js';
import { shortRunId } from '../../core/journal/paths.js';
import { formatDuration, formatMoney, formatTokens } from '../../core/units.js';
import { ExitCode, type ExitCodeValue } from '../../core/errors.js';
import { knownLanes } from '../../core/lanes/lanes.js';
import { mergedLanes, readLaneMerge, type LaneMergeRecord } from '../../core/lanes/mergeRecord.js';
import { formatColumns } from '../output.js';
import { commandRow, PIPELINE_SERVICES } from '../commandRow.js';
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
  // Манифест журнала прежней версии engine не несёт вовсе — «версия движка не
  // умела писать это поле», а не «движок лежал вне дерева», и строка молчит,
  // не притворяясь одним из двух. Читается мягко: строка о движке —
  // необязательная деталь вывода, и манифест, разошедшийся по версии формата
  // или испорченный, не вправе отнимать у читателя весь остальной ответ,
  // который целиком берётся из `status.json`.
  const engine = readManifestSoft(paths).manifest?.engine;
  if (engine !== undefined) {
    write(
      `движок: ${engine.root} → ${engine.entry}${engine.pinned ? ' (снимок)' : ''}`,
    );
  }
  if (sleeping) write(`проснётся: ${status.wake_at}`);

  // Ожидание решения — тем же местом, где печатается пробуждение спящего
  // прогона: и то и другое читается из непустого поля состояния, а не из
  // нового значения статуса (design.md изменения `user-decision-steps`,
  // решение 2).
  for (const entry of status.awaiting ?? []) {
    const outcomes = Object.keys(entry.outcomes).join(', ');
    write(`ждёт решения: ${entry.job}/${entry.step} — исходы: ${outcomes}${entry.deadline === undefined ? '' : `, срок: ${entry.deadline}`}`);
  }

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

  // Причина остановки по бюджету читается из состояния, а не собирается
  // разбором статусов работ: шаг, перешедший потолок, мог отчитаться успехом,
  // и тогда среди работ её попросту нет (run-journal, «Причина остановки
  // читается из состояния»).
  if (budget.exceeded !== undefined) {
    write(`потолок перейдён: ${describeExceededState(budget.exceeded)}`);
  }

  // Исход сведения читается из каталога прогона, а не из git log: это и
  // требует спека — «остановлен по бюджету, дорожки сведены» и «остановлен
  // по бюджету, сведение не выполнено» различимы этим выводом одним.
  //
  // Перечень — известные прогону дорожки вместе с теми, на которые запись
  // исхода есть: запись пишет посторонний процесс (`merge-lanes`), и умолчать
  // о записанном исходе оттого, что состояние про дорожку не знает, значило бы
  // потерять ровно тот факт, ради которого запись заведена.
  const lanes = [...new Set([...knownLanes(status.jobs), ...mergedLanes(paths.dir)])].sort();
  for (const lane of lanes) {
    write(`дорожка ${lane}: ${describeLaneMerge(readLaneMerge(paths.dir, lane))}`);
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

export const row = commandRow(
  {
    name: 'status',
    spec: {
      description: 'показать состояние прогона',
      flags: {
        run: { kind: 'string', description: 'идентификатор прогона, по умолчанию последний' },
        explain: {
          kind: 'boolean',
          description: 'объяснить по каждому шагу, будет ли он переиспользован при возобновлении',
        },
      },
    },
    run: (args, io, env) => runStatusCommand(args, io.out, env.cwd),
  },
  { inject: PIPELINE_SERVICES },
);

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

/**
 * Перейдённый потолок из состояния прогона: область, величины в единицах
 * своего измерения и адрес шага, на котором он сработал. Величины печатаются
 * тем же кодом, что и в журнале (`describeBudgetAmounts`): микродоллары,
 * миллисекунды и проценты, напечатанные как есть, читались бы как токены.
 */
function describeExceededState(exceeded: NonNullable<RunStatus['budget']['exceeded']>): string {
  const amounts =
    exceeded.dimension === undefined
      ? `израсходовано ${exceeded.used} при потолке ${exceeded.limit}`
      : describeBudgetAmounts(exceeded.dimension, exceeded.used, exceeded.limit);
  return `${exceeded.scope}: ${amounts} (${exceeded.job}/${exceeded.step})`;
}

/** Коммиты сведения дорожки, текстом: `репозиторий: sha`, через запятую. */
function describeCommits(commits: Readonly<Record<string, string>> | undefined): string {
  const entries = Object.entries(commits ?? {});
  if (entries.length === 0) return '';
  return ` (коммиты: ${entries.map(([repo, sha]) => `${repo}: ${sha}`).join(', ')})`;
}

/**
 * Исход сведения дорожки для `stepcast status` — та же запись, которую пишет
 * `stepcast merge-lanes` (`src/core/lanes/mergeRecord.ts`). Дорожка без
 * записи называется дорожкой, сведение которой не выполнялось: молчание об
 * этом читалось бы как «неизвестно», а не как факт прогона.
 */
function describeLaneMerge(record: LaneMergeRecord | undefined): string {
  if (record === undefined) return 'сведение не выполнялось';
  switch (record.kind) {
    case 'merged':
      return `сведена, пункт «${record.slug}»${describeCommits(record.commits)}`;
    case 'already_merged':
      return `уже сведена ранее${record.slug === undefined ? '' : `, пункт «${record.slug}»`}`;
    case 'empty':
      return 'пропущена — слот не заполнен';
    case 'no_item':
      return 'пропущена — пункт очереди ей не доставался';
    case 'check_failed':
      return `не сведена, откачена${record.reason === undefined ? '' : `: ${record.reason}`}`;
    case 'not_reached':
      return `не сведена, не пробована${record.reason === undefined ? '' : `: ${record.reason}`}`;
    default:
      return `не сведена${record.reason === undefined ? '' : `: ${record.reason}`}`;
  }
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
