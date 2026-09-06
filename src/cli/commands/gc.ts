import { resolveConfig } from '../../core/config/resolve.js';
import { findProjectRoot, projectKey, shortRunId } from '../../core/journal/paths.js';
import {
  backfillUsageStore,
  readUsageStore,
  removeUsageRecords,
  selectUsageRecords,
  usageRecordAddress,
  type UsageRecordSelectTraits,
} from '../../core/journal/usageStore.js';
import { cleanupRun, listCandidates, selectOlderThan } from '../../core/run/cleanup.js';
import { formatBytes, parseDuration } from '../../core/units.js';
import { ExitCode, StepcastError, type ExitCodeValue } from '../../core/errors.js';
import { formatColumns } from '../output.js';
import type { ParsedArgs } from '../args.js';

/**
 * `stepcast gc` — две отдельные цели, которых один вызов не смешивает
 * (design.md изменения run-stats-retention, Решение 14): без `--stats` цель —
 * каталоги прогонов (`--older-than` снимает их, как и раньше); со `--stats` —
 * записи хранилища расхода, а файлов вызов не трогает вовсе.
 */

const HINT_REMOVE_FILES = 'удаление файлов: stepcast gc --older-than <длительность>, например 30d';
const HINT_REMOVE_STATS =
  'снятие записей: stepcast gc --stats --older-than <срок> | --stats --failed | --stats --project <ключ> (весь проект)';

function statsTraitsOf(args: ParsedArgs): UsageRecordSelectTraits {
  const olderThan = args.flags['older-than'] as string | undefined;
  return {
    ...(args.flags['failed'] === true ? { failed: true } : {}),
    ...(olderThan === undefined ? {} : { olderThanMs: parseDuration(olderThan, '--older-than') }),
  };
}

function hasTrait(traits: UsageRecordSelectTraits): boolean {
  return traits.failed === true || traits.olderThanMs !== undefined;
}

/**
 * Цель «записи хранилища расхода»: файлов прогонов вызов не касается.
 *
 * Область — тот же проект, что и у цели «файлы»: `listCandidates` отбирает
 * каталоги проекта рабочего каталога, и `stepcast gc --stats --older-than 1y`,
 * набранная внутри проекта, обязана снимать записи этого же проекта, а не всей
 * установки. Чужой проект адресуется явно — `--project <ключ>`, тем ключом,
 * который называет отчёт; названный явно, он и сам признак отбора: без срока и
 * исхода снимает свою область целиком.
 */
function runGcStats(
  runsRoot: string,
  projectRoot: string,
  args: ParsedArgs,
  write: (line: string) => void,
): ExitCodeValue {
  backfillUsageStore(runsRoot);
  const named = args.flags['project'] as string | undefined;
  const project = named ?? projectKey(projectRoot);
  const traits = statsTraitsOf(args);

  if (!hasTrait(traits) && named === undefined) {
    // Без единого признака отбор не отбирает ничего (design.md, Решение 14) —
    // отчёт называет все записи кандидатами, а не отбор пустого множества.
    const { records, corrupted } = readUsageStore(runsRoot);
    const candidates = [...records.values()].filter((record) => record.project.key === project);

    if (candidates.length === 0) {
      write('записей хранилища расхода ещё нет, снимать нечего');
      return ExitCode.ok;
    }

    const rows = candidates.map((record) => [
      `  ${record.project.key}/${shortRunId(record.run_id)}`,
      record.finished_at ?? record.started_at,
      record.status,
    ]);
    for (const line of formatColumns(rows)) write(line);
    write(
      `записей: ${candidates.length}` + (corrupted > 0 ? `, испорченных строк: ${corrupted}` : ''),
    );
    write(HINT_REMOVE_STATS);
    return ExitCode.ok;
  }

  const selected = selectUsageRecords(runsRoot, traits, { project });
  if (selected.length === 0) {
    write('нет записей, подходящих под признак отбора');
    return ExitCode.ok;
  }

  const removed = removeUsageRecords(runsRoot, selected.map((entry) => entry.address));
  for (const entry of selected) write(`снята запись: ${usageRecordAddress(entry.record)}`);
  write(`снято записей: ${removed}`);
  return ExitCode.ok;
}

