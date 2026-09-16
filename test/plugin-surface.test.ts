import assert from 'node:assert/strict';
import { readFileSync, readdirSync, type Dirent } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/**
 * Граница плагинов пакета (design.md первого настоящего плагина, решение 2;
 * design.md `user-decision-steps`, решение 12) закреплена дважды: правилом
 * линта (`eslint.config.js`) и здесь. Линт решает построчно и не разворачивает
 * `**`-паттерн заранее — этот тест перечисляет модули на диске, так что новый
 * файл `src/backends/**` или `src/parts/steps/decision/**` проверяется без
 * отдельной правки теста, а не только когда кто-то напишет нарушающий импорт.
 *
 * Разрешено ровно три направления (`plugin-surface-split`, design.md,
 * Решение 10): ядерная поверхность `../../plugin.js`, доменная поверхность
 * `src/parts/pipeline/surface.ts` и соседний модуль того же каталога — плагин
 * из нескольких файлов (манифест отдельно от адаптера, поля отдельно от
 * исполнителя) остаётся законной раскладкой, а путь наружу, в ядро, отсюда не
 * ведёт никуда. Оба каталога — `src/backends` и `src/parts/steps/decision` —
 * обходятся одним перечислением: граница у них одна и та же, а не две её
 * копии.
 *
 * Каталог `src/parts/steps/decision` — не единственный вид шага в
 * `src/parts/steps/`: `run`/`uses`/`script`/`agent` под этой же границей не
 * ходят вовсе — их строки лишь называют внутреннюю форму разбора движка
 * (`core/pipeline/expand.js`), и этой поверхности не имеют
 * (`builtin-step-kinds-as-rows`, design.md, Решение 8). Корень назван точно
 * на `decision`, не на всём `src/parts/steps/`.
 *
 * `row.ts` границы не проверяет — исключён так же, как в `eslint.config.js`:
 * он не реализация вклада, ему нужен тип `BuiltinRow` из `src/core/plugins/load.js`.
 *
 * На пустом каталоге тест проходит вырожденно: перечислять и проверять нечего,
 * пока в пакете нет ни одного плагина этого вида.
 */
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const surfaceRoots = [join(repoRoot, 'src/backends'), join(repoRoot, 'src/parts/steps/decision')];
const pluginModule = resolve(repoRoot, 'src/plugin.ts');
/** Доменная поверхность `stepcast/pipeline` — второе законное направление рядом с ядерной. */
const pipelineSurfaceModule = resolve(repoRoot, 'src/parts/pipeline/surface.ts');

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

/** Модуль соседнего плагина того же каталога — законное направление наравне с поверхностью. */
function insideRoot(root: string, path: string): boolean {
  return path.startsWith(root + sep);
}

function surfaceViolations(): string[] {
  const violations: string[] = [];

  for (const root of surfaceRoots) {
    for (const file of listTsFiles(root)) {
      // Модуль строки — не реализация вклада, границу с ним не проверяет
      // (та же оговорка, что у блока `eslint.config.js`).
      if (file.endsWith(`${sep}row.ts`)) continue;
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
        if (resolved === pluginModule || resolved === pipelineSurfaceModule || insideRoot(root, resolved)) continue;
        violations.push(
          `${where}: '${specifier}' — ведёт мимо ../../plugin.js, мимо parts/pipeline/surface.js и мимо ${relative(repoRoot, root)}`,
        );
      }
    }
  }

  return violations;
}

describe('backends и steps/decision: публичная поверхность', () => {
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
