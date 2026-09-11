import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

import { listProjects } from '../core/journal/reader.js';
import { backfillUsageStore } from '../core/journal/usageStore.js';
import type { Config } from '../core/config/resolve.js';
import { dashboardHtml } from './assets.js';
import { sendJson } from './http.js';
import { currentDaemonKernel } from './kernel.js';
import {
  createKernelCache,
  disposeRaisedKernels,
  shareKernelCache,
  type KernelCache,
} from './pipelines.js';
import type { RequestEnv } from './screens/registry.js';
import { isApiPath, isPluginPath, isSafeSegment, isSharedPath, isWidgetPath } from './routes.js';
import { createWatcher, type Watcher } from './watcher.js';
import {
  createWidgetCompiler,
  errorModuleText,
  resolveWidgetFile,
  type WidgetCompiler,
} from './widgets.js';
import { SHARED_MODULE_BY_SEGMENT, sharedModuleText } from './sharedModules.js';
import { directoryFingerprint, type PluginsOverview } from './plugins.js';

/**
 * HTTP-витрина журнала.
 *
 * Только петля: сервер, доступный всей сети, — грубый случай, которого здесь
 * быть не должно. Чтение журнала остаётся чтением: демон по-прежнему не пишет
 * в файлы прогонов.
 *
 * Диспетчер не знает ни одного имени экрана (`ui-screens`, «Сервер витрины
 * знает механизм регистрации маршрутов, а не имена экранов»): обработчик
 * запроса под `/api/` выбирается поиском в реестре `api`, который несёт
 * действующее ядро демона (`src/ui/kernel.ts`). Здесь остаются: проверка
 * источника и метода, содержимое под `/widgets/` (Решение 16 — среда
 * выполнения виджетов, не маршрут экрана) и отдача страницы витрины на любой
 * прочий GET.
 */

/** Петлевой адрес: слушать `0.0.0.0` витрине незачем. */
export const LOOPBACK = '127.0.0.1';

export interface UiServerOptions {
  readonly runsRoot: string;
  readonly port: number;
  readonly watcher?: Watcher;
  /**
   * Компилятор виджетов. Заводится сервером сам, если не передан; переданный
   * снаружи сервер не останавливает при `close()` — тем же приёмом, что и
   * `watcher` (design.md изменения `ui-runtime-widget-spike`, Решение 12).
   */
  readonly widgetCompiler?: WidgetCompiler;
  /**
   * Конфигурация для разбора пайплайнов. Без неё экран пайплайнов пуст:
   * раскрытие пайплайна опирается на умолчания конфигурации.
   */
  readonly config?: Config;
  /** Домашний каталог: определяет, какой глобальный конфиг правят настройки. */
  readonly home?: string;
  /**
   * Кеш ядер: контекст на корень проекта плюс собственный контекст демона
   * (ключ `home:<домашний каталог>`) — им пользуется `src/ui/kernel.ts`.
   * Заводится сервером сам, если не передан, тем же приёмом, что и `watcher`:
   * полученный снаружи кеш `close()` не снимает — ни один из его контекстов.
   */
  readonly kernelCache?: KernelCache;
  /**
   * Файл собранной витрины. По умолчанию — артефакт сборки рядом с кодом
   * (`dist/ui-web/index.html`). Переопределение нужно проверке отказа
   * несобранной витрины: без него она вынуждена удалять настоящий артефакт с
   * диска, то есть портить рабочее дерево ради одного сценария.
   */
  readonly dashboardFile?: string;
  /** Куда наблюдатель печатает отказ разбора файла журнала. См. `WatcherOptions.log`. */
  readonly log?: (line: string) => void;
}

export interface UiServer {
  readonly server: Server;
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Запрос на изменение пришёл со своей же страницы.
 *
 * Петлевой порт открыт любой странице, которую откроет браузер пользователя:
 * без этой проверки чужой сайт мог бы фоновым запросом снести историю
 * прогонов. Чтение остаётся свободным — оно и так ничего не меняет.
 */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  // Запрос без Origin — не из браузера: curl и тесты обращаются к демону
  // напрямую, и запрещать это значило бы запрещать работу из терминала.
  if (origin === undefined) return true;

