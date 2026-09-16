import { expandPipeline } from '../document/expand.js';
import { hasErrors, lintPipeline, type Diagnostic } from '../domain/lint.js';
import { resolveConfig, type Config } from '../config/resolve.js';
import type { Registry } from '../../../kernel/registry.js';
import { ExitCode, isStepcastError, type ExitCodeValue } from '../../../kernel/errors.js';
import { resolvePipelineTarget } from '../domain/package-schema.js';
import type { PipelineCommandEnv } from '../contract.js';
import { commandRow } from '../../../kernel/cli/commandRow.js';
import { PIPELINE_SERVICES } from '../services.js';
import type { ParsedArgs } from '../../../kernel/cli/args.js';

export function formatDiagnostic(diagnostic: Diagnostic): string[] {
  const label = diagnostic.severity === 'error' ? 'ошибка' : 'предупреждение';
  const lines = [`${label}: ${diagnostic.message}`];
  const location = [diagnostic.file, diagnostic.at].filter((part) => part !== undefined).join(': ');
  if (location !== '') lines.push(`  где: ${location}`);
  if (diagnostic.hint !== undefined) lines.push(`  ${diagnostic.hint}`);
  return lines;
}

/**
 * Конфигурация приходит из окружения команды, когда точка входа уже разрешила
 * её вместе с плагинами: повторный `resolveConfig({ cwd })` терял бы слой
 * умолчаний плагинных бэкендов, и `backends.<имя>` плагина не существовало бы
 * для команды, хотя `stepcast config` его показывает. Без `config` (прямой
 * вызов из тестов) команда разрешает конфигурацию сама, как прежде.
 */
export function runLintCommand(
  args: ParsedArgs,
  write: (line: string) => void,
  cwd: string,
  registry?: Registry,
  resolvedConfig?: Config,
): ExitCodeValue {
  const target = args.positional[0] ?? 'stepcast.yml';
  const { pipelinePath, isSupplyPipeline } = resolvePipelineTarget(cwd, target);
  const config = resolvedConfig ?? resolveConfig({ cwd }).config;

  const inputs = (args.flags.input as Record<string, string> | undefined) ?? {};

  let expanded;
  try {
    expanded = expandPipeline({
      pipelinePath,
      config,
      inputs,
      ...(registry === undefined ? {} : { registry }),
      ...(isSupplyPipeline ? { projectRoot: cwd } : {}),
    });
  } catch (error) {
    // Без раскрытия проверять нечего, поэтому такая ошибка одна и фатальна.
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
    return ExitCode.configError;
  }

  const diagnostics = lintPipeline(expanded, { config, cwd, ...(registry === undefined ? {} : { registry }) });

  for (const diagnostic of diagnostics) {
    for (const line of formatDiagnostic(diagnostic)) write(line);
  }

  const errors = diagnostics.filter((item) => item.severity === 'error').length;
  const warnings = diagnostics.length - errors;

  if (hasErrors(diagnostics)) {
    write(`${target}: ошибок ${errors}, предупреждений ${warnings}`);
    return ExitCode.configError;
  }

  write(warnings === 0 ? `ok: ${target}` : `ok: ${target} (предупреждений ${warnings})`);
  return ExitCode.ok;
}

export const row = commandRow<PipelineCommandEnv>(
  {
    name: 'lint',
    spec: {
      description: 'статически проверить пайплайн, ничего не запуская',
      positional: ['pipeline'],
      flags: {
        input: { kind: 'keyValue', description: 'значение входа пайплайна: --input имя=значение' },
      },
    },
    run: (args, io, env) => runLintCommand(args, io.out, env.cwd, env.registry, env.config),
  },
  { inject: PIPELINE_SERVICES },
);
