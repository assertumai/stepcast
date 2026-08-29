import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fmtBytes, fmtDuration, fmtMoney, fmtSpan, fmtTokens } from '../src/ui/format.js';

describe('ui-format: длительность', () => {
  it('не показывает разрядов, которых на часах не бывает', () => {
    // Разряды, округлённые порознь, складываются в «52м 60с»: 3 179 600 мс —
    // это 52 минуты и 59.6 секунды, и каждый разряд по отдельности честен.
    assert.equal(fmtDuration(3_179_600), '53м');
    // То же на границе часа: 1 час 59 минут 59 секунд.
    assert.equal(fmtDuration(7_199_000), '2ч');
  });

  it('старший разряд без младшего не тянет за собой ноль', () => {
    assert.equal(fmtDuration(3_600_000), '1ч');
    assert.equal(fmtDuration(60_000), '1м');
  });

  it('считает двумя старшими разрядами', () => {
    assert.equal(fmtDuration(3_179_000), '52м 59с');
    assert.equal(fmtDuration(4_920_000), '1ч 22м');
    assert.equal(fmtDuration(1_000), '1с');
  });

  it('несообщённая длительность — прочерк, а не ноль', () => {
    assert.equal(fmtDuration(undefined), '—');
    assert.equal(fmtDuration(null), '—');
    assert.equal(fmtDuration(0), '0с');
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
    assert.equal(fmtBytes(512), '512 Б');
    assert.equal(fmtBytes(2048), '2.0 КБ');
    assert.equal(fmtBytes(3 * 1024 * 1024), '3.0 МБ');
  });
});

describe('ui-format: отрезок исполнения', () => {
  const START = '2026-08-01T00:00:00.000Z';
  const NOW = Date.parse('2026-08-01T00:05:00.000Z');

  it('у завершённого — фактическая длительность, у идущего — сколько идёт', () => {
    assert.equal(fmtSpan(START, '2026-08-01T00:02:00.000Z', NOW), '2м');
    assert.equal(fmtSpan(START, undefined, NOW), 'идёт 5м');
  });

  it('без начала отрезка нет вовсе: работа ещё не начиналась', () => {
    assert.equal(fmtSpan(undefined, undefined, NOW), undefined);
    assert.equal(fmtSpan(undefined, '2026-08-01T00:02:00.000Z', NOW), undefined);
  });

  it('расходящиеся часы витрины и прогона не дают отрицательного отрезка', () => {
    assert.equal(fmtSpan('2026-08-01T00:10:00.000Z', undefined, NOW), 'идёт 0с');
  });

  it('нечитаемое время — не отрезок, а его отсутствие', () => {
    assert.equal(fmtSpan('не время', undefined, NOW), undefined);
    assert.equal(fmtSpan(START, 'не время', NOW), undefined);
  });
});
