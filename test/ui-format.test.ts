import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fmtBytes, fmtDuration, fmtMoney, fmtSpan, fmtTokens, pluralRuns } from '../src/parts/ui/format.js';

describe('ui-format: длительность', () => {
  it('не показывает разрядов, которых на часах не бывает', () => {
    // Разряды, округлённые порознь, складываются в «52м 60с»: 3 179 600 мс —
    // это 52 минуты и 59.6 секунды, и каждый разряд по отдельности честен.
    assert.equal(fmtDuration(3_179_600), '53m');
    // То же на границе часа: 1 час 59 минут 59 секунд.
    assert.equal(fmtDuration(7_199_000), '2h');
  });

  it('старший разряд без младшего не тянет за собой ноль', () => {
    assert.equal(fmtDuration(3_600_000), '1h');
    assert.equal(fmtDuration(60_000), '1m');
  });

  it('считает двумя старшими разрядами', () => {
    assert.equal(fmtDuration(3_179_000), '52m 59s');
    assert.equal(fmtDuration(4_920_000), '1h 22m');
    assert.equal(fmtDuration(1_000), '1s');
  });

  it('несообщённая длительность — прочерк, а не ноль', () => {
    assert.equal(fmtDuration(undefined), '—');
    assert.equal(fmtDuration(null), '—');
    assert.equal(fmtDuration(0), '0s');
  });
});

describe('ui-format: величины расхода', () => {
  it('несообщённое значение отличимо от нуля', () => {
    assert.equal(fmtTokens(undefined), '—');
    assert.equal(fmtMoney(null), '—');
    assert.equal(fmtTokens(0), '0');
    assert.equal(fmtMoney(0), '$0.0000');
  });

  it('крупные числа сокращаются, мелкие деньги показываются точнее', () => {
    assert.equal(fmtTokens(2_000_000), '2M');
    assert.equal(fmtTokens(2_500), '2.5k');
    assert.equal(fmtMoney(1.5), '$1.50');
    assert.equal(fmtMoney(0.0123), '$0.0123');
  });

  it('размер файла растёт единицами, а не порядками', () => {
    assert.equal(fmtBytes(512), '512 B');
    assert.equal(fmtBytes(2048), '2.0 KB');
    assert.equal(fmtBytes(3 * 1024 * 1024), '3.0 MB');
  });
});

describe('ui-format: отрезок исполнения', () => {
  const START = '2026-08-01T00:00:00.000Z';
  const NOW = Date.parse('2026-08-01T00:05:00.000Z');

  it('у завершённого — фактическая длительность, у идущего — сколько идёт', () => {
    assert.equal(fmtSpan(START, '2026-08-01T00:02:00.000Z', NOW), '2m');
    assert.equal(fmtSpan(START, undefined, NOW), 'running 5m');
  });

  it('без начала отрезка нет вовсе: работа ещё не начиналась', () => {
    assert.equal(fmtSpan(undefined, undefined, NOW), undefined);
    assert.equal(fmtSpan(undefined, '2026-08-01T00:02:00.000Z', NOW), undefined);
  });

  it('расходящиеся часы витрины и прогона не дают отрицательного отрезка', () => {
    assert.equal(fmtSpan('2026-08-01T00:10:00.000Z', undefined, NOW), 'running 0s');
  });

  it('нечитаемое время — не отрезок, а его отсутствие', () => {
    assert.equal(fmtSpan('не время', undefined, NOW), undefined);
    assert.equal(fmtSpan(START, 'не время', NOW), undefined);
  });
});

describe('ui-format: число «run»', () => {
  it('единственное число только у единицы', () => {
    assert.equal(pluralRuns(1), '1 run');
    assert.equal(pluralRuns(2), '2 runs');
    assert.equal(pluralRuns(5), '5 runs');
    assert.equal(pluralRuns(0), '0 runs');
  });

  it('11 и 21 — множественное: английское число не смотрит на последнюю цифру', () => {
    assert.equal(pluralRuns(11), '11 runs');
    assert.equal(pluralRuns(21), '21 runs');
    assert.equal(pluralRuns(111), '111 runs');
  });
});
