#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

import { SCHEMA_TARGETS } from './schema-targets.js';
import { buildPublishedSchemas } from '../src/core/pipeline/published-schema.js';

/**
 * JSON Schema для автодополнения в редакторах.
 *
 * Генерируется из тех же zod-схем, которыми проверяются документы: иначе
 * подсказка в редакторе и валидация разъезжаются, и первая начинает врать.
 *
 * Цели `pipeline` и `job` печатаются `buildPublishedSchemas()` с пустым
 * перечнем плагинных предикатов — тем же кодом, каким `stepcast schema`
 * печатает схему проекта (design.md, решение 4): две реализации одного
 * преобразования разошлись бы.
 */
const published = buildPublishedSchemas();
const publishedByKind = { pipeline: published.pipeline, job: published.job };

for (const target of SCHEMA_TARGETS) {
  const path = resolve(process.cwd(), target.file);
  mkdirSync(dirname(path), { recursive: true });
  const json =
    target.published === undefined
      ? { title: target.title, ...z.toJSONSchema(target.schema, { io: target.io, unrepresentable: 'any' }) }
      : publishedByKind[target.published];
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`сгенерировано: ${target.file}`);
}