  try {
    return new URL(origin).hostname === LOOPBACK || new URL(origin).hostname === 'localhost';
  } catch {
    return false;
  }
}

/** Содержимое под `/widgets/`: JS всегда 200, `text/javascript` — сам модуль решает, рабочий он или ошибка (design.md, Решение 8). */
function sendWidgetModule(res: ServerResponse, code: string, options: { readonly error?: true } = {}): void {
  res.writeHead(200, {
    'content-type': 'text/javascript; charset=utf-8',
    'cache-control': 'no-store',
    // Заголовок-пометка ошибки — для curl и проверки, не разбирающих JS.
    ...(options.error === true ? { 'x-stepcast-widget-error': '1' } : {}),
  });
  res.end(code);
}

/**
 * Один и тот же отказ на все причины отсутствия: неизвестный ключ проекта,
 * проект без известного пути, отсутствующий файл виджета. Ответ не обязан
 * рассказывать любопытному, какие проекты известны демону (design.md,
 * Решение 5).
 */
function sendWidgetNotFound(res: ServerResponse): void {
  sendJson(res, 404, { error: 'Виджет не найден' });
}

/** `<id>.js` → `<id>` — разобранный сегмент раскладки; расширение исходника фиксировано (design.md, Решение 10). */
function widgetIdFromRoute(raw: string): string | undefined {
  if (!raw.endsWith('.js')) return undefined;
  try {
    return decodeURIComponent(raw.slice(0, -'.js'.length));
  } catch {
    return undefined;
  }
}

/** `/widgets/<projectKey>/<id>.js`: компиляция при запросе, кеш и ошибка — модулем, а не отказом HTTP. */
async function handleWidgetModule(
  runsRoot: string,
  compiler: WidgetCompiler,
  rawKey: string,
  rawId: string,
  res: ServerResponse,
): Promise<void> {
  let key: string;
  try {
    key = decodeURIComponent(rawKey);
  } catch {
    sendWidgetNotFound(res);
    return;
  }
  const id = widgetIdFromRoute(rawId);
  if (!isSafeSegment(key) || id === undefined) {
    sendWidgetNotFound(res);
    return;
  }

  const project = listProjects(runsRoot).find((candidate) => candidate.key === key);
  if (project?.path === undefined || !existsSync(project.path)) {
    sendWidgetNotFound(res);
    return;
  }

  const file = resolveWidgetFile(project.path, id);
  if (file === undefined) {
    sendWidgetNotFound(res);
    return;
  }

  // Файл мог исчезнуть между разрешением адреса и компиляцией — тот же 404,
  // что и на отсутствующий файл, не отказ сервера.
  const outcome = await compiler.compile(file);
  if (outcome === undefined) {
    sendWidgetNotFound(res);
    return;
  }

  if (outcome.kind === 'ok') {
    sendWidgetModule(res, outcome.code);
    return;
  }
  sendWidgetModule(res, errorModuleText(outcome.failure), { error: true });
}

/**
 * Диспетчер `/widgets/...`: ровно одна объявленная форма адреса, остальное —
 * 404 без перечисления каталога (design.md, Решение 10). Сегменты не несут
 * `..` и разделителей — та же проверка, что и у прочих адресов витрины
 * (`isSafeSegment`), внутри `handleWidgetModule`.
 */
async function handleWidgetRequest(
  runsRoot: string,
  compiler: WidgetCompiler,
  pathname: string,
  res: ServerResponse,
): Promise<void> {
  const parts = pathname.split('/').filter((part) => part !== '');
  // `parts[0]` — всегда `widgets`: вызывающий уже проверил `isWidgetPath`.
  if (parts.length === 3) {
    await handleWidgetModule(runsRoot, compiler, parts[1] as string, parts[2] as string, res);
    return;
  }
  sendWidgetNotFound(res);
}

