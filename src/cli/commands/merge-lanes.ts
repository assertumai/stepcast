import { resolve as resolvePath } from 'node:path';

import { resolveConfig } from '../../core/config/resolve.js';
import { ExitCode, StepcastError, type ExitCodeValue } from '../../core/errors.js';
import { findProjectRoot } from '../../core/journal/paths.js';
import { resolveRun } from '../../core/journal/reader.js';
import { mergeLanes, type LaneMergeResult } from '../../core/lanes/merge.js';
import type { ParsedArgs } from '../args.js';

/**
 * `stepcast merge-lanes [<run-id>] --lanes a,b --check "<команда>" [--file
 * backlog.md]` — сведение дорожек командой бинаря: разбор ключей и печать
 * здесь, обход дорожек — в `src/core/lanes/merge.ts`.
 */

function stringFlag(flags: ParsedArgs['flags'], name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

function parseLaneList(raw: string): readonly string[] {
  const lanes = raw.split(',').map((entry) => entry.trim());
  if (lanes.length === 0 || lanes.some((lane) => lane === '')) {
    throw new StepcastError('ключ --lanes требует непустого перечня имён через запятую');
  }
  if (new Set(lanes).size !== lanes.length) {
    throw new StepcastError('имена дорожек должны быть попарно различны');
  }
  return lanes;
}

function describe(result: LaneMergeResult): string {
  switch (result.kind) {
    case 'merged':
      return `сведена, пункт «${result.slug}» помечен done`;
    case 'empty':
      return 'пропущена — слот не заполнен, все работы дорожки skipped';
    case 'no_item':
      return 'пропущена — пункт очереди ей не доставался, отмечать в очереди нечего';
    default:
      return `не сведена — ${result.reason}`;
  }
}

export async function runMergeLanesCommand(
  args: ParsedArgs,
  write: (line: string) => void,
  cwd: string,
): Promise<ExitCodeValue> {
  const lanesFlag = stringFlag(args.flags, 'lanes');
  if (lanesFlag === undefined) {
    throw new StepcastError('ключ --lanes обязателен');
  }
  const lanes = parseLaneList(lanesFlag);

  const check = stringFlag(args.flags, 'check');
  if (check === undefined || check.trim() === '') {
    throw new StepcastError('ключ --check обязателен: свести непроверенное молча команда не может');
  }

  const file = resolvePath(cwd, stringFlag(args.flags, 'file') ?? 'backlog.md');

  // «Последний прогон» здесь не подставляется: команда коммитит и стирает
  // дерево, и ошибиться прогоном по умолчанию она не должна иметь возможности.
  const runId = args.positional[0] ?? process.env.STEPCAST_RUN_ID;
  if (runId === undefined) {
    throw new StepcastError('не назван прогон: укажите его позиционным аргументом либо переменной STEPCAST_RUN_ID');
  }

  const { config } = resolveConfig({ cwd });
  const projectRoot = findProjectRoot(cwd);
  const paths = resolveRun(config.runs.root, projectRoot, runId);

  const results = await mergeLanes({
    paths,
    cwd,
    lanes,
    check,
    file,
    ...(config.project.nestedRepos === undefined ? {} : { nestedRepos: config.project.nestedRepos }),
  });

  let merged = 0;
  for (const result of results) {
    write(`дорожка ${result.lane}: ${describe(result)}`);
    if (result.kind === 'merged') merged += 1;
  }
  write(`итог: сведено ${merged}, не сведено ${results.length - merged}`);

  const stopped = results.some((result) => result.kind === 'conflict' || result.kind === 'check_failed');
  return stopped ? ExitCode.jobFailed : ExitCode.ok;
}
