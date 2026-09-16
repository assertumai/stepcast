import { z } from 'zod';

/**
 * Схема документа `plugins.patch.yml` (design.md изменения
 * `source-tree-microkernel-layout`, Решение 5): формат патча описывает дерево
 * строк, а не конфигурацию движка, и живёт рядом с механизмом, который его
 * применяет (`tree.ts`). Конфигурация движка (`src/parts/pipeline/config/schema.ts`,
 * `src/parts/pipeline/config/resolve.ts`) читает схему отсюда — `parts` вправе читать
 * ядро.
 */

/**
 * Строка документа `plugins.patch.yml`: `id` известный — заменяет одноимённую
 * строку дерева целиком, `id` новый — вставляется по `before`/`after`
 * (design.md, Решение 3). `use` обязателен всегда — то, что как раз меняет
 * замена; `enabled` необязателен, умолчание `true` то же, что и у строки
 * дерева.
 *
 * `id` не ограничен видом слага нарочно: чаще всего это и есть слаг,
 * придуманный автором патча заново, но патч, ссылающийся на строку ключа
 * `plugins`, обязан назвать её id — сам спецификатор модуля
 * (`stepcast-configuration`, Решение 4), а он путём быть и обязан
 * (`./plugins/local.mjs`). Единственное требование — непустая строка, той же
 * моделью, что `use`.
 */
export const PluginPatchRowSchema = z
  .object({
    id: z.string().trim().min(1).regex(/\S/, 'id строки не может быть пустым'),
    use: z.string().trim().min(1).regex(/\S/, 'модуль строки не может быть пустым'),
    enabled: z.boolean().optional(),
    before: z.string().min(1).optional(),
    after: z.string().min(1).optional(),
  })
  .strict();

export type PluginPatchRow = z.infer<typeof PluginPatchRowSchema>;

/**
 * Документ `plugins.patch.yml` (design.md, Решение 9): отдельный от
 * `config.yml`, со своими `version`/`kind` — оба обязательны, в отличие от
 * `config.yml`, где они допускались пустыми ради файлов, заведённых раньше
 * появления этого поля. У патча такой истории нет.
 */
export const PluginsPatchDocumentSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('plugins-patch'),
    plugins: z.array(PluginPatchRowSchema).min(1),
  })
  .strict();

export type PluginsPatchDocument = z.infer<typeof PluginsPatchDocumentSchema>;