/** Тот же отказ на все причины отсутствия под `/shared/` — сегмент вне таблицы, путь лишней вложенности. */
function sendSharedNotFound(res: ServerResponse): void {
  sendJson(res, 404, { error: 'Общий модуль не найден' });
}

/**
 * `/shared/<имя>.js`: закрытый перечень модулей-переходников таблицы общих
 * модулей витрины (design.md изменения `shared-module-table`, Решения 1, 3—4).
 */
function handleSharedModule(rawName: string, res: ServerResponse): void {
  if (!rawName.endsWith('.js')) {
    sendSharedNotFound(res);
    return;
  }
  const entry = SHARED_MODULE_BY_SEGMENT.get(rawName.slice(0, -'.js'.length));
  if (entry === undefined) {
    sendSharedNotFound(res);
    return;
  }
  sendWidgetModule(res, sharedModuleText(entry));
}

/** Диспетчер `/shared/...`: ровно одна объявленная форма адреса, остальное — 404 без перечисления каталога. */
function handleSharedRequest(pathname: string, res: ServerResponse): void {
  const parts = pathname.split('/').filter((part) => part !== '');
  // `parts[0]` — всегда `shared`: вызывающий уже проверил `isSharedPath`.
  if (parts.length === 2) {
    handleSharedModule(parts[1] as string, res);
    return;
  }
  sendSharedNotFound(res);
}

/** Тот же отказ на все причины отсутствия плагина — небезопасный сегмент, неизвестный `id`, строка вне действующего состава, строка без браузерной половины. */
function sendPluginNotFound(res: ServerResponse): void {
  sendJson(res, 404, { error: 'Плагин не найден' });
}

/**
 * `/plugins/<id>.js`: отдаётся только строка действующего состава
 * (`daemon.plugins`, `src/ui/kernel.ts` — патч и коллизии имени уже учтены),
 * компиляция бандлом при запросе, кеш по отпечатку каталога, ошибка сборки —
 * модулем, а не отказом HTTP (design.md изменения `hot-swap-preserves-data`,
 * Решение 13).
 */
async function handlePluginModule(
  home: string,
  kernelCache: KernelCache | undefined,
  compiler: WidgetCompiler,
  rawId: string,
  res: ServerResponse,
): Promise<void> {
  if (!rawId.endsWith('.js')) {
    sendPluginNotFound(res);
    return;
  }
  let id: string;
  try {
    id = decodeURIComponent(rawId.slice(0, -'.js'.length));
  } catch {
    sendPluginNotFound(res);
    return;
  }

  if (!isSafeSegment(id)) {
    sendPluginNotFound(res);
    return;
  }

  const daemon = await currentDaemonKernel(kernelCache, home);
  // Каталог и файл половины берутся у самой строки состава, а не выводятся из
  // `id`: их назвал манифест, применённый сборкой дерева, и границы каталога
  // плагина по реальному пути проверены там же (`resolvePluginHalf`,
  // `src/core/plugins/manifest.ts`) — демон отдаёт то, что назвал манифест, и
  // ничего сверх.
  const row = daemon.plugins.find((candidate) => candidate.id === id);
  if (row === undefined) {
    sendPluginNotFound(res);
    return;
  }

  const cacheKey = directoryFingerprint(row.dir);
  const outcome = await compiler.compileBundle(row.browser, cacheKey);
  if (outcome === undefined) {
    sendPluginNotFound(res);
    return;
  }

  if (outcome.kind === 'ok') {
    sendWidgetModule(res, outcome.code);
    return;
  }
  sendWidgetModule(res, errorModuleText(outcome.failure), { error: true });
}

/** Диспетчер `/plugins/...`: ровно одна объявленная форма адреса, остальное — 404 без перечисления каталога. */
async function handlePluginRequest(
  home: string,
  kernelCache: KernelCache | undefined,
  compiler: WidgetCompiler,
  pathname: string,
  res: ServerResponse,
): Promise<void> {
  const parts = pathname.split('/').filter((part) => part !== '');
  // `parts[0]` — всегда `plugins`: вызывающий уже проверил `isPluginPath`.
  if (parts.length === 2) {
    await handlePluginModule(home, kernelCache, compiler, parts[1] as string, res);
    return;
  }
  sendPluginNotFound(res);
}

