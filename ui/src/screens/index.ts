import type { Context } from 'cordis';

import agents from './agents';
import backlog from './backlog';
import cleanup from './cleanup';
import pipelines from './pipelines';
import routes from './routes';
import run from './run';
import runs from './runs';
import settings from './settings';
import steps from './steps';
import usage from './usage';
import widgets from './widgets';

/**
 * Таблица «id → браузерная половина» встроенных экранов (design.md, Решение
 * 12, 14). Плагин `ui/src/plugins/screens.tsx` применяет запись, только если
 * демон назвал этот `id` в действующем составе (`GET /api/screens`) — вклад
 * встроенного экрана, которого демон не назвал, в бандле остаётся, но не
 * применяется.
 */
export type ScreenPlugin = (ctx: Context) => void;

export const BUILTIN_SCREENS: Readonly<Record<string, ScreenPlugin>> = {
  'screen-runs': runs,
  'screen-run': run,
  'screen-pipelines': pipelines,
  'screen-steps': steps,
  'screen-widgets': widgets,
  'screen-backlog': backlog,
  'screen-usage': usage,
  'screen-cleanup': cleanup,
  'screen-agents': agents,
  'screen-settings': settings,
  'screen-routes': routes,
};
