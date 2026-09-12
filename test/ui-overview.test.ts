import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { buildOverview } from '../src/ui/overview.js';
import { cleanupRun, removeRunWithStats } from '../src/core/run/cleanup.js';
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
    assert.equal(broken.problem?.kind, 'missing');
  });

  // Сценарий: «Незнакомый ключ»
  it('прогон с полем, которого читатель не знает, остаётся в обзоре с расхождением версий', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, { runId: 'skewed' });

    const raw = JSON.parse(readFileSync(journal.paths.manifest, 'utf8')) as Record<string, unknown>;
    raw.bogus_field = 'x';
    writeFileSync(journal.paths.manifest, `${JSON.stringify(raw, null, 2)}\n`);

    const runs = buildOverview(runsRoot).projects[0]?.runs ?? [];
    const skewed = runs.find((run) => run.runId === 'skewed');

    assert.ok(skewed !== undefined, 'прогон с расхождением версий не должен пропадать из обзора');
    assert.equal(skewed.problem?.kind, 'version-skew');
    assert.equal(skewed.problem?.file, 'run.json');
    assert.match(skewed.problem?.detail ?? '', /bogus_field/);
    assert.ok(skewed.problem?.journalFormat !== undefined);
    assert.ok(skewed.problem?.readerFormat !== undefined);
  });

  /**
   * Найдено ревью: `status.json` пишется позже манифеста, и опрос застаёт
   * начинающийся прогон без него. Обвинять здоровый прогон бедой нельзя.
   */
  it('не считает бедой ещё не записанные состояние и сводку расхода', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, { runId: 'starting' });
    rmSync(journal.paths.status);
    rmSync(journal.paths.usage, { force: true });

    const run = buildOverview(runsRoot).projects[0]?.runs[0];
    assert.equal(run?.runId, 'starting');
    assert.equal(run?.problem, undefined);
  });

  it('называет отказ разбора сводки расхода, когда манифест и состояние читаются', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, { runId: 'usage-broken' });

    const raw = JSON.parse(readFileSync(journal.paths.usage, 'utf8')) as Record<string, unknown>;
    raw.bogus_field = 'x';
    writeFileSync(journal.paths.usage, `${JSON.stringify(raw, null, 2)}\n`);

    const run = buildOverview(runsRoot).projects[0]?.runs[0];
    assert.equal(run?.problem?.kind, 'version-skew');
    assert.equal(run?.problem?.file, 'usage.json');
    assert.match(run?.problem?.detail ?? '', /bogus_field/);
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

  // Сценарий user-decision-steps: «Ожидающие прогоны видны втрое» (обзор)
  it('показывает ожидание решения тем же полем, что и момент пробуждения', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, {
      runId: 'awaiting-run',
      status: 'running',
      jobs: [{ id: 'apply', status: 'running', steps: [] }],
      awaiting: [
        {
          wait_id: 'w1',
          job: 'apply',
          step: 'gate',
          outcomes: { approve: { effect: 'continue' } },
          prompt: 'продолжить?',
          since: '2026-08-23T22:00:00.000Z',
        },
      ],
    });

    const run = buildOverview(runsRoot).projects[0]?.runs[0];
    assert.equal(run?.running, true);
    assert.equal(run?.awaiting?.length, 1);
    assert.equal(run?.awaiting?.[0]?.job, 'apply');
    assert.equal(run?.awaiting?.[0]?.step, 'gate');
  });

  it('прогон без ожиданий не несёт поля awaiting', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'plain', status: 'running' });

    const run = buildOverview(runsRoot).projects[0]?.runs[0];
    assert.equal(run?.awaiting, undefined);
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
    // Не «идущий прогон» — у того сводка уже есть: это окно до первой её
    // записи или прогон прежней формы, не доживший до конца.
    seedRun(runsRoot, projectRoot, { runId: 'nosummary', status: 'running', skipUsage: true });

    const runs = buildOverview(runsRoot).projects[0]?.runs ?? [];
    const aggregated = runs.find((run) => run.runId === 'aggregated');
    const nosummary = runs.find((run) => run.runId === 'nosummary');

    assert.equal(aggregated?.usage?.aggregated, true);
    assert.equal(aggregated?.usage?.billableTokens, 150);
    assert.equal(nosummary?.usage?.aggregated, false);
    assert.equal(nosummary?.usage?.billableTokens, 0);
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
    seedRun(runsRoot, projectRoot, { runId: 'nosummary', status: 'running', skipUsage: true });

    const runs = buildOverview(runsRoot).projects[0]?.runs ?? [];
    assert.deepEqual(runs.find((run) => run.runId === 'aggregated')?.usage?.breakdown, {
      tokensIn: 100,
      tokensOut: 50,
      cacheRead: 900,
      cacheWrite: 30,
    });
    // Разрез отсутствует не у идущего прогона, а у прогона без сводки вовсе:
    // состояние хранит одну сумму, и разложить её по видам можно было бы
    // только выдумкой. Идущий прогон со сводкой разрез несёт — тест ниже.
    assert.equal(runs.find((run) => run.runId === 'nosummary')?.usage?.breakdown, undefined);
  });

  // Требование: «Незаконченная сводка расхода помечена в самом файле» (usage-live-progress)
  it('идущий прогон со сводкой несёт разрез по видам токенов и признак незаконченности', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, {
      runId: 'live',
      status: 'running',
      usage: {
        run_id: 'live',
        partial: true,
        total: {
          tokens_in: 40,
          tokens_out: 10,
          cache_read: 0,
          cache_write: 0,
          billable_tokens: 50,
          wallclock_ms: 1_000,
        },
        unreported: [],
        jobs: {},
      },
    });
    seedRun(runsRoot, projectRoot, { runId: 'done' });

    const runs = buildOverview(runsRoot).projects[0]?.runs ?? [];
    const live = runs.find((run) => run.runId === 'live');
    const done = runs.find((run) => run.runId === 'done');

    assert.equal(live?.usage?.aggregated, true, 'сводка прочитана, пусть и незаконченная');
    assert.equal(live?.usage?.partial, true);
    assert.deepEqual(live?.usage?.breakdown, { tokensIn: 40, tokensOut: 10, cacheRead: 0, cacheWrite: 0 });
    // Сводка без поля — прежняя форма или сводка, записанная последней:
    // читается как подведённая.
    assert.equal(done?.usage?.partial, false);
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

  // Требование ui-dashboard «Прогон без файлов остаётся видимым и отличимым».
  it('прогон без файлов виден в обзоре с признаком filesGone и отличим от убранного', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    seedRun(runsRoot, projectRoot, {
      runId: 'gone',
      usage: {
        run_id: 'gone',
        total: { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, billable_tokens: 40, wallclock_ms: 40, cost_usd: 4 },
        unreported: [],
        jobs: {},
      },
    });
    const sweptJournal = seedRun(runsRoot, projectRoot, { runId: 'swept' });
    cleanupRun(sweptJournal.paths);

    const result = removeRunWithStats(runsRoot, key, 'gone');
    assert.equal(result.stats, 'kept');

    const overview = buildOverview(runsRoot);
    const runs = overview.projects.find((p) => p.key === key)?.runs ?? [];
    const gone = runs.find((r) => r.runId === 'gone');
    const swept = runs.find((r) => r.runId === 'swept');

    assert.ok(gone !== undefined, 'прогон без файлов обязан остаться в обзоре');
    assert.equal(gone.filesGone, true);
    assert.equal(gone.swept, false);
    assert.equal(gone.usage?.billableTokens, 40);
    assert.equal(gone.usage?.costUsd, 4);

    assert.ok(swept !== undefined);
    assert.equal(swept.swept, true);
    assert.equal(swept.filesGone, false, 'убранный прогон отличим от прогона без файлов');
  });

  it('прогон без файлов и без записи в обзоре отсутствует', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    seedRun(runsRoot, projectRoot, { runId: 'kept' });
    seedRun(runsRoot, projectRoot, { runId: 'erased' });

    removeRunWithStats(runsRoot, key, 'erased', 'drop');

    const runs = buildOverview(runsRoot).projects.find((p) => p.key === key)?.runs ?? [];
    assert.equal(
      runs.some((r) => r.runId === 'erased'),
      false,
    );
    assert.ok(runs.some((r) => r.runId === 'kept'));
  });
});
