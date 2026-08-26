import { resolveConfig } from '../../core/config/resolve.js';
import { ExitCode, isStepcastError, type ExitCodeValue } from '../../core/errors.js';
import { findProjectRoot, shortRunId } from '../../core/journal/paths.js';
import { resolveRun } from '../../core/journal/reader.js';
import { describePlan, planResume, readSourceRun } from '../../core/run/resumePlan.js';
import { runPipeline } from '../../core/run/runner.js';
import { formatDiagnostic } from './lint.js';
import type { ParsedArgs } from '../args.js';

export async function runResumeCommand(
  args: ParsedArgs,
  write: (line: string) => void,
  cwd: string,
): Promise<ExitCodeValue> {
  const { config } = resolveConfig({ cwd });
  const projectRoot = findProjectRoot(cwd);

  try {
    const sourcePaths = resolveRun(config.runs.root, projectRoot, args.positional[0]);
    const source = readSourceRun(sourcePaths);

    // Входы берутся из исходного прогона; `--set` их переопределяет и тем
    // самым меняет ключи всех зависящих шагов.
    const overrides = (args.flags.set as Record<string, string> | undefined) ?? {};
    const from = typeof args.flags.from === 'string' ? args.flags.from : undefined;

    const { expanded, plan } = planResume({
      cwd,
      config,
      source,
      overrides,
      ...(from === undefined ? {} : { from }),
    });

    for (const line of describePlan(plan)) write(line);

    if (args.flags['dry-run'] === true) {
      write('пробный запуск: ничего не исполнено, прогон не создан');
      return ExitCode.ok;
    }

    const result = await runPipeline({
      expanded,
      config,
      projectRoot,
      cwd,
      resume: { plan, source },
    });

    write(`прогон ${shortRunId(result.journal.paths.runId)}: ${result.status}`);
    write(`журнал: ${result.journal.paths.dir}`);
    return result.exitCode;
  } catch (error) {
    if (!isStepcastError(error)) throw error;
    for (const line of formatDiagnostic({
      severity: 'error',
      message: error.message,
      ...(error.file === undefined ? {} : { file: error.file }),
      ...(error.at === undefined ? {} : { at: error.at }),
      ...(error.hint === undefined ? {} : { hint: error.hint }),
    })) {
      write(line);
    }
    return error.exitCode;
  }
}
