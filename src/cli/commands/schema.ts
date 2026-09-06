import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

import { buildPublishedSchemas, pluginPredicateEntries } from '../../core/pipeline/published-schema.js';
import type { Registry } from '../../core/plugins/registry.js';
import { ExitCode, type ExitCodeValue } from '../../core/errors.js';
import type { ParsedArgs } from '../args.js';

/**
 * Печатает схемы документов проекта: `stepcast schema`.
 *
 * Отказ загрузки объявленного плагина достаётся общим ходом точки входа
 * (`resolveWithPlugins`, `src/cli/main.ts`) — до этой функции дело не
 * доходит вовсе, и записи от неполного реестра здесь произойти не может
 * (design.md, решение 1).
 */
export function runSchemaCommand(
  args: ParsedArgs,
  write: (line: string) => void,
  cwd: string,
  registry: Registry,
): ExitCodeValue {
  const outDir = resolvePath(cwd, typeof args.flags.out === 'string' ? args.flags.out : join('.stepcast', 'schema'));

  // Тот же перечень, с каким сверяет записанный файл `stepcast lint`.
  const predicates = pluginPredicateEntries(registry);

  const { pipeline, job, notes } = buildPublishedSchemas(predicates);

  mkdirSync(outDir, { recursive: true });
  const pipelinePath = join(outDir, 'pipeline.schema.json');
  const jobPath = join(outDir, 'job.schema.json');
  writeFileSync(pipelinePath, `${JSON.stringify(pipeline, null, 2)}\n`);
  writeFileSync(jobPath, `${JSON.stringify(job, null, 2)}\n`);

  write(`записано: ${pipelinePath}`);
  write(`записано: ${jobPath}`);

  if (predicates.length === 0) {
    write('плагинных предикатов нет: схема совпадает с поставляемой пакетом');
  }

  for (const note of notes) {
    write(
      `предупреждение: схема значения предиката ${note.predicate} (плагин ${note.plugin}) не вложена в схему — ${note.reason}`,
    );
  }

  return ExitCode.ok;
}