/**
 * `stepcast gc` без stdin: без `--older-than` — только отчёт, ничего не
 * удаляется; с ним — удаляет прогоны старше порога. Никакого диалога.
 */
export function runGcCommand(
  args: ParsedArgs,
  write: (line: string) => void,
  cwd: string,
): ExitCodeValue {
  const { config } = resolveConfig({ cwd });
  const projectRoot = findProjectRoot(cwd);
  const runsRoot = config.runs.root;

  const statsTarget = args.flags['stats'] === true;
  const failedFlag = args.flags['failed'] === true;
  const projectFlag = args.flags['project'] as string | undefined;

  // `--failed`/`--project` снимают записи, а не файлы: без `--stats` цель
  // вызова — файлы, и эти признаки для неё не определены. Разрешить это
  // молча значило бы иногда снимать не то, что человек имел в виду; отказ
  // называет, какая из двух целей эти признаки понимает.
  if (!statsTarget && (failedFlag || projectFlag !== undefined)) {
    throw new StepcastError(
      '--failed и --project снимают записи хранилища расхода и действуют только вместе с --stats',
      { hint: 'За один вызов gc снимает либо файлы (--older-than), либо записи (--stats) — не то и другое сразу' },
    );
  }

  if (statsTarget) return runGcStats(runsRoot, projectRoot, args, write);

  const candidates = listCandidates(runsRoot, projectRoot);
  const olderThan = args.flags['older-than'] as string | undefined;

  if (olderThan === undefined) {
    backfillUsageStore(runsRoot);
    const key = projectKey(projectRoot);
    const { records, corrupted } = readUsageStore(runsRoot);
    const recordCount = [...records.values()].filter((record) => record.project.key === key).length;

    if (candidates.length === 0 && recordCount === 0) {
      write('прогонов ещё не было, убирать нечего');
      return ExitCode.ok;
    }

    if (candidates.length > 0) {
      const rows = candidates.map((candidate) => [
        `  ${shortRunId(candidate.runId)}`,
        candidate.endedAt,
        formatBytes(candidate.sizeBytes),
      ]);
      for (const line of formatColumns(rows)) write(line);

      const total = candidates.reduce((sum, candidate) => sum + candidate.sizeBytes, 0);
      write(`итого: ${formatBytes(total)}, прогонов ${candidates.length}`);
    } else {
      write('каталогов прогонов нет');
    }

    write(`записей хранилища расхода: ${recordCount}` + (corrupted > 0 ? `, испорченных строк: ${corrupted}` : ''));
    write(HINT_REMOVE_FILES);
    write(HINT_REMOVE_STATS);
    return ExitCode.ok;
  }

  if (candidates.length === 0) {
    write('прогонов ещё не было, убирать нечего');
    return ExitCode.ok;
  }

  const thresholdMs = parseDuration(olderThan, '--older-than');
  const selected = selectOlderThan(candidates, thresholdMs);

  if (selected.length === 0) {
    write('нет прогонов старше указанного порога');
    return ExitCode.ok;
  }

  let freed = 0;
  for (const candidate of selected) {
    const result = cleanupRun(candidate.paths);
    freed += candidate.sizeBytes;
    write(`удалён: ${shortRunId(candidate.runId)} (${formatBytes(candidate.sizeBytes)})`);
    for (const item of result.unresolvedWorktrees) {
      write(`  не снята запись рабочего дерева: ${item}`);
    }
    for (const item of result.preservedWorkspaces) {
      write(`  каталог сохранён ради продолжения прогоном ${shortRunId(item.adoptedBy)}: ${item.path}`);
    }
  }
  write(`освобождено: ${formatBytes(freed)}, прогонов ${selected.length}`);
  return ExitCode.ok;
}
