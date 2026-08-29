import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  cleanupRun,
  dirSize,
  listCandidates,
  removeRun,
  removeRuns,
  selectCandidates,
  selectOlderThan,
} from '../src/core/run/cleanup.js';
import { projectKey } from '../src/core/journal/paths.js';
import { RunJournal } from '../src/core/journal/writer.js';
import type { RunManifest, StatusValue } from '../src/core/journal/schema.js';

function bed(): { runsRoot: string; projectRoot: string } {
  const base = mkdtempSync(join(tmpdir(), 'stepcast-cleanup-'));
  const runsRoot = join(base, 'runs');
  const projectRoot = join(base, 'project');
  mkdirSync(runsRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  return { runsRoot, projectRoot };
}

/** Второй проект в том же корне прогонов: отбор идёт по всем проектам сразу. */
function otherProject(): string {
  const base = mkdtempSync(join(tmpdir(), 'stepcast-cleanup-other-'));
  const projectRoot = join(base, 'project');
  mkdirSync(projectRoot, { recursive: true });
  return projectRoot;
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

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  };
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Тест');
  writeFileSync(join(dir, 'a.txt'), 'x\n');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'начало');
}

function addWorktreeFor(repoDir: string, path: string): void {
  execFileSync('git', ['-C', repoDir, 'worktree', 'add', '--detach', '--quiet', path, 'HEAD']);
}

function worktreeRecords(repoDir: string): string[] {
  try {
    return readdirSync(join(repoDir, '.git', 'worktrees'));
  } catch {
    return [];
  }
}

