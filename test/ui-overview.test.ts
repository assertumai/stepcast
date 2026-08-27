import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { buildOverview } from '../src/ui/overview.js';
import { cleanupRun } from '../src/core/run/cleanup.js';
import { projectKey } from '../src/core/journal/paths.js';
import { makeJournalBed, seedRun } from './helpers.js';

describe('ui-dashboard: обзор всех проектов и прогонов', () => {
  // Сценарий: «Прогоны нескольких проектов в одном обзоре»
  it('показывает прогоны двух разных проектов', () => {
    const first = makeJournalBed();
    const second = makeJournalBed();

    seedRun(first.runsRoot, first.projectRoot, { runId: 'a' });
    seedRun(first.runsRoot, second.projectRoot, { runId: 'b' });

    const overview = buildOverview(first.runsRoot);
    assert.equal(overview.projects.length, 2);
    assert.deepEqual(
      overview.projects.map((project) => project.path).sort(),
      [first.projectRoot, second.projectRoot].sort(),
    );
  });

  // Сценарий: «Порядок прогонов»
  it('перечисляет прогоны проекта новейшими первыми', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: '2026-08-01T00-00-00Z-aaa' });
    seedRun(runsRoot, projectRoot, { runId: '2026-08-02T00-00-00Z-bbb' });
    seedRun(runsRoot, projectRoot, { runId: '2026-08-03T00-00-00Z-ccc' });

    const runs = buildOverview(runsRoot).projects[0]?.runs ?? [];
    assert.deepEqual(
      runs.map((run) => run.shortId),
      ['ccc', 'bbb', 'aaa'],
    );
  });

  // Сценарий: «Идущий прогон отличим от завершённого»
  it('отличает идущий прогон от завершённого', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'done', status: 'success' });
    seedRun(runsRoot, projectRoot, { runId: 'going', status: 'running' });

    const runs = buildOverview(runsRoot).projects[0]?.runs ?? [];
    const going = runs.find((run) => run.runId === 'going');
    const done = runs.find((run) => run.runId === 'done');

    assert.equal(going?.running, true);
    assert.equal(going?.status, 'running');
    assert.equal(done?.running, false);
    assert.equal(done?.status, 'success');
  });

  // Сценарий: «Проект без записи в указателе»
  it('показывает проект без пути, если его нет в указателе', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });

    // Каталог проекта без записи в указателе и без прогонов в обзор не
    // попадает; с прогоном — попадает, но без пути.
    const orphanKey = 'ffffffffffff';
    mkdirSync(join(runsRoot, orphanKey, 'orphan-run'), { recursive: true });

    const orphan = buildOverview(runsRoot).projects.find((project) => project.key === orphanKey);
    assert.ok(orphan !== undefined);
    assert.equal(orphan.path, undefined);
    assert.equal(orphan.runs.length, 1);
  });

  // Сценарий: «Прогон с нечитаемым состоянием»
  it('оставляет в обзоре прогон, чьи манифест и состояние не читаются', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'good' });
    mkdirSync(join(runsRoot, projectKey(projectRoot), 'broken'), { recursive: true });

    const runs = buildOverview(runsRoot).projects[0]?.runs ?? [];
    const broken = runs.find((run) => run.runId === 'broken');

    assert.ok(broken !== undefined, 'битый прогон не должен молча исчезать из обзора');
    assert.equal(broken.unreadable, true);
    assert.equal(broken.status, undefined);
  });

  // Сценарий: «Убранный прогон в обзоре»
  it('оставляет в обзоре прогон, подвергшийся уборке', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, { runId: 'swept', artifacts: { build: {} } });
    cleanupRun(journal.paths);

    const run = buildOverview(runsRoot).projects[0]?.runs[0];
    assert.equal(run?.runId, 'swept');
    assert.equal(run?.swept, true);
    assert.equal(run?.status, 'success');
    assert.equal(run?.unreadable, false);
  });

  // Сценарий: «Спящий прогон отличим от зависшего»
  it('показывает момент пробуждения спящего прогона', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, {
      runId: 'sleeping',
      status: 'running',
      wakeAt: '2026-08-23T22:00:00.000Z',
    });

    const run = buildOverview(runsRoot).projects[0]?.runs[0];
    assert.equal(run?.running, true);
    assert.equal(run?.wakeAt, '2026-08-23T22:00:00.000Z');
  });

  it('на пустом корне прогонов отдаёт пустой обзор', () => {
    const { runsRoot } = makeJournalBed();
    assert.deepEqual(buildOverview(runsRoot).projects, []);
  });

  // Сценарий: «Расход прогона в обзоре»
  it('показывает расход прогона, в том числе для прогона без сводки', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, {
      runId: 'aggregated',
      usage: {
        run_id: 'aggregated',
        total: { tokens_in: 100, tokens_out: 50, cache_read: 0, cache_write: 0, billable_tokens: 150, wallclock_ms: 5_000 },
        unreported: [],
        jobs: {},
      },
    });
    seedRun(runsRoot, projectRoot, { runId: 'going', status: 'running', skipUsage: true });

    const runs = buildOverview(runsRoot).projects[0]?.runs ?? [];
    const aggregated = runs.find((run) => run.runId === 'aggregated');
    const going = runs.find((run) => run.runId === 'going');

    assert.equal(aggregated?.usage?.aggregated, true);
    assert.equal(aggregated?.usage?.billableTokens, 150);
    assert.equal(going?.usage?.aggregated, false);
    assert.equal(going?.usage?.billableTokens, 0);
  });

  // Требование: «Прогон показывает расход с разрезом по видам токенов»
  it('раскладывает токены по видам у прогона со сводкой и молчит о разрезе без неё', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, {
      runId: 'aggregated',
      usage: {
        run_id: 'aggregated',
        total: {
          tokens_in: 100,
          tokens_out: 50,
          cache_read: 900,
          cache_write: 30,
          billable_tokens: 180,
          wallclock_ms: 5_000,
        },
        unreported: [],
        jobs: {},
      },
    });
    seedRun(runsRoot, projectRoot, { runId: 'going', status: 'running', skipUsage: true });

    const runs = buildOverview(runsRoot).projects[0]?.runs ?? [];
    assert.deepEqual(runs.find((run) => run.runId === 'aggregated')?.usage?.breakdown, {
      tokensIn: 100,
      tokensOut: 50,
      cacheRead: 900,
      cacheWrite: 30,
    });
    // На идущем прогоне разреза нет: состояние хранит одну сумму, и
    // разложить её по видам можно было бы только выдумкой.
    assert.equal(runs.find((run) => run.runId === 'going')?.usage?.breakdown, undefined);
  });

  it('считает продолжительность по отметкам манифеста, а у идущего — до сих пор', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'finished' });
    seedRun(runsRoot, projectRoot, {
      runId: 'going',
      status: 'running',
      manifest: { started_at: '2026-08-01T00:00:00.000Z', finished_at: undefined },
    });

    const now = new Date('2026-08-01T00:10:00.000Z');
    const runs = buildOverview(runsRoot, now).projects[0]?.runs ?? [];

    assert.equal(runs.find((run) => run.runId === 'finished')?.durationMs, 5 * 60_000);
    assert.equal(runs.find((run) => run.runId === 'going')?.durationMs, 10 * 60_000);
  });

  // Сценарий: «Оборванный и идущий рядом»
  it('отличает оборванный прогон от живого идущего', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, {
      runId: 'alive',
      status: 'running',
      manifest: { started_at: new Date().toISOString(), pid: process.pid },
    });
    seedRun(runsRoot, projectRoot, {
      runId: 'abandoned',
      status: 'running',
      manifest: { started_at: new Date().toISOString(), pid: 999_999_999 },
    });

    const runs = buildOverview(runsRoot).projects[0]?.runs ?? [];

    assert.equal(runs.find((run) => run.runId === 'alive')?.running, true);
    assert.equal(runs.find((run) => run.runId === 'alive')?.abandoned, false);
    assert.equal(runs.find((run) => run.runId === 'abandoned')?.running, true);
    assert.equal(runs.find((run) => run.runId === 'abandoned')?.abandoned, true);
  });

  // Сценарий: «Завершённый прогон не оборван»
  it('признак оборванности ложен у завершённого прогона', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'done', status: 'success' });

    const run = buildOverview(runsRoot).projects[0]?.runs[0];
    assert.equal(run?.abandoned, false);
  });

  // Сценарий: «Обзор не считает размеров»
  it('не считает размеров каталогов', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });

    const run = buildOverview(runsRoot).projects[0]?.runs[0];
    assert.ok(run !== undefined);
    assert.ok(!('sizeBytes' in run), 'размер не место обзору: он нужен только в подтверждении');

    // Обход каталога делает `dirSize` из cleanup.ts. Подменить функцию
    // встроенного модуля в ESM нельзя — как process.kill выше, — поэтому
    // проверяется то, что проверке доступно: обзор о ней вовсе не знает, и
    // её появление здесь заметит именно эта проверка.
    const source = readFileSync(new URL('../src/ui/overview.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /dirSize|run\/cleanup/);
  });

  it('не проверяет живость процесса для прогона вне running', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'done', status: 'success' });

    // Живость проверяется через process.kill; для прогона вне running
    // isRunAlive не должен даже дойти до сигнала процессу.
    const originalKill = process.kill;
    process.kill = (() => {
      throw new Error('process.kill не должен звонить для прогона вне running');
    }) as typeof process.kill;
    try {
      const run = buildOverview(runsRoot).projects[0]?.runs[0];
      assert.equal(run?.abandoned, false);
    } finally {
      process.kill = originalKill;
    }
  });
});
