import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  collectFilterValues,
  runDuration,
  viewRuns,
  DEFAULT_SORT,
  type ProjectLike,
  type RunFilters,
  type RunLike,
  type SortOrder,
} from '../src/parts/ui/runsView.js';

/** Прогон обзора с разумными умолчаниями — тест переопределяет только то, что проверяет. */
function run(overrides: Partial<RunLike> & { readonly runId: string }): RunLike {
  return {
    pipeline: 'demo',
    running: false,
    ...overrides,
  };
}

function project<R extends RunLike>(key: string, runs: readonly R[], path?: string): ProjectLike<R> {
  return { key, ...(path === undefined ? {} : { path }), runs };
}

describe('runsView: фильтры', () => {
  it('объединяются по «и»: проект и статус вместе сужают список', () => {
    const projects = [
      project('p1', [
        run({ runId: 'a', status: 'failed' }),
        run({ runId: 'b', status: 'success' }),
      ]),
      project('p2', [run({ runId: 'c', status: 'failed' })]),
    ];

    const filters: RunFilters = { project: 'p1', status: 'failed' };
    const rows = viewRuns(projects, filters, DEFAULT_SORT, 0);

    assert.deepEqual(rows.map((row) => row.address), ['p1/a']);
  });

  it('два файла пайплайна с одним именем не смешиваются', () => {
    const projects = [
      project('p1', [
        run({ runId: 'a', pipeline: 'build', pipelineFile: 'a.yml' }),
        run({ runId: 'b', pipeline: 'build', pipelineFile: 'b.yml' }),
      ]),
    ];

    const values = collectFilterValues(projects);
    assert.equal(values.pipelines.length, 2, 'два файла — два разных значения фильтра');

    const fileA = values.pipelines.find((option) => option.label.includes('a.yml'));
    assert.ok(fileA !== undefined);

    const rows = viewRuns(projects, { pipeline: fileA.value }, DEFAULT_SORT, 0);
    assert.deepEqual(rows.map((row) => row.address), ['p1/a']);
  });

  it('прогон без файла пайплайна отбирается по имени', () => {
    const projects = [
      project('p1', [
        run({ runId: 'a', pipeline: 'named' }),
        run({ runId: 'b', pipeline: 'named' }),
        run({ runId: 'c', pipeline: '' }),
      ]),
    ];

    const values = collectFilterValues(projects);
    assert.equal(values.pipelines.length, 2, '«named» и «без имени» — два разных значения');

    const named = values.pipelines.find((option) => option.label === 'named');
    assert.ok(named !== undefined);
    const rows = viewRuns(projects, { pipeline: named.value }, DEFAULT_SORT, 0);
    assert.deepEqual(
      rows.map((row) => row.address).sort(),
      ['p1/a', 'p1/b'],
    );
  });

  it('выбранное значение, исчезнувшее из обзора, даёт пустой список, а не другую линзу', () => {
    const projects = [project('p1', [run({ runId: 'a', status: 'success' })])];

    const rows = viewRuns(projects, { project: 'ушедший-проект' }, DEFAULT_SORT, 0);
    assert.deepEqual(rows, []);
  });
});

