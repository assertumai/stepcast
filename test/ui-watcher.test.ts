import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createWatcher } from '../src/ui/watcher.js';
import { cleanupRun } from '../src/core/run/cleanup.js';
import type { Overview } from '../src/ui/overview.js';
import { makeJournalBed, seedRun } from './helpers.js';

describe('ui-dashboard: наблюдатель за корнем прогонов', () => {
  // Сценарий: «Новый прогон появляется сам»
  it('доводит до слушателя прогон, появившийся после старта наблюдения', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const watcher = createWatcher({ runsRoot, intervalMs: 10_000 });

    const seen: Overview[] = [];
    watcher.subscribe((overview) => seen.push(overview));

    assert.deepEqual(watcher.current().projects, [], 'до прогонов обзор пуст');

    seedRun(runsRoot, projectRoot, { runId: 'новый' });
    watcher.poll();

    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.projects[0]?.runs[0]?.runId, 'новый');
    watcher.dispose();
  });

  it('не уведомляет, когда ничего не изменилось', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });

    const watcher = createWatcher({ runsRoot, intervalMs: 10_000 });
    let calls = 0;
    watcher.subscribe(() => (calls += 1));

    watcher.poll();
    watcher.poll();
    watcher.poll();

    assert.equal(calls, 0, 'неизменившийся корень не должен порождать уведомлений');
    watcher.dispose();
  });

  // Сценарий: «Несколько открытых вкладок»
  it('раздаёт один и тот же обзор всем слушателям', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const watcher = createWatcher({ runsRoot, intervalMs: 10_000 });

    const first: Overview[] = [];
    const second: Overview[] = [];
    watcher.subscribe((overview) => first.push(overview));
    watcher.subscribe((overview) => second.push(overview));

    seedRun(runsRoot, projectRoot, { runId: 'a' });
    watcher.poll();

    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.equal(first[0], second[0], 'обзор собирается один раз на всех');
    watcher.dispose();
  });

  it('замечает изменение состояния прогона', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, { runId: 'a', status: 'running' });

    const watcher = createWatcher({ runsRoot, intervalMs: 10_000 });
    const seen: Overview[] = [];
    watcher.subscribe((overview) => seen.push(overview));

    journal.writeStatus({
      run_id: journal.paths.runId,
      pipeline: 'demo',
      lock_hash: 'abc',
      status: 'success',
      workspace: { mode: 'cwd' },
      inputs: {},
      jobs: [],
      budget: { tokens_used: 0, wallclock_ms: 0 },
      updated_at: '2026-08-01T01:00:00.000Z',
    });
    watcher.poll();

    assert.equal(seen.at(-1)?.projects[0]?.runs[0]?.status, 'success');
    watcher.dispose();
  });

  /**
   * Найдено ручной проверкой: `gc` сносит содержимое прогона, не трогая
   * `status.json`, поэтому отпечаток по одному лишь mtime состояния уборку не
   * замечал — и обзор навсегда оставался с устаревшим признаком.
   */
  it('замечает уборку прогона, которая не меняет состояние', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, { runId: 'a', artifacts: { build: {} } });

    const watcher = createWatcher({ runsRoot, intervalMs: 10_000 });
    const seen: Overview[] = [];
    watcher.subscribe((overview) => seen.push(overview));

    assert.equal(watcher.current().projects[0]?.runs[0]?.swept, false);

    cleanupRun(journal.paths);
    watcher.poll();

    assert.equal(seen.length, 1, 'уборка должна дойти до клиента');
    assert.equal(seen[0]?.projects[0]?.runs[0]?.swept, true);
    watcher.dispose();
  });

  it('отписка и dispose прекращают уведомления', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const watcher = createWatcher({ runsRoot, intervalMs: 10_000 });

    let calls = 0;
    const unsubscribe = watcher.subscribe(() => (calls += 1));

    seedRun(runsRoot, projectRoot, { runId: 'a' });
    watcher.poll();
    assert.equal(calls, 1);

    unsubscribe();
    seedRun(runsRoot, projectRoot, { runId: 'b' });
    watcher.poll();
    assert.equal(calls, 1, 'отписавшийся слушатель больше не вызывается');

    watcher.subscribe(() => (calls += 1));
    watcher.dispose();
    seedRun(runsRoot, projectRoot, { runId: 'c' });
    watcher.poll();
    assert.equal(calls, 1, 'после dispose слушателей не остаётся');
  });
});
