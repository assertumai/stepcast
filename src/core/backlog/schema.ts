import { z } from 'zod';

/**
 * Формат пункта очереди `backlog.md` и ответа `backlog pick --lanes`, одной
 * моделью на каждую форму. Разбор (`parse.ts`) проверяет пункт этой же
 * схемой, а `scripts/generate-schema.ts` печатает из неё же публикуемую JSON
 * Schema — описание формата и его проверка не должны расходиться.
 */

/** Слаг пункта либо группы: та же форма, что и у идентификатора работы. */
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const BacklogSlugSchema = z
  .string()
  .regex(KEBAB_CASE, 'должен быть слагом в kebab-case');

export const BACKLOG_STATUSES = ['pending', 'in_progress', 'done', 'failed'] as const;

export const BacklogStatusSchema = z.enum(BACKLOG_STATUSES);

/**
 * Пункт очереди целиком, как он получается из текста файла: слаг из
 * заголовка плюс плоские поля под ним. Схема нестрогая (`looseObject`) —
 * поле, не входящее в перечень известных, MUST пережить правку файла, а не
 * потеряться на первой же проверке.
 */
export const BacklogItemSchema = z.looseObject({
  slug: BacklogSlugSchema,
  status: BacklogStatusSchema,
  title: z.string(),
  why: z.string(),
  done_when: z.string(),
  group: BacklogSlugSchema.optional(),
  started_at: z.string().optional(),
  reason: z.string().optional(),
});

export type BacklogItem = z.infer<typeof BacklogItemSchema>;

/** Публикуемая запись пункта — то, что видят `list` и `pick`. */
export const BacklogRecordSchema = z
  .object({
    slug: z.string(),
    title: z.string(),
    why: z.string(),
    done_when: z.string(),
    group: z.string(),
  })
  .strict();

export type BacklogRecord = z.infer<typeof BacklogRecordSchema>;

const BacklogLaneSchema = z
  .object({
    filled: z.boolean(),
    slug: z.string(),
    title: z.string(),
    group: z.string(),
    item: BacklogRecordSchema.nullable(),
  })
  .strict();

/**
 * Ответ `pick --lanes`. Ключи объекта `lanes` — имена дорожек, заданные
 * вызывающим: набор из фиксированных полей описать нечем, дорожки не
 * известны схеме заранее.
 */
export const BacklogSlotsResponseSchema = z
  .object({
    lanes: z.record(z.string(), BacklogLaneSchema),
  })
  .strict();

export type BacklogSlotsResponse = z.infer<typeof BacklogSlotsResponseSchema>;
