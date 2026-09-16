import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { SCHEMA_TARGETS } from '../scripts/schema-targets.js';
import { buildPublishedSchemas, pluginPredicateEntries, pluginStepKindEntries } from '../src/parts/pipeline/document/published-schema.js';
import { builtinRegistry } from '../src/parts/builtin.js';

/**
 * Схемы `schema/*.json` печатаются из zod-моделей `scripts/generate-schema.ts`
 * и коммитятся как обычные файлы репозитория. Тест сравнивает файл с тем, что
 * даёт та же модель прямо сейчас: правка модели без перегенерации схемы
 * должна ронять `npm run check`, а не расходиться молча.
 *
 * Цели `pipeline` и `job` печатаются не голым `z.toJSONSchema`, а
 * `buildPublishedSchemas()` встроенного дерева (`generate-schema.ts`,
 * design.md `user-decision-steps` решение 12): в поставке уже есть плагинный
 * вид шага `decision`, и его ветвь обязана быть в схеме пакета.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const registry = builtinRegistry();
const published = buildPublishedSchemas(pluginPredicateEntries(registry), pluginStepKindEntries(registry));
const publishedByKind = { pipeline: published.pipeline, job: published.job };

describe('публикуемые схемы совпадают с моделями', () => {
  for (const target of SCHEMA_TARGETS) {
    it(`${target.file} порождён текущей моделью`, () => {
      const expected =
        target.published === undefined
          ? { title: target.title, ...z.toJSONSchema(target.schema, { io: target.io, unrepresentable: 'any' }) }
          : publishedByKind[target.published];
      const actual = JSON.parse(readFileSync(`${ROOT}${target.file}`, 'utf8')) as unknown;

      assert.deepEqual(actual, expected);
    });
  }
});
