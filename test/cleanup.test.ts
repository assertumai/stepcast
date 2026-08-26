import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  cleanupRun,
  dirSize,
  listCandidates,
  removeRun,
  selectOlderThan,
} from '../src/core/run/cleanup.js';
import { projectKey } from '../src/core/journal/paths.js';
import { RunJournal } from '../src/core/journal/writer.js';
import type { RunManifest } from '../src/core/journal/schema.js';

function bed(): { runsRoot: string; projectRoot: string } {
  const base = mkdtempSync(join(tmpdir(), 'stepcast-cleanup-'));
  const runsRoot = join(base, 'runs');
  const projectRoot = join(base, 'project');
  mkdirSync(runsRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  return { runsRoot, projectRoot };
}

function baseManifest(runId: string): RunManifest {
  return {
    run_id: runId,
    pipeline: 'demo',
    pipeline_file: '/tmp/stepcast.yml',
    lock_hash: 'abc',
    project_root: '/tmp/project',
    workspace: { mode: 'cwd' },
    inputs: {},
    git: {},
    backends: {},
    started_at: '2026-08-01T00:00:00.000Z',
  };
}

/** Прогон с содержимым во всех удаляемых каталогах и минимумом. */
function makeRun(
  runsRoot: string,
  projectRoot: string,
  runId: string,
  manifestOverrides: Partial<RunManifest> = {},
): RunJournal {
  const journal = RunJournal.create({ runsRoot, projectRoot, runId });
  journal.writeManifest({ ...baseManifest(journal.paths.runId), ...manifestOverrides });
  journal.writeStatus({
    run_id: journal.paths.runId,
    pipeline: 'demo',
    lock_hash: 'abc',
    status: 'success',
    workspace: { mode: 'cwd' },
    inputs: {},
    jobs: [],
    budget: { tokens_used: 0, wallclock_ms: 0 },
    updated_at: '2026-08-01T00:00:00.000Z',
  });
  journal.writeUsage({
    run_id: journal.paths.runId,
    total: { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, billable_tokens: 0, wallclock_ms: 0 },
    unreported: [],
    jobs: {},
  });
  journal.writeArtifact('build', { ok: true });
  const stepDir = journal.prepareStep('build', 1, 'compile');
  journal.writeStepFile(stepDir, 'stdout.log', 'вывод шага\n');
  journal.writeLock('version: 1\n');
  journal.event({ kind: 'job.started', job: 'build' });
  return journal;
}

describe('run-cleanup: подсчёт размера', () => {
  // Спека run-cleanup: подсчёт размера директории рекурсивным обходом
  it('считает размер дерева с известным числом байт', () => {
    const base = mkdtempSync(join(tmpdir(), 'stepcast-dirsize-'));
    writeFileSync(join(base, 'a.txt'), 'x'.repeat(100));
    mkdirSync(join(base, 'nested'));
    writeFileSync(join(base, 'nested', 'b.txt'), 'y'.repeat(50));

    assert.equal(dirSize(base), 150);
  });

  it('считает несуществующую директорию нулевой', () => {
    assert.equal(dirSize('/несуществующий/путь/stepcast-test'), 0);
  });
});

describe('run-cleanup: отбор и удаление', () => {
  // Сценарий: «Отчёт без действия»
  it('перечисляет прогоны с размером, ничего не удаляя', () => {
    const { runsRoot, projectRoot } = bed();
    makeRun(runsRoot, projectRoot, 'run-a');

    const candidates = listCandidates(runsRoot, projectRoot);
    assert.equal(candidates.length, 1);
    assert.ok(candidates[0]!.sizeBytes > 0);
    assert.ok(existsSync(candidates[0]!.paths.jobs));
  });

  // Сценарий: «Нет прогонов»
  it('сообщает об отсутствии прогонов', () => {
    const { runsRoot, projectRoot } = bed();
    assert.deepEqual(listCandidates(runsRoot, projectRoot), []);
  });

  // Сценарий: «Удаление прогонов старше порога» и «Прогоны младше порога не трогаются»
  it('отбирает по возрасту от finished_at', () => {
    const { runsRoot, projectRoot } = bed();
    const now = new Date('2026-08-20T00:00:00.000Z');

    makeRun(runsRoot, projectRoot, 'old', {
      started_at: '2026-07-01T00:00:00.000Z',
      finished_at: '2026-07-11T00:00:00.000Z', // 40 дней назад
    });
    makeRun(runsRoot, projectRoot, 'recent', {
      started_at: '2026-08-09T00:00:00.000Z',
      finished_at: '2026-08-10T00:00:00.000Z', // 10 дней назад
    });

    const candidates = listCandidates(runsRoot, projectRoot, now);
    const selected = selectOlderThan(candidates, 30 * 86_400_000);

    assert.deepEqual(
      selected.map((c) => c.runId),
      ['old'],
    );
  });

  // Сценарий: «Возраст прерванного прогона»
  it('считает возраст прерванного прогона от started_at при отсутствии finished_at', () => {
    const { runsRoot, projectRoot } = bed();
    const now = new Date('2026-08-20T00:00:00.000Z');

    makeRun(runsRoot, projectRoot, 'interrupted', {
      started_at: '2026-07-01T00:00:00.000Z',
    });

    const [candidate] = listCandidates(runsRoot, projectRoot, now);
    assert.equal(candidate!.endedAt, '2026-07-01T00:00:00.000Z');
    assert.equal(candidate!.ageMs, now.getTime() - new Date('2026-07-01T00:00:00.000Z').getTime());
  });

  // Сценарий: «Минимум остаётся»
  it('удаление сохраняет run.json, status.json, usage.json и стирает остальное', () => {
    const { runsRoot, projectRoot } = bed();
    const journal = makeRun(runsRoot, projectRoot, 'run-a');
    const paths = journal.paths;

    cleanupRun(paths);

    assert.ok(existsSync(paths.manifest));
    assert.ok(existsSync(paths.status));
    assert.ok(existsSync(paths.usage));
    assert.ok(!existsSync(paths.jobs));
    assert.ok(!existsSync(paths.artifacts));
    assert.ok(!existsSync(paths.lock));
    assert.ok(!existsSync(paths.events));
    assert.ok(!existsSync(paths.anchors));
  });

  it('удаление из истории сносит каталог прогона целиком', () => {
    const { runsRoot, projectRoot } = bed();
    const kept = makeRun(runsRoot, projectRoot, 'run-a');
    const doomed = makeRun(runsRoot, projectRoot, 'run-b');

    removeRun(runsRoot, projectKey(projectRoot), 'run-b');

    assert.ok(!existsSync(doomed.paths.dir));
    assert.ok(existsSync(kept.paths.manifest));
  });

  it('не оставляет ярлык latest указывать на удалённый прогон', () => {
    const { runsRoot, projectRoot } = bed();
    const kept = makeRun(runsRoot, projectRoot, 'run-a');
    makeRun(runsRoot, projectRoot, 'run-b');
    const link = join(kept.paths.projectDir, 'latest');

    // Ярлык ведёт на новейший прогон — именно его и удаляем.
    assert.equal(readlinkSync(link), 'run-b');
    removeRun(runsRoot, projectKey(projectRoot), 'run-b');

    assert.equal(readlinkSync(link), 'run-a');
    assert.ok(existsSync(link));
  });

  it('снимает запись проекта из указателя, когда прогонов не осталось', () => {
    const { runsRoot, projectRoot } = bed();
    makeRun(runsRoot, projectRoot, 'run-a');
    const key = projectKey(projectRoot);
    const indexPath = join(runsRoot, 'projects.json');

    assert.ok(key in (JSON.parse(readFileSync(indexPath, 'utf8')) as Record<string, unknown>));
    removeRun(runsRoot, key, 'run-a');

    assert.ok(!(key in (JSON.parse(readFileSync(indexPath, 'utf8')) as Record<string, unknown>)));
    assert.ok(!existsSync(join(runsRoot, key)));
  });
});
