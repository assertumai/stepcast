import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatBytes, formatDuration, formatMoney, formatTokens, parseDuration, parseMoney, parseTokens } from '../src/core/units.js';
import { StepcastError } from '../src/core/errors.js';

describe('единицы измерения', () => {
  // Спека pipeline-definition: «Дробное число токенов»
  it('разбирает дробное число токенов', () => {
    assert.equal(parseTokens('1.5M'), 1_500_000);
    assert.equal(parseTokens('500k'), 500_000);
    assert.equal(parseTokens('200000'), 200_000);
  });

  // Спека pipeline-definition: «Минуты и миллионы различаются»
  it('различает минуты и миллионы по регистру', () => {
    assert.equal(parseDuration('30m'), 30 * 60_000);
    assert.equal(parseTokens('2M'), 2_000_000);
  });

  it('отклоняет строчную m в токенах и объясняет регистр', () => {
    assert.throws(
      () => parseTokens('2m'),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.hint ?? '', /Регистр различается/);
        return true;
      },
    );
  });

  it('отклоняет заглавную M в длительности', () => {
    assert.throws(() => parseDuration('2M'), StepcastError);
  });

  it('разбирает остальные единицы времени', () => {
    assert.equal(parseDuration('45s'), 45_000);
    assert.equal(parseDuration('2h'), 7_200_000);
    assert.equal(parseDuration('30d'), 30 * 86_400_000);
    assert.equal(parseDuration(90), 90_000);
  });

  it('отклоняет мусор', () => {
    assert.throws(() => parseTokens('много'), StepcastError);
    assert.throws(() => parseDuration('скоро'), StepcastError);
    assert.throws(() => parseTokens(-1), StepcastError);
  });

  it('печатает величины обратно в человекочитаемом виде', () => {
    assert.equal(formatTokens(1_500_000), '1.5M');
    assert.equal(formatTokens(500_000), '500k');
    assert.equal(formatTokens(42), '42');
    assert.equal(formatDuration(1_800_000), '30m');
    assert.equal(formatDuration(7_200_000), '2h');
  });

  // Спека run-cleanup: оценка размера в отчёте gc
  it('печатает размер в байтах человекочитаемо', () => {
    assert.equal(formatBytes(0), '0 Б');
    assert.equal(formatBytes(512), '512 Б');
    assert.equal(formatBytes(1024), '1 КБ');
    assert.equal(formatBytes(1536), '1.5 КБ');
    assert.equal(formatBytes(1024 * 1024), '1 МБ');
    assert.equal(formatBytes(1024 * 1024 * 1024 * 2.5), '2.5 ГБ');
  });

  // Спека stepcast-configuration: «Денежная единица»
  it('разбирает денежные величины', () => {
    assert.equal(parseMoney(12), 12_000_000);
    assert.equal(parseMoney(12.5), 12_500_000);
    assert.equal(parseMoney('12'), 12_000_000);
    assert.equal(parseMoney('12.5'), 12_500_000);
    assert.equal(parseMoney('$12.50'), 12_500_000);
    assert.equal(parseMoney(' 12.50 '), 12_500_000);
    assert.equal(parseMoney('$ 12.50'), 12_500_000);
  });

  it('отклоняет отрицательные, нечисловые и валютные денежные величины', () => {
    assert.throws(() => parseMoney(-5), StepcastError);
    assert.throws(() => parseMoney('-5'), StepcastError);
    assert.throws(() => parseMoney(''), StepcastError);
    assert.throws(() => parseMoney('   '), StepcastError);
    assert.throws(() => parseMoney('много'), StepcastError);
    assert.throws(() => parseMoney('12 EUR'), StepcastError);
    assert.throws(() => parseMoney('€12'), StepcastError);
  });

  it('печатает денежные величины: два знака от доллара, четыре ниже', () => {
    assert.equal(formatMoney(12_500_000), '$12.50');
    assert.equal(formatMoney(1_000_000), '$1.00');
    assert.equal(formatMoney(250_000), '$0.2500');
    assert.equal(formatMoney(1), '$0.0000');
  });
});
