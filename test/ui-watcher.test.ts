import assert from 'node:assert/strict';
import { readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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

  // Сценарий: «Отказ разбора назван в логе» + «Строка не повторяется на
  // каждом опросе» + «Расхождение версий называет лекарство»
  it('печатает одну строку на беду за жизнь демона и называет лекарство при расхождении версий', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, { runId: 'skewed' });

    const raw = JSON.parse(readFileSync(journal.paths.manifest, 'utf8')) as Record<string, unknown>;
    raw.bogus_field = 'x';
    writeFileSync(journal.paths.manifest, `${JSON.stringify(raw, null, 2)}\n`);

    const lines: string[] = [];
    const watcher = createWatcher({ runsRoot, intervalMs: 10_000, log: (line) => lines.push(line) });

    // Несколько пересборок подряд: status.json переписывается и получает
    // новую mtime, отпечаток корня меняется, обзор собирается заново — но
    // беда run.json от этого не меняется.
    for (let i = 1; i <= 3; i += 1) {
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
      const bumped = new Date(2026, 7, 1, 0, i, 0);
      utimesSync(journal.paths.status, bumped, bumped);
      watcher.poll();
    }

    assert.equal(lines.length, 1, 'беда должна быть названа один раз, а не на каждую пересборку');
    assert.match(lines[0] ?? '', /skewed/);
    assert.match(lines[0] ?? '', /run\.json/);
    assert.match(lines[0] ?? '', /bogus_field/);
    assert.match(lines[0] ?? '', /версия журнала/);
    assert.match(lines[0] ?? '', /версия читателя/);
    assert.match(lines[0] ?? '', /stepcast down && stepcast up/);
    watcher.dispose();
  });

  /**
   * Найдено ревью: между записью манифеста и первой записью состояния лежат
   * секунды, а опрос идёт раз в секунду. Строка «status.json — файл не
   * найден» о здоровом прогоне легла бы в `~/.stepcast/ui.log` навсегда и
   * обесценила бы правило «одна строка на беду».
   */
  it('не печатает в лог ещё не записанные файлы начинающегося прогона', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, { runId: 'starting' });
    rmSync(journal.paths.status);
    rmSync(journal.paths.usage, { force: true });

    const lines: string[] = [];
    const watcher = createWatcher({ runsRoot, intervalMs: 10_000, log: (line) => lines.push(line) });
    watcher.poll();

    assert.deepEqual(lines, [], 'отсутствие ещё не записанного файла отказом разбора не является');
    watcher.dispose();
  });

  it('печатает отказ разбора сводки расхода', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, { runId: 'usage-broken' });

    const raw = JSON.parse(readFileSync(journal.paths.usage, 'utf8')) as Record<string, unknown>;
    raw.bogus_field = 'x';
    writeFileSync(journal.paths.usage, `${JSON.stringify(raw, null, 2)}\n`);

    const lines: string[] = [];
    const watcher = createWatcher({ runsRoot, intervalMs: 10_000, log: (line) => lines.push(line) });

    assert.equal(lines.length, 1, 'сводка расхода — такой же файл журнала, как манифест');
    assert.match(lines[0] ?? '', /usage\.json/);
    assert.match(lines[0] ?? '', /bogus_field/);
    watcher.dispose();
  });
});
