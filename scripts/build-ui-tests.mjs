#!/usr/bin/env node
import { readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

/**
 * Сборка браузерных тестов витрины — design.md `cordis-kernel-browser`,
 * Решение 12. `ui/test/**\/*.test.tsx` собираются esbuild'ом (тем же
 * пакетом, которым демон компилирует виджеты, `src/ui/widgets.ts`) в
 * `dist/ui-test/`; `react` и `react-dom` (и его подпути, включая
 * `react-dom/server`, которым тесты рендерят) остаются внешними — их
 * разрешит сам Node из `node_modules`. Отдельный скрипт, а не запись esbuild
 * в `package.json` напрямую: список файлов собирается обходом каталога, а не
 * шаблоном оболочки, — переносимо между `sh` и `bash` и не зависит от того,
 * включён ли `globstar`.
 *
 * Примитивы Radix (`@stepcast/ui`, design.md изменения `shared-module-table`,
 * Решение 6) — тоже внешние, а не забандленные: их собственные внутренние
 * зависимости (`react-remove-scroll` и подобные) несут код, рассчитанный на
 * CJS-разрешение `require()` в самом Node, и бандл esbuild в ESM даёт на нём
 * «Dynamic require... is not supported» — esbuild сшивает CJS-интероп
 * внешнего `react` внутрь чужого CJS-модуля и не может сделать это статично.
 * Не бандлить сам пакет Radix — и разрешать его Node'у напрямую из
 * `node_modules` — снимает проблему целиком: их собственные транзитивные
 * зависимости тогда вовсе не попадают в поле зрения esbuild.
 *
 * `@dnd-kit/*` (перетаскивание карточек доски) — внешний по той же причине и
 * с тем же отказом: его CJS-сборка зовёт `require('react')`.
 */

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEST_DIR = join(ROOT, 'ui', 'test');
const OUT_DIR = join(ROOT, 'dist', 'ui-test');

function collectTestFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTestFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.test.tsx')) {
      out.push(full);
    }
  }
  return out;
}

const entryPoints = collectTestFiles(TEST_DIR);
if (entryPoints.length === 0) {
  // Пустой каталог тестов — не молчаливый пропуск: без явного отказа
  // `node --test "dist/ui-test/**/*.test.js"` не нашёл бы ничего и это
  // осталось бы незамеченным (design.md, дорожка тестов проверяется
  // нарочно падающей пустышкой).
  console.error(`build-ui-tests: в ${TEST_DIR} нет ни одного файла *.test.tsx`);
  process.exit(1);
}

// Очистка перед сборкой: тест, удалённый из `ui/test`, не должен оставлять в
// `dist/ui-test` скомпилированный файл, который `node --test` продолжил бы
// молча находить и запускать.
rmSync(OUT_DIR, { recursive: true, force: true });

await esbuild.build({
  entryPoints,
  outdir: OUT_DIR,
  outbase: TEST_DIR,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'es2023',
  external: ['react', 'react-dom', 'react-dom/*', '@radix-ui/*', '@dnd-kit/*'],
  // Имена таблицы, живущие в репозитории (design.md изменения
  // `shared-module-table`, Решения 5, 6): у плагина их разрешает карта имён
  // страницы, здесь — то же отображение, что в `vite.config.ts` и обоих
  // `ui/tsconfig*.json`. Без него браузерный тест был бы единственным местом,
  // пишущим относительный путь вместо имени.
  alias: {
    '@stepcast/slots': join(ROOT, 'ui', 'src', 'sharedSlots.ts'),
    '@stepcast/ui': join(ROOT, 'ui', 'src', 'ui', 'index.ts'),
  },
  jsx: 'automatic',
  logLevel: 'info',
});
