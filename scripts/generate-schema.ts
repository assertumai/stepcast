#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

import { SCHEMA_TARGETS } from './schema-targets.js';

/**
 * JSON Schema для автодополнения в редакторах.
 *
 * Генерируется из тех же zod-схем, которыми проверяются документы: иначе
 * подсказка в редакторе и валидация разъезжаются, и первая начинает врать.
 */
for (const target of SCHEMA_TARGETS) {
  const path = resolve(process.cwd(), target.file);
  mkdirSync(dirname(path), { recursive: true });
  const json = z.toJSONSchema(target.schema, { io: target.io, unrepresentable: 'any' });
  writeFileSync(path, `${JSON.stringify({ title: target.title, ...json }, null, 2)}\n`);
  console.log(`сгенерировано: ${target.file}`);
}
