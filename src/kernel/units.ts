import { StepcastError } from './errors.js';

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

function fail(message: string, hint: string, at?: string, source?: string): never {
  const fullHint = source === undefined ? hint : `${hint}. Значение получено из ${source}`;
  throw new StepcastError(message, at === undefined ? { hint: fullHint } : { hint: fullHint, at });
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

const MONEY_PATTERN = /^\$?\s*(\d+(?:\.\d+)?)\s*$/;

/**
 * Деньги: число долларов либо строка с необязательным `$` и пробелами.
 * Результат — целые микродоллары (1e-6 USD): сложение сотен значений с
 * дробным числом центов в `number` даёт дрейф, из-за которого сравнение с
 * потолком перестаёт быть воспроизводимым.
 */
export function parseMoney(input: string | number, at?: string): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) {
      fail(`Денежная величина должна быть неотрицательным числом, получено ${input}`, 'Например: 12, 12.5, "$12.50"', at);
    }
    return Math.round(input * 1_000_000);
  }

  const match = MONEY_PATTERN.exec(input.trim());
  if (match === null) {
    fail(`Не удалось разобрать денежную величину: ${input}`, 'Ожидается число долларов с необязательным знаком $, например 12.50 или "$12.50". Иная валюта не поддерживается.', at);
  }

  const [, digits] = match as unknown as [string, string];
  return Math.round(Number(digits) * 1_000_000);
}

const COUNT_PATTERN = /^\d+$/;

/**
 * Счётчик: целое положительное число, без суффиксов величин — `concurrency`,
 * `max_iterations` и подобные поля не измеряют ни токены, ни время.
 */
export function parseCount(input: string | number, at?: string, source?: string): number {
  if (typeof input === 'number') {
    if (!Number.isInteger(input) || input <= 0) {
      fail(`Счётчик должен быть целым положительным числом, получено ${input}`, 'Например: 1, 4, 20', at, source);
    }
    return input;
  }

  const trimmed = input.trim();
  if (!COUNT_PATTERN.test(trimmed)) {
    const hint = /^\d+(?:\.\d+)?[a-zA-Z]+$/.test(trimmed)
      ? 'Счётчик не принимает суффиксов величин, например k или M'
      : 'Ожидается целое положительное число, например 1, 4 или 20';
    fail(`Не удалось разобрать счётчик: ${input}`, hint, at, source);
  }

  const value = Number(trimmed);
  if (value <= 0) {
    fail(`Счётчик должен быть положительным числом, получено ${input}`, 'Например: 1, 4, 20', at, source);
  }
  return value;
}

const PERCENT_PATTERN = /^\d+(?:\.\d+)?$/;

/** Процент: число от 0 до 100, дробная часть допустима. */
export function parsePercent(input: string | number, at?: string, source?: string): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0 || input > 100) {
      fail(`Процент должен быть числом от 0 до 100, получено ${input}`, 'Например: 0, 50, 87.5', at, source);
    }
    return input;
  }

  const trimmed = input.trim();
  if (!PERCENT_PATTERN.test(trimmed)) {
    fail(`Не удалось разобрать процент: ${input}`, 'Ожидается число от 0 до 100, например 50 или 87.5', at, source);
  }

  const value = Number(trimmed);
  if (value < 0 || value > 100) {
    fail(`Процент должен быть числом от 0 до 100, получено ${input}`, 'Например: 0, 50, 87.5', at, source);
  }
  return value;
}

const EXIT_CODE_PATTERN = /^-?\d+$/;

/** Код возврата процесса: целое число, ноль и отрицательные значения допустимы. */
export function parseExitCode(input: string | number, at?: string, source?: string): number {
  if (typeof input === 'number') {
    if (!Number.isInteger(input)) {
      fail(`Код возврата должен быть целым числом, получено ${input}`, 'Например: 0, 1, -1', at, source);
    }
    return input;
  }

  const trimmed = input.trim();
  if (!EXIT_CODE_PATTERN.test(trimmed)) {
    fail(`Не удалось разобрать код возврата: ${input}`, 'Ожидается целое число, например 0, 1 или -1', at, source);
  }
  return Number(trimmed);
}

/** Обратное преобразование для отчётов: 12500000 → "$12.50", 250000 → "$0.2500". */
export function formatMoney(microUsd: number): string {
  const usd = microUsd / 1_000_000;
  const digits = Math.abs(usd) >= 1 ? 2 : 4;
  return `$${usd.toFixed(digits)}`;
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

const BYTE_UNITS = ['Б', 'КБ', 'МБ', 'ГБ'] as const;

/** Человекочитаемый размер: 1536 → "1.5 КБ". */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = unitIndex === 0 ? value : Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} ${BYTE_UNITS[unitIndex]}`;
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
