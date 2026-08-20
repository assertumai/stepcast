import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runGcCommand } from '../src/cli/commands/gc.js';
import type { ParsedArgs } from '../src/cli/args.js';
import { ExitCode } from '../src/core/errors.js';
import { RunJournal } from '../src/core/journal/writer.js';
import type { RunManifest } from '../src/core/journal/schema.js';

function args(flags: ParsedArgs['flags'] = {}): ParsedArgs {
  return { command: 'gc', positional: [], flags };
}

interface Bed {
  readonly runsRoot: string;
  readonly projectRoot: string;
  readonly home: string;
}

/** `resolveConfig` внутри команды читает `runs.root` только из глобального
 * конфига (это GLOBAL_ONLY-ключ), поэтому изоляция теста идёт через
 * подменённый HOME, а не через .stepcast/config.yml в проекте. */
function bed(): Bed {
  const base = mkdtempSync(join(tmpdir(), 'stepcast-gc-'));
  const runsRoot = join(base, 'runs');
  const projectRoot = join(base, 'project');
  const home = join(base, 'home');
  mkdirSync(runsRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(join(home, '.stepcast'), { recursive: true });
  writeFileSync(join(home, '.stepcast', 'config.yml'), `runs:\n  root: ${runsRoot}\n`);
  return { runsRoot, projectRoot, home };
}

function withHome<T>(home: string, fn: () => T): T {
  const original = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
  }
}

function makeRun(
  runsRoot: string,
  projectRoot: string,
  runId: string,
  overrides: Partial<RunManifest> = {},
): RunJournal {
  const journal = RunJournal.create({ runsRoot, projectRoot, runId });
  journal.writeManifest({
    run_id: journal.paths.runId,
    pipeline: 'demo',
    pipeline_file: '/tmp/stepcast.yml',
    lock_hash: 'abc',
    project_root: projectRoot,
    workspace: { mode: 'cwd' },
    inputs: {},
    git: {},
    backends: {},
    started_at: '2026-08-01T00:00:00.000Z',
    finished_at: '2026-08-01T00:05:00.000Z',
    ...overrides,
  });
  journal.writeStatus({
    run_id: journal.paths.runId,
    pipeline: 'demo',
    lock_hash: 'abc',
    status: 'success',
    workspace: { mode: 'cwd' },
    inputs: {},
    jobs: [],
    budget: { tokens_used: 0, wallclock_ms: 0 },
    updated_at: '2026-08-01T00:05:00.000Z',
  });
  journal.writeUsage({
    run_id: journal.paths.runId,
    total: { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, billable_tokens: 0, wallclock_ms: 0 },
    unreported: [],
    jobs: {},
  });
  journal.writeArtifact('build', { ok: true });
  journal.writeLock('version: 1\n');
  return journal;
}

describe('CLI: stepcast gc', () => {
  // Сценарий: «Нет прогонов»
  it('сообщает об отсутствии прогонов и завершается кодом 0', () => {
    const { projectRoot, home } = bed();
    const lines: string[] = [];

    const code = withHome(home, () => runGcCommand(args(), (line) => lines.push(line), projectRoot));

    assert.equal(code, ExitCode.ok);
    assert.match(lines.join('\n'), /убирать нечего/);
  });

  // Сценарий: «Отчёт без действия» и «Подсказка о флаге удаления»
  it('без --older-than только отчитывается и не удаляет файлы', () => {
    const { runsRoot, projectRoot, home } = bed();
    const journal = makeRun(runsRoot, projectRoot, 'run-a');
    const lines: string[] = [];

    const code = withHome(home, () => runGcCommand(args(), (line) => lines.push(line), projectRoot));

    assert.equal(code, ExitCode.ok);
    assert.ok(existsSync(journal.paths.jobs));
    assert.ok(existsSync(journal.paths.artifacts));
    assert.match(lines.join('\n'), /--older-than/);
    assert.match(lines.join('\n'), /итого/);
  });

  // Сценарий: «Удаление прогонов старше порога», «Прогоны младше порога не трогаются», «Отчёт об удалённом»
  it('с --older-than удаляет только прогоны старше порога', () => {
    const { runsRoot, projectRoot, home } = bed();

    const old = makeRun(runsRoot, projectRoot, 'old', {
      started_at: '2026-06-01T00:00:00.000Z',
      finished_at: '2026-06-01T00:05:00.000Z',
    });
    const recent = makeRun(runsRoot, projectRoot, 'recent', {
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    });

    const lines: string[] = [];
    const code = withHome(home, () =>
      runGcCommand(args({ 'older-than': '1d' }), (line) => lines.push(line), projectRoot),
    );

    assert.equal(code, ExitCode.ok);
    assert.ok(!existsSync(old.paths.jobs));
    assert.ok(existsSync(old.paths.manifest));
    assert.ok(existsSync(recent.paths.jobs));
    assert.match(lines.join('\n'), /освобождено/);
  });

  // Сценарий: «Без интерактивного ввода» — команда синхронна и не трогает stdin.
  it('работает без обращения к stdin', () => {
    const { runsRoot, projectRoot, home } = bed();
    makeRun(runsRoot, projectRoot, 'run-a', {
      started_at: '2020-01-01T00:00:00.000Z',
      finished_at: '2020-01-01T00:05:00.000Z',
    });

    const code = withHome(home, () => runGcCommand(args({ 'older-than': '0s' }), () => {}, projectRoot));
    assert.equal(code, ExitCode.ok);
  });
});
