import { SHARED_MODULES, changeNoteFor } from './daemon/sharedModules.js';

/**
 * Разбор голых спецификаторов файла виджета (`widget-migration`, design.md
 * Решение 9): достаточно консервативный, чтобы ложный плюс (виджет назван
 * устаревшим зря) не стоил дороже ложного минуса (устаревание пропущено —
 * его всё равно покажет браузер карточкой «неразрешённый импорт»). Полного
 * разбора TypeScript здесь нет — только построчный образец `import … from
 * '…'`, нечувствительный к строке внутри комментария или литерала.
 */

export interface WidgetImport {
  readonly specifier: string;
  /** Именованные импорты клаузы; пустой список — импорт без вида `{ … }` (пространство имён либо только вид по умолчанию). */
  readonly names: readonly string[];
}

const IMPORT_LINE = /^\s*import\s+(?:type\s+)?([^;]+?)\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/;

function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/');
}

/** Именованные импорты клаузы: `Button, { Card, Table as T }` → `['Card', 'Table']`; `as` отбрасывается — таблица сверяет исходное имя. */
function namedImportsOf(clause: string): readonly string[] {
  const match = /\{([^}]*)\}/.exec(clause);
  if (match === null) return [];
  return (match[1] as string)
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => (part.split(/\s+as\s+/)[0] as string).trim())
    .filter((name) => name !== '');
}

/** Снять комментарии, чтобы `// import { X } from 'y'` не считался импортом. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Голые импорты файла виджета, в порядке появления. Неразбираемый файл
 * (двоичный мусор, оборванный синтаксис) даёт пустой перечень — консервативный
 * разбор молчит там, где не уверен, а не отказывает.
 */
export function parseWidgetImports(source: string): readonly WidgetImport[] {
  const text = stripComments(source);
  const imports: WidgetImport[] = [];
  for (const line of text.split('\n')) {
    const match = IMPORT_LINE.exec(line);
    if (match === null) continue;
    const clause = match[1] as string;
    const specifier = match[2] as string;
    if (!isBareSpecifier(specifier)) continue;
    imports.push({ specifier, names: namedImportsOf(clause) });
  }
  return imports;
}

/** Что именно не разрешается действующей таблицей: сам голый спецификатор либо имя его клаузы. */
export type UnresolvedSharedKind = 'specifier' | 'name';

/** То, чего действующая таблица не несёт, — с текстом записи о смене, если она есть. */
export interface UnresolvedSharedName {
  readonly kind: UnresolvedSharedKind;
  readonly specifier: string;
  /** Неразрешимое: имя клаузы при `kind: 'name'`, сам спецификатор при `kind: 'specifier'`. */
  readonly name: string;
  readonly noteText: string | undefined;
}

/**
 * Сверка голых импортов с действующей таблицей (`widget-migration`, «Виджет,
 * импортирующий имя не из таблицы, считается устаревшим»; design.md Решение 9:
 * признак — «голый спецификатор в файле виджета, которого нет в действующей
 * таблице общих модулей»). Неразрешимым считается двоё:
 *
 * - **сам спецификатор**, которого в таблице нет вовсе. Виджет не собирается
 *   бандлом: его голые импорты разрешает карта имён страницы, а она несёт
 *   ровно специфаки таблицы (`SHARED_MODULE_IMPORT_MAP`). Значит, и ушедшее
 *   целиком имя (самый вероятный вид смены таблицы), и подпуть пакета таблицы
 *   (`react-dom/client`), и сторонний пакет (`lodash`) в браузере не
 *   разрешатся — это и есть устаревание, а не «не наша проверка»;
 * - **имя клаузы** у специфика, который таблица знает: сам специфик остался,
 *   а имя из него ушло.
 *
 * Порядок перечня — порядок появления импортов; у одного импорта спецификатор
 * назван один раз, а не по разу на каждое имя его клаузы: чинить надо импорт,
 * а не каждое имя в нём по отдельности.
 */
export function unresolvedSharedNames(imports: readonly WidgetImport[]): readonly UnresolvedSharedName[] {
  const out: UnresolvedSharedName[] = [];
  for (const entryImport of imports) {
    const entry = (SHARED_MODULES as Readonly<Record<string, { readonly names: readonly string[] } | undefined>>)[
      entryImport.specifier
    ];
    if (entry === undefined) {
      out.push({
        kind: 'specifier',
        specifier: entryImport.specifier,
        name: entryImport.specifier,
        noteText: changeNoteFor(entryImport.specifier)?.text,
      });
      continue;
    }
    for (const name of entryImport.names) {
      if (!entry.names.includes(name)) {
        out.push({ kind: 'name', specifier: entryImport.specifier, name, noteText: changeNoteFor(name)?.text });
      }
    }
  }
  return out;
}