/** Страница витрины. Любой не-API адрес ведёт на неё: маршруты разбирает клиент. */
function handlePage(res: ServerResponse, dashboardFile: string | undefined): void {
  const html = dashboardFile === undefined ? dashboardHtml() : dashboardHtml(dashboardFile);
  if (html === undefined) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Витрина не собрана. Соберите её командой npm run build:ui.\n');
    return;
  }

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

export function createUiServer(options: UiServerOptions): Promise<UiServer> {
  const { runsRoot, config, home, dashboardFile } = options;
  // Плагины домашнего слоя читаются от действующего домашнего каталога, тем
  // же умолчанием, что и `currentDaemonKernel` (`src/ui/kernel.ts`), — здесь
  // разрешается один раз, а не в каждом запросе `/plugins/...`.
  const homeDir = home ?? homedir();
  // Перенос накопленного делает тот, кто открывает хранилище — здесь, при
  // старте демона, до первого обзора и до первого запроса, — поэтому
  // `GET /api/usage` и прочие читающие маршруты остаются чтением (design.md
  // изменения run-stats-retention, Решение 9).
  backfillUsageStore(runsRoot);
  const watcher =
    options.watcher ??
    createWatcher({ runsRoot, home: homeDir, ...(options.log === undefined ? {} : { log: options.log }) });
  const ownsWatcher = options.watcher === undefined;
  // Один кеш ядер на сервер, не на модуль: тесты поднимают несколько демонов в
  // одном процессе, и общий кеш связал бы их между собой (design.md,
  // Решение 3). Ядро проекта и собственное ядро демона (ключ `home:...`,
  // `src/ui/kernel.ts`) живут в одном кеше — их пространства имён не
  // пересекаются (Решение 6).
  const kernelCache =
    options.kernelCache === undefined
      ? createKernelCache(options.log)
      : shareKernelCache(options.kernelCache, options.log);
  // Компилятор виджетов — тем же приёмом, что и `watcher`: заводится сервером
  // сам, если не передан, и снаружи полученный сервер не останавливает
  // (design.md, Решение 12).
  const widgetCompiler =
    options.widgetCompiler ??
    createWidgetCompiler(options.log === undefined ? {} : { log: options.log });
  const ownsWidgetCompiler = options.widgetCompiler === undefined;

  /**
   * Действующий состав браузерных строк для потока событий — пересечение двух
   * взглядов, и оба нужны целиком: членство берётся у ядра демона
   * (`currentDaemonKernel`, патч и итоги применения уже учтены), потому что
   * этим же составом гейтится адрес `/plugins/<id>.js`, и разойдись они —
   * страница просила бы строку, на которую демон отвечает 404, и садила бы её
   * в состояние отказа вместо того, чтобы не знать о ней вовсе. Версия
   * берётся у наблюдателя: она свежий отпечаток каталога, а состав ядра
   * переживает попадание в кеш (дерево от правки файла половины не меняется)
   * и нёс бы версию последней сборки дерева — то есть замена не случалась бы
   * вовсе.
   *
   * Асимметрия одна: строка, чей каталог лежит вне домашнего слоя, у
   * наблюдателя не отпечатывается и в поток не уходит, хотя по адресу
   * отдаётся. Это то же самое, чем она была до сих пор, — расширять взгляд
   * наблюдателя на каталоги, названные конфигом, эта работа не бралась.
   */
  const activePlugins = async (): Promise<PluginsOverview> => {
    const daemon = await currentDaemonKernel(kernelCache, homeDir);
    const active = new Set(daemon.plugins.map((row) => row.id));
    return { plugins: watcher.currentPlugins().plugins.filter((row) => active.has(row.id)) };
  };

  /**
   * Обработчик запроса под `/api/`: ядро демона собирается заново на каждый
   * вызов (`currentDaemonKernel`, попадание в кеш — сравнение дерева, не
   * пересборка), обработчик ищется в его сервисе `api`. Путь, известный под
   * другим методом, отвечает 405; путь, которого не объявила ни одна строка,
   * — 404 (`ui-screens`, «Сервер витрины знает механизм регистрации
   * маршрутов, а не имена экранов»).
   */
  async function dispatchApi(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<void> {
    const daemon = await currentDaemonKernel(kernelCache, home);
    const handler = daemon.api.find(method, url.pathname);
    if (handler === undefined) {
      if (daemon.api.hasAnyMethod(url.pathname)) {
        sendJson(res, 405, { error: 'Такого действия у витрины нет' });
      } else {
        sendJson(res, 404, { error: `Нет такого маршрута: ${method} ${url.pathname}` });
      }
      return;
    }

    const env: RequestEnv = {
      runsRoot,
      watcher,
      config,
      home,
      kernelCache,
      screens: daemon.screens,
      buildError: daemon.buildError,
      activePlugins,
    };
    await handler(req, res, env);
  }

  /**
   * Отказ, не пойманный обработчиком, — ответ 500, а не необработанное
   * отклонение промиса: обработчики приходят и от строк пользователя, а демон
   * — процесс долгоживущий, и падать от чужой ошибки в одном маршруте он не
   * вправе. Заголовки, уже отправленные обработчиком (поток событий), не
   * переписываются — соединение просто закрывается.
   */
  function dispatchApiSafely(req: IncomingMessage, res: ServerResponse, url: URL, method: string): void {
    void dispatchApi(req, res, url, method).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      options.log?.(`отказ обработчика ${method} ${url.pathname}: ${message}`);
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: `Отказ обработчика ${method} ${url.pathname}: ${message}` });
    });
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${LOOPBACK}`);
    const method = req.method ?? 'GET';

    if (method !== 'GET' && !sameOrigin(req)) {
      sendJson(res, 403, { error: 'Запрос пришёл со стороннего адреса' });
      return;
    }

    if (isApiPath(url.pathname)) {
      dispatchApiSafely(req, res, url, method);
      return;
    }

    if (method !== 'GET') {
      sendJson(res, 405, { error: 'Такого действия у витрины нет' });
      return;
    }

    // Содержимое под `/widgets/` — среда выполнения виджетов, не маршрут
    // экрана (design.md, Решение 16): разбирается по префиксу и сегментам, а
    // не по точному совпадению пути реестра.
    if (isWidgetPath(url.pathname)) {
      void handleWidgetRequest(runsRoot, widgetCompiler, url.pathname, res);
      return;
    }

    // Переходники общих модулей — своя форма адреса, не про виджеты
    // (design.md изменения `shared-module-table`, Решение 3).
    if (isSharedPath(url.pathname)) {
      handleSharedRequest(url.pathname, res);
      return;
    }

    // Браузерная половина плагина домашнего слоя — тем же приёмом, что и
    // виджет: форма адреса демона (design.md изменения
    // `hot-swap-preserves-data`, Решение 13).
    if (isPluginPath(url.pathname)) {
      void handlePluginRequest(homeDir, kernelCache, widgetCompiler, url.pathname, res);
      return;
    }

    handlePage(res, dashboardFile);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, LOOPBACK, () => {
      server.removeListener('error', reject);
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : options.port;

      resolve({
        server,
        port,
        close: async () => {
          if (ownsWatcher) watcher.dispose();
          // Служебный процесс esbuild переживает `stepcast down` и вешает
          // `node --test`, если его не остановить (design.md, Решение 12);
          // компилятор, полученный снаружи, останавливает тот, кто его поднял.
          if (ownsWidgetCompiler) await widgetCompiler.dispose();
          // Тем же правилом «останавливает тот, кто поднял», считанным по
          // ядру: снимаются контексты, поднятые этим сервером, и остаются
          // действующими те, что положил в кеш кто-то другой (design.md,
          // Решение 6, ui-daemon spec).
          await disposeRaisedKernels(kernelCache);
          server.closeAllConnections();
          await new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
  });
}
