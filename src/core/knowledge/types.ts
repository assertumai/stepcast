import { z } from 'zod';

/**
 * Контракт источника знания: четыре глагола, JSON на входе и выходе.
 *
 * Форма нарочно узкая. За ней помещается каталог файлов, вики, граф и что
 * угодно ещё, а движок не узнаёт ни про «факт», ни про «индекс», ни про
 * «дрейф» — ровно как он не знает про OpenSpec, зная про `project.spec`.
 *
 * Схемы ответов строгие. Источник — внешний процесс на пути сборки контекста
 * каждого агентского шага; ответ, не прошедший схему, обязан дать внятный
 * отказ, а не молча пустой контекст: шаг с пустым контекстом отработал бы и
 * выглядел успешным.
 */

/** Селектор записи контекста: оглавление, отбор по области, отбор по имени. */
export type KnowledgeSelector =
  | { readonly kind: 'index' }
  | { readonly kind: 'scope'; readonly scope: readonly string[]; readonly budget?: number }
  | { readonly kind: 'id'; readonly id: readonly string[]; readonly budget?: number };

/** Запись оглавления: заголовок и область, без тела. */
export const KnowledgeIndexEntrySchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    scope: z.array(z.string()).default([]),
  })
  .strict();

export const KnowledgeIndexResponseSchema = z
  .object({
    entries: z.array(KnowledgeIndexEntrySchema),
  })
  .strict();

/**
 * Отобранная запись: ровно одно из `path` и `text`. Путь — чтобы движок мог
 * применить к нему `context.deny` и порог вставки теми же правилами, что к
 * файловой записи; текст — для источника, за которым файла нет вовсе.
 */
export const KnowledgeEntrySchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    path: z.string().optional(),
    text: z.string().optional(),
    tokens: z.number().nonnegative(),
  })
  .strict()
  .refine(
    (entry) => (entry.path === undefined) !== (entry.text === undefined),
    'Запись знания обязана нести ровно одно из path и text',
  );

export const KnowledgeSelectResponseSchema = z
  .object({
    entries: z.array(KnowledgeEntrySchema),
  })
  .strict();

/**
 * Нарушение целостности памяти. Уровень — не украшение: `red` проваливает
 * гейт, `yellow` попадает в отчёт и не проваливает. Проверка, краснеющая от
 * любой правки задетого файла, красна всегда, и первое, что с ней сделают, —
 * обойдут.
 */
export const KnowledgeProblemSchema = z
  .object({
    id: z.string().optional(),
    kind: z.string().min(1),
    level: z.enum(['red', 'yellow']),
    detail: z.string().min(1),
  })
  .strict();

export const KnowledgeCheckResponseSchema = z
  .object({
    ok: z.boolean(),
    problems: z.array(KnowledgeProblemSchema).default([]),
  })
  .strict();

/**
 * Идентификатор записываемой единицы. Ограничение не про аккуратность:
 * источник, кладущий знание файлами, собирает из идентификатора имя файла, и
 * `../../src/core/errors` записал бы за пределы каталога знания — поверх кода,
 * мимо всякой проверки. Ограничение стоит на контракте, а не во встроенном
 * источнике: любой источник, отображающий идентификатор в путь, наступил бы на
 * то же самое.
 *
 * Разделителей и ведущей точки нет вовсе — так `..` невыразимо ни в каком
 * виде, и отдельного правила для него не требуется.
 */
export const KnowledgeIdSchema = z
  .string()
  .min(1)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    'Идентификатор состоит из букв, цифр, точки, дефиса и подчёркивания и начинается с буквы или цифры',
  );

export const KnowledgeWriteRequestSchema = z
  .object({
    id: KnowledgeIdSchema,
    title: z.string().min(1),
    scope: z.array(z.string()).default([]),
    anchors: z.array(z.string()).default([]),
    body: z.string().min(1),
    status: z.enum(['active', 'superseded']).optional(),
    supersedes: z.array(z.string()).optional(),
  })
  .strict();

export const KnowledgeWriteResponseSchema = z
  .object({
    ok: z.boolean(),
    path: z.string().optional(),
    problems: z.array(KnowledgeProblemSchema).default([]),
  })
  .strict();

export type KnowledgeIndexEntry = z.infer<typeof KnowledgeIndexEntrySchema>;
export type KnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;
export type KnowledgeProblem = z.infer<typeof KnowledgeProblemSchema>;
export type KnowledgeCheckResponse = z.infer<typeof KnowledgeCheckResponseSchema>;
export type KnowledgeWriteRequest = z.infer<typeof KnowledgeWriteRequestSchema>;
export type KnowledgeWriteResponse = z.infer<typeof KnowledgeWriteResponseSchema>;

/**
 * Источник знания глазами движка. Синхронный намеренно: сборка контекста
 * (`assembleContext`) синхронна и обязана уложиться в бюджет **до** запуска
 * шага, а асинхронный источник потребовал бы разнести проверку бюджета и
 * сборку по разным моментам времени.
 */
export interface KnowledgeSource {
  index(): readonly KnowledgeIndexEntry[];
  select(selector: KnowledgeSelector): readonly KnowledgeEntry[];
  check(): KnowledgeCheckResponse;
  write(request: KnowledgeWriteRequest): KnowledgeWriteResponse;
}

/** Есть ли среди нарушений хоть одно, проваливающее гейт. */
export function hasRedProblem(problems: readonly KnowledgeProblem[]): boolean {
  return problems.some((problem) => problem.level === 'red');
}
