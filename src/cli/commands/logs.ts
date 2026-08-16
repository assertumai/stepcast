import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveConfig } from '../../core/config/resolve.js';
import { findProjectRoot } from '../../core/journal/paths.js';
import { findStepDir, follow, resolveRun } from '../../core/journal/reader.js';
import { ExitCode, ScarpError, type ExitCodeValue } from '../../core/errors.js';
import type { ParsedArgs } from '../args.js';

/**
 * Логи шага или поток событий прогона.
 *
 * Без `--follow` печатается то, что уже записано; с ним вывод продолжает
 * появляться по мере работы. Девяностоминутный прогон без живого вывода — это
 * про «непонятно, работает ли оно вообще».
 */
export async function runLogsCommand(
  args: ParsedArgs,
  write: (line: string) => void,
  cwd: string,
): Promise<ExitCodeValue> {
  const { config } = resolveConfig({ cwd });
  const projectRoot = findProjectRoot(cwd);
  const paths = resolveRun(config.runs.root, projectRoot, args.positional[0]);
  const target = args.positional[1];

  const files = target === undefined ? [paths.events] : stepLogFiles(paths, target);

  if (args.flags.follow === true) {
    const first = files[0];
    if (first === undefined) return ExitCode.ok;
    for await (const line of follow(first)) write(line);
    return ExitCode.ok;
  }

  for (const file of files) {
    if (!existsSync(file)) continue;
    const content = readFileSync(file, 'utf8');
    if (content === '') continue;
    if (files.length > 1) write(`--- ${file} ---`);
    for (const line of content.replace(/\n$/, '').split('\n')) write(line);
  }

  return ExitCode.ok;
}

function stepLogFiles(paths: ReturnType<typeof resolveRun>, target: string): string[] {
  const separator = target.indexOf('/');
  if (separator === -1) {
    throw new ScarpError(`Шаг адресуется как <работа>/<шаг>, получено ${target}`, {
      hint: 'Например: implement/write-code',
    });
  }

  const jobId = target.slice(0, separator);
  const stepId = target.slice(separator + 1);
  const dir = findStepDir(paths, jobId, stepId);

  if (dir === undefined) {
    throw new ScarpError(`Шаг ${target} в прогоне не найден`, { file: paths.dir });
  }

  return [join(dir, 'stdout.log'), join(dir, 'stderr.log')];
}
