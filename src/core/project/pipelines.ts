import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Обход файлов-кандидатов пайплайна в проекте.
 *
 * Общий модуль для витрины (`src/ui/pipelines.ts`) и планировщика расписания:
 * оба ищут одни и те же файлы одним и тем же правилом, и раздваивать его —
 * плодить два места, которые могут разойтись.
 *
 * Обход намеренно мелкий: корневой `stepcast.yml` и `.stepcast/pipelines/*.yml`
 * — раскладка, которую заводит `stepcast init` и которой держится сам проект.
 * Полный обход дерева проекта стоил бы дорого и находил бы чужие YAML.
 */

/** Каталог пайплайнов проекта относительно его корня. */
const PIPELINE_DIR = join('.stepcast', 'pipelines');

/** Пайплайн ли это. Определение работы лежит в таком же `.yml` и им не является. */
export function isPipelineFile(path: string): boolean {
  try {
    // Достаточно шапки: `kind` объявляется в первых строках документа.
    return /^kind:\s*pipeline\s*$/m.test(readFileSync(path, 'utf8').slice(0, 4096));
  } catch {
    return false;
  }
}

/** Файлы-кандидаты пайплайна проекта, в порядке от корневого к каталогу пайплайнов. */
export function listPipelineFiles(projectPath: string): string[] {
  const out: string[] = [];
  const root = join(projectPath, 'stepcast.yml');
  if (existsSync(root)) out.push(root);

  const dir = join(projectPath, PIPELINE_DIR);
  try {
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith('.yml') || name.endsWith('.yaml')) out.push(join(dir, name));
    }
  } catch {
    // Каталога пайплайнов у проекта может не быть — это не ошибка.
  }
  return out.filter(isPipelineFile);
}
