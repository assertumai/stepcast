import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * Сборка витрины.
 *
 * Одна самодостаточная страница со встроенными скриптами и стилями: демон
 * отдаёт её единственным файлом. Свойство «демон не становится файловым
 * сервером» с разбором MIME и защитой от обхода путей отменено спайком
 * `ui-runtime-widget-spike`: демон отдаёт сгенерированный JS виджетов по двум
 * объявленным формам адреса под `/widgets/` (`src/ui/server.ts`), с той же
 * защитой от обхода, что и у прочих путей витрины. Страница по-прежнему одна:
 * то, что отменено, — граница «ничего, кроме страницы», а не «страница не
 * одна».
 *
 * `dev` работает против поднятого демона: `stepcast up`, затем `npm run
 * dev:ui`. Порт совпадает с `ui.port` встроенных умолчаний.
 */

const ROOT = dirname(fileURLToPath(import.meta.url));
const DAEMON = 'http://127.0.0.1:7717';

/**
 * Имена таблицы, живущие в самом репозитории (design.md изменения
 * `shared-module-table`, Решения 5, 6): у плагина их разрешает карта имён
 * страницы, у встроенной половины — это отображение. Встроенный экран
 * обязан писать то же имя, что и плагин: иначе голый специфик ни разу не
 * проверяется внутри поставки, и первый экран, написанный по документации,
 * не соберётся. Отображение заведено во всех четырёх местах сразу — здесь,
 * в `ui/tsconfig.json`, `ui/tsconfig.test.json` и `scripts/build-ui-tests.mjs`.
 */
const SHARED_IN_REPO = {
  '@stepcast/slots': join(ROOT, 'ui', 'src', 'sharedSlots.ts'),
  '@stepcast/ui': join(ROOT, 'ui', 'src', 'ui', 'index.ts'),
};

export default defineConfig({
  root: 'ui',
  plugins: [react(), viteSingleFile()],
  resolve: { alias: SHARED_IN_REPO },
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
      // Перечень форм адреса виджета — тот же, что отдаёт демон
      // (`isWidgetPath`, `src/ui/routes.ts`), и это сверено тестом
      // («карта имён страницы», `test/ui-shared-modules.test.ts`: каждая форма
      // адреса обязана попасть под запись прокси). Без записи здесь дев-сервер
      // сам отвечал бы на `/widgets/...` (и то и молча, 404 встроенным
      // обработчиком Vite), и правка витрины перестала бы проверяться на
      // виджетах (design.md, Решение 14).
      '/widgets': { target: DAEMON, changeOrigin: false },
      // Переходники общих модулей — своя форма адреса демона (design.md
      // изменения `shared-module-table`, Решение 3); без записи здесь
      // дев-сервер отвечал бы на `/shared/...` сам.
      '/shared': { target: DAEMON, changeOrigin: false },
    },
    fs: {
      // Дев-сервер отдаёт браузеру файлы: разрешено ровно то, из чего витрина
      // собирается, — её собственный каталог, зависимости и общие с
      // демоном модули (`routes.ts` — разбор адресов, `grouping.ts` — склейка
      // прогонов с пайплайнами, `format.ts` — форматирование величин,
      // `transcript.ts` — разбор потока шага в записи хода, `runsView.ts` —
      // фильтры и порядок списка прогонов, `filters.ts` — общее обоим экранам
      // правило «выбранное значение фильтра не исчезает», `backlogView.ts` —
      // нумерация, фильтры и порядок очереди улучшений, `sharedModules.ts` —
      // таблица общих модулей и ключ глобали, которую публикует `main.tsx`,
      // `fibers.ts` — успокоение контекста и поиск зависших областей, общее с
      // ядром демона (design.md `cordis-kernel-browser`, Решение 6)).
      // Целый корень репозитория здесь означал бы,
      // что любая открытая в браузере страница читает через `/@fs/` что
      // угодно из рабочего дерева.
      //
      // `src/ui/screens` разрешён каталогом, а не перечнем файлов
      // (`builtin-pages-as-plugins`, design.md Решение 14): объявления
      // экранов — общий с демоном модуль на каждый встроенный экран
      // (`src/ui/screens/<id>/declaration.ts`), и перечислять десять файлов
      // поимённо давало бы тот же доступ ценой лишней строки на каждый новый
      // экран; серверные половины (`server.ts`) в этом каталоге тоже лежат, но
      // витрина их не импортирует, и дев-сервер отдаёт браузеру только то, что
      // запрошено.
      allow: [
        join(ROOT, 'ui'),
        join(ROOT, 'node_modules'),
        join(ROOT, 'src', 'ui', 'routes.ts'),
        join(ROOT, 'src', 'ui', 'grouping.ts'),
        join(ROOT, 'src', 'ui', 'format.ts'),
        join(ROOT, 'src', 'ui', 'transcript.ts'),
        join(ROOT, 'src', 'ui', 'runsView.ts'),
        join(ROOT, 'src', 'ui', 'filters.ts'),
        join(ROOT, 'src', 'ui', 'backlogView.ts'),
        join(ROOT, 'src', 'ui', 'sharedModules.ts'),
        join(ROOT, 'src', 'ui', 'screens'),
        join(ROOT, 'src', 'core', 'config', 'modelTiers.ts'),
        join(ROOT, 'src', 'core', 'plugins', 'fibers.ts'),
      ],
    },
  },
});
