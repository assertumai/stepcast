import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';

import { StepcastError } from '../errors.js';
import { WIRING_KEYS } from './schema.js';

/** Прочитать и разобрать YAML-документ, отдав понятную диагностику. */
export function readYamlDocument(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new StepcastError(`Файл не найден: ${path}`, { file: path, cause: error });
    }
    throw new StepcastError(`Не удалось прочитать файл: ${(error as Error).message}`, {
      file: path,
      cause: error,
    });
  }

  try {
    return parseYaml(text);
  } catch (error) {
    throw new StepcastError(`Документ не разбирается как YAML: ${(error as Error).message}`, {
      file: path,
      cause: error,
    });
  }
}

type SchemaIssue = z.core.$ZodIssue;

/** Причина отказа схемы: текст и место внутри документа. */
export interface SchemaFailure {
  readonly message: string;
  /** Путь внутри документа, например `jobs.propose-a`. Пусто — корень. */
  readonly at: string | undefined;
}

/**
 * Неизвестный ключ объясняет отказ лучше всего остального: он назван в самом
 * документе, а не выведен из схемы. «Обязательный ключ отсутствует» рядом с
 * ним — обычно след чужого варианта объединения, а не настоящая причина.
 */
function informative(issue: SchemaIssue): number {
  return issue.code === 'unrecognized_keys' ? 1 : 0;
}

function deepest(issues: readonly SchemaIssue[]): number {
  return issues.reduce((max, issue) => Math.max(max, issue.path.length), 0);
}

/**
 * Замечание, объясняющее отказ: сначала то, что называет лишний ключ, затем —
 * самое глубокое по пути. При равенстве побеждает первое, то есть поведение
 * не меняется там, где замечание всего одно.
 */
function chooseIssue(issues: readonly SchemaIssue[]): SchemaIssue | undefined {
  let best: SchemaIssue | undefined;
  for (const issue of issues) {
    if (best === undefined) {
      best = issue;
      continue;
    }
    if (informative(issue) > informative(best)) best = issue;
    else if (informative(issue) === informative(best) && issue.path.length > best.path.length) {
      best = issue;
    }
  }
  return best;
}

/**
 * Вариант объединения, ближе всего подошедший к документу: чем меньше у него
 * замечаний, тем ближе он к тому, что автор имел в виду; при равном счёте
 * побеждает вариант, разобравший документ глубже. Слепо взятый первый вариант
 * увёл бы диагностику в чужую форму записи — например, объяснял бы встроенную
 * работу отсутствием ключа `uses`.
 */
function chooseBranch(branches: readonly (readonly SchemaIssue[])[]): readonly SchemaIssue[] | undefined {
  let best: readonly SchemaIssue[] | undefined;
  for (const branch of branches) {
    if (branch.length === 0) continue;
    if (best === undefined || branch.length < best.length) {
      best = branch;
      continue;
    }
    if (branch.length === best.length && deepest(branch) > deepest(best)) best = branch;
  }
  return best;
}

/** Текст замечания. Лишний ключ называется прямо: имя ключа и есть ответ. */
function describeIssue(issue: SchemaIssue): string {
  if (issue.code === 'unrecognized_keys') {
    const keys = issue.keys.join(', ');
    return issue.keys.length === 1 ? `неизвестный ключ ${keys}` : `неизвестные ключи ${keys}`;
  }
  return issue.message;
}

/**
 * Причина отказа схемы по дереву замечаний zod.
 *
 * Схемы документов — объединения вариантов (работа по ссылке `uses` против
 * встроенной, агентский шаг против командного), а на объединении zod выдаёт
 * обобщённое `Invalid input`: настоящая причина лежит глубже, внутри
 * замечаний конкретного варианта. Поэтому замечание не берётся первым
 * попавшимся, а выбирается спуском в тот вариант, который документу ближе.
 */
export function describeSchemaFailure(error: z.ZodError): SchemaFailure {
  const explain = (issues: readonly SchemaIssue[], prefix: readonly string[]): SchemaFailure => {
    const issue = chooseIssue(issues);
    const at = prefix.length === 0 ? undefined : prefix.join('.');
    if (issue === undefined) return { message: 'неизвестная ошибка', at };
    const path = [...prefix, ...issue.path.map((segment) => String(segment))];
    if (issue.code === 'invalid_union') {
      const branch = chooseBranch(issue.errors);
      if (branch !== undefined) return explain(branch, path);
    }
    return { message: describeIssue(issue), at: path.length === 0 ? undefined : path.join('.') };
  };
  return explain(error.issues, []);
}

/** Проверить документ схемой, привязав ошибку к файлу и месту внутри него. */
export function validateDocument<T extends z.ZodType>(
  schema: T,
  document: unknown,
  file: string,
): z.infer<T> {
  const parsed = schema.safeParse(document);
  if (parsed.success) return parsed.data;

  const failure = describeSchemaFailure(parsed.error);
  throw new StepcastError(`Документ не соответствует схеме: ${failure.message}`, {
    file,
    ...(failure.at === undefined ? {} : { at: failure.at }),
    hint: 'Сверьтесь с docs/pipeline-format.md',
  });
}

/**
 * Обвязка описывает место работы в конкретном пайплайне, поэтому внутри файла
 * работы её быть не может: иначе работа перестаёт быть переиспользуемой.
 * Схема строгая и такие ключи и так не пропустит, но диагностика по существу
 * полезнее, чем «неизвестный ключ».
 */
export function rejectWiringKeys(document: unknown, file: string): void {
  if (typeof document !== 'object' || document === null) return;
  for (const key of WIRING_KEYS) {
    if (key in (document as Record<string, unknown>)) {
      throw new StepcastError(`Ключ ${key} недопустим внутри файла работы`, {
        file,
        at: key,
        hint: 'Зависимости и условия описываются на месте подключения работы в пайплайне',
      });
    }
  }
}
