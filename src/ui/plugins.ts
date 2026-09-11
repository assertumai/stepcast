import { createHash } from 'node:crypto';
import { readdirSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

import { pluginsDirPath } from '../core/plugins/discover.js';
import { readPluginManifest } from '../core/plugins/manifest.js';

/**
 * Плагины домашнего слоя, дающие браузерную половину (design.md изменения
 * `hot-swap-preserves-data`, Решение 12, задача 4.1 `user-plugins-from-files`).
 *
 * Версия — отпечаток каталога плагина целиком, а не одного файла: браузерная
 * половина плагина вправе состоять из нескольких файлов (локальные
 * относительные импорты, `src/ui/widgets.ts`, режим бандла), и правка любого
 * из них обязана сдвинуть версию (`user-plugins`, «Признаком изменения SHALL
 * быть отпечаток каталога плагина»).
 */

/** Отпечаток каталога — рекурсивный обход с пропуском `node_modules`, `.git` и точечных каталогов, свёртка `mtime` и размеров. */
function collectFileStats(dir: string, relative: string, hash: ReturnType<typeof createHash>): void {
  let entries: readonly Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    const entryRelative = `${relative}${entry.name}`;

    if (entry.isDirectory()) {
      collectFileStats(path, `${entryRelative}/`, hash);
      continue;
    }
    if (!entry.isFile()) continue;

    try {
      const stat = statSync(path);
      hash.update(`${entryRelative}:${stat.mtimeMs}:${stat.size}\n`);
    } catch {
      // Файл исчез между перечислением и `stat` — та же гонка, что и у
      // `widgetFingerprint`; пропускается, а не роняет обход.
    }
  }
}

/** Отпечаток каталога плагина строкой — тем же приёмом, что `fingerprintVersion` у виджета (`src/ui/widgets.ts`), но по каталогу целиком. */
export function directoryFingerprint(dir: string): string {
  const hash = createHash('sha256');
  collectFileStats(dir, '', hash);
  return hash.digest('hex');
}

/** Сверено построчно с `PluginRowView` (`ui/src/api.ts`). */
export interface PluginRowView {
  readonly id: string;
  readonly version: string;
}

/**
 * Действующая браузерная строка глазами демона (`currentDaemonKernel`,
 * `src/ui/kernel.ts`): откуда взят каталог плагина и каким файлом объявлена
 * его браузерная половина — оба поля приходят из манифеста, применённого
 * сборкой дерева, а не выводятся из `id`. Каталожная строка вправе лежать где
 * угодно (`use: ./путь`), и предполагаемый путь `~/.stepcast/plugins/<id>`
 * дал бы отпечаток несуществующего каталога и поиск половины не там, где она
 * есть.
 *
 * Версии здесь нет нарочно: состав переживает попадание ядра в кеш (дерево
 * совпало — сборки не было), а отпечаток каталога обязан быть свежим на
 * момент вопроса. Его считает тот, кому он нужен: адрес `/plugins/<id>.js`
 * (ключ кеша сборки) и поток событий (версия строки в событии `plugins`).
 */
export interface ActivePluginRow {
  readonly id: string;
  readonly dir: string;
  /** Абсолютный реальный путь браузерной половины — уже проверенный манифестом внутри каталога плагина. */
  readonly browser: string;
}

export interface PluginsOverview {
  readonly plugins: readonly PluginRowView[];
}

/** Имена каталогов верхнего уровня каталога плагинов, отсортированные — тем же обходом, что `listProjectWidgetIds`. */
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

/**
 * Плагины домашнего слоя, несущие браузерную половину, — наивным обходом
 * каталога плагинов, без учёта патча (`enabled: false`) и коллизий имени со
 * встроенной строкой: этим владеет `currentDaemonKernel`
 * (`src/ui/kernel.ts`, действующий состав задачи 11), у которого есть дерево
 * и итоги его сборки.
 *
 * Это взгляд наблюдателя (`src/ui/watcher.ts`): он отвечает на вопрос «на
 * диске что-то изменилось» и даёт СВЕЖУЮ версию каждой строки — отпечаток на
 * момент опроса, а не на момент последней сборки дерева. Содержимым события
 * `plugins` служит пересечение этого взгляда с действующим составом демона
 * (`src/ui/server.ts`, `activePlugins`): членство — от демона, чтобы поток и
 * адрес `/plugins/<id>.js` не расходились, версия — отсюда, потому что правка
 * файла половины дерева не меняет и в кешированное ядро не попадает.
 */
export function buildHomePlugins(home: string): PluginsOverview {
  const dir = pluginsDirPath(home);
  const plugins: PluginRowView[] = [];

  for (const id of listPluginDirNames(dir)) {
    const pluginDir = join(dir, id);
    let manifest;
    try {
      manifest = readPluginManifest(pluginDir);
    } catch {
      continue;
    }
    if (manifest.browser === undefined) continue;
    plugins.push({ id, version: directoryFingerprint(pluginDir) });
  }

  return { plugins };
}

/** Каталог одного плагина домашнего слоя — общий путь для отпечатка версии и для чтения манифеста. */
export function pluginDirPath(home: string, id: string): string {
  return join(pluginsDirPath(home), id);
}
