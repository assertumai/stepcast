import { useCallback, useEffect, useState } from 'react';

import { parseRoute, runHref, type Route } from '../../src/ui/routes';

/**
 * Маршрутизация на History API.
 *
 * Настоящие адреса, а не `#`: страница прогона должна пережить перезагрузку,
 * открыться в новой вкладке и годиться для ссылки. Демон отдаёт витрину на
 * любой не-API адрес (`src/ui/server.ts`), а разбор пути — `parseRoute` из
 * `src/ui/routes.ts` — общий с ним модуль: разъедись они, и адрес страницы
 * перестал бы совпадать с адресом, который эта же витрина умеет разобрать.
 *
 * Библиотеки роутинга здесь не окупаются: маршрутов два, и оба — разбор
 * одного пути.
 */

export type { Route };
export { runHref };

export function useRoute(): { route: Route; navigate: (href: string) => void } {
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

  return { route: parseRoute(pathname), navigate };
}
