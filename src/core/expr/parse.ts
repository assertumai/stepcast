import { ScarpError } from '../errors.js';

/**
 * Язык выражений для `if`.
 *
 * Грамматика закрыта намеренно: обращение к полям, сравнения, `and`, `or`,
 * `not`, литералы и скобки. Библиотека общего назначения принесла бы
 * арифметику и вызовы функций, и первый же пользователь начал бы писать в
 * YAML логику, которой там не место. Ограниченность здесь — свойство
 * продукта, а не экономия усилий.
 */

export type BinaryOperator = 'and' | 'or' | '==' | '!=' | '<' | '<=' | '>' | '>=';

export type Expr =
  | { readonly kind: 'literal'; readonly value: string | number | boolean }
  | { readonly kind: 'ref'; readonly path: readonly string[] }
  | { readonly kind: 'not'; readonly operand: Expr }
  | {
      readonly kind: 'binary';
      readonly op: BinaryOperator;
      readonly left: Expr;
      readonly right: Expr;
    };

type Token =
  | { kind: 'ident'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'op'; value: string }
  | { kind: 'eof' };

const OPERATOR_CHARS = new Set(['(', ')', '=', '!', '<', '>']);

function tokenize(source: string, at: string | undefined): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  const fail = (message: string): never => {
    throw new ScarpError(`${message} в выражении: ${source}`, at === undefined ? {} : { at });
  };

  while (index < source.length) {
    const char = source[index] as string;

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      const end = source.indexOf(char, index + 1);
      if (end === -1) fail('Незакрытая строка');
      tokens.push({ kind: 'string', value: source.slice(index + 1, end) });
      index = end + 1;
      continue;
    }

    if (/[0-9]/.test(char)) {
      const match = /^[0-9]+(\.[0-9]+)?/.exec(source.slice(index));
      const text = (match as RegExpExecArray)[0];
      tokens.push({ kind: 'number', value: Number(text) });
      index += text.length;
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(source.slice(index));
      const text = (match as RegExpExecArray)[0];
      tokens.push({ kind: 'ident', value: text });
      index += text.length;
      continue;
    }

    if (OPERATOR_CHARS.has(char)) {
      const two = source.slice(index, index + 2);
      if (['==', '!=', '<=', '>='].includes(two)) {
        tokens.push({ kind: 'op', value: two });
        index += 2;
        continue;
      }
      if (char === '=' || char === '!') {
        fail(`Недопустимый оператор ${char}`);
      }
      tokens.push({ kind: 'op', value: char });
      index += 1;
      continue;
    }

    fail(`Недопустимый символ ${char}`);
  }

  tokens.push({ kind: 'eof' });
  return tokens;
}

export function parseExpression(source: string, at?: string): Expr {
  const tokens = tokenize(source, at);
  let position = 0;

  const peek = (): Token => tokens[position] as Token;
  const advance = (): Token => tokens[position++] as Token;

  const fail = (message: string): never => {
    throw new ScarpError(`${message} в выражении: ${source}`, {
      ...(at === undefined ? {} : { at }),
      hint: 'Допустимы обращения к полям, сравнения, and, or, not и скобки',
    });
  };

  const isKeyword = (token: Token, word: string): boolean =>
    token.kind === 'ident' && token.value === word;

  const parsePrimary = (): Expr => {
    const token = advance();

    if (token.kind === 'op' && token.value === '(') {
      const inner = parseOr();
      const closing = advance();
      if (closing.kind !== 'op' || closing.value !== ')') fail('Ожидалась закрывающая скобка');
      return inner;
    }

    if (token.kind === 'string') return { kind: 'literal', value: token.value };
    if (token.kind === 'number') return { kind: 'literal', value: token.value };

    if (token.kind === 'ident') {
      if (token.value === 'true') return { kind: 'literal', value: true };
      if (token.value === 'false') return { kind: 'literal', value: false };
      return { kind: 'ref', path: token.value.split('.') };
    }

    return fail('Неожиданный конец выражения');
  };

  const parseNot = (): Expr => {
    if (isKeyword(peek(), 'not')) {
      advance();
      return { kind: 'not', operand: parseNot() };
    }
    return parsePrimary();
  };

  const parseComparison = (): Expr => {
    const left = parseNot();
    const token = peek();
    if (token.kind === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(token.value)) {
      advance();
      return {
        kind: 'binary',
        op: token.value as BinaryOperator,
        left,
        right: parseNot(),
      };
    }
    return left;
  };

  const parseAnd = (): Expr => {
    let left = parseComparison();
    while (isKeyword(peek(), 'and')) {
      advance();
      left = { kind: 'binary', op: 'and', left, right: parseComparison() };
    }
    return left;
  };

  function parseOr(): Expr {
    let left = parseAnd();
    while (isKeyword(peek(), 'or')) {
      advance();
      left = { kind: 'binary', op: 'or', left, right: parseAnd() };
    }
    return left;
  }

  const result = parseOr();
  if (peek().kind !== 'eof') fail('Лишние символы после выражения');
  return result;
}

/** Все обращения к полям в выражении — для проверки на этапе линта. */
export function references(expr: Expr): Array<readonly string[]> {
  switch (expr.kind) {
    case 'ref':
      return [expr.path];
    case 'not':
      return references(expr.operand);
    case 'binary':
      return [...references(expr.left), ...references(expr.right)];
    case 'literal':
      return [];
  }
}

function lookup(scope: Readonly<Record<string, unknown>>, path: readonly string[]): unknown {
  let cursor: unknown = scope;
  for (const segment of path) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/**
 * Неопределённое значение ложно, а сравнение с ним не выполняется. Это прямо
 * следует из правила про выход упавшей работы: обращение к нему делает условие
 * ложным, а не роняет прогон.
 */
export function evaluate(expr: Expr, scope: Readonly<Record<string, unknown>>): boolean {
  return truthy(evaluateValue(expr, scope));
}

function truthy(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function evaluateValue(expr: Expr, scope: Readonly<Record<string, unknown>>): unknown {
  switch (expr.kind) {
    case 'literal':
      return expr.value;

    case 'ref':
      return lookup(scope, expr.path);

    case 'not':
      return !truthy(evaluateValue(expr.operand, scope));

    case 'binary': {
      if (expr.op === 'and') {
        return truthy(evaluateValue(expr.left, scope)) && truthy(evaluateValue(expr.right, scope));
      }
      if (expr.op === 'or') {
        return truthy(evaluateValue(expr.left, scope)) || truthy(evaluateValue(expr.right, scope));
      }

      const left = evaluateValue(expr.left, scope);
      const right = evaluateValue(expr.right, scope);

      if (expr.op === '==') return equals(left, right);
      if (expr.op === '!=') return !equals(left, right);

      if (typeof left !== 'number' || typeof right !== 'number') return false;
      if (expr.op === '<') return left < right;
      if (expr.op === '<=') return left <= right;
      if (expr.op === '>') return left > right;
      return left >= right;
    }
  }
}

function equals(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => equals(item, right[index]));
  }
  return left === right;
}
