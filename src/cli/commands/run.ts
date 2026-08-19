import { resolve as resolvePath } from 'node:path';

import { resolveConfig } from '../../core/config/resolve.js';
import { ExitCode, isStepcastError, type ExitCodeValue } from '../../core/errors.js';
import { findProjectRoot } from '../../core/journal/paths.js';
import { shortRunId } from '../../core/journal/paths.js';
import { readStatus } from '../../core/journal/reader.js';
import { hasErrors, lintPipeline } from '../../core/lint.js';
import { expandPipeline } from '../../core/pipeline/expand.js';
import { runPipeline } from '../../core/run/runner.js';
import { formatDiagnostic } from './lint.js';
import type { ParsedArgs } from '../args.js';

export async function runRunCommand(
  args: ParsedArgs,
  write: (line: string) => void,
  cwd: string,
): Promise<ExitCodeValue> {
  const target = args.positional[0] ?? 'stepcast.yml';
  const pipelinePath = resolvePath(cwd, target);
  const { config } = resolveConfig({ cwd });
  const inputs = (args.flags.input as Record<string, string> | undefined) ?? {};

  const expanded = expandPipeline({ pipelinePath, config, inputs });

  // Проверка перед запуском бесплатна по сравнению с прогоном, поэтому она
  // безусловна: ловить структурную ошибку после первого агентского шага
  // означает платить за неё токенами.
  const diagnostics = lintPipeline(expanded, { config });
  for (const diagnostic of diagnostics) {
    for (const line of formatDiagnostic(diagnostic)) write(line);
  }
  if (hasErrors(diagnostics)) return ExitCode.configError;

  if (args.flags['dry-run'] === true) {
    write(`ok: ${target} — проверка пройдена, прогон не запускался`);
    return ExitCode.ok;
  }

  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    const result = await runPipeline({
      expanded,
      config,
      projectRoot: findProjectRoot(cwd),
      cwd,
      signal: controller.signal,
    });

    const runId = shortRunId(result.journal.paths.runId);
    write(`прогон ${runId}: ${result.status}`);
    write(`журнал: ${result.journal.paths.dir}`);

    // В изолированном режиме результат остался в стороне. Молча закончить —
    // значит оставить пользователя гадать, где его работа.
    const isolated = readStatus(result.journal.paths).jobs.filter(
      (job) => job.workspace !== undefined && job.workspace.mode !== 'cwd',
    );
    if (isolated.length > 0) {
      write('рабочие деревья:');
      for (const job of isolated) {
        write(`  ${job.id} (${job.workspace?.mode}): ${job.workspace?.path}`);
      }
      write(`наложить результат на текущее дерево: stepcast apply ${runId}`);
    }

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
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}
