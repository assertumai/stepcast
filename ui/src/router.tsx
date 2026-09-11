import { useCallback, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { Context } from 'cordis';

import { defaultScreenId, hrefFor, parseRoute, type ParsedRoute, type RouteScreen } from '../../src/ui/routes';
import { KernelContext } from './kernel';
import type { ScreensSnapshot } from './services/screens';

export type { ParsedRoute };

/**
 * Маршрутизация на History API — над таблицей действующих экранов, а не над
 * перечислением их имён (`ui-screens`, «Навигация и разбор адреса собираются
 * из зарегистрированных экранов»).
 *
 * Настоящие адреса, а не `#`: страница прогона должна пережить перезагрузку,
 * открыться в новой вкладке и годиться для ссылки. Демон отдаёт витрину на
 * любой не-API адрес (`src/ui/server.ts`), а разбор пути — `parseRoute` из
 * `src/ui/routes.ts` — общий с ним модуль.
 *
 * Таблица экранов приходит от демона (`GET /api/screens`, плагин `screens`)
 * и живёт в сервисе `ctx.screens` (`ui/src/services/screens.ts`). Хуки
 * (`useRoute`, `useScreens`, `useDefaultScreenId`) читают его обычным
 * `useContext` — `screenHref` вызывается как простая функция из компонентов
 * страниц, где хук неуместен (внутри `.map()` при сборке ссылки), и ему нужен
 * контекст без дерева React: `bindRouterKernel` привязывает к нему этот
 * модуль тем же порядком, что и `main.tsx` поднимает ядро — вне дерева,
 * до первой отрисовки.
 *
 * Ни одного имени экрана здесь нет и быть не может (`ui-screens`,
 * «Навигация и разбор адреса собираются из зарегистрированных экранов»):
 * ссылка на конкретный экран собирается там, где этот экран объявлен, —
 * адрес страницы прогона, например, даёт `runHref` из `ui/src/screens/run.tsx`.
 */

let boundCtx: Context | undefined;

/** Вызывается один раз из `main.tsx`, сразу после `createBrowserKernel()`. */
export function bindRouterKernel(ctx: Context): void {
  boundCtx = ctx;
}

/** Действующая таблица экранов — читается напрямую, без подписки: для мест, которым реактивность не нужна (`runHref` и подобные). */
function currentScreens(): ReadonlyMap<string, RouteScreen> {
  if (boundCtx === undefined) {
    throw new Error('Маршрутизатор использован до bindRouterKernel(): ядро ещё не поднято');
  }
  return boundCtx.screens.get().table;
}

/** Ссылка на экран по id и параметрам — тонкая обёртка над `hrefFor` с текущей таблицей. */
export function screenHref(id: string, params: Readonly<Record<string, string>> = {}): string {
  return hrefFor(id, params, currentScreens());
}

function useKernelContext(): Context {
  const ctx = useContext(KernelContext);
  if (ctx === undefined) throw new Error('Маршрутизатор вызван вне дерева ядра витрины');
  return ctx;
}

/** Снимок состава целиком — таблица экранов и причина отказа последней сборки на демоне. */
export function useScreens(): ScreensSnapshot {
  const ctx = useKernelContext();
  return useSyncExternalStore(
    (listener) => ctx.screens.subscribe(listener),
    () => ctx.screens.get(),
    () => ctx.screens.get(),
  );
}

function useScreensTable(): ReadonlyMap<string, RouteScreen> {
  return useScreens().table;
}

export function useRoute(): { route: ParsedRoute; navigate: (href: string) => void } {
  const table = useScreensTable();
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

/** Экран по умолчанию действующего состава — тот же, на который ведёт неразобранный путь (`ui-kernel`, «Ключа нет в слоте экранов»). */
export function useDefaultScreenId(): string | undefined {
  const table = useScreensTable();
  return defaultScreenId(table);
}
