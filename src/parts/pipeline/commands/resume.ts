import { resolveConfig, type Config } from '../config/resolve.js';
import type { Registry } from '../../../kernel/registry.js';
import { ExitCode, isStepcastError, type ExitCodeValue } from '../../../kernel/errors.js';
import { findProjectRoot, shortRunId, type RunPaths } from '../run/journal/paths.js';
import type { PipelineCommandEnv } from '../contract.js';
import { resolveRun } from '../run/journal/reader.js';
import { describePlan, planResume, readSourceRun } from '../run/resumePlan.js';
import { runPipeline } from '../run/runner.js';
import { commandRow } from '../../../kernel/cli/commandRow.js';
import { PIPELINE_SERVICES } from '../services.js';
import { formatDiagnostic } from './lint.js';
import type { ParsedArgs } from '../../../kernel/cli/args.js';

/**
 * Продолжить цепочку по просьбе о перезапуске (design.md изменения
 * `user-decision-steps`, решение 4): прогон, законченный исходом `restart`,
 * возобновляется с названного места в том же процессе — цепочку ведёт
 * команда, а не `runPipeline`, поэтому прогон, запущенный кнопкой витрины
 * отсоединённым процессом, продолжает себя сам, без участия демона.
 *
 * Предела цепочке нет намеренно: каждое звено стоит собственного решения
 * человека, а единственный путь к самозацикливанию без него — `restart`
 * исходом по истечении срока — закрыт линтом вклада `decision` (design.md,
 * решение 7).
 */
export async function continueRestartChain(
  from: string,
  sourcePaths: RunPaths,
  config: Config,
  cwd: string,
  write: (line: string) => void,
  registry?: Registry,
  /**
   * Сигнал отмены команды — тот же, что получил первый прогон цепочки. Без
   * него звено цепочки Ctrl-C не отменял бы вовсе: обработчик команды взводит
   * контроллер, а слушать его в звене было бы некому — особенно заметно на
   * звене, стоящем на шаге решения, которое ждёт бессрочно.
   */
  signal?: AbortSignal,
): Promise<ExitCodeValue> {
  const projectRoot = findProjectRoot(cwd);
  const source = readSourceRun(sourcePaths);

  const { expanded, plan } = planResume({
    cwd,
    config,
    source,
    from,
    ...(registry === undefined ? {} : { registry }),
  });
  for (const line of describePlan(plan)) write(line);

  const result = await runPipeline({
    expanded,
    config,
    projectRoot,
    cwd,
    ...(registry === undefined ? {} : { registry }),
    ...(signal === undefined ? {} : { signal }),
    resume: { plan, source },
  });

  write(`прогон ${shortRunId(result.journal.paths.runId)}: ${result.status}`);
  write(`журнал: ${result.journal.paths.dir}`);

  if (result.restart !== undefined) {
    return continueRestartChain(result.restart.from, result.journal.paths, config, cwd, write, registry, signal);
  }
  return result.exitCode;
}

/** Конфигурация — из окружения команды, см. комментарий у `runRunCommand`. */
export async function runResumeCommand(
  args: ParsedArgs,
  write: (line: string) => void,
  cwd: string,
  registry?: Registry,
  resolvedConfig?: Config,
): Promise<ExitCodeValue> {
  const config = resolvedConfig ?? resolveConfig({ cwd }).config;
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
      ...(registry === undefined ? {} : { registry }),
    });

    for (const line of describePlan(plan)) write(line);

    if (args.flags['dry-run'] === true) {
      write('пробный запуск: ничего не исполнено, прогон не создан');
      return ExitCode.ok;
    }

    // Отмена — тем же приёмом, что у `stepcast run`: возобновлённый прогон
    // останавливается на шаге решения так же, как первый, и выйти из него
    // Ctrl-C обязан так же.
    const controller = new AbortController();
    const onSignal = (): void => controller.abort();
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    try {
      const result = await runPipeline({
        expanded,
        config,
        projectRoot,
        cwd,
        ...(registry === undefined ? {} : { registry }),
        signal: controller.signal,
        resume: { plan, source },
      });

      write(`прогон ${shortRunId(result.journal.paths.runId)}: ${result.status}`);
      write(`журнал: ${result.journal.paths.dir}`);

      if (result.restart !== undefined) {
        return continueRestartChain(
          result.restart.from,
          result.journal.paths,
          config,
          cwd,
          write,
          registry,
          controller.signal,
        );
      }
      return result.exitCode;
    } finally {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
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

export const row = commandRow<PipelineCommandEnv>(
  {
    name: 'resume',
    spec: {
      description: 'возобновить прогон, переиспользовав шаги с совпавшим ключом',
      positional: ['run'],
      flags: {
        from: { kind: 'string', description: 'начать заново с работы или шага: --from job[/step]' },
        set: { kind: 'keyValue', description: 'переопределить вход: --set имя=значение' },
        'dry-run': { kind: 'boolean', description: 'показать план, ничего не исполняя' },
      },
    },
    run: (args, io, env) => runResumeCommand(args, io.out, env.cwd, env.registry, env.config),
  },
  { inject: PIPELINE_SERVICES },
);
