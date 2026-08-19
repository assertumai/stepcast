import { resolveConfig } from '../../core/config/resolve.js';
import { ExitCode, type ExitCodeValue } from '../../core/errors.js';
import { findProjectRoot } from '../../core/journal/paths.js';
import { resolveRun } from '../../core/journal/reader.js';
import { applyRun } from '../../core/run/apply.js';
import type { ParsedArgs } from '../args.js';

export function runApplyCommand(
  args: ParsedArgs,
  write: (line: string) => void,
  cwd: string,
): ExitCodeValue {
  const { config } = resolveConfig({ cwd });
  const projectRoot = findProjectRoot(cwd);
  const paths = resolveRun(config.runs.root, projectRoot, args.positional[0]);

  const outcome = applyRun({
    paths,
    cwd,
    ...(typeof args.flags.job === 'string' ? { job: args.flags.job } : {}),
  });

  switch (outcome.kind) {
    case 'already-in-place':
      write('прогон исполнялся в каталоге запуска: результат уже на месте, ничего не изменено');
      return ExitCode.ok;
    case 'nothing-to-apply':
      write('изолированные работы дерево не изменили: накладывать нечего');
      return ExitCode.ok;
    case 'applied':
      write(`наложено: ${outcome.jobs.join(', ')}`);
      return ExitCode.ok;
  }
}
