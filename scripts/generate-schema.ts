#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

import { SCHEMA_TARGETS } from './schema-targets.js';
import { buildPublishedSchemas, pluginPredicateEntries, pluginStepKindEntries } from '../src/parts/pipeline/document/published-schema.js';
import { builtinRegistry } from '../src/parts/builtin.js';

/**
 * JSON Schema для автодополнения в редакторах.
 *
 * Генерируется из тех же zod-схем, которыми проверяются документы: иначе
 * подсказка в редакторе и валидация разъезжаются, и первая начинает врать.
 *
 * Цели `pipeline` и `job` печатаются `buildPublishedSchemas()` тем же кодом,
 * каким `stepcast schema` печатает схему проекта (design.md, решение 4): две
 * реализации одного преобразования разошлись бы. Перечень предикатов
 * встроенного реестра пуст (встроенные предикаты — резерв имени, а не
 * настоящий вклад, `src/parts/builtin.ts`), а перечень видов шага несёт
 * `decision` (`user-decision-steps`) — первый плагинный вид, идущий в
 * поставке строкой дерева: без него схема пакета не знала бы о нём вовсе.
 */
const registry = builtinRegistry();
const published = buildPublishedSchemas(pluginPredicateEntries(registry), pluginStepKindEntries(registry));
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
