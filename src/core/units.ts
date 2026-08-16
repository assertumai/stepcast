import { ScarpError } from './errors.js';

/**
 * Разбор величин из конфигурации и пайплайна.
 *
 * Регистр различается намеренно: `m` — минуты, `M` — миллионы. Ошибка регистра
 * даёт диагностику, а не молчаливое приведение, потому что перепутанные
 * минуты и миллионы дают расхождение в шесть порядков.
 */

const TOKEN_MULTIPLIERS: Record<string, number> = {
  k: 1_000,
  M: 1_000_000,
};

const DURATION_MULTIPLIERS_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const TOKEN_PATTERN = /^(\d+(?:\.\d+)?)([a-zA-Z]*)$/;
const DURATION_PATTERN = /^(\d+(?:\.\d+)?)([a-zA-Z]*)$/;

function fail(message: string, hint: string, at?: string): never {
  throw new ScarpError(message, at === undefined ? { hint } : { hint, at });
}

/** Токены: целое число либо число с суффиксом `k` или `M`. */
export function parseTokens(input: string | number, at?: string): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) {
      fail(`Величина в токенах должна быть неотрицательным числом, получено ${input}`, 'Например: 500k, 1.5M, 200000', at);
    }
    return Math.round(input);
  }

  const match = TOKEN_PATTERN.exec(input.trim());
  if (match === null) {
    fail(`Не удалось разобрать величину в токенах: ${input}`, 'Ожидается число с необязательным суффиксом k или M, например 500k или 1.5M', at);
  }

  const [, digits, suffix] = match as unknown as [string, string, string];
  const amount = Number(digits);

  if (suffix === '') return Math.round(amount);

  const multiplier = TOKEN_MULTIPLIERS[suffix];
  if (multiplier === undefined) {
    const lower = suffix.toLowerCase();
    const hint =
      lower === 'k' || lower === 'm'
        ? 'Регистр различается: k — тысячи, M — миллионы. Строчная m означает минуты и в токенах недопустима.'
        : 'Допустимые суффиксы: k (тысячи), M (миллионы)';
    fail(`Неизвестный суффикс величины в токенах: ${suffix}`, hint, at);
  }

  return Math.round(amount * multiplier);
}

/** Длительность в миллисекундах: число секунд либо число с суффиксом s, m, h, d. */
export function parseDuration(input: string | number, at?: string): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) {
      fail(`Длительность должна быть неотрицательным числом, получено ${input}`, 'Например: 30s, 5m, 2h, 30d', at);
    }
    return Math.round(input * 1_000);
  }

  const match = DURATION_PATTERN.exec(input.trim());
  if (match === null) {
    fail(`Не удалось разобрать длительность: ${input}`, 'Ожидается число с суффиксом s, m, h или d, например 30m', at);
  }

  const [, digits, suffix] = match as unknown as [string, string, string];
  const amount = Number(digits);

  if (suffix === '') return Math.round(amount * 1_000);

  const multiplier = DURATION_MULTIPLIERS_MS[suffix];
  if (multiplier === undefined) {
    const hint =
      suffix === 'M'
        ? 'Регистр различается: m — минуты, M — миллионы и применимо только к токенам.'
        : 'Допустимые суффиксы: s, m, h, d';
    fail(`Неизвестный суффикс длительности: ${suffix}`, hint, at);
  }

  return Math.round(amount * multiplier);
}

/** Обратное преобразование для отчётов: 1_500_000 → "1.5M". */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    const scaled = value / 1_000_000;
    return `${Number.isInteger(scaled) ? scaled : scaled.toFixed(1)}M`;
  }
  if (value >= 1_000) {
    const scaled = value / 1_000;
    return `${Number.isInteger(scaled) ? scaled : scaled.toFixed(1)}k`;
  }
  return String(value);
}

/** Обратное преобразование для отчётов: 1_800_000 → "30m". */
export function formatDuration(ms: number): string {
  for (const [suffix, multiplier] of [
    ['d', DURATION_MULTIPLIERS_MS.d],
    ['h', DURATION_MULTIPLIERS_MS.h],
    ['m', DURATION_MULTIPLIERS_MS.m],
    ['s', DURATION_MULTIPLIERS_MS.s],
  ] as const) {
    const factor = multiplier as number;
    if (ms >= factor && ms % factor === 0) return `${ms / factor}${suffix}`;
  }
  return `${Math.round(ms / 1000)}s`;
}
