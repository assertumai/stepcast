import { execaSync } from 'execa';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { Ajv, type ErrorObject } from 'ajv';

import { ScarpError } from '../errors.js';
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
}

const ajv = new Ajv({ allErrors: true, strict: false });

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
    case 'judge':
      throw new ScarpError(`Предикат ${predicate.kind} ещё не реализован`, {
        hint:
          predicate.kind === 'changed_only'
            ? 'Ему нужен якорь рабочего дерева, который появится вместе с worktree и resume'
            : 'Судья требует отдельного агентского вызова и появится отдельным изменением',
      });
  }
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
    throw new ScarpError(`Не удалось прочитать схему ${path}: ${(error as Error).message}`, {
      file: path,
      cause: error,
    });
  }

  const validate = ajv.compile(schema as object);
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
