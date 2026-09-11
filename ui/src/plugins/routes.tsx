import type { Context } from 'cordis';

import type { RouteDefinition } from '../../../src/ui/routes.ts';

/**
 * Плагин `routes` — читает действующую таблицу маршрутов у демона
 * (`ui-routes`, design.md Решение 9; `ui-daemon`, «Поток событий несёт
 * действующие маршруты и состав экранов»).
 *
 * Тем же приёмом, что и `screens`: `fetch` при загрузке страницы — быстрее
 * первого обмена SSE, страница не остаётся без навигации до подключения —
 * и дальше событием потока `routes`, чтобы правка файла слоя была видна без
 * перезагрузки.
 */

interface RoutesResponse {
  readonly routes: readonly RouteDefinition[];
  readonly buildError?: string;
}

async function fetchRoutes(): Promise<RoutesResponse> {
  const response = await fetch('/api/routes');
  const data = (await response.json()) as RoutesResponse & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `Демон ответил ${response.status}`);
  return data;
}

export default function routes(ctx: Context): void {
  const apply = (response: RoutesResponse): void => {
    ctx.routes.set(response.routes, response.buildError);
  };

  void fetchRoutes()
    .then(apply)
    .catch((error: Error) => {
      console.error(`[stepcast] не удалось получить таблицу маршрутов: ${error.message}`);
    });

  let last: RoutesResponse | undefined;
  ctx.live.subscribe(() => {
    const next = ctx.live.get().routes;
    if (next === undefined || next === last) return;
    last = next;
    apply(next);
  });
}
