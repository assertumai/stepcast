import type { IncomingMessage, ServerResponse } from 'node:http';

import type { BuiltinRow } from '../../core/plugins/builtin.js';
import { sendJson } from '../http.js';
import { snapshotOrRecord, parseRunAddress } from '../runAddress.js';
import type { BacklogOverview } from '../backlog.js';
import type { WidgetsOverview } from '../widgets.js';
import { ApiService, ScreensService, screenRow, type ApiHandler, type RequestEnv } from './registry.js';

import { row as agentsRow } from './agents/server.js';
import { row as backlogRow } from './backlog/server.js';
import { row as cleanupRow } from './cleanup/server.js';
import { row as pipelinesRow } from './pipelines/server.js';
import { row as routesRow } from './routes/server.js';
import { row as runRow } from './run/server.js';
import { row as runsRow } from './runs/server.js';
import { row as settingsRow } from './settings/server.js';
import { row as stepsRow } from './steps/server.js';
import { row as usageRow } from './usage/server.js';
import { row as widgetsRow } from './widgets/server.js';
import { row as dashboardsRow } from '../dashboards/row.js';
import { row as runLaunchRow } from '../runLaunch/row.js';
import { routesPayload } from '../routesFile.js';
import type { ActiveScreen } from './registry.js';

/**
 * Строки поставки витрины во встроенном слое дерева (`plugin-tree`, «Строки
 * поставки от вызывающего»; `ui-screens`, «Встроенный слой дерева демона —
 * строки движка плюс строки витрины»).
 *
 * `stepcast up` передаёт эти строки `resolveWithCachedKernel`
 * (`src/ui/kernel.ts`) — только он: команды CLI не передают ничего и не
 * видят ни `ui-shell`, ни один из `screen-*` в своём дереве (design.md,
 * Решение 2).
 */

const handleOverview: ApiHandler = (_req, res, env) => {
  sendJson(res, 200, env.watcher.current());
};

function handleEvents(req: IncomingMessage, res: ServerResponse, env: RequestEnv): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });

  const url = new URL(req.url ?? '/', 'http://internal');
  const followed = parseRunAddress(url.searchParams.get('run'));

  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Последняя отправленная очередь: пока наблюдатель отдаёт то же значение,
  // слать её заново незачем.
  let sent: BacklogOverview | undefined;
  let sentWidgets: WidgetsOverview | undefined;
  // Состав плагинов сравнивается не по ссылке, как соседи выше, а по
  // содержимому: он собирается на каждый такт заново (пересечение взгляда
  // наблюдателя с действующим составом демона, `activePlugins` в
  // `src/ui/server.ts`), и ссылка у него всегда новая.
  let sentPluginsKey: string | undefined;
  // Таблица маршрутов сравнивается по содержимому, а не по ссылке `watcher`:
  // объект пересобирается наблюдателем только по сдвигу своей части
  // отпечатка (`src/ui/watcher.ts`), но новое значение — новый объект даже
  // тогда, когда содержимое совпало с прежним посланным (например, файл
  // тронут без смысловой правки).
  let sentRoutesKey: string | undefined;
  // Состав дашбордов — тем же приёмом, что и `routes`: пересобирается
  // наблюдателем только по сдвигу своей части отпечатка (`src/ui/watcher.ts`),
  // а сравнение потока — по содержимому, не по ссылке (`ui-daemon`, «Поток
  // событий несёт действующие дашборды»).
  let sentDashboardsKey: string | undefined;
  // Состав экранов — тем же приёмом, что и `plugins`: пересобирается на
  // каждый такт заново (`activeScreens`, `src/ui/server.ts`).
  let sentScreensKey: string | undefined;
  let closed = false;
  // Очередь на состав: он приходит из асинхронного вызова, и два такта подряд
  // иначе разошлись бы в порядке отправки.
  let pluginsTail: Promise<void> = Promise.resolve();
  let screensTail: Promise<void> = Promise.resolve();

  const pushPlugins = (): void => {
    pluginsTail = pluginsTail
      .then(async () => {
        const plugins = await env.activePlugins();
        if (closed) return;
        const key = plugins.plugins.map((row) => `${row.id}:${row.version}`).join('|');
        if (key === sentPluginsKey) return;
        sentPluginsKey = key;
        send('plugins', plugins);
      })
      .catch(() => {
        // Отказ сборки дерева уже назван в `GET /api/screens` полем
        // `buildError`; поток событий от него не рвётся и не молчит по
        // остальным своим событиям.
      });
  };

  /**
   * Состав экранов потоком — тем же правилом, что и `plugins` (`ui-daemon`,
   * «Поток событий несёт действующие маршруты и состав экранов»): снятие
   * ограничения «новый состав виден только после перезагрузки»
   * (`docs/ui-plugins.md`).
   */
  const pushScreens = (): void => {
    screensTail = screensTail
      .then(async () => {
        const { screens, buildError } = await env.activeScreens();
        if (closed) return;
        const payload = screensPayload(screens, buildError);
        const key = JSON.stringify(payload);
        if (key === sentScreensKey) return;
        sentScreensKey = key;
        send('screens', payload);
      })
      .catch(() => {
        // Тем же правилом, что и `pushPlugins`: причина уже названа `GET
        // /api/screens`, а поток от неё не рвётся и не молчит по остальным
        // своим событиям.
      });
  };

  const push = (): void => {
    send('overview', env.watcher.current());
    const backlog = env.watcher.currentBacklog();
    if (backlog !== sent) {
      sent = backlog;
      send('backlog', backlog);
    }
    const widgets = env.watcher.currentWidgets();
    if (widgets !== sentWidgets) {
      sentWidgets = widgets;
      send('widgets', widgets);
    }
    // Таблица маршрутов — синхронно из наблюдателя (`ui-routes`, Решение 10):
    // ему не нужно ядро демона, поэтому, в отличие от `screens`/`plugins`,
    // отправка не отстаёт от прочих событий такта на микрозадачу.
    const routesPayloadValue = routesPayload(env.watcher.currentRoutes());
    const routesBuildError = env.watcher.currentRoutesError();
    const routesKey = JSON.stringify({ routes: routesPayloadValue, buildError: routesBuildError });
    if (routesKey !== sentRoutesKey) {
      sentRoutesKey = routesKey;
      send('routes', { routes: routesPayloadValue, ...(routesBuildError === undefined ? {} : { buildError: routesBuildError }) });
    }
    // Состав дашбордов — синхронно из наблюдателя, тем же приёмом, что и
    // `routes`: отказ одного дашборда едет причиной внутри `failures`, не
    // отменяя прочие (`ui-daemon`, «Сломанный файл не отменяет остальные»).
    const dashboardsValue = env.watcher.currentDashboards();
    const dashboardsKey = JSON.stringify(dashboardsValue);
    if (dashboardsKey !== sentDashboardsKey) {
      sentDashboardsKey = dashboardsKey;
      send('dashboards', dashboardsValue);
    }
    // Действующий состав браузерных строк и состав экранов — первым же
    // обменом при подключении и дальше по правилу «только при отличии от
    // отправленного», тем же приёмом, что и `widgets` (design.md изменения
    // `hot-swap-preserves-data`, Решение 11). Отправка отстаёт от прочих
    // событий такта на микрозадачу: оба спрашиваются у ядра демона, а это
    // `await`.
    pushPlugins();
    pushScreens();
    if (followed === undefined) return;
    const snapshot = snapshotOrRecord(env.runsRoot, followed.key, followed.runId);
    if (snapshot !== undefined) send('run', snapshot);
  };

  push();
  const unsubscribe = env.watcher.subscribe(push);

  // Клиент закрыл вкладку — подписка снимается, лишней работы не остаётся.
  req.on('close', () => {
    closed = true;
    unsubscribe();
    res.end();
  });
}

