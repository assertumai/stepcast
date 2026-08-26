import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runStatusCommand } from '../src/cli/commands/status.js';
import type { ParsedArgs } from '../src/cli/args.js';
import { makeJournalBed, seedRun, withHome } from './helpers.js';

function args(flags: ParsedArgs['flags'] = {}): ParsedArgs {
  return { command: 'status', positional: [], flags };
}

function capture(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

describe('CLI: stepcast status', () => {
  // Спека stepcast-configuration: «Денежный расход и объявленный потолок»
  it('печатает потраченное и объявленный денежный потолок рядом с токенами', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, {
      budget: {
        tokens_used: 1000,
        tokens_limit: 5000,
        cost_used_usd: 2.5,
        cost_limit_usd: 10,
        wallclock_ms: 60_000,
      },
    });

    const { lines, write } = capture();
    withHome(home, () => runStatusCommand(args({ run: journal.paths.runId }), write, projectRoot));

    const text = lines.join('\n');
    assert.match(text, /\$2\.50 из \$10\.00/);
  });

  it('без объявленного потолка печатает прочерк вместо величины', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, {
      budget: { tokens_used: 0, wallclock_ms: 0 },
    });

    const { lines, write } = capture();
    withHome(home, () => runStatusCommand(args({ run: journal.paths.runId }), write, projectRoot));

    const text = lines.join('\n');
    assert.match(text, /\$0\.0000 из —/);
  });

  it('называет число попыток без сообщённой цены', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, {
      budget: {
        tokens_used: 100,
        wallclock_ms: 1000,
        cost_used_usd: 0,
        cost_limit_usd: 5,
        cost_unreported_attempts: 3,
      },
    });

    const { lines, write } = capture();
    withHome(home, () => runStatusCommand(args({ run: journal.paths.runId }), write, projectRoot));

    const text = lines.join('\n');
    assert.match(text, /3 попыток без сообщённой цены/);
  });
});
