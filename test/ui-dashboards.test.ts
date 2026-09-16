import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  checkDashboardDocument,
  DashboardDocumentError,
  resolveCellParam,
  type DashboardCellDefinition,
  type DashboardDefinition,
} from '../src/parts/ui/dashboards.js';

function cell(overrides: Partial<DashboardCellDefinition> & Pick<DashboardCellDefinition, 'id'>): DashboardCellDefinition {
  return { widget: 'runs', at: { column: 0, row: 0, width: 4, height: 2 }, ...overrides };
}

describe('ui-dashboards: подстановка и приведение к типу манифеста', () => {
  it('подставляет параметр пути и приводит к строке', () => {
    const result = resolveCellParam('runs', 'project', '${params.project}', { kind: 'string' }, { project: 'demo' });
    assert.deepEqual(result, { ok: true, value: 'demo' });
  });

  it('приводит подставленное значение к числу, а не оставляет строкой', () => {
    const result = resolveCellParam('usage', 'days', '${params.days}', { kind: 'number' }, { days: '20' });
    assert.deepEqual(result, { ok: true, value: 20 });
  });

  it('приводит подставленное значение к булеву', () => {
    const result = resolveCellParam('runs', 'compact', '${params.compact}', { kind: 'boolean' }, { compact: 'true' });
    assert.deepEqual(result, { ok: true, value: true });
  });

  it('литеральное числовое и булево значение ячейки проходит без подстановки', () => {
    assert.deepEqual(resolveCellParam('runs', 'limit', 5, { kind: 'number' }, {}), { ok: true, value: 5 });
    assert.deepEqual(resolveCellParam('runs', 'compact', false, { kind: 'boolean' }, {}), { ok: true, value: false });
  });

  it('значение не того типа — причина называет виджет, параметр, значение и выражение', () => {
    const result = resolveCellParam('usage', 'days', '${params.days}', { kind: 'number' }, { days: 'вчера' });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('unreachable');
    assert.match(result.reason, /usage/);
    assert.match(result.reason, /days/);
    assert.match(result.reason, /вчера/);
    assert.match(result.reason, /\$\{params\.days\}/);
  });

  it('литеральное значение не того типа тоже отказывает, без упоминания выражения', () => {
    const result = resolveCellParam('usage', 'days', 'вчера', { kind: 'number' }, {});
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('unreachable');
    assert.doesNotMatch(result.reason, /выражения/);
  });

  it('пустое значение числом не становится — `Number("")` даёт 0, а это молчаливая подмена', () => {
    for (const empty of ['', '   ']) {
      const result = resolveCellParam('usage', 'days', '${params.days}', { kind: 'number' }, { days: empty });
      assert.equal(result.ok, false, `пустое значение ${JSON.stringify(empty)} не число`);
      if (result.ok) throw new Error('unreachable');
      assert.match(result.reason, /должен быть числом/);
    }
    const literal = resolveCellParam('usage', 'days', '', { kind: 'number' }, {});
    assert.equal(literal.ok, false);
  });

  it('подстановка на имя, которого нет в параметрах маршрута — названная причина', () => {
    const result = resolveCellParam('runs', 'project', '${params.nope}', { kind: 'string' }, {});
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('unreachable');
    assert.match(result.reason, /nope/);
  });

  it('перечень принимает только объявленные значения', () => {
    const type = { kind: 'enum' as const, values: ['ok', 'failed'] };
    assert.deepEqual(resolveCellParam('runs', 'status', 'ok', type, {}), { ok: true, value: 'ok' });
    const bad = resolveCellParam('runs', 'status', 'unknown', type, {});
    assert.equal(bad.ok, false);
  });
});

describe('ui-dashboards: проверки документа', () => {
  const grid = { columns: 12 };

  it('документ без конфликтов не отказывает', () => {
    const doc: DashboardDefinition = {
      grid,
      cells: [cell({ id: 'a', at: { column: 0, row: 0, width: 4, height: 2 } }), cell({ id: 'b', at: { column: 4, row: 0, width: 4, height: 2 } })],
    };
    assert.doesNotThrow(() => checkDashboardDocument(doc));
  });

  it('повтор id ячеек — отказ, называющий этот id', () => {
    const doc: DashboardDefinition = { grid, cells: [cell({ id: 'a' }), cell({ id: 'a' })] };
    assert.throws(
      () => checkDashboardDocument(doc),
      (error: unknown) => {
        assert.ok(error instanceof DashboardDocumentError);
        assert.deepEqual(error.cellIds, ['a']);
        assert.match(error.message, /a/);
        return true;
      },
    );
  });

  it('ячейка шире объявленного числа колонок — отказ', () => {
    const doc: DashboardDefinition = { grid: { columns: 8 }, cells: [cell({ id: 'a', at: { column: 6, row: 0, width: 4, height: 2 } })] };
    assert.throws(
      () => checkDashboardDocument(doc),
      (error: unknown) => {
        assert.ok(error instanceof DashboardDocumentError);
        assert.match(error.message, /a/);
        assert.match(error.message, /8/);
        return true;
      },
    );
  });

  it('наложение двух ячеек — отказ, называющий обе', () => {
    const doc: DashboardDefinition = {
      grid,
      cells: [
        cell({ id: 'a', at: { column: 0, row: 0, width: 4, height: 2 } }),
        cell({ id: 'b', at: { column: 2, row: 1, width: 4, height: 2 } }),
      ],
    };
    assert.throws(
      () => checkDashboardDocument(doc),
      (error: unknown) => {
        assert.ok(error instanceof DashboardDocumentError);
        assert.deepEqual(error.cellIds.slice().sort(), ['a', 'b']);
        return true;
      },
    );
  });

  it('ячейки, касающиеся краями, не считаются наложением', () => {
    const doc: DashboardDefinition = {
      grid,
      cells: [
        cell({ id: 'a', at: { column: 0, row: 0, width: 4, height: 2 } }),
        cell({ id: 'b', at: { column: 4, row: 0, width: 4, height: 2 } }),
        cell({ id: 'c', at: { column: 0, row: 2, width: 4, height: 2 } }),
      ],
    };
    assert.doesNotThrow(() => checkDashboardDocument(doc));
  });
});
