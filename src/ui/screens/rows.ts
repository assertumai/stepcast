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
import { row as runRow } from './run/server.js';
import { row as runsRow } from './runs/server.js';
import { row as settingsRow } from './settings/server.js';
import { row as stepsRow } from './steps/server.js';
import { row as usageRow } from './usage/server.js';
import { row as widgetsRow } from './widgets/server.js';

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
    if (followed === undefined) return;
    const snapshot = snapshotOrRecord(env.runsRoot, followed.key, followed.runId);
    if (snapshot !== undefined) send('run', snapshot);
  };

  push();
  const unsubscribe = env.watcher.subscribe(push);

  // Клиент закрыл вкладку — подписка снимается, лишней работы не остаётся.
  req.on('close', () => {
    unsubscribe();
    res.end();
  });
}

/**
 * Состав экранов: `id`, заголовок, место в навигации, параметры, путь и
 * происхождение строки по каждому действующему экрану, плюс причина отказа
 * последней сборки дерева (`ui-screens`, «Витрина узнаёт действующий состав
 * экранов у демона»; `ui-daemon`, «Отказ сборки состава не гасит витрину»).
 * И причина, и происхождение приходят окружением, а не читаются здесь заново:
 * `src/ui/kernel.ts` — единственное место, знающее, удалась ли последняя
 * сборка, а происхождение ставит реестр по применившей строке.
 */
const handleScreens: ApiHandler = (_req, res, env) => {
  sendJson(res, 200, {
    screens: [...env.screens.values()].map(({ declaration, builtin }) => ({
      id: declaration.id,
      title: declaration.title,
      ...(declaration.nav === undefined ? {} : { nav: declaration.nav }),
      params: declaration.params,
      path: declaration.path,
      ...(declaration.paramValues === undefined ? {} : { paramValues: declaration.paramValues }),
      // Происхождение строки: по нему страница решает, вправе ли она взять
      // браузерную половину из своего бандла (`ui-screens`, «Экран
      // отключается и заменяется патчем состава»).
      builtin,
    })),
    ...(env.buildError === undefined ? {} : { buildError: env.buildError }),
  });
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
];

/** Строки поставки витрины целиком: каркас, затем экраны. */
export const UI_ROWS: readonly BuiltinRow[] = [UI_SHELL_ROW, ...SCREEN_ROWS];
