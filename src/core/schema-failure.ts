import type { z } from 'zod';

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
