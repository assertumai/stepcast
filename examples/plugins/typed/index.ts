import { z } from 'zod';
import { definePlugin, definePredicate, defineStepKind } from 'stepcast/plugin';

/**
 * Образец плагина движка (design.md изменения `plugin-typed-helpers`,
 * Решение 8): первый в репозитории, применяющий хелперы `define*` к своему
 * коду, а не к встроенным плагинам пакета. Каждая схема вклада — значение
 * предиката, поля вида шага и его структурированный выход — приходит из своей
 * единственной zod-модели: тип выводом (`z.infer`), схема — преобразованием
 * той же модели (`toContributionSchema` ниже). Второй записи формы значения в
 * этом файле нет.
 *
 * Импорты — только `stepcast/plugin` и `zod`: то же, что видит сторонний
 * автор плагина, установивший `stepcast` пакетом (design.md, Решение 9).
 */

/**
 * Преобразование модели в самодостаточную схему вклада (design.md, Решение
 * 7). Три опции защищают самодостаточность:
 *
 * - `reused: 'inline'` — повторно используемая подсхема вкладывается на
 *   месте, а не выносится `$ref`: движок вкладывает схему вклада в документ
 *   проекта (`stepcast schema`), и ссылка разрешалась бы там от чужого корня.
 * - `io: 'input'` — читается сторона входа модели: документ пайплайна и есть
 *   вход, а умолчания и преобразования модели — дело автора, не документа.
 * - Корневой `$schema` снимается после преобразования: тем же ключом, каким
 *   объявлен диалект, схема заявила бы права на документ, в который её
 *   вложили.
 *
 * Требование к результату называет `docs/plugins.md`, а держит состав опций
 * `test/example-plugin.test.ts`: он прогоняет схемы этого образца настоящей
 * печатью схемы проекта (`buildPublishedSchemas`,
 * `src/core/pipeline/published-schema.ts`) и падает, если движок хотя бы одну
 * из них вложить не смог.
 */
function toContributionSchema<T extends z.ZodType>(model: T): Record<string, unknown> {
  const schema = z.toJSONSchema(model, {
    target: 'draft-2020-12',
    io: 'input',
    reused: 'inline',
  }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

/** Значение предиката `even-number`: целое число — единственный источник и типа, и схемы. */
const EvenNumberValue = z.number().int();
type EvenNumberValue = z.infer<typeof EvenNumberValue>;

/** Поля вида шага `word-count`: текст и необязательный нижний порог числа слов. */
const WordCountFields = z
  .object({
    text: z.string(),
    min: z.number().int().nonnegative().optional(),
  })
  .strict();
type WordCountFields = z.infer<typeof WordCountFields>;

/**
 * Структурированный выход того же вида шага: та же модель — и схема `output`
 * вклада, которой движок проверяет `outcome.structured`
 * (`src/core/exec/pluginStep.ts`), и тип значения, которое собирает
 * исполнитель. Второй схемы вклада в образце не было бы вовсе, если бы рецепт
 * показывался только на входе: выход проверяется тем же приёмом и той же
 * ценой ошибки.
 */
const WordCountOutput = z.object({ words: z.number().int().nonnegative() }).strict();
type WordCountOutput = z.infer<typeof WordCountOutput>;

export default definePlugin({
  name: 'typed-example',
  version: '0.1.0',
  predicates: [
    definePredicate<EvenNumberValue>({
      name: 'even-number',
      schema: toContributionSchema(EvenNumberValue),
      evaluate(value) {
        // `value` — число: схема выше уже проверила его при разборе
        // документа, приведения здесь нет.
        return {
          predicate: 'even-number',
          passed: value % 2 === 0,
          hard: true,
          expected: 'чётное число',
          actual: value,
        };
      },
    }),
  ],
  steps: [
    defineStepKind<WordCountFields>({
      name: 'word-count',
      title: 'Счётчик слов',
      fields: toContributionSchema(WordCountFields),
      output: toContributionSchema(WordCountOutput),
      execute(input) {
        // `input.fields` — WordCountFields: ни `as …`, ни второй записи формы
        // полей в этом файле нет.
        const { text, min } = input.fields;
        const words = text.split(/\s+/).filter((word) => word.length > 0).length;
        const threshold = min ?? 0;
        // Аннотация типом выхода — то же обещание, что и у полей: расхождение
        // с моделью `WordCountOutput` не доживёт до схемы `output`, которой
        // движок проверит это значение.
        const structured: WordCountOutput = { words };
        return {
          exitCode: words >= threshold ? 0 : 1,
          text: String(words),
          structured,
        };
      },
    }),
  ],
});
