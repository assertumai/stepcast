import { execaSync } from 'execa';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
// Сборка для draft 2020-12: схемы пишутся по актуальному стандарту, а
// обычный экспорт ajv знает только draft-07 и отклоняет ссылку на мета-схему.
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';

import { StepcastError } from '../errors.js';
import type { Predicate } from '../pipeline/model.js';
import type { PredicateResult } from '../journal/schema.js';

/**
 * Вычисление предикатов.
 *
 * Все объявленные предикаты вычисляются, даже если один уже не прошёл: отчёт
 * с одной первой ошибкой заставляет чинить их по очереди, а стоимость
 * вычисления остальных пренебрежима по сравнению с шагом.
 */

export interface EvaluationInput {
  readonly exitCode: number | null;
  /** Текстовый результат: для агента — итоговый ответ, для команды — stdout. */
  readonly text: string;
  readonly structured: unknown;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /**
   * Пути, изменившиеся за время шага, — база для предиката границ.
   * `undefined` означает, что якорь снять не удалось: предикат тогда не
   * вычисляется, а помечается невычисленным. Считать его непройденным нельзя —
   * это превратило бы неудачу внутреннего учёта в отказ пользователю.
   */
  readonly changedPaths?: readonly string[] | undefined;
}

const ajv = new Ajv2020({ allErrors: true, strict: false });

export function evaluatePredicates(
  predicates: readonly Predicate[],
  input: EvaluationInput,
): PredicateResult[] {
  if (predicates.length === 0) {
    const passed = input.exitCode === 0;
    return [
      {
        predicate: 'exit_code',
        passed,
        hard: true,
        expected: 0,
        actual: input.exitCode,
        ...(passed ? {} : { detail: `код возврата ${input.exitCode ?? 'нет'} вместо 0` }),
      },
    ];
  }

  return predicates.map((predicate) => evaluateOne(predicate, input));
}

function evaluateOne(predicate: Predicate, input: EvaluationInput): PredicateResult {
  switch (predicate.kind) {
    case 'exit_code': {
      const passed = input.exitCode === predicate.value;
      return {
        predicate: 'exit_code',
        passed,
        hard: true,
        expected: predicate.value,
        actual: input.exitCode,
        ...(passed
          ? {}
          : { detail: `код возврата ${input.exitCode ?? 'нет'} вместо ${predicate.value}` }),
      };
    }

    case 'file_exists': {
      const path = absolute(predicate.path, input.cwd);
      const passed = existsSync(path);
      return {
        predicate: 'file_exists',
        passed,
        hard: true,
        expected: predicate.path,
        ...(passed ? {} : { detail: `файл не найден: ${predicate.path}` }),
      };
    }

    case 'schema':
      return evaluateSchema(predicate.path, input);

    case 'matches':
    case 'not_matches': {
      const regexp = compile(predicate.pattern);
      const found = regexp.test(input.text);
      const passed = predicate.kind === 'matches' ? found : !found;
      return {
        predicate: predicate.kind,
        passed,
        hard: true,
        expected: predicate.pattern,
        ...(passed
          ? {}
          : {
              detail:
                predicate.kind === 'matches'
                  ? `в выводе нет совпадения с ${predicate.pattern}`
                  : `в выводе найдено запрещённое совпадение с ${predicate.pattern}`,
            }),
      };
    }

    case 'cmd': {
      const result = execaSync(predicate.command, {
        cwd: input.cwd,
        env: input.env,
        extendEnv: false,
        reject: false,
        shell: true,
        all: true,
      });
      const passed = result.exitCode === 0;
      return {
        predicate: 'cmd',
        passed,
        hard: true,
        expected: predicate.command,
        actual: result.exitCode,
        // Вывод сохраняется целиком: он и есть то, что подмешивается
        // следующей попытке при include_failure.
        ...(passed ? {} : { detail: `${predicate.command}:\n${String(result.all ?? '').trim()}` }),
      };
    }

    case 'changed_only':
      return evaluateChangedOnly(predicate.globs, input);
    case 'judge':
      // Вычисление судьи — второй, асинхронный проход попытки (см.
      // exec/judgePass.ts): он требует агентского вызова, сессий и журнала, а
      // этот синхронный проход о них не знает нарочно. Место в списке
      // сохраняется, чтобы порядок предикатов не зависел от того, что судья
      // вычисляется позже остальных.
      return {
        predicate: 'judge',
        passed: true,
        hard: false,
        expected: predicate.claim,
        detail: 'не вычислен: судья вызывается вторым проходом',
      };
  }
}

/**
 * Границы изменений: все изменившиеся пути обязаны попадать хотя бы под один
 * из объявленных шаблонов.
 *
 * Предикат проверяет границы, но не факт работы: шаг, не изменивший ничего,
 * его проходит. Держать его единственным не стоит, о чём предупреждает линт.
 */
function evaluateChangedOnly(
  globs: readonly string[],
  input: EvaluationInput,
): PredicateResult {
  if (input.changedPaths === undefined) {
    return {
      predicate: 'changed_only',
      passed: true,
      hard: false,
      detail: 'не вычислен: состояние рабочего дерева снять не удалось',
      expected: globs,
    };
  }

  const outside = input.changedPaths.filter((path) => !globs.some((glob) => matches(glob, path)));

  return {
    predicate: 'changed_only',
    passed: outside.length === 0,
    hard: true,
    expected: globs,
    ...(outside.length === 0
      ? {}
      : {
          actual: outside,
          detail: `за объявленные границы вышли: ${outside.join(', ')}`,
        }),
  };
}

/** Сопоставление пути с шаблоном: `**` пересекает разделители, `*` — нет. */
function matches(glob: string, path: string): boolean {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] as string;
    if (char === '*' && glob[index + 1] === '*') {
      source += '.*';
      index += 1;
      if (glob[index + 1] === '/') index += 1;
      continue;
    }
    if (char === '*') {
      source += '[^/]*';
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`).test(path);
}

function evaluateSchema(path: string, input: EvaluationInput): PredicateResult {
  if (input.structured === undefined) {
    return {
      predicate: 'schema',
      passed: false,
      hard: true,
      expected: path,
      detail: 'шаг не произвёл структурированного вывода',
    };
  }

  let schema: unknown;
  try {
    schema = JSON.parse(readFileSync(absolute(path, input.cwd), 'utf8'));
  } catch (error) {
    throw new StepcastError(`Не удалось прочитать схему ${path}: ${(error as Error).message}`, {
      file: path,
      cause: error,
    });
  }

  let validate: ValidateFunction;
  try {
    validate = ajv.compile(schema as object);
  } catch (error) {
    // Схему писал пользователь: её дефект — ошибка конфигурации с указанием
    // файла, а не внутренний сбой движка со стеком.
    throw new StepcastError(`Схема ${path} некорректна: ${(error as Error).message}`, {
      file: path,
      cause: error,
    });
  }

  const passed = validate(input.structured) === true;

  return {
    predicate: 'schema',
    passed,
    hard: true,
    expected: path,
    ...(passed
      ? {}
      : {
          detail: (validate.errors ?? [])
            .map(
              (error: ErrorObject) =>
                `${error.instancePath === '' ? '/' : error.instancePath}: ${error.message ?? ''}`,
            )
            .join('\n'),
        }),
  };
}

function compile(pattern: string): RegExp {
  const match = /^\/(.*)\/([a-z]*)$/.exec(pattern);
  return match === null
    ? new RegExp(pattern)
    : new RegExp(match[1] as string, match[2] as string);
}

function absolute(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolvePath(cwd, path);
}
