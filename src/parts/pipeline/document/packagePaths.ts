import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findPackageRoot } from '../domain/package-schema.js';

/**
 * Переносимая форма ссылок на ресурсы поставки в замке и ключе шага.
 *
 * Схемы `stepcast:<имя>`, обёртка `stepcast:step`, встроенные скрипты, шаги
 * и пайплайны разрешаются в абсолютные пути от корня пакета — а корень у
 * каждого выпуска свой (`~/.stepcast/releases/<ts>-<sha>/`, `node_modules`
 * другого репозитория). Войди такой путь в `jobLockHash` и `computeStepKey`
 * как есть, любой новый выпуск менял бы ключ каждого шага, который ссылается
 * на поставку, а через выходы работ — и всего графа ниже, хотя ни одно
 * определение не менялось.
 *
 * Поэтому перед хешированием каждая строка, которая *целиком* является путём
 * внутри каталогов ресурсов поставки, заменяется на
 * `stepcast-package:<путь от корня>#sha256:<отпечаток содержимого>`: имя
 * ресурса держит ключ независимым от места установки, отпечаток — чутким к
 * правке самого файла. Исполнение этой формы не видит: шаг, `resolved.json`
 * и `pipeline.lock.yml` несут настоящий путь, по которому файл и читается.
 *
 * Трогаются только каталоги ресурсов, а не весь корень: при запуске движка из
 * исходников корень пакета — это рабочее дерево stepcast, и хешировать
 * содержимое произвольных его файлов (которые шаги как раз и правят) значило
 * бы привязать ключ к состоянию дерева в обход отпечатка входов.
 */

export const PACKAGE_REFERENCE_PREFIX = 'stepcast-package:';

/** Каталоги поставки, из которых движок читает ресурсы по ссылкам `stepcast:`. */
const RESOURCE_DIRS: readonly string[] = ['schema', join('src', 'builtin'), 'dist'];

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** Корень пакета stepcast, из которого исполняется движок. */
export function enginePackageRoot(): string {
  return findPackageRoot(HERE);
}

/**
 * Форма, в которую приводятся пути поставки перед хешированием:
 *
 * - `portable` — переносимая ссылка с отпечатком содержимого (действующее
 *   правило);
 * - `relocated` — абсолютный путь с корнем `from`, заменённым на `to`, без
 *   прочих изменений. Так ключ считался до переносимой формы: форма нужна
 *   возобновлению прогонов, записанных прежними выпусками (`resumePlan.ts`).
 */
export type PackagePathForm =
  | { readonly kind: 'portable'; readonly root: string }
  | { readonly kind: 'relocated'; readonly from: string; readonly to: string };

export function portableForm(root: string = enginePackageRoot()): PackagePathForm {
  return { kind: 'portable', root };
}

/** Путь ресурса относительно корня пакета, если строка — путь внутри каталога ресурсов. */
export function packageResourcePath(value: string, root: string): string | undefined {
  const base = root.endsWith(sep) ? root : root + sep;
  if (!value.startsWith(base)) return undefined;
  const relative = value.slice(base.length);
  return RESOURCE_DIRS.some((dir) => relative === dir || relative.startsWith(dir + sep)) ? relative : undefined;
}

/** Отпечаток содержимого файла; каталог и нечитаемый путь отпечатка не дают. */
export function resourceFingerprint(path: string): string | undefined {
  try {
    if (!statSync(path).isFile()) return undefined;
    return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
  } catch {
    return undefined;
  }
}

function normalizeString(value: string, form: PackagePathForm): string {
  if (form.kind === 'relocated') {
    const relative = packageResourcePath(value, form.from);
    return relative === undefined ? value : join(form.to, relative);
  }
  const relative = packageResourcePath(value, form.root);
  if (relative === undefined) return value;
  const portable = relative.split(sep).join('/');
  const fingerprint = resourceFingerprint(value);
  return `${PACKAGE_REFERENCE_PREFIX}${portable}${fingerprint === undefined ? '' : `#sha256:${fingerprint}`}`;
}

/**
 * Копия значения, в которой пути поставки приведены к форме `form`. Порядок
 * ключей объектов сохраняется — от него зависит `JSON.stringify`, а значит и
 * хеш.
 */
export function normalizePackagePaths<T>(value: T, form: PackagePathForm): T {
  return walk(value, form) as T;
}

function walk(value: unknown, form: PackagePathForm): unknown {
  if (typeof value === 'string') return normalizeString(value, form);
  if (Array.isArray(value)) return value.map((item) => walk(item, form));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item, form)]));
  }
  return value;
}

/** Пути ресурсов поставки (относительно `root`), на которые ссылается значение. */
export function packageResourcesIn(value: unknown, root: string): readonly string[] {
  const found = new Set<string>();
  const visit = (item: unknown): void => {
    if (typeof item === 'string') {
      const relative = packageResourcePath(item, root);
      if (relative !== undefined) found.add(relative);
    } else if (Array.isArray(item)) {
      item.forEach(visit);
    } else if (item !== null && typeof item === 'object') {
      Object.values(item).forEach(visit);
    }
  };
  visit(value);
  return [...found].sort();
}
