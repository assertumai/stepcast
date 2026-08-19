import { createHash } from 'node:crypto';

import { createAnchorer, detectAnchorKind, manifestStore } from '../../core/anchor/index.js';
import { resolveConfig } from '../../core/config/resolve.js';
import { ExitCode, isStepcastError, type ExitCodeValue } from '../../core/errors.js';
import { findProjectRoot, shortRunId } from '../../core/journal/paths.js';
import { resolveRun } from '../../core/journal/reader.js';
import { expandPipeline } from '../../core/pipeline/expand.js';
import { serializeLock } from '../../core/pipeline/lock.js';
import {
  buildResumePlan,
  changedSince,
  describePlan,
  finalAnchorOf,
  producedBy,
  parseFrom,
  readSourceRun,
} from '../../core/run/resumePlan.js';
import { runPipeline } from '../../core/run/runner.js';
import { StepcastError } from '../../core/errors.js';
import { formatDiagnostic } from './lint.js';
import type { ParsedArgs } from '../args.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    const inputs: Record<string, string> = {};
    for (const [name, value] of Object.entries(source.manifest.inputs)) inputs[name] = String(value);
    for (const [name, value] of Object.entries(overrides)) inputs[name] = value;

    const expanded = expandPipeline({
      pipelinePath: source.manifest.pipeline_file,
      config,
      inputs,
    });

    const from = typeof args.flags.from === 'string' ? parseFrom(args.flags.from) : undefined;
    if (from?.step !== undefined) {
      const job = expanded.pipeline.jobs.find((item) => item.id === from.job);
      if (job !== undefined && job.session === 'shared') {
        throw new StepcastError(
          `Работа ${job.id} объявляет session: shared — возобновление с отдельного шага невозможно`,
          {
            hint: `Результат шага зависит от диалога, которого при частичном повторе нет. Укажите --from ${job.id}`,
          },
        );
      }
    }

    const lockHash = createHash('sha256')
      .update(serializeLock(expanded.pipeline))
      .digest('hex')
      .slice(0, 16);

    // Что пользователь тронул с момента окончания прошлого прогона — это и
    // есть основание для решения о валидности каждого шага.
    const anchorKind = detectAnchorKind(cwd);
    const stateDir = mkdtempSync(join(tmpdir(), 'stepcast-plan-'));
    const anchorer = createAnchorer({
      dir: cwd,
      stateDir,
      kind: anchorKind,
      scope: 'plan',
      readStores: [manifestStore(source.paths.anchors)],
    });
    let changed;
    try {
      changed = changedSince(anchorer, finalAnchorOf(source.status, anchorKind), anchorer.capture());
    } catch {
      changed = 'all' as const;
    }

    const plan = buildResumePlan({
      expanded,
      config,
      source,
      lockHash,
      changed,
      producedPaths: (step) => producedBy(anchorer, step),
      ...(from === undefined ? {} : { from }),
    });

    // Якорь нужен плану для вычисления произведённых путей, поэтому
    // освобождается только теперь.
    anchorer.dispose();

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
