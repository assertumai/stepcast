import type { BuiltinRow } from '../../kernel/load.js';

import { row as agentsRow } from './screens/agents/server.js';
import { row as backlogRow } from './screens/backlog/server.js';
import { row as cleanupRow } from './screens/cleanup/server.js';
import { row as decisionsRow } from './screens/decisions/server.js';
import { row as pipelinesRow } from './screens/pipelines/server.js';
import { row as proposalsRow } from './screens/proposals/server.js';
import { row as routesRow } from './screens/routes/server.js';
import { row as runRow } from './screens/run/server.js';
import { row as runsRow } from './screens/runs/server.js';
import { row as scrumRow } from './screens/scrum/server.js';
import { row as settingsRow } from './screens/settings/server.js';
import { row as usageRow } from './screens/usage/server.js';
import { row as widgetsRow } from './screens/widgets/server.js';
import { row as dashboardsRow } from './dashboards/row.js';
import { row as runLaunchRow } from './runLaunch/row.js';
import { row as uiShellRow } from './shell/row.js';

/**
 * Строки поставки витрины во встроенном слое дерева (`plugin-tree`, «Строки
 * поставки от вызывающего»; `ui-screens`, «Встроенный слой дерева демона —
 * строки движка плюс строки витрины»). Перечень — список модулей, а не
 * программа: ни одного тела строки здесь нет (design.md, Решение 3). Уровнем
 * выше `screens/`, `dashboards/`, `runLaunch/`, потому что называет не только
 * экраны.
 *
 * `stepcast up` передаёт эти строки `resolveWithCachedKernel`
 * (`src/parts/ui/daemon/kernel.ts`) — только он: команды CLI не передают ничего и не видят
 * ни `ui-shell`, ни один из `screen-*` в своём дереве (design.md, Решение 2).
 */

/**
 * Строка каркаса. Перечень — единственное место, где она зовётся по имени:
 * сам модуль экспортирует её как `row`, по общему соглашению строк.
 */
export const UI_SHELL_ROW: BuiltinRow = uiShellRow;

/** По одной строке на встроенный экран, в порядке навигации (`ui-screens`, «Перевод экранов»). */
export const SCREEN_ROWS: readonly BuiltinRow[] = [
  runsRow,
  runRow,
  pipelinesRow,
  decisionsRow,
  widgetsRow,
  backlogRow,
  scrumRow,
  usageRow,
  cleanupRow,
  agentsRow,
  settingsRow,
  routesRow,
  proposalsRow,
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
