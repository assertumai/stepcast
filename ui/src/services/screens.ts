import { Service, type Context } from 'cordis';

import type { ScreenDeclaration } from '../../../src/ui/screens/declaration.ts';

/**
 * Состав экранов на месте живого сервиса ядра витрины (design.md, Решение
 * 10, 12): таблица действующих объявлений, которую демон назвал через
 * `GET /api/screens`, плюс причина отказа последней сборки дерева
 * (`ui-daemon`, «Отказ сборки состава не гасит витрину»).
 *
 * Заводится ядром (`ui/src/kernel.ts`) наравне со `slots` и `live` — плагин
 * `screens` (`ui/src/plugins/screens.tsx`) только пишет в него после ответа
 * демона, а читают его маршрутизатор (`ui/src/router.tsx`) и плагин `screens`
 * при применении браузерных половин.
 */
export const SCREENS_SERVICE_NAME = 'screens';

export interface ScreensSnapshot {
  readonly table: ReadonlyMap<string, ScreenDeclaration>;
  readonly buildError: string | undefined;
}

const EMPTY: ScreensSnapshot = { table: new Map(), buildError: undefined };

export class ScreensService extends Service {
  private data: ScreensSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();

  constructor(ctx: Context) {
    super(ctx, SCREENS_SERVICE_NAME);
  }

  /** Снимок — та же ссылка, пока состав не менялся: сервис читают через `useSyncExternalStore`. */
  get(): ScreensSnapshot {
    return this.data;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Заменить состав целиком — вызывает плагин `screens` после каждого ответа демона. */
  set(table: ReadonlyMap<string, ScreenDeclaration>, buildError: string | undefined): void {
    this.data = { table, buildError };
    for (const listener of this.listeners) listener();
  }
}

declare module 'cordis' {
  interface Context {
    screens: ScreensService;
  }
}
