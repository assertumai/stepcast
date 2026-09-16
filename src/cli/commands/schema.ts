import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

import { buildPublishedSchemas, pluginPredicateEntries, pluginStepKindEntries } from '../../core/pipeline/published-schema.js';
import { nativeStepKindNames, type Registry } from '../../core/plugins/registry.js';
import { isDefaultNativeStepKinds } from '../../core/pipeline/schema.js';
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
  const stepKinds = pluginStepKindEntries(registry);
  const nativeStepKinds = nativeStepKindNames(registry);

  const { pipeline, job, notes } = buildPublishedSchemas(predicates, stepKinds, nativeStepKinds);

  mkdirSync(outDir, { recursive: true });
  const pipelinePath = join(outDir, 'pipeline.schema.json');
  const jobPath = join(outDir, 'job.schema.json');
  writeFileSync(pipelinePath, `${JSON.stringify(pipeline, null, 2)}\n`);
  writeFileSync(jobPath, `${JSON.stringify(job, null, 2)}\n`);

  write(`записано: ${pipelinePath}`);
  write(`записано: ${jobPath}`);

  // Виды шага встроенных строк дерева (`decision`) в этот счёт не входят: они
  // есть и в поставляемой пакетом схеме, и проект, ничего своего не
  // добавивший, получает файл, совпадающий с ней, — сообщать обратное значило
  // бы звать пользователя искать отличие, которого нет. Отключённый встроенный
  // вид шага (`builtin-step-kinds-as-rows`) снимает эту схожесть тоже: схема
  // проекта тогда не признаёт его ключей, и печатать «совпадает» значило бы
  // соврать.
  if (predicates.length === 0 && stepKinds.every((entry) => entry.builtin === true) && isDefaultNativeStepKinds(nativeStepKinds)) {
    write('плагинных предикатов и видов шага нет: схема совпадает с поставляемой пакетом');
  }

  for (const note of notes) {
    const kind = note.kind === 'predicate' ? 'предиката' : 'полей вида шага';
    write(`предупреждение: схема значения ${kind} ${note.name} (плагин ${note.plugin}) не вложена в схему — ${note.reason}`);
  }

  return ExitCode.ok;
}
