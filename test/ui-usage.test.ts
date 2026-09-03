import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { cleanupRun } from '../src/core/run/cleanup.js';
import { projectKey } from '../src/core/journal/paths.js';
import { buildOverview, type Overview } from '../src/ui/overview.js';
import { buildUsage, NO_PIPELINE, UNKNOWN_MODEL } from '../src/ui/usage.js';
import { makeJournalBed, seedRun } from './helpers.js';

describe('ui-dashboard: расход поперёк прогонов', () => {
  // Сценарии: «Итог за период», «Столбцы по дням с долями моделей», «День без прогонов»
  it('складывает прогоны разных дней и моделей в итог периода, models по деньгам, days по календарю', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, {
      runId: 'a',
      manifest: { started_at: '2026-08-01T09:00:00.000Z' },
      usage: {
        run_id: 'a',
        total: { tokens_in: 900, tokens_out: 100, cache_read: 0, cache_write: 0, billable_tokens: 1000, wallclock_ms: 5_000, cost_usd: 10 },
        unreported: [],
        jobs: {
          build: {
            billable_tokens: 1000,
            wallclock_ms: 5_000,
            cost_usd: 10,
            steps: {
              write: {
                billable_tokens: 1000,
                wallclock_ms: 5_000,
                cost_usd: 10,
                attempts: [{ attempt: 1, backend: 'claude', model: 'opus', billable_tokens: 1000, wallclock_ms: 5_000, cost_usd: 10 }],
              },
            },
          },
        },
      },
    });
    seedRun(runsRoot, projectRoot, {
      runId: 'b',
      manifest: { started_at: '2026-08-03T09:00:00.000Z' },
      usage: {
        run_id: 'b',
        total: { tokens_in: 450, tokens_out: 50, cache_read: 0, cache_write: 0, billable_tokens: 500, wallclock_ms: 3_000, cost_usd: 5 },
        unreported: [],
        jobs: {
          build: {
            billable_tokens: 500,
            wallclock_ms: 3_000,
            cost_usd: 5,
            steps: {
              write: {
                billable_tokens: 500,
                wallclock_ms: 3_000,
                cost_usd: 5,
                attempts: [{ attempt: 1, backend: 'claude', model: 'sonnet', billable_tokens: 500, wallclock_ms: 3_000, cost_usd: 5 }],
              },
            },
          },
        },
      },
    });

    const now = new Date('2026-08-03T12:00:00.000Z');
    const overview = buildOverview(runsRoot, now);
    const usage = buildUsage(runsRoot, overview, { days: 3, now });

    assert.equal(usage.from, '2026-08-01');
    assert.equal(usage.to, '2026-08-03');
    assert.equal(usage.total.runs, 2);
    assert.equal(usage.total.billableTokens, 1500);
    assert.equal(usage.total.costUsd, 15);
    // По убыванию денег: opus (10) впереди sonnet (5).
    assert.deepEqual(usage.models, [
      { model: 'opus', billableTokens: 1000, costUsd: 10 },
      { model: 'sonnet', billableTokens: 500, costUsd: 5 },
    ]);
    assert.deepEqual(
      usage.days.map((day) => day.day),
      ['2026-08-01', '2026-08-02', '2026-08-03'],
    );
    // День без единого прогона остаётся в ряду пустым столбцом.
    assert.deepEqual(usage.days[1]?.models, []);
    assert.deepEqual(usage.days[0]?.models, [{ model: 'opus', billableTokens: 1000, costUsd: 10 }]);
    assert.deepEqual(usage.days[2]?.models, [{ model: 'sonnet', billableTokens: 500, costUsd: 5 }]);
  });

  // Сценарий: «Прогон относится к дню своего старта»
  it('прогон, начавшийся перед полуночью и кончившийся назавтра, целиком лежит в дне старта', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    // Местное время, а не UTC: день считается в поясе демона (Решение 3), и
    // проверка не должна зависеть от пояса машины, на которой её гоняют.
    const started = new Date(2026, 7, 1, 23, 30);
    const finished = new Date(2026, 7, 2, 1, 0);
    seedRun(runsRoot, projectRoot, {
      runId: 'overnight',
      manifest: { started_at: started.toISOString(), finished_at: finished.toISOString() },
      usage: {
        run_id: 'overnight',
        total: { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, billable_tokens: 800, wallclock_ms: 5_400_000, cost_usd: 8 },
        unreported: [],
        jobs: {
          build: {
            billable_tokens: 800,
            wallclock_ms: 5_400_000,
            cost_usd: 8,
            steps: {
              write: {
                billable_tokens: 800,
                wallclock_ms: 5_400_000,
                cost_usd: 8,
                attempts: [{ attempt: 1, backend: 'claude', model: 'opus', billable_tokens: 800, wallclock_ms: 5_400_000, cost_usd: 8 }],
              },
            },
          },
        },
      },
    });

    const now = new Date(2026, 7, 2, 12, 0);
    const overview = buildOverview(runsRoot, now);
    const usage = buildUsage(runsRoot, overview, { days: 2, now });

    assert.deepEqual(
      usage.days.map((day) => day.day),
      ['2026-08-01', '2026-08-02'],
    );
    assert.deepEqual(usage.days[0]?.models, [{ model: 'opus', billableTokens: 800, costUsd: 8 }]);
    // День завершения остаётся пустым: расход не делится между сутками.
    assert.deepEqual(usage.days[1]?.models, []);
    assert.equal(usage.pipelines[0]?.runs[0]?.day, '2026-08-01');
  });

  // Требование «Сумма столбцов периода сходится с итогом за период»
  it('перенесённая попытка не раздувает разрез: доли ужаты до итога прогона', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    // Шаг, продолживший оборванную сессию: расход перенесённой попытки лежит
    // в сводке шага, но в итог прогона не входит (`docs/run-layout.md`,
    // раздел «Возобновление»). Сумма попыток здесь вдвое больше итога.
    seedRun(runsRoot, projectRoot, {
      runId: 'continued',
      manifest: { started_at: '2026-08-01T09:00:00.000Z' },
      usage: {
        run_id: 'continued',
        total: { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, billable_tokens: 1000, wallclock_ms: 1_000, cost_usd: 10 },
        unreported: [],
        jobs: {
          build: {
            billable_tokens: 2000,
            wallclock_ms: 1_000,
            cost_usd: 20,
            steps: {
              write: {
                billable_tokens: 2000,
                wallclock_ms: 1_000,
                cost_usd: 20,
                attempts: [
                  { attempt: 1, backend: 'claude', model: 'opus', billable_tokens: 1500, wallclock_ms: 700, cost_usd: 15 },
                  { attempt: 2, backend: 'claude', model: 'sonnet', billable_tokens: 500, wallclock_ms: 300, cost_usd: 5 },
                ],
              },
            },
          },
        },
      },
    });

    const now = new Date('2026-08-01T12:00:00.000Z');
    const overview = buildOverview(runsRoot, now);
    const usage = buildUsage(runsRoot, overview, { days: 1, now });

    // Итог — из обзора, тот же, что показывает экран «Прогоны».
    assert.equal(usage.total.billableTokens, 1000);
    assert.equal(usage.total.costUsd, 10);
    // Доли ужаты пропорционально и складываются ровно в итог.
    assert.deepEqual(usage.models, [
      { model: 'opus', billableTokens: 750, costUsd: 7.5 },
      { model: 'sonnet', billableTokens: 250, costUsd: 2.5 },
    ]);
    const columns = usage.days.flatMap((day) => day.models);
    assert.equal(
      columns.reduce((sum, slice) => sum + slice.billableTokens, 0),
      usage.total.billableTokens,
    );
    assert.equal(
      columns.reduce((sum, slice) => sum + slice.costUsd, 0),
      usage.total.costUsd,
    );
    // Строка пайплайна считается из того же итога: разойтись им негде.
    assert.equal(usage.pipelines[0]?.billableTokens, 1000);
    assert.equal(usage.pipelines[0]?.costUsd, 10);
  });

  // Сценарии: «Прогон без сводки расхода», «Сводка прежней формы без разбивки по попыткам»
  it('прогон без сводки и сводка прежней формы отдают весь итог долей «модель не сообщена»', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, {
      runId: 'going',
      status: 'running',
      skipUsage: true,
      manifest: { started_at: '2026-08-01T00:00:00.000Z' },
      budget: { tokens_used: 200, wallclock_ms: 1_000, cost_used_usd: 2 },
    });

    const oldForm = seedRun(runsRoot, projectRoot, {
      runId: 'old-form',
      manifest: { started_at: '2026-08-01T00:00:00.000Z' },
    });
    // Форма до разбивки по попыткам: `attempts` — счётчик, а не список
    // (та же форма, что проверяет `test/usage-command.test.ts`).
    writeFileSync(
      oldForm.paths.usage,
      JSON.stringify({
        run_id: 'old-form',
        total: { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, billable_tokens: 300, wallclock_ms: 1_000, cost_usd: 3 },
        unreported: [],
        jobs: {
          build: {
            billable_tokens: 300,
            wallclock_ms: 1_000,
            cost_usd: 3,
            steps: { write: { billable_tokens: 300, wallclock_ms: 1_000, cost_usd: 3, attempts: 1 } },
          },
        },
      }),
    );

    const now = new Date('2026-08-01T12:00:00.000Z');
    const overview = buildOverview(runsRoot, now);
    const usage = buildUsage(runsRoot, overview, { days: 1, now });

    assert.equal(usage.runsWithoutBreakdown, 2);
    assert.deepEqual(usage.models, [{ model: UNKNOWN_MODEL, billableTokens: 500, costUsd: 5 }]);
    assert.equal(usage.total.billableTokens, 500);
    assert.equal(usage.total.costUsd, 5);
    assert.deepEqual(usage.days[0]?.models, [{ model: UNKNOWN_MODEL, billableTokens: 500, costUsd: 5 }]);
  });

  // Сценарий: «Попытка без сообщённой цены»
  it('попытка без cost_usd не входит в денежные суммы, но её токены входят; costUnreportedAttempts назван на итоге, пайплайне и заходе', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, {
      runId: 'a',
      manifest: { started_at: '2026-08-01T00:00:00.000Z' },
      usage: {
        run_id: 'a',
        total: { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, billable_tokens: 700, wallclock_ms: 1_000, cost_usd: 5 },
        unreported: ['reported_cost_usd'],
        jobs: {
          build: {
            billable_tokens: 700,
            wallclock_ms: 1_000,
            cost_usd: 5,
            steps: {
              write: {
                billable_tokens: 700,
                wallclock_ms: 1_000,
                cost_usd: 5,
                attempts: [
                  { attempt: 1, backend: 'claude', model: 'opus', billable_tokens: 200, wallclock_ms: 400 },
                  { attempt: 2, backend: 'claude', model: 'opus', billable_tokens: 500, wallclock_ms: 600, cost_usd: 5 },
                ],
              },
            },
          },
        },
      },
    });

    const now = new Date('2026-08-01T12:00:00.000Z');
    const overview = buildOverview(runsRoot, now);
    const usage = buildUsage(runsRoot, overview, { days: 1, now });

    assert.equal(usage.total.costUnreportedAttempts, 1);
    assert.equal(usage.total.billableTokens, 700);
    assert.equal(usage.total.costUsd, 5);
    assert.deepEqual(usage.models, [{ model: 'opus', billableTokens: 700, costUsd: 5 }]);
    assert.equal(usage.pipelines[0]?.costUnreportedAttempts, 1);
    assert.equal(usage.pipelines[0]?.runs[0]?.costUnreportedAttempts, 1);
  });

  // Сценарии: «Сводка по всем пайплайнам», «Заходы пайплайна со стоимостью каждого»,
  // «Прогон без известного пайплайна»
  it('группирует по «проект + файл пайплайна», прогон без пайплайна — своей строкой, заходы новейшими первыми', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    for (const runId of ['p1-old', 'p1-new', 'p2', 'orphan']) {
      seedRun(runsRoot, projectRoot, { runId, manifest: { started_at: '2026-08-01T00:00:00.000Z' } });
    }

    const measure = { billableTokens: 100, wallclockMs: 0, costUsd: 1, aggregated: true, unreported: [] as const };
    const overview: Overview = {
      generatedAt: '2026-08-02T12:00:00.000Z',
      projects: [
        {
          key,
          path: projectRoot,
          runs: [
            {
              runId: 'p1-old',
              shortId: 'p1-old',
              pipeline: 'один',
              pipelineFile: 'один.yml',
              running: false,
              abandoned: false,
              startedAt: '2026-08-01T00:00:00.000Z',
              swept: false,
              unreadable: false,
              usage: measure,
            },
            {
              runId: 'p1-new',
              shortId: 'p1-new',
              pipeline: 'один',
              pipelineFile: 'один.yml',
              running: false,
              abandoned: false,
              startedAt: '2026-08-02T00:00:00.000Z',
              swept: false,
              unreadable: false,
              usage: measure,
            },
            {
              runId: 'p2',
              shortId: 'p2',
              pipeline: 'два',
              pipelineFile: 'два.yml',
              running: false,
              abandoned: false,
              startedAt: '2026-08-01T00:00:00.000Z',
              swept: false,
              unreadable: false,
              usage: measure,
            },
            // Манифест не читается: ни файла, ни имени пайплайна назвать нечем.
            {
              runId: 'orphan',
              shortId: 'orphan',
              pipeline: '',
              running: false,
              abandoned: false,
              startedAt: '2026-08-01T00:00:00.000Z',
              swept: false,
              unreadable: true,
              usage: measure,
            },
          ],
        },
      ],
    };

    const usage = buildUsage(runsRoot, overview, { days: 2, now: new Date('2026-08-02T12:00:00.000Z') });

    const one = usage.pipelines.find((p) => p.pipeline === 'один');
    assert.deepEqual(
      one?.runs.map((r) => r.runId),
      ['p1-new', 'p1-old'],
    );
    assert.ok(usage.pipelines.some((p) => p.pipeline === 'два'));
    const orphanSlice = usage.pipelines.find((p) => p.pipeline === NO_PIPELINE);
    assert.ok(orphanSlice !== undefined, 'прогон без пайплайна не должен пропасть из разреза');
    assert.deepEqual(
      orphanSlice.runs.map((r) => r.runId),
      ['orphan'],
    );
  });

  // Сценарий: «Прогон без отметки старта»
  it('прогон без читаемого времени старта не входит ни в один день или итог, а считается undated; прогон старее периода исключён', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'in-period', manifest: { started_at: '2026-08-05T00:00:00.000Z' } });
    seedRun(runsRoot, projectRoot, { runId: 'too-old', manifest: { started_at: '2026-07-01T00:00:00.000Z' } });
    // Манифест и состояние оба не читаются: время старта взять неоткуда.
    mkdirSync(join(runsRoot, projectKey(projectRoot), 'broken'), { recursive: true });

    const now = new Date('2026-08-05T12:00:00.000Z');
    const overview = buildOverview(runsRoot, now);
    const usage = buildUsage(runsRoot, overview, { days: 3, now });

    assert.equal(usage.undated, 1);
    assert.equal(usage.total.runs, 1);
    assert.deepEqual(
      usage.pipelines.flatMap((p) => p.runs.map((r) => r.runId)),
      ['in-period'],
    );
  });

  // Требование ui-daemon: «Убранный прогон остаётся в агрегате»
  it('убранный прогон входит в агрегат вместе с разрезом по моделям', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, {
      runId: 'swept',
      manifest: { started_at: '2026-08-01T00:00:00.000Z' },
      artifacts: { build: {} },
      usage: {
        run_id: 'swept',
        total: { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, billable_tokens: 400, wallclock_ms: 1_000, cost_usd: 4 },
        unreported: [],
        jobs: {
          build: {
            billable_tokens: 400,
            wallclock_ms: 1_000,
            cost_usd: 4,
            steps: {
              write: {
                billable_tokens: 400,
                wallclock_ms: 1_000,
                cost_usd: 4,
                attempts: [{ attempt: 1, backend: 'claude', model: 'opus', billable_tokens: 400, wallclock_ms: 1_000, cost_usd: 4 }],
              },
            },
          },
        },
      },
    });
    cleanupRun(journal.paths);

    const now = new Date('2026-08-01T12:00:00.000Z');
    const overview = buildOverview(runsRoot, now);
    const usage = buildUsage(runsRoot, overview, { days: 1, now });

    assert.equal(usage.total.runs, 1);
    assert.equal(usage.total.billableTokens, 400);
    assert.deepEqual(usage.models, [{ model: 'opus', billableTokens: 400, costUsd: 4 }]);
  });
});
