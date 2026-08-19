import { StepcastError } from '../errors.js';
import type { Substitution } from './model.js';

/**
 * Подстановки вида `${namespace.path}`.
 *
 * Интерполятор возвращает не строку, а строку вместе со списком применённых
 * подстановок. Без этого нельзя выполнить два правила линта: пропускать
 * проверку существования у путей с подстановками и отклонять
 * `${jobs.*.output.*}` в строковой форме `run`. Восстанавливать это по
 * результату регулярным выражением нельзя — данные сами могут содержать `${`.
 */

export interface Scope {
  /** Доступные пространства имён и их значения. */
  readonly values: Readonly<Record<string, unknown>>;
  /**
   * Пространства, значения которых станут известны только в прогоне. Такие
   * подстановки остаются в тексте как есть и лишь записываются в список.
   */
  readonly deferred: ReadonlySet<string>;
  /**
   * Подсказки для конкретных недоступных пространств. Нужны там, где
   * недоступность — правило, а не опечатка: работе, например, намеренно не
   * видны `inputs` пайплайна, и об этом стоит сказать прямо.
   */
  readonly hints?: Readonly<Record<string, string>>;
}

export interface Interpolated {
  readonly value: string;
  readonly substitutions: readonly Substitution[];
}

const PLACEHOLDER = /\$\$\{|\$\{([^}]*)\}/g;

function lookup(values: Readonly<Record<string, unknown>>, path: readonly string[]): unknown {
  let cursor: unknown = values;
  for (const segment of path) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function renderValue(value: unknown, expression: string, at: string | undefined): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new StepcastError(`Подстановка ${expression} даёт значение, непредставимое строкой`, {
    ...(at === undefined ? {} : { at }),
    hint: 'В подстановке допустимы строки, числа и логические значения',
  });
}

export function interpolate(template: string, scope: Scope, at?: string): Interpolated {
  const substitutions: Substitution[] = [];

  const value = template.replace(PLACEHOLDER, (match, expressionRaw: string | undefined) => {
    if (match === '$${') return '${';

    const expression = (expressionRaw ?? '').trim();
    if (expression === '') {
      throw new StepcastError('Пустая подстановка ${}', at === undefined ? {} : { at });
    }

    const segments = expression.split('.');
    const namespace = segments[0] as string;
    const rest = segments.slice(1);

    if (scope.deferred.has(namespace)) {
      substitutions.push({ expression, namespace, path: rest.join('.'), deferred: true });
      return match;
    }

    if (!(namespace in scope.values)) {
      const available = [...Object.keys(scope.values), ...scope.deferred].sort().join(', ');
      throw new StepcastError(`Неизвестное пространство подстановки: ${namespace}`, {
        ...(at === undefined ? {} : { at }),
        hint: scope.hints?.[namespace] ?? `Доступны: ${available}`,
      });
    }

    const resolved = lookup(scope.values, segments);
    if (resolved === undefined) {
      throw new StepcastError(`Подстановка ${expression} не определена`, {
        ...(at === undefined ? {} : { at }),
        hint: `Проверьте, что ${namespace}.${rest.join('.')} объявлено`,
      });
    }

    substitutions.push({ expression, namespace, path: rest.join('.'), deferred: false });
    return renderValue(resolved, expression, at);
  });

  return { value, substitutions };
}

/** Есть ли в строке хоть одна подстановка. Дешевле, чем полный разбор. */
export function hasPlaceholder(template: string): boolean {
  PLACEHOLDER.lastIndex = 0;
  for (const match of template.matchAll(PLACEHOLDER)) {
    if (match[0] !== '$${') return true;
  }
  return false;
}

export interface TreeResult<T> {
  readonly value: T;
  readonly substitutions: Map<string, readonly Substitution[]>;
}

/**
 * Обойти документ и раскрыть подстановки во всех строках, запомнив по каждому
 * точечному пути, какие подстановки там применялись.
 */
export function interpolateTree<T>(node: T, scope: Scope, prefix = ''): TreeResult<T> {
  const substitutions = new Map<string, readonly Substitution[]>();

  const walk = (value: unknown, path: string): unknown => {
    if (typeof value === 'string') {
      const result = interpolate(value, scope, path === '' ? undefined : path);
      if (result.substitutions.length > 0) substitutions.set(path, result.substitutions);
      return result.value;
    }
    if (Array.isArray(value)) {
      return value.map((item, index) => walk(item, path === '' ? String(index) : `${path}.${index}`));
    }
    if (typeof value === 'object' && value !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) {
        out[key] = walk(child, path === '' ? key : `${path}.${key}`);
      }
      return out;
    }
    return value;
  };

  return { value: walk(node, prefix) as T, substitutions };
}
