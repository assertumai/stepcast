import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { SCHEMA_TARGETS } from '../scripts/schema-targets.js';

/**
 * Схемы `schema/*.json` печатаются из zod-моделей `scripts/generate-schema.ts`
 * и коммитятся как обычные файлы репозитория. Тест сравнивает файл с тем, что
 * даёт та же модель прямо сейчас: правка модели без перегенерации схемы
 * должна ронять `npm run check`, а не расходиться молча.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

describe('публикуемые схемы совпадают с моделями', () => {
  for (const target of SCHEMA_TARGETS) {
    it(`${target.file} порождён текущей моделью`, () => {
      const expected = {
        title: target.title,
        ...z.toJSONSchema(target.schema, { io: target.io, unrepresentable: 'any' }),
      };
      const actual = JSON.parse(readFileSync(`${ROOT}${target.file}`, 'utf8')) as unknown;

      assert.deepEqual(actual, expected);
    });
  }
});
