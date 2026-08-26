import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { layoutJobs, type GraphInput } from '../src/ui/graph.js';

/**
 * Раскладка работ графом. Проверяется правило, а не картинка: колонка равна
 * длине длиннейшего пути, и от неё зависит, читается ли зависимость на экране.
 */

function columns(jobs: readonly GraphInput[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const node of layoutJobs(jobs).nodes) out[node.id] = node.column;
  return out;
}

describe('ui-graph: колонки по зависимостям', () => {
  it('выстраивает цепочку по одной работе на колонку', () => {
    assert.deepEqual(
      columns([
        { id: 'a', needs: [] },
        { id: 'b', needs: ['a'] },
        { id: 'c', needs: ['b'] },
      ]),
      { a: 0, b: 1, c: 2 },
    );
  });

  it('сводит ромб: обе ветви на одной колонке, схождение — на следующей', () => {
    assert.deepEqual(
      columns([
        { id: 'a', needs: [] },
        { id: 'left', needs: ['a'] },
        { id: 'right', needs: ['a'] },
        { id: 'join', needs: ['left', 'right'] },
      ]),
      { a: 0, left: 1, right: 1, join: 2 },
    );
  });

  it('ставит работу по длиннейшему пути, а не по первой зависимости', () => {
    assert.deepEqual(
      columns([
        { id: 'a', needs: [] },
        { id: 'b', needs: ['a'] },
        { id: 'c', needs: ['a', 'b'] },
      ]),
      { a: 0, b: 1, c: 2 },
    );
  });

  it('разворачивает needs: all во весь основной граф и ставит работу последней', () => {
    const graph = layoutJobs([
      { id: 'a', needs: [] },
      { id: 'b', needs: ['a'] },
      { id: 'report', needs: ['all'] },
    ]);

    const report = graph.nodes.find((node) => node.id === 'report');
    assert.deepEqual(report?.needs, ['a', 'b']);
    assert.equal(report?.column, 2);
  });

  it('не зависает на цикле, хотя линт его и не пропустит', () => {
    const graph = layoutJobs([
      { id: 'a', needs: ['b'] },
      { id: 'b', needs: ['a'] },
    ]);
    assert.equal(graph.nodes.length, 2);
  });

  it('отбрасывает зависимость на несуществующую работу вместо ребра в пустоту', () => {
    const graph = layoutJobs([{ id: 'a', needs: ['нет-такой'] }]);
    assert.deepEqual(graph.nodes[0]?.needs, []);
    assert.equal(graph.edges.length, 0);
  });

  it('различает работы по строкам внутри колонки', () => {
    const graph = layoutJobs([
      { id: 'left', needs: [] },
      { id: 'right', needs: [] },
    ]);
    assert.deepEqual(
      graph.nodes.map((node) => node.row),
      [0, 1],
    );
  });
});

describe('ui-graph: условные работы и виновник пропуска', () => {
  it('помечает условной работу с if и работу с on, отличным от success', () => {
    const graph = layoutJobs([
      { id: 'plain', needs: [] },
      { id: 'guarded', needs: [], if: 'inputs.deep' },
      { id: 'rescue', needs: [], on: 'failure' },
    ]);

    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    assert.equal(byId.get('plain')?.conditional, false);
    assert.equal(byId.get('guarded')?.conditional, true);
    assert.equal(byId.get('rescue')?.conditional, true);
  });

  it('называет предшественника, чей отказ отменил пропущенную работу', () => {
    const graph = layoutJobs([
      { id: 'review', needs: [], status: 'failed' },
      { id: 'fix', needs: ['review'], status: 'skipped' },
      { id: 'verify', needs: ['fix'], status: 'skipped' },
    ]);

    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    assert.deepEqual(byId.get('fix')?.blockedBy, ['review']);
    // Цепочка отмены показывается по звеньям: у verify виноват её собственный
    // предшественник, а не первопричина. Так на графе видно, куда смотреть
    // дальше, вместо одной подписи «виноват review» под всеми работами сразу.
    assert.deepEqual(byId.get('verify')?.blockedBy, ['fix']);

    const blocking = graph.edges.filter((edge) => edge.blocking);
    assert.deepEqual(
      blocking.map((edge) => `${edge.from}->${edge.to}`),
      ['review->fix', 'fix->verify'],
    );
  });

  it('не считает виновником успешного предшественника работы с on: failure', () => {
    const graph = layoutJobs([
      { id: 'build', needs: [], status: 'success' },
      { id: 'rescue', needs: ['build'], on: 'failure', status: 'skipped' },
    ]);

    assert.deepEqual(graph.nodes[1]?.blockedBy, ['build']);
  });

  it('не назначает виновника, пока предшественник ещё идёт', () => {
    const graph = layoutJobs([
      { id: 'build', needs: [], status: 'running' },
      { id: 'next', needs: ['build'], status: 'skipped' },
    ]);

    assert.deepEqual(graph.nodes[1]?.blockedBy, []);
  });
});
