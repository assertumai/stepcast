import { resolve as resolvePath } from 'node:path';

import { expandPipeline } from '../../core/pipeline/expand.js';
import { hasErrors, lintPipeline, type Diagnostic } from '../../core/lint.js';
import { resolveConfig } from '../../core/config/resolve.js';
import { ExitCode, isStepcastError, type ExitCodeValue } from '../../core/errors.js';
import type { ParsedArgs } from '../args.js';

export function formatDiagnostic(diagnostic: Diagnostic): string[] {
  const label = diagnostic.severity === 'error' ? 'ошибка' : 'предупреждение';
  const lines = [`${label}: ${diagnostic.message}`];
  const location = [diagnostic.file, diagnostic.at].filter((part) => part !== undefined).join(': ');
  if (location !== '') lines.push(`  где: ${location}`);
  if (diagnostic.hint !== undefined) lines.push(`  ${diagnostic.hint}`);
  return lines;
}

export function runLintCommand(
  args: ParsedArgs,
  write: (line: string) => void,
  cwd: string,
): ExitCodeValue {
  const target = args.positional[0] ?? 'stepcast.yml';
  const pipelinePath = resolvePath(cwd, target);
  const { config } = resolveConfig({ cwd });

  const inputs = (args.flags.input as Record<string, string> | undefined) ?? {};

  let expanded;
  try {
    expanded = expandPipeline({ pipelinePath, config, inputs });
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

  const diagnostics = lintPipeline(expanded, { config });

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
