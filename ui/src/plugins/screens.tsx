import type { JSX } from 'react';
import type { Context } from 'cordis';

import type { ScreenListing } from '../../../src/ui/screens/declaration.ts';
import { BUILTIN_SCREENS } from '../screens/index';
import { navItem } from './navItem';
import { NAV, SCREEN } from './shell';

/**
 * Плагин `screens` — читает действующий состав у демона и применяет
 * встроенные половины (design.md, Решение 12).
 *
 * Читается один раз при загрузке страницы: перечитывание состава в открытой
 * вкладке без перезагрузки — `hot-swap-preserves-data`, здесь новый состав
 * приходит только со следующей загрузкой страницы (`docs/ui-plugins.md`).
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
 * Демон назвал экран, чью браузерную половину страница взять не может
 * (design.md, Решение 13): строка заменена чужим модулем либо принесена им же,
 * а чтение браузерных половин с диска ещё не реализовано
 * (`user-plugins-from-files`). Показан с причиной, а не пропущен молча.
 */
function MissingScreen({ id }: { readonly id: string }): JSX.Element {
  return (
    <div className="screen-error">
      Экран «{id}» объявлен строкой состава, но браузерная половина недоступна:
      формат плагина, приносящего свою половину, здесь не поддержан.
    </div>
  );
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
  void fetchScreens()
    .then((response) => {
      const table = new Map(response.screens.map((declaration) => [declaration.id, declaration]));
      ctx.screens.set(table, response.buildError);

      for (const declaration of response.screens) {
        const plugin = halfFor(declaration);
        if (plugin !== undefined) {
          ctx.plugin(plugin);
          continue;
        }

        if (declaration.nav !== undefined) {
          ctx.slots.contribute(NAV, { component: navItem(declaration), order: declaration.nav.order });
        }
        ctx.slots.contribute(SCREEN, {
          component: () => <MissingScreen id={declaration.id} />,
          key: declaration.id,
        });
      }
    })
    .catch((error: Error) => {
      // Отказ самого запроса (демон не отвечает) не должен погасить каркас:
      // он рисуется независимо от состава, а причина хотя бы попадёт в консоль.
      console.error(`[stepcast] не удалось получить состав экранов: ${error.message}`);
    });
}
