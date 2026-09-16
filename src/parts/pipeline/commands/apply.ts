import { resolveConfig } from '../config/resolve.js';
import { ExitCode, StepcastError, type ExitCodeValue } from '../../../kernel/errors.js';
import { findProjectRoot } from '../run/journal/paths.js';
import { resolveRun } from '../run/journal/reader.js';
import { applyRun } from '../run/apply.js';
import { commandRow } from '../../../kernel/cli/commandRow.js';
import { PIPELINE_SERVICES } from '../services.js';
import type { ParsedArgs } from '../../../kernel/cli/args.js';

export function runApplyCommand(
  args: ParsedArgs,
  write: (line: string) => void,
  cwd: string,
): ExitCodeValue {
  const { config } = resolveConfig({ cwd });
  const projectRoot = findProjectRoot(cwd);
  const paths = resolveRun(config.runs.root, projectRoot, args.positional[0]);

  if (typeof args.flags.job === 'string' && typeof args.flags.lane === 'string') {
    throw new StepcastError('--job и --lane взаимоисключимы', {
      hint: 'Укажите либо конкретную работу, либо целую дорожку',
    });
  }

  const outcome = applyRun({
    paths,
    cwd,
    ...(typeof args.flags.job === 'string' ? { job: args.flags.job } : {}),
    ...(typeof args.flags.lane === 'string' ? { lane: args.flags.lane } : {}),
    ...(args.flags.force === true ? { force: true } : {}),
    ...(config.project.nestedRepos === undefined ? {} : { nestedRepos: config.project.nestedRepos }),
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

export const row = commandRow(
  {
    name: 'apply',
    spec: {
      description: 'наложить результат изолированного прогона на текущее дерево',
      positional: ['run'],
      flags: {
        job: { kind: 'string', description: 'наложить только результат этой работы' },
        lane: { kind: 'string', description: 'наложить только результат этой дорожки, одним диффом' },
        force: {
          kind: 'boolean',
          description: 'снять отказ в повторном наложении дорожки, чей записанный исход — «сведена»',
        },
      },
    },
    run: (args, io, env) => runApplyCommand(args, io.out, env.cwd),
  },
  { inject: PIPELINE_SERVICES },
);
