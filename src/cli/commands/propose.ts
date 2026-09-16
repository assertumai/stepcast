import { readFileSync } from 'node:fs';
import { basename, dirname, resolve as resolvePath } from 'node:path';

import { resolveConfig } from '../../core/config/resolve.js';
import { ExitCode, isStepcastError, StepcastError, type ExitCodeValue } from '../../core/errors.js';
import { findProjectRoot, runPaths } from '../../core/journal/paths.js';
import { readManifest } from '../../core/journal/reader.js';
import type { PipelineCommandEnv } from '../../core/plugins/pipeline-contract.js';
import type { ProposalOrigin } from '../../core/proposals/entry.js';
import { proposeEntry, writeProposalTargetDirect } from '../../core/proposals/store.js';
import { commandRow, PIPELINE_SERVICES } from '../commandRow.js';
import { formatDiagnostic } from './lint.js';
import type { ParsedArgs } from '../args.js';

/**
 * `stepcast propose <цель> --from <файл>` — единственный писатель очереди
 * предложений (`ui-proposals`, design.md Решение 2, 4, 7), тем же приёмом,
 * каким `stepcast decide` — единственный писатель решения. Пайплайн зовёт её
 * командным шагом через `$STEPCAST_BIN`, агент — из своего `Bash`, если шаг
 * это право ему дал.
 */

function stringFlag(flags: ParsedArgs['flags'], name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Содержимое предложения: файл, названный `--from`, либо стандартный ввод.
 * Оба источника пустыми — отказ с названной причиной, очередь не меняется.
 */
async function resolveContent(
  cwd: string,
  fromFlag: string | undefined,
  readStdin: (() => Promise<string>) | undefined,
): Promise<string> {
  if (fromFlag !== undefined) {
    const path = resolvePath(cwd, fromFlag);
    try {
      return readFileSync(path, 'utf8');
    } catch (error) {
      throw new StepcastError(`Файл содержимого не читается: ${path}: ${(error as Error).message}`, {
        file: path,
        cause: error,
      });
    }
  }

  const text = (await readStdin?.()) ?? '';
  if (text === '') {
    throw new StepcastError('Содержимого нет: назовите файл --from <файл> либо подайте его на стандартный ввод', {
      hint: 'stepcast propose <цель> --from <файл> — или конвейером на стандартный ввод',
    });
  }
  return text;
}

/** Происхождение из окружения шага — пусто, если команда вызвана руками, вне прогона. */
function originFromEnv(): ProposalOrigin {
  const run = process.env['STEPCAST_RUN_ID'];
  const job = process.env['STEPCAST_JOB'];
  const step = process.env['STEPCAST_STEP'];
  return {
    ...(run === undefined ? {} : { run }),
    ...(job === undefined ? {} : { job }),
    ...(step === undefined ? {} : { step }),
  };
}

/**
 * Проект, чья очередь принимает предложение (`ui-proposals`, Решение 4):
 * внутри шага — по каталогу прогона (`STEPCAST_RUN_DIR`) и манифесту, который
 * несёт настоящий корень проекта независимо от режима рабочей директории
 * шага (`worktree`/`copy` работают во временном дереве, которое снимет
 * уборка прогона); вне прогона — каталог запуска, как у любой другой команды.
 */
function resolveProjectRoot(cwd: string): string {
  const runDir = process.env['STEPCAST_RUN_DIR'];
  if (runDir === undefined || runDir.trim() === '') return findProjectRoot(cwd);

  const runId = basename(runDir);
  const projectDir = dirname(runDir);
  const key = basename(projectDir);
  const runsRoot = dirname(projectDir);
  const manifest = readManifest(runPaths(runsRoot, key, runId));
  return manifest.project_root;
}

export async function runProposeCommand(
  args: ParsedArgs,
  write: (line: string) => void,
  cwd: string,
  readStdin?: () => Promise<string>,
): Promise<ExitCodeValue> {
  try {
    const target = args.positional[0];
    if (target === undefined) {
      throw new StepcastError('Не названа цель: stepcast propose <цель> --from <файл>');
    }

    const content = await resolveContent(cwd, stringFlag(args.flags, 'from'), readStdin);
    const reason = stringFlag(args.flags, 'reason');
    const origin = originFromEnv();
    const projectRoot = resolveProjectRoot(cwd);
    const { config } = resolveConfig({ cwd: projectRoot });

    if (config.project.proposals === 'direct') {
      const path = writeProposalTargetDirect(projectRoot, target, content);
      write(`записан ${path}`);
      return ExitCode.ok;
    }

    const record = proposeEntry(projectRoot, {
      target,
      content,
      ...(reason === undefined ? {} : { reason }),
      origin,
    });
    write(`предложение поставлено в очередь: ${record.id} (${record.target})`);
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

/**
 * Встроенная команда, тем же приёмом, что `decide` (`ui-proposals`,
 * design.md изменения `agent-edits-widgets`, Решение 2): единственный
 * писатель очереди читает `STEPCAST_RUN_DIR`/`STEPCAST_JOB`/`STEPCAST_STEP`
 * из окружения шага напрямую, публиковать их плагинам ради одной команды
 * незачем.
 */
export const row = commandRow<PipelineCommandEnv>(
  {
    name: 'propose',
    spec: {
      description:
        'предложить правку файла кабинета проекта: stepcast propose <цель> --from <файл> — единственный писатель очереди',
      positional: ['target'],
      flags: {
        from: { kind: 'string', description: 'файл с содержимым предложения — без него читается стандартный ввод' },
        reason: { kind: 'string', description: 'причина предложения, необязательна' },
      },
    },
    run: (args, io) => runProposeCommand(args, io.out, io.cwd, io.readStdin),
  },
  { inject: PIPELINE_SERVICES },
);
