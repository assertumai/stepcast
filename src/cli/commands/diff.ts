import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAnchorer, detectAnchorKind, manifestStore } from '../../core/anchor/index.js';
import { resolveConfig } from '../../core/config/resolve.js';
import { ExitCode, StepcastError, type ExitCodeValue } from '../../core/errors.js';
import { findProjectRoot } from '../../core/journal/paths.js';
import { resolveRun } from '../../core/journal/reader.js';
import { describeComparison, diffRuns } from '../../core/run/diff.js';
import type { ParsedArgs } from '../args.js';

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
  const anchorKind = detectAnchorKind(cwd);
  const stateDir = mkdtempSync(join(tmpdir(), 'stepcast-diff-'));
  const anchorer = createAnchorer({
    dir: cwd,
    stateDir,
    kind: anchorKind,
    scope: 'diff',
    readStores: [manifestStore(a.anchors), manifestStore(b.anchors)],
  });

  try {
    const comparison = diffRuns({ a, b, anchorer });
    for (const line of describeComparison(comparison)) write(line);
    return ExitCode.ok;
  } finally {
    anchorer.dispose();
  }
}