/**
 * Состав экранов в форме ответа: `id`, заголовок, параметры и происхождение
 * строки по каждому действующему экрану, плюс причина отказа последней сборки
 * дерева (`ui-screens`, «Витрина узнаёт действующий состав экранов у демона»;
 * `ui-daemon`, «Отказ сборки состава не гасит витрину»). Адрес и место в
 * навигации сюда не входят — это поля маршрута (`ui-routes`), а не экрана;
 * их несёт `GET /api/routes` и событие потока `routes`.
 *
 * Общая форма для `GET /api/screens` и события потока `screens`: расхождение
 * между ними значило бы, что открытая вкладка и свежая загрузка страницы
 * видят разные составы одного и того же демона.
 */
function screensPayload(screens: ReadonlyMap<string, ActiveScreen>, buildError: string | undefined) {
  return {
    screens: [...screens.values()].map(({ declaration, builtin }) => ({
      id: declaration.id,
      title: declaration.title,
      params: declaration.params,
      // Происхождение строки: по нему страница решает, вправе ли она взять
      // браузерную половину из своего бандла (`ui-screens`, «Экран
      // отключается и заменяется патчем состава»).
      builtin,
    })),
    ...(buildError === undefined ? {} : { buildError }),
  };
}

const handleScreens: ApiHandler = (_req, res, env) => {
  sendJson(res, 200, screensPayload(env.screens, env.buildError));
};

/**
 * Строка каркаса: первая строка витрины во встроенном слое (design.md,
 * Решение 4). Заводит сервисы `screens` и `api` на корневом контексте ядра
 * демона — строки экранов видят их через `ctx.inject`, и порядок строк в
 * дереве от этого не зависит, — и регистрирует три маршрута, не
 * принадлежащих ни одному экрану.
 */
export const UI_SHELL_ROW: BuiltinRow = screenRow('ui-shell', [], (ctx) => {
  new ScreensService(ctx);
  new ApiService(ctx);
  ctx.api.register('GET', '/api/overview', handleOverview);
  ctx.api.register('GET', '/api/events', handleEvents);
  ctx.api.register('GET', '/api/screens', handleScreens);
});

/** По одной строке на встроенный экран, в порядке навигации (`ui-screens`, «Перевод экранов»). */
export const SCREEN_ROWS: readonly BuiltinRow[] = [
  runsRow,
  runRow,
  pipelinesRow,
  stepsRow,
  widgetsRow,
  backlogRow,
  usageRow,
  cleanupRow,
  agentsRow,
  settingsRow,
  routesRow,
];

/**
 * Строки состава без экрана — только маршруты `api` (`ui-dashboards`, design.md
 * Решение 11). Показ и правка дашборда живут во вкладе браузерной строки в
 * `route.target`, а не на отдельном экране, поэтому у `ui-dashboards` нет
 * объявления в `ScreensService`.
 */
export const API_ROWS: readonly BuiltinRow[] = [dashboardsRow, runLaunchRow];

/** Строки поставки витрины целиком: каркас, затем экраны, затем строки без экрана. */
export const UI_ROWS: readonly BuiltinRow[] = [UI_SHELL_ROW, ...SCREEN_ROWS, ...API_ROWS];
