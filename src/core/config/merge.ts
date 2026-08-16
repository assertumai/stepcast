import { parseDuration, parseTokens } from '../units.js';

/** Откуда пришло значение. Печатается в `scarp config`. */
export type Source =
  | { readonly kind: 'builtin' }
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'flag'; readonly name: string };

export function describeSource(source: Source): string {
  switch (source.kind) {
    case 'builtin':
      return 'встроенное умолчание';
    case 'file':
      return source.path;
    case 'flag':
      return `${source.name} (флаг)`;
  }
}

export interface Layer {
  readonly source: Source;
  readonly values: Record<string, unknown>;
}

export interface DenyContribution {
  readonly source: Source;
  readonly patterns: readonly string[];
}

export interface MergeResult {
  /** Плоская карта «путь → значение» после слияния всех слоёв. */
  readonly values: ReadonlyMap<string, unknown>;
  /** Плоская карта «путь → источник победившего значения». */
  readonly provenance: ReadonlyMap<string, Source>;
  /** Вклад каждого источника в объединяемые списки. */
  readonly denyContributions: ReadonlyMap<string, readonly DenyContribution[]>;
}

/** Путь ключа, в котором величина задаётся в токенах. */
const TOKEN_VALUED = new Set(['limits.tokens', 'context.inline_threshold', 'context.max_tokens']);

/** Путь ключа, в котором величина задаётся длительностью. */
const DURATION_VALUED = new Set([
  'runs.keep',
  'defaults.step_timeout',
  'defaults.stall_timeout',
  'limits.wallclock',
]);

export function valueKind(path: string): 'tokens' | 'duration' | 'plain' {
  if (TOKEN_VALUED.has(path)) return 'tokens';
  if (DURATION_VALUED.has(path)) return 'duration';
  return 'plain';
}

/** Привести величину к числу для сравнения и для итоговой конфигурации. */
export function normalizeValue(path: string, value: unknown): unknown {
  if (value === undefined || value === null) return value;
  switch (valueKind(path)) {
    case 'tokens':
      return parseTokens(value as string | number, path);
    case 'duration':
      return parseDuration(value as string | number, path);
    case 'plain':
      return value;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Обойти вложенный объект, отдавая листья с их точечными путями. */
export function flatten(
  value: Record<string, unknown>,
  prefix = '',
): Array<readonly [string, unknown]> {
  const out: Array<readonly [string, unknown]> = [];
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (isPlainObject(child)) {
      out.push(...flatten(child, path));
    } else {
      out.push([path, child]);
    }
  }
  return out;
}

/** Собрать вложенный объект обратно из плоской карты. */
export function unflatten(values: ReadonlyMap<string, unknown>): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [path, value] of values) {
    const segments = path.split('.');
    let cursor = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i] as string;
      const next = cursor[segment];
      if (!isPlainObject(next)) {
        const created: Record<string, unknown> = {};
        cursor[segment] = created;
        cursor = created;
      } else {
        cursor = next;
      }
    }
    cursor[segments[segments.length - 1] as string] = value;
  }
  return root;
}

/** Совпадение точечного пути с шаблоном, где `*` покрывает один сегмент. */
export function matchesKeyPattern(path: string, pattern: string): boolean {
  const pathSegments = path.split('.');
  const patternSegments = pattern.split('.');
  if (pathSegments.length !== patternSegments.length) return false;
  return patternSegments.every((segment, index) => segment === '*' || segment === pathSegments[index]);
}

export interface MergeOptions {
  /** Пути списков, которые объединяются между слоями вместо замены. */
  readonly unionLists: readonly string[];
  /** Пути потолков, где побеждает строжайшее значение независимо от порядка слоёв. */
  readonly tightenOnly: readonly string[];
}

/**
 * Слить слои конфигурации, сохранив происхождение каждого значения.
 *
 * Обычные значения перекрываются по порядку слоёв. Списки запретов
 * объединяются — политика, которую отменяет тот, кого она ограничивает, не
 * политика. Потолки берутся строжайшие: нижний слой может ужесточить, но не
 * ослабить.
 */
export function mergeLayers(layers: readonly Layer[], options: MergeOptions): MergeResult {
  const values = new Map<string, unknown>();
  const provenance = new Map<string, Source>();
  const denyContributions = new Map<string, DenyContribution[]>();

  for (const layer of layers) {
    for (const [path, rawValue] of flatten(layer.values)) {
      if (options.unionLists.includes(path)) {
        const incoming = Array.isArray(rawValue) ? (rawValue as string[]) : [];
        if (incoming.length > 0) {
          const existing = (values.get(path) as string[] | undefined) ?? [];
          const merged = [...existing];
          for (const pattern of incoming) {
            if (!merged.includes(pattern)) merged.push(pattern);
          }
          values.set(path, merged);
          const contributions = denyContributions.get(path) ?? [];
          contributions.push({ source: layer.source, patterns: incoming });
          denyContributions.set(path, contributions);
          // Победитель у объединяемого списка не один, поэтому в provenance
          // держим последний вклад, а полный расклад — в denyContributions.
          provenance.set(path, layer.source);
        }
        continue;
      }

      const normalized = normalizeValue(path, rawValue);

      if (options.tightenOnly.includes(path)) {
        const existing = values.get(path);
        if (
          typeof existing === 'number' &&
          typeof normalized === 'number' &&
          existing <= normalized
        ) {
          continue;
        }
      }

      values.set(path, normalized);
      provenance.set(path, layer.source);
    }
  }

  return { values, provenance, denyContributions };
}
