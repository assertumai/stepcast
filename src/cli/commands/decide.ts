import { resolveConfig, type Config } from '../../core/config/resolve.js';
import type { Registry } from '../../core/plugins/registry.js';
import { ExitCode, isStepcastError, StepcastError, type ExitCodeValue } from '../../core/errors.js';
import { findProjectRoot, shortRunId } from '../../core/journal/paths.js';
import { isRunAlive, readManifest, readStatus, resolveRun } from '../../core/journal/reader.js';
import { writeDecisionRecord } from '../../core/journal/writer.js';
import { expandPipeline } from '../../core/pipeline/expand.js';
import { pipelineStepAddresses, selectAwaiting, validateDecision } from '../../core/run/decision.js';
import { formatDiagnostic } from './lint.js';
import type { ParsedArgs } from '../args.js';

/**
 * `stepcast decide` — единственный писатель решения (design.md изменения
 * `user-decision-steps`, решение 5): пишет `decisions/<wait_id>.json`
 * атомарной заменой, а ждущий процесс опрашивает этот каталог. Проверки —
 * общие с демоном и с движком (`core/run/decision.ts`), чтобы обе дороги к
 * решению соглашались, что оно допустимо.
 *
 * Конфигурация — из окружения команды, см. комментарий у `runRunCommand`.
 */
export async function runDecideCommand(
  args: ParsedArgs,
  write: (line: string) => void,
  cwd: string,
  registry?: Registry,
  resolvedConfig?: Config,
): Promise<ExitCodeValue> {
  const config = resolvedConfig ?? resolveConfig({ cwd }).config;
  const projectRoot = findProjectRoot(cwd);

  try {
    const paths = resolveRun(config.runs.root, projectRoot, args.positional[0]);
    const status = readStatus(paths);
    const outcome = args.positional[1];
    if (outcome === undefined) {
      throw new StepcastError('Не назван исход: stepcast decide <run> <исход>');
    }

    const step = typeof args.flags.step === 'string' ? args.flags.step : undefined;
    const reason = typeof args.flags.reason === 'string' ? args.flags.reason : undefined;
    const from = typeof args.flags.from === 'string' ? args.flags.from : undefined;

    const awaiting = selectAwaiting(status.awaiting ?? [], step);

    const manifest = readManifest(paths);
    const expanded = expandPipeline({
      pipelinePath: manifest.pipeline_file,
      config,
      inputs: Object.fromEntries(Object.entries(manifest.inputs).map(([name, value]) => [name, String(value)])),
      ...(registry === undefined ? {} : { registry }),
    });
    const knownSteps = pipelineStepAddresses(expanded.pipeline);

    const validated = validateDecision(
      awaiting,
      { outcome, ...(reason === undefined ? {} : { reason }), ...(from === undefined ? {} : { restartFrom: from }) },
      knownSteps,
    );

    writeDecisionRecord(paths, awaiting.wait_id, {
      outcome: validated.outcome,
      ...(validated.reason === undefined ? {} : { reason: validated.reason }),
      ...(validated.restartFrom === undefined ? {} : { restart_from: validated.restartFrom }),
    });

    write(`решение записано: ${awaiting.job}/${awaiting.step} → ${validated.outcome} (${validated.effect})`);

    if (!isRunAlive(paths)) {
      write(
        `прогон ${shortRunId(paths.runId)} не идёт — решение применится при возобновлении: stepcast resume ${shortRunId(paths.runId)} --from ${awaiting.job}/${awaiting.step}`,
      );
    }

    return ExitCode.ok;
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
