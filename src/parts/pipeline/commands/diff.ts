import { createAnchorer, detectAnchorKind, manifestStore } from '../domain/anchor/index.js';
import { resolveConfig } from '../config/resolve.js';
import { ExitCode, StepcastError, type ExitCodeValue } from '../../../kernel/errors.js';
import { withTempDir } from '../../../kernel/fs/tempDir.js';
import { findProjectRoot } from '../run/journal/paths.js';
import type { PipelineCommandEnv } from '../contract.js';
import { resolveRun } from '../run/journal/reader.js';
import { describeComparison, diffRuns } from '../run/diff.js';
import { commandRow } from '../../../kernel/cli/commandRow.js';
import { PIPELINE_SERVICES } from '../services.js';
import type { ParsedArgs } from '../../../kernel/cli/args.js';

export function runDiffCommand(
  args: ParsedArgs,
  write: (line: string) => void,
  cwd: string,
): ExitCodeValue {
  const [first, second] = args.positional;
  if (first === undefined || second === undefined) {
    throw new StepcastError('Нужно указать два прогона', { hint: 'stepcast diff <run-a> <run-b>' });
  }

  const { config } = resolveConfig({ cwd });
  const projectRoot = findProjectRoot(cwd);
  const a = resolveRun(config.runs.root, projectRoot, first);
  const b = resolveRun(config.runs.root, projectRoot, second);

  // Якорь нужен только для сравнения деревьев и читает тела манифестов обоих
  // прогонов: сам он ничего не фиксирует.
  const anchorKind = detectAnchorKind(cwd, config.project.nestedRepos);
  return withTempDir('stepcast-diff-', (stateDir) => {
    const anchorer = createAnchorer({
      dir: cwd,
      stateDir,
      kind: anchorKind,
      scope: 'diff',
      ...(config.project.nestedRepos === undefined ? {} : { nested: config.project.nestedRepos }),
      readStores: [manifestStore(a.anchors), manifestStore(b.anchors)],
    });

    try {
      const comparison = diffRuns({ a, b, anchorer });
      for (const line of describeComparison(comparison)) write(line);
      return ExitCode.ok;
    } finally {
      anchorer.dispose();
    }
  });
}

export const row = commandRow<PipelineCommandEnv>(
  {
    name: 'diff',
    spec: {
      description: 'сравнить два прогона по ключам шагов, промптам, контексту и деревьям',
      positional: ['run-a', 'run-b'],
    },
    run: (args, io, env) => runDiffCommand(args, io.out, env.cwd),
  },
  { inject: PIPELINE_SERVICES },
);
