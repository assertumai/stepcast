import { Service, type Context } from 'cordis';

import type { RouteTable } from '../../../src/parts/ui/routes.ts';

/**
 * Таблица маршрутов на месте живого сервиса ядра витрины (`ui-routes`,
 * design.md Решение 9) — тем же приёмом, что и `screens` (`ui/src/services/screens.ts`):
 * плагин `ui/src/plugins/routes.tsx` пишет сюда после ответа демона и после
 * каждого отличающегося события потока `routes`.
 *
 * Читают его маршрутизатор (`ui/src/router.tsx`) и каркас (`ui/src/plugins/shell.tsx`,
 * сборка навигации и перечень маршрутов на неизвестном адресе).
 */
export const ROUTES_SERVICE_NAME = 'routes';

export interface RoutesSnapshot {
  readonly table: RouteTable;
  readonly buildError: string | undefined;
}

const EMPTY: RoutesSnapshot = { table: [], buildError: undefined };

export class RoutesService extends Service {
  private data: RoutesSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();

  constructor(ctx: Context) {
    super(ctx, ROUTES_SERVICE_NAME);
  }

  /** Снимок — та же ссылка, пока таблица не менялась: сервис читают через `useSyncExternalStore`. */
  get(): RoutesSnapshot {
    return this.data;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Заменить таблицу целиком — вызывает плагин `routes` после каждого ответа демона. */
  set(table: RouteTable, buildError: string | undefined): void {
    this.data = { table, buildError };
    for (const listener of this.listeners) listener();
  }
}

declare module 'cordis' {
  interface Context {
    routes: RoutesService;
  }
}
