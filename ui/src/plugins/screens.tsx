import type { Context } from 'cordis';

import type { ScreenListing } from '../../../src/ui/screens/declaration.ts';
import { BUILTIN_SCREENS } from '../screens/index';

/**
 * Плагин `screens` — читает действующий состав у демона и применяет
 * встроенные половины (design.md, Решение 12; `ui-daemon`, «Поток событий
 * несёт действующие маршруты и состав экранов»).
 *
 * Заявка состава — сразу же `fetch` при загрузке страницы (быстрее первого
 * обмена SSE) и дальше событием потока `screens`: строка, ставшая активной
 * без перезагрузки, получает свою половину тем же тактом (ограничение
 * «новый состав виден только после перезагрузки», названное в
 * `docs/ui-plugins.md`, снято этой работой).
 *
 * Экран без бандловой половины (чужой модуль, чью браузерную часть страница
 * взять не может) здесь ничем не отмечается: слот `SCREEN` для него просто
 * не заводится, и вид цели `route.target` (`ui/src/plugins/shell.tsx`)
 * реактивно проверяет присутствие `id` в `ctx.screens` — отключённый или
 * незнакомый экран получает названную причину на месте, без стороннего учёта.
 */

interface ScreensResponse {
  readonly screens: readonly ScreenListing[];
  readonly buildError?: string;
}

async function fetchScreens(): Promise<ScreensResponse> {
  const response = await fetch('/api/screens');
  const data = (await response.json()) as ScreensResponse & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `Демон ответил ${response.status}`);
  return data;
}

/**
 * Встроенная половина применима, только если демон назвал строку своей:
 * строка-замена несёт тот же `id` (`plugin-tree`, замена по `id`), и без
 * признака происхождения страница показала бы встроенный экран там, где
 * пользователь поставил свой, — то есть ровно то, что замена должна была
 * убрать (`ui-screens`, «встроенная половина MUST NOT применяться вовсе»).
 */
function halfFor(listing: ScreenListing): ((ctx: Context) => void) | undefined {
  return listing.builtin ? BUILTIN_SCREENS[listing.id] : undefined;
}

export default function screens(ctx: Context): void {
  // Строки, чью половину уже применили, — приём не звать `ctx.plugin` дважды
  // на один и тот же `id`, когда состав пришёл повторно (событие `screens`
  // может прийти с уже применённой строкой, если сменились другие).
  const applied = new Set<string>();

  const apply = (response: ScreensResponse): void => {
    ctx.screens.set(new Map(response.screens.map((declaration) => [declaration.id, declaration])), response.buildError);

    for (const declaration of response.screens) {
      if (applied.has(declaration.id)) continue;
      const plugin = halfFor(declaration);
      if (plugin === undefined) continue;
      applied.add(declaration.id);
      ctx.plugin(plugin);
    }
  };

  void fetchScreens()
    .then(apply)
    .catch((error: Error) => {
      // Отказ самого запроса (демон не отвечает) не должен погасить каркас:
      // он рисуется независимо от состава, а причина хотя бы попадёт в консоль.
      console.error(`[stepcast] не удалось получить состав экранов: ${error.message}`);
    });

  let lastScreens: ScreensResponse | undefined;
  ctx.live.subscribe(() => {
    const next = ctx.live.get().screens;
    if (next === undefined || next === lastScreens) return;
    lastScreens = next;
    apply(next);
  });
}
