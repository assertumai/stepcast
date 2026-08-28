import { StepcastError, isStepcastError } from '../errors.js';
import { REASON_LIMIT, finishItem, tailLine } from '../backlog/index.js';
import type { RunPaths } from '../journal/paths.js';
import { readStatus } from '../journal/reader.js';
import type { RunStatus } from '../journal/schema.js';
import { applyRun } from '../run/apply.js';
import { runCheck } from './check.js';
import { hasLaneItem, readLaneItem } from './item.js';
import { evaluateLane, knownLanes } from './lanes.js';
import { assertCleanTree, commitAll, currentCommit, resetToCommit } from './tree.js';

/**
 * Обход дорожек прогона: наложение, проверка, коммит зелёной, откат красной.
 * Возвращает исход каждой дорожки перечня — печать и код возврата остаются
 * заботой команды (`src/cli/commands/merge-lanes.ts`).
 */

export interface MergeLanesOptions {
  readonly paths: RunPaths;
  /** Дерево запуска: команда коммитит и, при красной проверке, стирает его правки. */
  readonly cwd: string;
  /** Дорожки в порядке обхода. Каждая обязана быть известна прогону. */
  readonly lanes: readonly string[];
  /** Команда проверки объединённого дерева, строка для оболочки. */
  readonly check: string;
  /** Файл очереди улучшений. */
  readonly file: string;
}

export type LaneMergeResult =
  | { readonly lane: string; readonly kind: 'merged'; readonly slug: string }
  | { readonly lane: string; readonly kind: 'empty' }
  | { readonly lane: string; readonly kind: 'no_item' }
  | { readonly lane: string; readonly kind: 'unfit'; readonly reason: string }
  | { readonly lane: string; readonly kind: 'conflict'; readonly reason: string }
  | { readonly lane: string; readonly kind: 'check_failed'; readonly reason: string }
  | { readonly lane: string; readonly kind: 'no_contribution'; readonly reason: string }
  | { readonly lane: string; readonly kind: 'not_reached'; readonly reason: string };

/** Причина с хвостом чужого вывода: приставка целиком, вывод — сколько влезло. */
function reasonWithOutput(prefix: string, output: string): string {
  return `${prefix}${tailLine(output, REASON_LIMIT - prefix.length)}`;
}

/** Путь рабочего дерева дорожки — последняя её работа, несущая `workspace`. */
function workspaceOf(status: RunStatus, lane: string): string | undefined {
  const records = status.jobs.filter((job) => job.lane === lane);
  return [...records].reverse().find((job) => job.workspace !== undefined)?.workspace?.path;
}

export async function mergeLanes(options: MergeLanesOptions): Promise<readonly LaneMergeResult[]> {
  const { paths, cwd, lanes, check, file } = options;
  const runDir = paths.dir;

  assertCleanTree(cwd);

  const status = readStatus(paths);
  const known = knownLanes(status.jobs);
  for (const lane of lanes) {
    if (!known.includes(lane)) {
      throw new StepcastError(`дорожка «${lane}» неизвестна прогону`, {
        hint: known.length === 0 ? 'В прогоне нет ни одной работы с меткой lane' : `Известны: ${known.join(', ')}`,
      });
    }
  }

  const results: LaneMergeResult[] = [];
  let stoppedAt: string | undefined;

  /**
   * Исходы, проставленные в очереди, но ещё не попавшие ни в один коммит.
   *
   * Файл очереди отслеживается git, а откат красной проверки — `git reset
   * --hard` на коммит до наложения: он снимает вместе с диффом дорожки и
   * отметки, проставленные более ранним дорожкам этого же обхода. Список
   * держит их, чтобы после отката проставить заново; коммит сведённой
   * дорожки список опустошает — эти правки уже в истории.
   */
  const uncommitted: { readonly slug: string; readonly reason: string }[] = [];

  /** Проставить дорожке `failed`, только если ей вообще достался пункт очереди. */
  const markFailed = (lane: string, reason: string): void => {
    if (!hasLaneItem(runDir, lane)) return;
    const item = readLaneItem(runDir, lane);
    if (finishItem(file, item.slug, 'failed', reason) === 'set') {
      uncommitted.push({ slug: item.slug, reason });
    }
  };

  /** Вернуть дерево к коммиту до наложения, восстановив стёртые им отметки очереди. */
  const rollback = (to: string): void => {
    resetToCommit(cwd, to);
    for (const mark of uncommitted) finishItem(file, mark.slug, 'failed', mark.reason);
  };

  for (const lane of lanes) {
    if (stoppedAt !== undefined) {
      const reason = `сведение остановилось на более ранней дорожке ${stoppedAt}`;
      markFailed(lane, reason);
      results.push({ lane, kind: 'not_reached', reason });
      continue;
    }

    const verdict = evaluateLane(status.jobs, lane);

    if (verdict.kind === 'empty') {
      results.push({ lane, kind: 'empty' });
      continue;
    }

    if (verdict.kind === 'unfit') {
      const reason = `работы дорожки не все успешны: ${verdict.jobs
        .map((job) => `${job.id}=${job.status}`)
        .join(', ')}`;
      markFailed(lane, reason);
      results.push({ lane, kind: 'unfit', reason });
      continue;
    }

    // verdict.kind === 'ready'

    // Пункт читается до наложения: слаг и заголовок нужны сообщению коммита,
    // и дорожка, которой пункт не достался, пропускается, не тронув дерево, —
    // иначе её дифф остался бы наложенным и незакоммиченным. По той же
    // причине здесь, а не после проверки, отказывает файл пункта без слага.
    if (!hasLaneItem(runDir, lane)) {
      results.push({ lane, kind: 'no_item' });
      continue;
    }
    const item = readLaneItem(runDir, lane);

    const before = currentCommit(cwd);

    let applied: ReturnType<typeof applyRun>;
    try {
      applied = applyRun({ paths, cwd, lane });
    } catch (error) {
      if (!isStepcastError(error)) throw error;
      const workspace = workspaceOf(status, lane);
      const reason = reasonWithOutput(
        `наложение дорожки не сошлось с текущим деревом (рабочее дерево: ${workspace ?? 'неизвестно'}): `,
        error.message,
      );
      markFailed(lane, reason);
      results.push({ lane, kind: 'conflict', reason });
      stoppedAt = lane;
      continue;
    }

    if (applied.kind !== 'applied') {
      const reason = 'дорожка не изменила дерево';
      markFailed(lane, reason);
      results.push({ lane, kind: 'no_contribution', reason });
      continue;
    }

    const checked = await runCheck({ command: check, cwd });
    const green = checked.outcome === 'exited' && checked.exitCode === 0;

    if (!green) {
      rollback(before);
      const workspace = workspaceOf(status, lane);
      const output = checked.stderr.trim() !== '' ? checked.stderr : checked.stdout;
      const reason = reasonWithOutput(
        `проверка после наложения красная (рабочее дерево: ${workspace ?? 'неизвестно'}): `,
        output,
      );
      markFailed(lane, reason);
      results.push({ lane, kind: 'check_failed', reason });
      stoppedAt = lane;
      continue;
    }

    // Правка очереди идёт до коммита: улучшение и его бухгалтерия остаются
    // одним событием, которое `git revert` снимает целиком.
    finishItem(file, item.slug, 'done');
    commitAll(cwd, `${item.slug}: ${item.title ?? 'улучшение из очереди'}`);
    // Коммит забрал в историю и отметки прежних дорожек: откатывать их
    // будущему `reset --hard` больше нечего.
    uncommitted.length = 0;
    results.push({ lane, kind: 'merged', slug: item.slug });
  }

  return results;
}
