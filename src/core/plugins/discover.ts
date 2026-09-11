import { readdirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

import { directoryOperations, type TreeOperation, type TreeRowFailure } from './tree.js';

/**
 * Обход каталога плагинов слоя (`user-plugins`, design.md, Решение 1, 2).
 *
 * Каталоги верхнего уровня каталога плагинов слоя — каждый становится
 * операцией дерева с `id`, равным имени каталога, и `use` — абсолютным путём
 * каталога; манифест здесь не читается вовсе — это дело загрузчика
 * (`applyTreeRow`, `src/core/plugins/load.ts`, задача 6), который и
 * отказывает строке без `plugin.json` мягко (Решение 10). Отсутствие
 * каталога плагинов — законное состояние, не ошибка.
 *
 * Каталог, названный идентификатором строки встроенного слоя (движка или
 * поставки вызывающего), опознаётся здесь же — имена встроенных строк известны
 * до обхода — и даёт строку с заведомым отказом (`TreeRowFailure`): замена
 * встроенной строки обязана лежать в файле патча и попадать в ревью, а не быть
 * побочным следствием имени каталога (design.md, Решение 5). Отказ этим и
 * ограничивается: встроенная строка остаётся в дереве и действует, соседние
 * каталоги обходятся как обычно, а сборка дерева не прекращается — иначе одна
 * чужая папка делала бы неработоспособными все команды разом.
 */

/** Каталог плагинов слоя: `<корень>/.stepcast/plugins/`. */
export function pluginsDirPath(root: string): string {
  return join(root, '.stepcast', 'plugins');
}

/** Имена каталогов верхнего уровня, отсортированные; вложенность глубже уровня не обходится. */
function listPluginDirNames(pluginsDir: string): readonly string[] {
  let entries: readonly Dirent[];
  try {
    entries = readdirSync(pluginsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function reservedNameFailure(id: string): TreeRowFailure {
  return {
    message: `Каталог плагина ${id} назван идентификатором встроенной строки ${id}`,
    hint: 'Замена встроенной строки делается патчем (plugins.patch.yml), а не именем каталога — см. docs/plugins.md',
  };
}

/**
 * `pluginsDir` — сам каталог плагинов слоя, а не корень над ним: домашний слой
 * берёт его от каталога глобального конфига (`dirname(globalPath)`), а не от
 * домашнего каталога машины, иначе сборка с подставным путём конфигурации —
 * запасное ядро демона (`src/ui/kernel.ts`) — читала бы настоящие
 * `~/.stepcast/plugins`, перестав быть встроенной.
 */
export function discoverPluginDirectories(
  pluginsDir: string,
  layer: 'project' | 'home',
  reservedIds: readonly string[],
): readonly TreeOperation[] {
  return directoryOperations(
    listPluginDirNames(pluginsDir).map((id) => ({
      id,
      dir: join(pluginsDir, id),
      ...(reservedIds.includes(id) ? { failure: reservedNameFailure(id) } : {}),
    })),
    layer,
  );
}