/** Прогон с явным статусом — для отбора по признаку, где статус и есть суть проверки. */
function makeStatusRun(
  runsRoot: string,
  projectRoot: string,
  runId: string,
  status: StatusValue,
  manifestOverrides: Partial<RunManifest> = {},
): RunJournal {
  const journal = RunJournal.create({ runsRoot, projectRoot, runId });
  journal.writeManifest({ ...baseManifest(journal.paths.runId), ...manifestOverrides });
  journal.writeStatus({
    run_id: journal.paths.runId,
    pipeline: 'demo',
    lock_hash: 'abc',
    status,
    workspace: { mode: 'cwd' },
    inputs: {},
    jobs: [],
    budget: { tokens_used: 0, wallclock_ms: 0 },
    updated_at: '2026-08-01T00:00:00.000Z',
  });
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

  // Требование run-cleanup: «при отсутствии оставшихся — сниматься»
  it('снимает ярлык latest вместе с последним прогоном проекта', () => {
    const { runsRoot, projectRoot } = bed();
    const journal = makeRun(runsRoot, projectRoot, 'run-a');
    const link = join(journal.paths.projectDir, 'latest');

    assert.ok(existsSync(link));
    removeRun(runsRoot, projectKey(projectRoot), 'run-a');

    assert.ok(!existsSync(link));
    assert.ok(!existsSync(journal.paths.projectDir));
  });

  // Требование run-cleanup: «Платформа без символических ссылок MUST NOT
  // приводить к отказу снятия»
  it('снимает прогон и там, где ярлык latest поставить не удаётся', () => {
    const { runsRoot, projectRoot } = bed();
    const kept = makeRun(runsRoot, projectRoot, 'run-a');
    const doomed = makeRun(runsRoot, projectRoot, 'run-b');
    const link = join(kept.paths.projectDir, 'latest');

    // Ярлык подменён непустым каталогом: снять его и поставить на его место
    // ссылку нельзя — ровно то, чем оборачивается платформа без ссылок.
    rmSync(link, { force: true });
    mkdirSync(link);
    writeFileSync(join(link, 'занято'), 'x');

    removeRun(runsRoot, projectKey(projectRoot), 'run-b');

    assert.ok(!existsSync(doomed.paths.dir), 'снятие не должно отказывать из-за ярлыка');
    assert.ok(existsSync(kept.paths.dir));
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

describe('run-cleanup: отбор по признаку', () => {
  // Живой процесс для проверки «оборванности» — процесс самого теста.
  const RECENT = new Date().toISOString();

  // Сценарий: «Отбор оборванных»
  it('отбирает оборванные прогоны, минуя живые и завершённые', () => {
    const { runsRoot, projectRoot } = bed();
    const key = projectKey(projectRoot);
    makeStatusRun(runsRoot, projectRoot, 'alive', 'running', { started_at: RECENT, pid: process.pid });
    makeStatusRun(runsRoot, projectRoot, 'abandoned', 'running', {
      started_at: RECENT,
      pid: 999_999_999,
    });
    makeStatusRun(runsRoot, projectRoot, 'done', 'success');

    const selected = selectCandidates(runsRoot, { abandoned: true });

    assert.deepEqual(
      selected.map((c) => c.address),
      [`${key}/abandoned`],
    );
  });

  // Сценарий: «Отбор отказавших»
  it('отбирает отказавшие прогоны и не берёт успешные', () => {
    const { runsRoot, projectRoot } = bed();
    const key = projectKey(projectRoot);
    makeStatusRun(runsRoot, projectRoot, 'failed', 'failed');
    makeStatusRun(runsRoot, projectRoot, 'budget', 'budget_exceeded');
    makeStatusRun(runsRoot, projectRoot, 'canceled', 'canceled');
    makeStatusRun(runsRoot, projectRoot, 'success', 'success');

    const selected = selectCandidates(runsRoot, { failed: true });

    assert.deepEqual(
      selected.map((c) => c.address).sort(),
      [`${key}/budget`, `${key}/canceled`, `${key}/failed`].sort(),
    );
  });

  // Сценарий: «Отбор по сроку»
  it('отбирает по сроку от finished_at и от started_at', () => {
    const { runsRoot, projectRoot } = bed();
    const now = new Date('2026-08-20T00:00:00.000Z');
    const key = projectKey(projectRoot);
    makeStatusRun(runsRoot, projectRoot, 'old-finished', 'success', {
      started_at: '2026-07-01T00:00:00.000Z',
      finished_at: '2026-07-11T00:00:00.000Z', // 40 дней назад
    });
    makeStatusRun(runsRoot, projectRoot, 'old-running', 'running', {
      started_at: '2026-07-01T00:00:00.000Z', // без finished_at — прерван
      pid: 999_999_999,
    });
    makeStatusRun(runsRoot, projectRoot, 'recent', 'success', {
      started_at: '2026-08-19T00:00:00.000Z',
      finished_at: '2026-08-19T12:00:00.000Z',
    });

    const selected = selectCandidates(runsRoot, { olderThanMs: 10 * 86_400_000 }, { now });

    assert.deepEqual(
      selected.map((c) => c.address).sort(),
      [`${key}/old-finished`, `${key}/old-running`].sort(),
    );
  });

  // Сценарий: «Прогон под двумя признаками»
  it('называет прогон под двумя признаками один раз', () => {
    const { runsRoot, projectRoot } = bed();
    const now = new Date('2026-08-20T00:00:00.000Z');
    const key = projectKey(projectRoot);
    makeStatusRun(runsRoot, projectRoot, 'stale-failed', 'failed', {
      started_at: '2026-07-01T00:00:00.000Z',
      finished_at: '2026-07-11T00:00:00.000Z', // 40 дней назад
    });

    const selected = selectCandidates(
      runsRoot,
      { failed: true, olderThanMs: 7 * 86_400_000 },
      { now },
    );

    assert.deepEqual(
      selected.map((c) => c.address),
      [`${key}/stale-failed`],
    );
  });

  // Сценарий: «Отбор по всем проектам»
  it('берёт подходящие прогоны обоих проектов, когда проект не указан', () => {
    const { runsRoot, projectRoot } = bed();
    const otherProjectRoot = otherProject();
    const key = projectKey(projectRoot);
    const otherKey = projectKey(otherProjectRoot);

    makeStatusRun(runsRoot, projectRoot, 'failed-a', 'failed');
    makeStatusRun(runsRoot, otherProjectRoot, 'failed-b', 'failed');
    makeStatusRun(runsRoot, otherProjectRoot, 'success-b', 'success');

    const selected = selectCandidates(runsRoot, { failed: true });

    assert.deepEqual(
      selected.map((c) => c.address).sort(),
      [`${key}/failed-a`, `${otherKey}/failed-b`].sort(),
    );
  });

  // Сценарий: «Отбор одного проекта»
  it('сужает отбор до одного проекта', () => {
    const { runsRoot, projectRoot } = bed();
    const otherProjectRoot = otherProject();
    const key = projectKey(projectRoot);
    const otherKey = projectKey(otherProjectRoot);

    makeStatusRun(runsRoot, projectRoot, 'failed-a', 'failed');
    makeStatusRun(runsRoot, otherProjectRoot, 'failed-b', 'failed');

    const selected = selectCandidates(runsRoot, { failed: true }, { project: key });

    assert.deepEqual(
      selected.map((c) => c.address),
      [`${key}/failed-a`],
    );
    assert.ok(!selected.some((c) => c.key === otherKey));
  });

  // Сценарий: «Размер отобранного прогона»
  it('называет размер каталога отобранного прогона', () => {
    const { runsRoot, projectRoot } = bed();
    const journal = makeRun(runsRoot, projectRoot, 'run-a');
    writeFileSync(join(journal.paths.dir, 'груз.bin'), 'x'.repeat(10_000));

    const [selected] = selectCandidates(runsRoot, { olderThanMs: 0 });

    assert.ok(selected !== undefined);
    assert.ok(selected.sizeBytes >= 10_000, 'размер должен считаться обходом содержимого');
  });

  // Сценарий: «Прогон с нечитаемым манифестом»
  it('называет прогон с нечитаемым манифестом, считая возраст по каталогу', () => {
    const { runsRoot, projectRoot } = bed();
    const key = projectKey(projectRoot);
    const journal = makeRun(runsRoot, projectRoot, 'broken');
    writeFileSync(journal.paths.manifest, '{ не json');

    const selected = selectCandidates(runsRoot, { olderThanMs: 0 });

    assert.deepEqual(
      selected.map((c) => c.address),
      [`${key}/broken`],
    );
    assert.equal(selected[0]?.unreadable, true);
    assert.ok(selected[0]!.ageMs >= 0, 'возраст должен быть посчитан, а не потерян');
  });

  // Сценарий: «Отказ у прогона с нечитаемым состоянием»
  it('берёт статус из манифеста, когда состояние не читается', () => {
    const { runsRoot, projectRoot } = bed();
    const key = projectKey(projectRoot);
    const journal = makeStatusRun(runsRoot, projectRoot, 'broken-state', 'failed', {
      status: 'failed',
    });
    writeFileSync(journal.paths.status, '{ не json');

    const selected = selectCandidates(runsRoot, { failed: true });

    assert.deepEqual(
      selected.map((c) => c.address),
      [`${key}/broken-state`],
    );
    assert.equal(selected[0]?.unreadable, false, 'манифест цел — прогон читаем');
  });

  // Сценарий: «Отбор ничего не трогает»
  it('не изменяет ничего на диске', () => {
    const { runsRoot, projectRoot } = bed();
    const journal = makeStatusRun(runsRoot, projectRoot, 'failed', 'failed');

    selectCandidates(runsRoot, { failed: true, olderThanMs: 0 });

    assert.ok(existsSync(journal.paths.dir));
    assert.ok(existsSync(journal.paths.manifest));
  });
});

describe('run-cleanup: групповое снятие', () => {
  // Сценарий: «Живой прогон в списке»
  it('пропускает живой прогон в списке и снимает остальные', () => {
    const { runsRoot, projectRoot } = bed();
    const key = projectKey(projectRoot);
    makeStatusRun(runsRoot, projectRoot, 'alive', 'running', {
      started_at: new Date().toISOString(),
      pid: process.pid,
    });
    const a = makeRun(runsRoot, projectRoot, 'run-a');
    const b = makeRun(runsRoot, projectRoot, 'run-b');

    const { outcomes, freedBytes } = removeRuns(runsRoot, [
      { key, runId: 'alive' },
      { key, runId: 'run-a' },
      { key, runId: 'run-b' },
    ]);

    assert.equal(outcomes.find((o) => o.address === `${key}/alive`)?.outcome, 'skipped_alive');
    assert.equal(outcomes.find((o) => o.address === `${key}/run-a`)?.outcome, 'removed');
    assert.equal(outcomes.find((o) => o.address === `${key}/run-b`)?.outcome, 'removed');
    assert.ok(freedBytes > 0);
    assert.ok(!existsSync(a.paths.dir));
    assert.ok(!existsSync(b.paths.dir));
  });

  // Решение 5 дизайна: размер, снятый отбором, снятие заново не меряет
  it('называет освобождённым размер, пришедший вместе с адресом', () => {
    const { runsRoot, projectRoot } = bed();
    const key = projectKey(projectRoot);
    makeRun(runsRoot, projectRoot, 'run-a');

    const { outcomes, freedBytes } = removeRuns(runsRoot, [
      { key, runId: 'run-a', sizeBytes: 4242 },
    ]);

    assert.equal(freedBytes, 4242);
    assert.deepEqual(outcomes, [{ address: `${key}/run-a`, outcome: 'removed', sizeBytes: 4242 }]);
  });

  // Сценарий: «Прогон исчез до удаления»
  it('отсутствующий адрес даёт skipped_missing, а не отказ', () => {
    const { runsRoot, projectRoot } = bed();
    const key = projectKey(projectRoot);

    const { outcomes } = removeRuns(runsRoot, [{ key, runId: 'нет-такого' }]);

    assert.deepEqual(outcomes, [{ address: `${key}/нет-такого`, outcome: 'skipped_missing' }]);
  });

  // Сценарий: «Каталог не удаляется»
  it('сбой на одном адресе не обрывает остальные', () => {
    const { runsRoot, projectRoot } = bed();
    const key = projectKey(projectRoot);
    const ok = makeRun(runsRoot, projectRoot, 'run-a');

    const otherProjectRoot = otherProject();
    const doomed = makeRun(runsRoot, otherProjectRoot, 'run-b');
    const doomedKey = projectKey(otherProjectRoot);

    // Каталог без права записи родителя нельзя ни снять, ни переставить в
    // нём ярлык — надёжный способ вызвать отказ, не трогая другой прогон.
    chmodSync(doomed.paths.projectDir, 0o500);
    try {
      const { outcomes } = removeRuns(runsRoot, [
        { key, runId: 'run-a' },
        { key: doomedKey, runId: 'run-b' },
      ]);

      assert.equal(outcomes.find((o) => o.address === `${key}/run-a`)?.outcome, 'removed');
      assert.equal(outcomes.find((o) => o.address === `${doomedKey}/run-b`)?.outcome, 'failed');
      assert.ok(existsSync(doomed.paths.dir));
      assert.ok(!existsSync(ok.paths.dir));
    } finally {
      chmodSync(doomed.paths.projectDir, 0o755);
    }
  });
});

describe('run-cleanup: снятие учётных записей рабочих деревьев', () => {
  /** Прогон с корневым worktree и одной частью, обе — настоящие git-деревья. */
  function makeWorktreeRun(
    runsRoot: string,
    projectRoot: string,
    partRepo: string,
    runId: string,
    status: StatusValue = 'success',
  ): RunJournal {
    const journal = RunJournal.create({ runsRoot, projectRoot, runId });
    const workDir = join(journal.paths.dir, 'workspace', 'build');
    const partDir = join(workDir, 'public-site');
    addWorktreeFor(projectRoot, workDir);
    addWorktreeFor(partRepo, partDir);

    journal.writeManifest({ ...baseManifest(journal.paths.runId), project_root: projectRoot });
    journal.writeStatus({
      run_id: journal.paths.runId,
      pipeline: 'demo',
      lock_hash: 'abc',
      status,
      workspace: { mode: 'worktree' },
      inputs: {},
      jobs: [
        {
          id: 'build',
          status,
          workspace: { mode: 'worktree', path: workDir, nested: [{ dir: 'public-site', repo: partRepo }] },
          steps: [],
        },
      ],
      budget: { tokens_used: 0, wallclock_ms: 0 },
      updated_at: '2026-08-01T00:00:00.000Z',
    });
    journal.writeUsage({
      run_id: journal.paths.runId,
      total: { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, billable_tokens: 0, wallclock_ms: 0 },
      unreported: [],
      jobs: {},
    });
    return journal;
  }

  it('cleanupRun снимает записи корня и части перед удалением каталогов прогона', () => {
    const { runsRoot, projectRoot } = bed();
    const partRepo = mkdtempSync(join(tmpdir(), 'stepcast-cleanup-part-'));
    initGitRepo(projectRoot);
    initGitRepo(partRepo);

    const journal = makeWorktreeRun(runsRoot, projectRoot, partRepo, 'run-a');
    assert.equal(worktreeRecords(projectRoot).length, 1);
    assert.equal(worktreeRecords(partRepo).length, 1);

    const result = cleanupRun(journal.paths);

    assert.deepEqual(result.unresolvedWorktrees, []);
    assert.deepEqual(worktreeRecords(projectRoot), []);
    assert.deepEqual(worktreeRecords(partRepo), []);
    // Минимум переживает уборку, как и всегда.
    assert.ok(existsSync(journal.paths.status));
  });

  it('removeRun снимает записи, а посторонняя запись того же репозитория цела', () => {
    const { runsRoot, projectRoot } = bed();
    const partRepo = mkdtempSync(join(tmpdir(), 'stepcast-cleanup-part-'));
    initGitRepo(projectRoot);
    initGitRepo(partRepo);

    const journal = makeWorktreeRun(runsRoot, projectRoot, partRepo, 'run-a');
    // Постороннее рабочее дерево того же корневого репозитория — заведено не
    // этим прогоном, и уборка не должна его знать.
    const foreignDir = mkdtempSync(join(tmpdir(), 'stepcast-cleanup-foreign-'));
    const foreignPath = join(foreignDir, 'foreign');
    addWorktreeFor(projectRoot, foreignPath);
    assert.equal(worktreeRecords(projectRoot).length, 2);

    const result = removeRun(runsRoot, projectKey(projectRoot), journal.paths.runId);

    assert.deepEqual(result.unresolvedWorktrees, []);
    assert.deepEqual(worktreeRecords(partRepo), []);
    assert.equal(worktreeRecords(projectRoot).length, 1, 'постороннее рабочее дерево должно остаться');
    assert.ok(existsSync(foreignPath), 'постороннее дерево должно остаться на месте');
  });

  // Запись пишется до первого шага (design.md, решение 6) — уборка обязана
  // быть полной и для прогона, ещё идущего или остановленного до конца.
  it('уборка прогона, остановленного до конца работы, полна', () => {
    const { runsRoot, projectRoot } = bed();
    const partRepo = mkdtempSync(join(tmpdir(), 'stepcast-cleanup-part-'));
    initGitRepo(projectRoot);
    initGitRepo(partRepo);

    const journal = makeWorktreeRun(runsRoot, projectRoot, partRepo, 'run-a', 'running');

    const result = cleanupRun(journal.paths);

    assert.deepEqual(result.unresolvedWorktrees, []);
    assert.deepEqual(worktreeRecords(projectRoot), []);
    assert.deepEqual(worktreeRecords(partRepo), []);
  });

  // `cleanupRun` бережёт `status.json`, и второй заход (`gc --older-than`
  // повторно, следом удаление того же прогона витриной) собирает те же
  // адреса. Снимать по ним уже нечего — и сказать об этом «неснятой
  // записью» нельзя: канал обязан называть настоящие утечки.
  it('повторная уборка того же прогона не выдумывает неснятых записей', () => {
    const { runsRoot, projectRoot } = bed();
    const partRepo = mkdtempSync(join(tmpdir(), 'stepcast-cleanup-part-'));
    initGitRepo(projectRoot);
    initGitRepo(partRepo);

    const journal = makeWorktreeRun(runsRoot, projectRoot, partRepo, 'run-a');
    assert.deepEqual(cleanupRun(journal.paths).unresolvedWorktrees, []);

    assert.deepEqual(cleanupRun(journal.paths).unresolvedWorktrees, []);
    const removal = removeRun(runsRoot, projectKey(projectRoot), journal.paths.runId);
    assert.deepEqual(removal.unresolvedWorktrees, []);
  });

  // Части, объявленные друг в друге (`a` и `a/b`): снятие объемлющей уносит
  // с диска каталог вложенной, поэтому вложенная снимается раньше — а её
  // запись не остаётся в чужом репозитории ни при каком порядке.
  it('снимает записи частей, объявленных друг в друге', () => {
    const { runsRoot, projectRoot } = bed();
    const outerRepo = mkdtempSync(join(tmpdir(), 'stepcast-cleanup-outer-'));
    const innerRepo = mkdtempSync(join(tmpdir(), 'stepcast-cleanup-inner-'));
    initGitRepo(projectRoot);
    initGitRepo(outerRepo);
    initGitRepo(innerRepo);

    const journal = RunJournal.create({ runsRoot, projectRoot, runId: 'run-a' });
    const workDir = join(journal.paths.dir, 'workspace', 'build');
    addWorktreeFor(projectRoot, workDir);
    addWorktreeFor(outerRepo, join(workDir, 'a'));
    addWorktreeFor(innerRepo, join(workDir, 'a', 'b'));

    journal.writeManifest({ ...baseManifest(journal.paths.runId), project_root: projectRoot });
    journal.writeStatus({
      run_id: journal.paths.runId,
      pipeline: 'demo',
      lock_hash: 'abc',
      status: 'success',
      workspace: { mode: 'worktree' },
      inputs: {},
      jobs: [
        {
          id: 'build',
          status: 'success',
          workspace: {
            mode: 'worktree',
            path: workDir,
            // Канонический порядок состава — объемлющая часть раньше вложенной.
            nested: [
              { dir: 'a', repo: outerRepo },
              { dir: 'a/b', repo: innerRepo },
            ],
          },
          steps: [],
        },
      ],
      budget: { tokens_used: 0, wallclock_ms: 0 },
      updated_at: '2026-08-01T00:00:00.000Z',
    });
    journal.writeUsage({
      run_id: journal.paths.runId,
      total: { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, billable_tokens: 0, wallclock_ms: 0 },
      unreported: [],
      jobs: {},
    });

    const result = cleanupRun(journal.paths);

    assert.deepEqual(result.unresolvedWorktrees, []);
    assert.deepEqual(worktreeRecords(outerRepo), []);
    assert.deepEqual(worktreeRecords(innerRepo), [], 'запись вложенной части не должна остаться');
    assert.deepEqual(worktreeRecords(projectRoot), []);
  });

  // Отказ снятия не останавливает уборку каталогов: запись, на которую не
  // выйти (репозиторий части исчез вместе с ней), называется в исходе, а
  // каталоги прогона всё равно уходят.
  it('при отказе снятия каталог прогона удаляется, а неснятая запись названа в исходе', () => {
    const { runsRoot, projectRoot } = bed();
    initGitRepo(projectRoot);

    const journal = RunJournal.create({ runsRoot, projectRoot, runId: 'run-a' });
    const workDir = join(journal.paths.dir, 'workspace', 'build');
    addWorktreeFor(projectRoot, workDir);
    // Репозиторий части никогда не существовал — снять запись по её пути нечем.
    const missingPartRepo = join(mkdtempSync(join(tmpdir(), 'stepcast-cleanup-missing-')), 'gone');

    journal.writeManifest({ ...baseManifest(journal.paths.runId), project_root: projectRoot });
    journal.writeStatus({
      run_id: journal.paths.runId,
      pipeline: 'demo',
      lock_hash: 'abc',
      status: 'success',
      workspace: { mode: 'worktree' },
      inputs: {},
      jobs: [
        {
          id: 'build',
          status: 'success',
          workspace: {
            mode: 'worktree',
            path: workDir,
            nested: [{ dir: 'public-site', repo: missingPartRepo }],
          },
          steps: [],
        },
      ],
      budget: { tokens_used: 0, wallclock_ms: 0 },
      updated_at: '2026-08-01T00:00:00.000Z',
    });
    journal.writeUsage({
      run_id: journal.paths.runId,
      total: { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, billable_tokens: 0, wallclock_ms: 0 },
      unreported: [],
      jobs: {},
    });

    const result = cleanupRun(journal.paths);

    assert.equal(result.unresolvedWorktrees.length, 1);
    assert.match(result.unresolvedWorktrees[0]!, /public-site/);
    // Корневая запись всё равно снята.
    assert.deepEqual(worktreeRecords(projectRoot), []);
    // Каталоги прогона удалены, несмотря на неснятую запись части.
    assert.ok(!existsSync(journal.paths.jobs));
  });
});
