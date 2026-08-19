#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

import { PipelineDocumentSchema, JobDocumentSchema } from '../src/core/pipeline/schema.js';
import { RawConfigSchema } from '../src/core/config/schema.js';

/**
 * JSON Schema для автодополнения в редакторах.
 *
 * Генерируется из тех же zod-схем, которыми проверяются документы: иначе
 * подсказка в редакторе и валидация разъезжаются, и первая начинает врать.
 */
const targets = [
  ['schema/pipeline.schema.json', PipelineDocumentSchema, 'stepcast pipeline'],
  ['schema/job.schema.json', JobDocumentSchema, 'stepcast job'],
  ['schema/config.schema.json', RawConfigSchema, 'stepcast config'],
] as const;

for (const [file, schema, title] of targets) {
  const path = resolve(process.cwd(), file);
  mkdirSync(dirname(path), { recursive: true });
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  writeFileSync(path, `${JSON.stringify({ title, ...json }, null, 2)}\n`);
  console.log(`сгенерировано: ${file}`);
}
