import { resolveConfig } from '../../core/config/resolve.js';
import { findProjectRoot, shortRunId } from '../../core/journal/paths.js';
import { cleanupRun, listCandidates, selectOlderThan } from '../../core/run/cleanup.js';
import { formatBytes, parseDuration } from '../../core/units.js';
import { ExitCode, type ExitCodeValue } from '../../core/errors.js';
import { formatColumns } from '../output.js';
import type { ParsedArgs } from '../args.js';

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
  const candidates = listCandidates(config.runs.root, projectRoot);

  if (candidates.length === 0) {
    write('прогонов ещё не было, убирать нечего');
    return ExitCode.ok;
  }

  const olderThan = args.flags['older-than'] as string | undefined;

  if (olderThan === undefined) {
    const rows = candidates.map((candidate) => [
      `  ${shortRunId(candidate.runId)}`,
      candidate.endedAt,
      formatBytes(candidate.sizeBytes),
    ]);
    for (const line of formatColumns(rows)) write(line);

    const total = candidates.reduce((sum, candidate) => sum + candidate.sizeBytes, 0);
    write(`итого: ${formatBytes(total)}, прогонов ${candidates.length}`);
    write('удаление: stepcast gc --older-than <длительность>, например 30d');
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
    cleanupRun(candidate.paths);
    freed += candidate.sizeBytes;
    write(`удалён: ${shortRunId(candidate.runId)} (${formatBytes(candidate.sizeBytes)})`);
  }
  write(`освобождено: ${formatBytes(freed)}, прогонов ${selected.length}`);
  return ExitCode.ok;
}
