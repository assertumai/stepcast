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
  /**
   * Этап раскрытия. `expand` — разбор документа: `$${` даёт литерал `${`, а
   * неизвестное пространство считается опечаткой и роняет разбор. `late` —
   * раскрытие отложенных подстановок перед исполнением работы: пространства,
   * которых нет в области видимости, остаются текстом, потому что на этом
   * этапе они уже не отличимы от литералов, полученных экранированием.
   */
  readonly mode?: 'expand' | 'late';
  /**
   * Почему значение недоступно. Позволяет отличить «работа ещё не
   * завершилась» от «работа упала и выхода не опубликовала»: обе выглядят как
   * отсутствующее поле, но означают разное.
   */
  readonly explain?: (expression: string, namespace: string, path: string) => string | undefined;
  /**
   * Файл, из которого пришёл разбираемый текст, — когда это не сам документ,
   * а что-то подключённое им, например файл промпта. Записывается в каждую
   * найденную подстановку как `origin`; без него подстановка считается частью
   * документа, и место указывает точечный путь поля, а не файл и позиция.
   */
  readonly origin?: string;
  /**
   * Документ, чьи поля раскрываются в этой области видимости: файл пайплайна
   * либо подключённый им файл работы. Записывается в каждую найденную
   * подстановку как `file` и называет место объявления — в отличие от
   * `origin`, называющего файл, откуда взят сам текст.
   */
  readonly file?: string;
}

export interface Interpolated {
  readonly value: string;
  readonly substitutions: readonly Substitution[];
}

const PLACEHOLDER = /\$\$\{([^}]*)\}|\$\$\{|\$\{([^}]*)\}/g;

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

/**
 * Строка и столбец начала выражения по смещению в исходном шаблоне, считая с
 * единицы. Считается по шаблону, а не по результату: раскрытая подстановка
 * обычно меняет длину текста, и позиция в результате указывала бы не туда.
 */
function positionAt(template: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < offset; i++) {
    if (template[i] === '\n') {
      line++;
      lastNewline = i;
    }
  }
  return { line, column: offset - lastNewline };
}

export function interpolate(template: string, scope: Scope, at?: string): Interpolated {
  const substitutions: Substitution[] = [];
  const late = scope.mode === 'late';

  const value = template.replace(
    PLACEHOLDER,
    (
      match,
      escapedRaw: string | undefined,
      plainRaw: string | undefined,
      offset: number,
    ) => {
      if (match.startsWith('$${')) {
        // Экранирование снимает тот этап, который раскрывает это пространство.
        // Снять его раньше значит отдать позднему проходу литерал, от
        // подстановки неотличимый, — и он его раскроет.
        if (escapedRaw === undefined) return '${';
        const escaped = escapedRaw.trim().split('.')[0] ?? '';
        return !late && scope.deferred.has(escaped) ? match : `\${${escapedRaw}}`;
      }

      const expression = (plainRaw ?? '').trim();
      if (expression === '') {
        throw new StepcastError('Пустая подстановка ${}', at === undefined ? {} : { at });
      }

      const segments = expression.split('.');
      const namespace = segments[0] as string;
      const rest = segments.slice(1);
      const { line, column } = positionAt(template, offset);

      if (scope.deferred.has(namespace)) {
        substitutions.push({
          expression,
          namespace,
          path: rest.join('.'),
          deferred: true,
          ...(scope.origin === undefined ? {} : { origin: scope.origin }),
          ...(scope.file === undefined ? {} : { file: scope.file }),
          line,
          column,
        });
        return match;
      }

      if (!(namespace in scope.values)) {
        // На позднем этапе чужое пространство — это литерал, полученный
        // экранированием, а не опечатка: опечатку ловит разбор документа.
        if (late) return match;
        const available = [...Object.keys(scope.values), ...scope.deferred].sort().join(', ');
        throw new StepcastError(`Неизвестное пространство подстановки: ${namespace}`, {
          ...(at === undefined ? {} : { at }),
          // Точечный путь поля называет место внутри документа, но не сам
          // документ: у работы, подключённой через `uses`, это файл работы, а
          // не пайплайн, откуда её видно.
          ...(scope.file === undefined ? {} : { file: scope.file }),
          hint: scope.hints?.[namespace] ?? `Доступны: ${available}`,
        });
      }

      const resolved = lookup(scope.values, segments);
      if (resolved === undefined) {
        throw new StepcastError(`Подстановка ${expression} не определена`, {
          ...(at === undefined ? {} : { at }),
          ...(scope.file === undefined ? {} : { file: scope.file }),
          hint:
            scope.explain?.(expression, namespace, rest.join('.')) ??
            `Проверьте, что ${namespace}.${rest.join('.')} объявлено`,
        });
      }

      substitutions.push({
        expression,
        namespace,
        path: rest.join('.'),
        deferred: false,
        ...(scope.origin === undefined ? {} : { origin: scope.origin }),
        ...(scope.file === undefined ? {} : { file: scope.file }),
        line,
        column,
      });
      return renderValue(resolved, expression, at);
    },
  );

  return { value, substitutions };
}

/**
 * Пространства неэкранированных подстановок, оставшихся в тексте. Смотрит на
 * само значение, а не на список применённых подстановок: отложенное выражение
 * может доехать до поля через `params`, и тогда на поле записана подстановка
 * `params.*`, а `${jobs...}` виден только в тексте.
 */
export function placeholderNamespaces(template: string): string[] {
  PLACEHOLDER.lastIndex = 0;
  const namespaces: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER)) {
    if (match[0].startsWith('$${')) continue;
    const expression = (match[2] ?? '').trim();
    if (expression === '') continue;
    const namespace = expression.split('.')[0] as string;
    if (!namespaces.includes(namespace)) namespaces.push(namespace);
  }
  return namespaces;
}

/** Есть ли в строке хоть одна подстановка. Дешевле, чем полный разбор. */
export function hasPlaceholder(template: string): boolean {
  PLACEHOLDER.lastIndex = 0;
  for (const match of template.matchAll(PLACEHOLDER)) {
    if (!match[0].startsWith('$${')) return true;
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