describe('runsView: порядок', () => {
  const NOW = 1_000_000;

  it('по времени начала, в обе стороны', () => {
    const projects = [
      project('p1', [
        run({ runId: 'old', startedAt: '2026-01-01T00:00:00.000Z' }),
        run({ runId: 'new', startedAt: '2026-02-01T00:00:00.000Z' }),
      ]),
    ];

    const desc = viewRuns(projects, {}, { metric: 'startedAt', direction: 'desc' }, NOW);
    assert.deepEqual(desc.map((row) => row.address), ['p1/new', 'p1/old']);

    const asc = viewRuns(projects, {}, { metric: 'startedAt', direction: 'asc' }, NOW);
    assert.deepEqual(asc.map((row) => row.address), ['p1/old', 'p1/new']);
  });

  it('по длительности, в обе стороны', () => {
    const projects = [
      project('p1', [
        run({ runId: 'short', durationMs: 1_000 }),
        run({ runId: 'long', durationMs: 60_000 }),
      ]),
    ];

    const order: SortOrder = { metric: 'duration', direction: 'desc' };
    assert.deepEqual(
      viewRuns(projects, {}, order, NOW).map((row) => row.address),
      ['p1/long', 'p1/short'],
    );
    assert.deepEqual(
      viewRuns(projects, {}, { ...order, direction: 'asc' }, NOW).map((row) => row.address),
      ['p1/short', 'p1/long'],
    );
  });

  it('по стоимости, в обе стороны', () => {
    const projects = [
      project('p1', [
        run({ runId: 'cheap', usage: { costUsd: 1, billableTokens: 0 } }),
        run({ runId: 'costly', usage: { costUsd: 9, billableTokens: 0 } }),
      ]),
    ];

    const order: SortOrder = { metric: 'cost', direction: 'desc' };
    assert.deepEqual(
      viewRuns(projects, {}, order, NOW).map((row) => row.address),
      ['p1/costly', 'p1/cheap'],
    );
    assert.deepEqual(
      viewRuns(projects, {}, { ...order, direction: 'asc' }, NOW).map((row) => row.address),
      ['p1/cheap', 'p1/costly'],
    );
  });

  it('по числу токенов, в обе стороны', () => {
    const projects = [
      project('p1', [
        run({ runId: 'few', usage: { costUsd: null, billableTokens: 10 } }),
        run({ runId: 'many', usage: { costUsd: null, billableTokens: 1_000 } }),
      ]),
    ];

    const order: SortOrder = { metric: 'tokens', direction: 'desc' };
    assert.deepEqual(
      viewRuns(projects, {}, order, NOW).map((row) => row.address),
      ['p1/many', 'p1/few'],
    );
    assert.deepEqual(
      viewRuns(projects, {}, { ...order, direction: 'asc' }, NOW).map((row) => row.address),
      ['p1/few', 'p1/many'],
    );
  });

  it('прогон без величины уходит в конец при обоих направлениях', () => {
    const projects = [
      project('p1', [
        run({ runId: 'unreported', startedAt: '2026-01-01T00:00:00.000Z' }),
        run({ runId: 'null-cost', usage: { costUsd: null, billableTokens: 5 }, startedAt: '2026-01-02T00:00:00.000Z' }),
        run({ runId: 'priced', usage: { costUsd: 3, billableTokens: 5 }, startedAt: '2026-01-03T00:00:00.000Z' }),
      ]),
    ];

    const order: SortOrder = { metric: 'cost', direction: 'desc' };
    const desc = viewRuns(projects, {}, order, NOW).map((row) => row.address);
    assert.deepEqual(desc.slice(0, 1), ['p1/priced']);
    assert.deepEqual(desc.slice(1).sort(), ['p1/null-cost', 'p1/unreported'].sort());

    const asc = viewRuns(projects, {}, { ...order, direction: 'asc' }, NOW).map((row) => row.address);
    assert.deepEqual(
      asc.slice(0, 1),
      ['p1/priced'],
      'единственная известная величина идёт первой и при возрастании — неизвестные не приравниваются к нулю',
    );
    assert.deepEqual(asc.slice(1).sort(), ['p1/null-cost', 'p1/unreported'].sort());
  });

  it('равные величины идут новейшими первыми', () => {
    const projects = [
      project('p1', [
        run({ runId: 'older', usage: { costUsd: 5, billableTokens: 0 }, startedAt: '2026-01-01T00:00:00.000Z' }),
        run({ runId: 'newer', usage: { costUsd: 5, billableTokens: 0 }, startedAt: '2026-02-01T00:00:00.000Z' }),
      ]),
    ];

    const order: SortOrder = { metric: 'cost', direction: 'desc' };
    assert.deepEqual(
      viewRuns(projects, {}, order, NOW).map((row) => row.address),
      ['p1/newer', 'p1/older'],
    );
  });

  it('идущий прогон встаёт по длительности, посчитанной от начала', () => {
    const startedAt = new Date(NOW - 5_000).toISOString();
    const projects = [
      project('p1', [
        run({ runId: 'going', running: true, startedAt, durationMs: 1 }),
        run({ runId: 'done', durationMs: 2_000 }),
      ]),
    ];

    const order: SortOrder = { metric: 'duration', direction: 'desc' };
    assert.deepEqual(
      viewRuns(projects, {}, order, NOW).map((row) => row.address),
      ['p1/going', 'p1/done'],
      'у идущего прогона длительность — 5с от начала, дольше готовых 2с у завершённого',
    );
  });

  it('умолчание — новейшими первыми', () => {
    const projects = [
      project('p1', [
        run({ runId: 'old', startedAt: '2026-01-01T00:00:00.000Z' }),
        run({ runId: 'new', startedAt: '2026-02-01T00:00:00.000Z' }),
      ]),
    ];

    assert.deepEqual(
      viewRuns(projects, {}, DEFAULT_SORT, NOW).map((row) => row.address),
      ['p1/new', 'p1/old'],
    );
  });
});

describe('runsView: длительность идущего прогона', () => {
  it('считается от начала до текущего момента', () => {
    const started = new Date('2026-01-01T00:00:00.000Z').getTime();
    const now = started + 5_000;
    assert.equal(runDuration(run({ runId: 'a', running: true, startedAt: new Date(started).toISOString() }), now), 5_000);
  });

  it('у завершённого — готовое значение обзора', () => {
    assert.equal(runDuration(run({ runId: 'a', running: false, durationMs: 42 }), 999), 42);
  });
});
