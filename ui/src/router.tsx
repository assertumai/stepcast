import { useCallback, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { Context } from 'cordis';

import { hrefFor, parseRoute, type MatchedRoute, type RouteTarget } from '../../src/ui/routes';
import { KernelContext } from './kernel';
import type { RoutesSnapshot } from './services/routes';
import type { ScreensSnapshot } from './services/screens';

export type { MatchedRoute };

/**
 * Маршрутизация на History API — над таблицей действующих маршрутов, а не
 * над перечислением экранов (`ui-routes`, «Навигация и разбор адреса
 * собираются из действующей таблицы маршрутов»).
 *
 * Настоящие адреса, а не `#`: страница прогона должна пережить перезагрузку,
 * открыться в новой вкладке и годиться для ссылки. Демон отдаёт витрину на
 * любой не-API адрес (`src/ui/server.ts`), а разбор пути — `parseRoute` из
 * `src/ui/routes.ts` — общий с ним модуль.
 *
 * Таблица маршрутов приходит от демона (`GET /api/routes`, событие потока
 * `routes`) и живёт в сервисе `ctx.routes` (`ui/src/services/routes.ts`).
 * Хуки (`useRoute`, `useRoutes`, `useScreens`) читают его обычным
 * `useContext` — `hrefForTarget` вызывается как простая функция из
 * компонентов страниц, где хук неуместен (внутри `.map()` при сборке ссылки),
 * и ему нужен контекст без дерева React: `bindRouterKernel` привязывает к
 * нему этот модуль тем же порядком, что и `main.tsx` поднимает ядро — вне
 * дерева, до первой отрисовки.
 *
 * Ни одного имени экрана здесь нет и быть не может (`ui-routes`): цель
 * маршрута — вид и идентификатор, а какой вид что показывает, решает слот
 * `route.target` (`ui/src/plugins/shell.tsx`).
 */

let boundCtx: Context | undefined;

/** Вызывается один раз из `main.tsx`, сразу после `createBrowserKernel()`. */
export function bindRouterKernel(ctx: Context): void {
  boundCtx = ctx;
}

/** Действующая таблица маршрутов — читается напрямую, без подписки: для мест, которым реактивность не нужна (`hrefForTarget` и подобные). */
function currentRoutesTable() {
  if (boundCtx === undefined) {
    throw new Error('Маршрутизатор использован до bindRouterKernel(): ядро ещё не поднято');
  }
  return boundCtx.routes.get().table;
}

/**
 * Ссылка на цель по параметрам — тонкая обёртка над `hrefFor` с текущей
 * таблицей (`ui-routes`, Решение 8). `undefined` — ни один действующий
 * маршрут не ведёт к этой цели: место вызова обязано показать отсутствие
 * ссылки с причиной, а не подставлять корень.
 */
export function hrefForTarget(target: RouteTarget, params: Readonly<Record<string, string>> = {}): string | undefined {
  return hrefFor(target, params, currentRoutesTable());
}

function useKernelContext(): Context {
  const ctx = useContext(KernelContext);
  if (ctx === undefined) throw new Error('Маршрутизатор вызван вне дерева ядра витрины');
  return ctx;
}

/** Снимок таблицы маршрутов целиком — таблица и причина отказа последней сборки на демоне. */
export function useRoutes(): RoutesSnapshot {
  const ctx = useKernelContext();
  return useSyncExternalStore(
    (listener) => ctx.routes.subscribe(listener),
    () => ctx.routes.get(),
    () => ctx.routes.get(),
  );
}

/** Снимок состава экранов — таблица и причина отказа последней сборки на демоне. */
export function useScreens(): ScreensSnapshot {
  const ctx = useKernelContext();
  return useSyncExternalStore(
    (listener) => ctx.screens.subscribe(listener),
    () => ctx.screens.get(),
    () => ctx.screens.get(),
  );
}

export function useRoute(): { route: MatchedRoute | undefined; navigate: (href: string) => void } {
  const table = useRoutes().table;
  const [pathname, setPathname] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPop = (): void => setPathname(window.location.pathname);
    // Кнопка «назад» должна работать браузерными средствами, а не своей
    // самодельной стрелкой.
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((href: string) => {
    window.history.pushState(null, '', href);
    setPathname(new URL(href, window.location.origin).pathname);
  }, []);

  return { route: parseRoute(pathname, table), navigate };
}
