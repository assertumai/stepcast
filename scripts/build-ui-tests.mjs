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
  external: ['react', 'react-dom', 'react-dom/*'],
  jsx: 'automatic',
  logLevel: 'info',
});
