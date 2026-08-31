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

type ResolvedExpression =
  | { readonly kind: 'deferred' }
  | { readonly kind: 'unknown-namespace' }
  | { readonly kind: 'value'; readonly namespace: string; readonly path: string; readonly value: unknown };

/** Классификация выражения без побочных эффектов — используется и раскрытием, и обнаружением списочных подстановок. */
function resolveExpression(expression: string, scope: Scope): ResolvedExpression {
  const segments = expression.split('.');
  const namespace = segments[0] as string;
  const rest = segments.slice(1);
  if (scope.deferred.has(namespace)) return { kind: 'deferred' };
  if (!(namespace in scope.values)) return { kind: 'unknown-namespace' };
  return { kind: 'value', namespace, path: rest.join('.'), value: lookup(scope.values, segments) };
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Значение подстановки строкой.
 *
 * Непредставимое значение — это чаще всего обращение к группе вместо её листа
 * (`${project.spec}` там, где объявлены `spec.dir` и прочие), а не попытка
 * подставить структуру. Поэтому подсказку здесь даёт то же объяснение области
 * видимости, что и у неопределённого имени: оно называет состав пространства,
 * тогда как «допустимы строки, числа и логические значения» о составе молчит.
 *
 * Списочное значение — отдельная причина с отдельной подсказкой: оно вполне
 * представимо, только не здесь, — и не должно путаться с объяснением
 * `scope.explain`, которое здесь ответило бы не по существу (путь объявлен, но
 * не тем значением).
 *
 * Подсказка выдаётся ровно там, где она правдива: размножается только список
 * строк (см. `resolveListExpansion`) — на обоих этапах одинаково. Массив
 * чисел или разнородный массив в элементе списка не размножится и дойдёт
 * сюда — сказать про него «раскрывается только в элементе списка» автору,
 * который уже в элементе списка, значило бы отправить его в тупик вместо
 * перечня допустимых значений.
 */
function renderValue(
  value: unknown,
  expression: string,
  at: string | undefined,
  scope: Scope,
  namespace: string,
  path: string,
): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (isStringArray(value)) {
    throw new StepcastError(`Подстановка ${expression} даёт значение, непредставимое строкой`, {
      ...(at === undefined ? {} : { at }),
      ...(scope.file === undefined ? {} : { file: scope.file }),
      hint: 'Списочное значение раскрывается только в элементе списка, а не в скалярном поле',
    });
  }
  throw new StepcastError(`Подстановка ${expression} даёт значение, непредставимое строкой`, {
    ...(at === undefined ? {} : { at }),
    ...(scope.file === undefined ? {} : { file: scope.file }),
    hint:
      scope.explain?.(expression, namespace, path) ??
      'В подстановке допустимы строки, числа и логические значения',
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

      const { line, column } = positionAt(template, offset);
      const resolved = resolveExpression(expression, scope);

      if (resolved.kind === 'deferred') {
        const namespace = expression.split('.')[0] as string;
        substitutions.push({
          expression,
          namespace,
          path: expression.split('.').slice(1).join('.'),
          deferred: true,
          ...(scope.origin === undefined ? {} : { origin: scope.origin }),
          ...(scope.file === undefined ? {} : { file: scope.file }),
          line,
          column,
        });
        return match;
      }

      if (resolved.kind === 'unknown-namespace') {
        // На позднем этапе чужое пространство — это литерал, полученный
        // экранированием, а не опечатка: опечатку ловит разбор документа.
        if (late) return match;
        const namespace = expression.split('.')[0] as string;
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

      const { namespace, path, value } = resolved;
      if (value === undefined) {
        throw new StepcastError(`Подстановка ${expression} не определена`, {
          ...(at === undefined ? {} : { at }),
          ...(scope.file === undefined ? {} : { file: scope.file }),
          hint: scope.explain?.(expression, namespace, path) ?? `Проверьте, что ${namespace}.${path} объявлено`,
        });
      }

      substitutions.push({
        expression,
        namespace,
        path,
        deferred: false,
        ...(scope.origin === undefined ? {} : { origin: scope.origin }),
        ...(scope.file === undefined ? {} : { file: scope.file }),
        line,
        column,
      });
      return renderValue(value, expression, at, scope, namespace, path);
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

export interface ListExpansion {
  readonly expression: string;
  readonly namespace: string;
  readonly path: string;
  readonly values: readonly string[];
}

/**
 * Найти подстановку шаблона, дающую список строк, — с возвратом самого
 * выражения и значений, чтобы вызывающий не разбирал шаблон второй раз ради
 * того же ответа. Отвечает на два разных вопроса одним проходом: «есть ли
 * ровно одна» (для решения — размножать элемент или нет) и «какая именно и
 * что в ней» (для самого размножения).
 *
 * Пространства вне области видимости и подстановки, разрешившиеся не в
 * список, здесь не ошибка: их видит обычный `interpolate` при раскрытии копии
 * элемента, и там для них уже есть точное сообщение. Здесь считается ошибкой
 * только то, что этот проход обязан различить сам, — вторая списочная
 * подстановка в одном элементе (раскрытие копии её не заметит, потому что
 * копия обрабатывает уже подставленное скалярное значение первой) и пустой
 * список (иначе элемент исчезает без единого слова).
 *
 * Правило действует на обоих этапах — и при разборе документа, и при позднем
 * раскрытии. Изначально позднее было из-под него выведено: значение там
 * приходит из выхода работы, произвольного JSON, и молча размноженный
 * `"${jobs.x.output.changed_files}"` менял бы состав прав уже после того, как
 * раскрытый пайплайн зафиксирован в `pipeline.lock.yml`. Снимок этого довода
 * не выдержал: до позднего раскрытия в нём стоит сам текст
 * `${jobs.x.output...}`, а не значение, — числа записей он не обещает ни с
 * правилом, ни без него, и читатель снимка узнаёт состав из журнала прогона в
 * обоих случаях. Молчания же правило не допускает нигде: пустой список — по
 * прежнему отказ, две списочные подстановки в элементе — отказ, а значение,
 * оказавшееся списком не там, где список уместен, остаётся непредставимым
 * строкой.
 *
 * Без этого дорожка не может получить права по репозиторию, который выбрал её
 * пункт очереди: перечень инструментов приезжает из выхода работы `slots`
 * (`stepcast project repos`) и другого пути в элемент `allow`, кроме позднего
 * раскрытия, у него нет.
 */
export function resolveListExpansion(
  template: string,
  scope: Scope,
  at: string | undefined,
): ListExpansion | undefined {
  const found: ListExpansion[] = [];
  for (const match of template.matchAll(PLACEHOLDER)) {
    if (match[0].startsWith('$${')) continue;
    const expression = (match[2] ?? '').trim();
    if (expression === '') continue;
    const resolved = resolveExpression(expression, scope);
    if (resolved.kind !== 'value' || !isStringArray(resolved.value)) continue;
    found.push({ expression, namespace: resolved.namespace, path: resolved.path, values: resolved.value });
  }

  if (found.length === 0) return undefined;
  if (found.length > 1) {
    throw new StepcastError(
      `Элемент списка содержит несколько списочных подстановок: ${found
        .map((item) => `\${${item.expression}}`)
        .join(', ')}`,
      {
        ...(at === undefined ? {} : { at }),
        ...(scope.file === undefined ? {} : { file: scope.file }),
        hint: 'Ровно одна списочная подстановка на элемент — иначе не определить, сколько записей получится',
      },
    );
  }

  const only = found[0] as ListExpansion;
  if (only.values.length === 0) {
    // Ноль значений дал бы ноль элементов — исчезнувшее право в `allow` или
    // исчезнувший глоб в `changed_only`, то есть тихую смену политики или
    // границ правок. Схемы пустой список не пропускают, но значение доезжает
    // сюда и мимо них — слоем флагов, — и молчать об этом нельзя.
    throw new StepcastError(`Подстановка \${${only.expression}} даёт пустой список`, {
      ...(at === undefined ? {} : { at }),
      ...(scope.file === undefined ? {} : { file: scope.file }),
      hint: 'Пустой список удалил бы элемент целиком; объявите хотя бы одно значение или снимите ссылку',
    });
  }
  return only;
}

/** Копия области видимости, где лист `namespace.path` заменён скалярным значением. */
function withListValue(scope: Scope, namespace: string, path: string, value: string): Scope {
  const segments = path === '' ? [] : path.split('.');
  const setAt = (node: unknown, remaining: readonly string[]): unknown => {
    if (remaining.length === 0) return value;
    const record = (typeof node === 'object' && node !== null ? node : {}) as Record<string, unknown>;
    const [head, ...tail] = remaining as [string, ...string[]];
    return { ...record, [head]: setAt(record[head], tail) };
  };
  return {
    ...scope,
    values: { ...scope.values, [namespace]: setAt(scope.values[namespace], segments) },
  };
}

export interface TreeResult<T> {
  readonly value: T;
  readonly substitutions: Map<string, readonly Substitution[]>;
}

/**
 * Обойти документ и раскрыть подстановки во всех строках, запомнив по каждому
 * точечному пути, какие подстановки там применялись.
 *
 * Элемент списка, чей шаблон даёт ровно одну списочную подстановку,
 * размножается — по элементу на значение, в объявленном порядке; окружающий
 * текст и прочие подстановки того же элемента раскрываются заново на каждую
 * копию. Путь в карте подстановок — это путь произведённого элемента
 * (`…allow.5`), а не исходного индекса, которого в раскрытом дереве больше
 * нет. Размножение действует на обоих этапах — и при разборе, и при позднем
 * раскрытии (см. `resolveListExpansion`).
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
      const out: unknown[] = [];
      value.forEach((item, originalIndex) => {
        const originalPath = path === '' ? String(originalIndex) : `${path}.${originalIndex}`;
        const expansion = typeof item === 'string' ? resolveListExpansion(item, scope, originalPath) : undefined;
        if (expansion === undefined) {
          out.push(walk(item, path === '' ? String(out.length) : `${path}.${out.length}`));
          return;
        }
        for (const single of expansion.values) {
          const producedPath = path === '' ? String(out.length) : `${path}.${out.length}`;
          const itemScope = withListValue(scope, expansion.namespace, expansion.path, single);
          const result = interpolate(item as string, itemScope, producedPath);
          if (result.substitutions.length > 0) substitutions.set(producedPath, result.substitutions);
          out.push(result.value);
        }
      });
      return out;
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
