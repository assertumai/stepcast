import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * Сборка витрины.
 *
 * Одна самодостаточная страница со встроенными скриптами и стилями: демон
 * отдаёт её единственным файлом и не превращается в файловый сервер с
 * разбором MIME и защитой от обхода путей. Прежняя витрина держалась строковой
 * константой ради того же свойства — оно сохраняется, ценой шага сборки.
 *
 * `dev` работает против поднятого демона: `stepcast up`, затем `npm run
 * dev:ui`. Порт совпадает с `ui.port` встроенных умолчаний.
 */

const ROOT = dirname(fileURLToPath(import.meta.url));
const DAEMON = 'http://127.0.0.1:7717';

export default defineConfig({
  root: 'ui',
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: '../dist/ui-web',
    emptyOutDir: true,
    // Ассеты всё равно встраиваются в страницу; отдельные файлы только сбили
    // бы с толку того, кто заглянет в dist.
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
  },
  server: {
    proxy: {
      '/api': { target: DAEMON, changeOrigin: false },
    },
    fs: {
      // Дев-сервер отдаёт браузеру файлы: разрешено ровно то, из чего витрина
      // собирается, — её собственный каталог, зависимости и общие с
      // демоном модули (`routes.ts` — разбор адресов, `grouping.ts` — склейка
      // прогонов с пайплайнами, `format.ts` — форматирование величин).
      // Целый корень репозитория здесь означал бы,
      // что любая открытая в браузере страница читает через `/@fs/` что
      // угодно из рабочего дерева.
      allow: [
        join(ROOT, 'ui'),
        join(ROOT, 'node_modules'),
        join(ROOT, 'src', 'ui', 'routes.ts'),
        join(ROOT, 'src', 'ui', 'grouping.ts'),
        join(ROOT, 'src', 'ui', 'format.ts'),
      ],
    },
  },
});
