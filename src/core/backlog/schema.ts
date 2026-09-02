import { isAbsolute } from 'node:path';

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
 * Вес пункта — метка, по которой пайплайн выбирает цепочку работ. Проверяется
 * форма, а не словарь: слова — соглашение репозитория и его пайплайна, и
 * перечень допустимых в ядре запретил бы репозиторию назвать свои веса
 * своими словами. Очередь не знает устройства проекта — знать его словарь ей
 * тем более неоткуда.
 *
 * Пункт без поля даёт пустую метку, а не слово по умолчанию: слово было бы
 * тем же навязанным словарём. Условие пайплайна сравнивает метку со своей —
 * несовпадение (в том числе пустая метка и опечатка) ведёт пункт цепочкой по
 * умолчанию, а какая она, решает пайплайн.
 */
export const BacklogTrackSchema = BacklogSlugSchema;

/**
 * Имя каталога в перечне `repos`: относительный путь без сегмента `..`, без
 * абсолютной формы и без символов шаблона глоба — тот же смысл, что у
 * `RelativeRepoPathSchema` конфигурации, но отдельная модель: очередь не
 * знает устройства проекта и не имеет права зависеть от `core/config`.
 */
const RepoNameSchema = z
  .string()
  .refine((value) => !isAbsolute(value), 'путь не может быть абсолютным')
  .refine((value) => !value.split('/').includes('..'), 'путь не может выходить за корень сегментом ..')
  .refine((value) => !/[*?]/.test(value), 'путь не может содержать символы шаблона глоба (*, ?)');

/**
 * Перечень репозиториев, которых касается пункт, — через запятую в тексте
 * очереди, `.` называет корень рабочего дерева. Разбор MUST NOT проверять,
 * что названный каталог объявлен составом: очередь не читает конфигурацию
 * проекта, это проверяет тот, кто разрешает имя в объявление
 * (`stepcast project repos`, `src/core/project/repos.ts`).
 */
const RepoListSchema = z.string().transform((value, ctx) => {
  if (value.trim() === '') {
    ctx.addIssue({ code: 'custom', message: 'пустое значение поля repos' });
    return z.NEVER;
  }
  const names = value.split(',').map((item) => item.trim());
  const seen = new Set<string>();
  for (const name of names) {
    if (name === '') {
      ctx.addIssue({ code: 'custom', message: 'пустой элемент перечня repos' });
      return z.NEVER;
    }
    if (seen.has(name)) {
      ctx.addIssue({ code: 'custom', message: `повтор имени «${name}» в repos` });
      return z.NEVER;
    }
    seen.add(name);
    const check = RepoNameSchema.safeParse(name);
    if (!check.success) {
      const reason = check.error.issues[0]?.message ?? 'некорректный формат';
      ctx.addIssue({ code: 'custom', message: `недопустимое имя «${name}» в repos: ${reason}` });
      return z.NEVER;
    }
  }
  return names;
});

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
  track: BacklogTrackSchema.optional(),
  started_at: z.string().optional(),
  reason: z.string().optional(),
  repos: RepoListSchema.optional(),
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
    /** Объявленный вес пункта; пусто, когда пункт поле не заполнил. */
    track: z.string(),
    /** Названные репозитории в объявленном порядке; пусто, когда пункт поле не заполнил. */
    repos: z.array(z.string()),
  })
  .strict();

export type BacklogRecord = z.infer<typeof BacklogRecordSchema>;

/**
 * Объявления репозитория, которые команда `stepcast project repos`
 * проставляет заполненной дорожке: каталог репозитория и его команда
 * проверки и практика спецификации, пути которой уже склеены от корня
 * рабочего дерева. `pick` этот блок не заполняет — он появляется, только
 * когда ответ прошёл через `project repos`.
 */
const BacklogRepoBlockSchema = z
  .object({
    dir: z.string(),
    check: z.string(),
    /**
     * Инструменты репозитория — корневой перечень плюс его собственный
     * (`resolveItemRepo`). Ключ необязателен: дерево, не объявившее
     * `project.tools` нигде, отвечает без него, а не пустым списком, который
     * в элементе `allow` дал бы ноль записей.
     */
    tools: z.array(z.string()).min(1).optional(),
    spec: z
      .object({
        dir: z.string(),
        rules: z.string(),
        tool: z.string(),
      })
      .strict(),
  })
  .strict();

export type BacklogRepoBlock = z.infer<typeof BacklogRepoBlockSchema>;

const BacklogLaneSchema = z
  .object({
    filled: z.boolean(),
    slug: z.string(),
    title: z.string(),
    group: z.string(),
    /**
     * Вес пункта дорожки — плоским полем рядом со слагом и заголовком, чтобы
     * условие `if` пайплайна читало его без захода внутрь `item`. Пусто и у
     * незаполненной дорожки, и у пункта без поля: сравнение с меткой,
     * которую ищет ветка пайплайна, даёт ложь, и ветка не запускается ни на
     * пустоте, ни на неразмеченном пункте.
     */
    track: z.string(),
    item: BacklogRecordSchema.nullable(),
    repo: BacklogRepoBlockSchema.optional(),
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
