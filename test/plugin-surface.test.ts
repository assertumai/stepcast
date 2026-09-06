import assert from 'node:assert/strict';
import { readFileSync, readdirSync, type Dirent } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/**
 * Граница плагинов пакета (design.md первого настоящего плагина, решение 2)
 * закреплена дважды: правилом линта (`eslint.config.js`) и здесь. Линт решает
 * построчно и не разворачивает `**`-паттерн заранее — этот тест перечисляет
 * модули на диске, так что новый файл `src/backends/**` проверяется без
 * отдельной правки теста, а не только когда кто-то напишет нарушающий импорт.
 *
 * Разрешено ровно два направления: публичная поверхность `../../plugin.js` и
 * соседний модуль того же каталога плагинов — плагин из нескольких файлов
 * (манифест отдельно от адаптера) остаётся законной раскладкой, а путь наружу,
 * в ядро, отсюда не ведёт никуда.
 *
 * На пустом каталоге `src/backends` тест проходит вырожденно: перечислять и
 * проверять нечего, пока в пакете нет ни одного плагина.
 */
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const backendsRoot = join(repoRoot, 'src/backends');
const pluginModule = resolve(repoRoot, 'src/plugin.ts');

function listTsFiles(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * `import … from '…'` и `import '…'` ради побочного эффекта, включая
 * многострочные: список имён в скобках переносов не запрещает, поэтому
 * отрицательный класс символов, а не `.`. Круглая скобка в нём исключена
 * намеренно — иначе выражение поглотило бы динамический `import(…)`, у
 * которого свой разбор ниже.
 */
const STATIC_IMPORT_RE = /(?:^|[\s;}])import\s+(?:type\s+)?(?:[^'"();]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;
/** `export … from '…'` — тот же путь наружу, только другим ключевым словом. */
const REEXPORT_RE = /(?:^|[\s;}])export\s+(?:type\s+)?[^'"();]*?\sfrom\s+['"]([^'"]+)['"]/gm;
/**
 * Динамический `import(…)` и `require(…)`. Их не видит `no-restricted-imports`
 * — правило разбирает только статические формы, — а обойти границу ими так же
 * легко. Специфик, собранный из выражения, статически не проверить вовсе:
 * такая форма запрещена целиком, отсюда необязательная группа — совпадение без
 * неё и есть нарушение.
 */
const DYNAMIC_IMPORT_RE = /\b(import|require)\s*\(\s*(?:['"]([^'"]+)['"]\s*\))?/g;

interface ModuleImports {
  readonly specifiers: readonly string[];
  /** Формы, чей специфик — не строковый литерал: проверить их нечем. */
  readonly computed: readonly string[];
}

function parseImports(source: string): ModuleImports {
  const specifiers: string[] = [];
  const computed: string[] = [];

  for (const re of [STATIC_IMPORT_RE, REEXPORT_RE]) {
    for (const match of source.matchAll(re)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  for (const match of source.matchAll(DYNAMIC_IMPORT_RE)) {
    const specifier = match[2];
    if (specifier === undefined) computed.push(`${match[1] ?? 'import'}(…)`);
    else specifiers.push(specifier);
  }

  return { specifiers, computed };
}

/** Модуль соседнего плагина того же пакета — законное направление наравне с поверхностью. */
function insideBackends(path: string): boolean {
  return path.startsWith(backendsRoot + sep);
}

function surfaceViolations(): string[] {
  const violations: string[] = [];

  for (const file of listTsFiles(backendsRoot)) {
    const where = relative(repoRoot, file);
    const { specifiers, computed } = parseImports(readFileSync(file, 'utf8'));

    for (const form of computed) {
      violations.push(`${where}: ${form} — специфик не литерал, границу на нём не проверить`);
    }

    for (const specifier of specifiers) {
      if (specifier.startsWith('node:')) continue;
      if (!specifier.startsWith('.')) {
        violations.push(
          `${where}: '${specifier}' — не встроенный модуль Node и не относительный импорт`,
        );
        continue;
      }
      // `.js` в исходнике — расширение скомпилированного модуля; на диске
      // рядом лежит `.ts`, и сверяться нужно с ним.
      const resolved = resolve(dirname(file), specifier).replace(/\.js$/, '.ts');
      if (resolved === pluginModule || insideBackends(resolved)) continue;
      violations.push(`${where}: '${specifier}' — ведёт мимо ../../plugin.js и мимо src/backends`);
    }
  }

  return violations;
}

describe('backends: публичная поверхность', () => {
  it('каждый импорт ведёт во встроенный модуль Node, в ../../plugin.js либо в соседний модуль плагина', () => {
    assert.deepEqual(surfaceViolations(), []);
  });

  // Разбор — половина проверки: пропущенная форма импорта означает границу,
  // которой на самом деле нет. Проверяется на тексте, а не на файле: писать
  // нарушающий модуль в `src/backends` ради теста значило бы ронять первую
  // проверку этого же describe.
  it('разбор видит побочный, динамический и вычисленный импорт наравне со статическим', () => {
    const parsed = parseImports(
      [
        "import '../../core/errors.js';",
        "import { join } from 'node:path';",
        "const { StepcastError } = await import('../../core/errors.js');",
        "const legacy = require('../../core/plugins/registry.js');",
        'const computed = await import(chosenByName);',
        "export type { Thing } from '../../plugin.js';",
      ].join('\n'),
    );

    assert.deepEqual(parsed.specifiers, [
      '../../core/errors.js',
      'node:path',
      '../../plugin.js',
      '../../core/errors.js',
      '../../core/plugins/registry.js',
    ]);
    assert.deepEqual(parsed.computed, ['import(…)']);
  });
});
