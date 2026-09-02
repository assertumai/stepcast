import { resolve as resolvePath } from 'node:path';

import { resolveConfig, type Config } from '../../core/config/resolve.js';
import type { Registry } from '../../core/plugins/registry.js';
import { ExitCode, isStepcastError, type ExitCodeValue } from '../../core/errors.js';
import { findProjectRoot, projectKey, runPaths, shortRunId } from '../../core/journal/paths.js';
import { readStatus } from '../../core/journal/reader.js';
import type { Event } from '../../core/journal/schema.js';
import { hasErrors, lintPipeline } from '../../core/lint.js';
import { expandPipeline } from '../../core/pipeline/expand.js';
import { runPipeline } from '../../core/run/runner.js';
import type { UsageSnapshot } from '../../core/budget/accumulator.js';
import { renderProgressLine } from '../progress.js';
import { formatDiagnostic } from './lint.js';
import type { ParsedArgs } from '../args.js';

export async function runRunCommand(
  args: ParsedArgs,
  write: (line: string) => void,
  cwd: string,
  registry?: Registry,
): Promise<ExitCodeValue> {
  const target = args.positional[0] ?? 'stepcast.yml';
  const pipelinePath = resolvePath(cwd, target);
  const { config } = resolveConfig({ cwd });
  const inputs = (args.flags.input as Record<string, string> | undefined) ?? {};

  const expanded = expandPipeline({ pipelinePath, config, inputs, ...(registry === undefined ? {} : { registry }) });

  // Проверка перед запуском бесплатна по сравнению с прогоном, поэтому она
  // безусловна: ловить структурную ошибку после первого агентского шага
  // означает платить за неё токенами.
  const diagnostics = lintPipeline(expanded, { config, cwd, ...(registry === undefined ? {} : { registry }) });
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

  const projectRoot = findProjectRoot(cwd);
  const onEvent = args.flags.quiet === true ? undefined : buildProgressObserver(config, projectRoot, write);

  try {
    const result = await runPipeline({
      expanded,
      config,
      projectRoot,
      cwd,
      ...(registry === undefined ? {} : { registry }),
      signal: controller.signal,
      ...(onEvent === undefined ? {} : { onEvent }),
    });

    const runId = shortRunId(result.journal.paths.runId);
    write(`прогон ${runId}: ${result.status}`);
    write(`журнал: ${result.journal.paths.dir}`);

    if (result.costLimitUnapplied) {
      write(
        'предупреждение: денежный потолок объявлен, но ни одна попытка не сообщила цены — потолок не применялся',
      );
    }

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

/**
 * Наблюдатель ленты хода прогона: по `run.started` первыми строками печатает
 * идентификатор прогона и путь к каталогу журнала — до того, как исполнится
 * хоть одна работа, — затем по одной строке на печатаемое событие.
 *
 * Время строки считается от `run.started` по меткам времени самих событий, а
 * не через `usage.elapsedMs()` снимка: тот вычитает сон и после
 * `budget.waiting` пошёл бы назад.
 */
function buildProgressObserver(
  config: Config,
  projectRoot: string,
  write: (line: string) => void,
): (event: Event, usage: UsageSnapshot) => void {
  let startedAtMs: number | undefined;
  return (event, usage) => {
    if (event.kind === 'run.started') {
      startedAtMs = Date.parse(event.ts);
      const paths = runPaths(config.runs.root, projectKey(projectRoot), event.run_id);
      write(`прогон ${shortRunId(event.run_id)}`);
      write(`журнал: ${paths.dir}`);
    }
    const elapsedMs = startedAtMs === undefined ? 0 : Date.parse(event.ts) - startedAtMs;
    const rendered = renderProgressLine(event, usage, elapsedMs);
    if (rendered !== undefined) write(rendered);
  };
}
