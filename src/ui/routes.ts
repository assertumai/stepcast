/**
 * Разбор адресов витрины — общий для демона и браузера.
 *
 * Адрес страницы прогона — контракт двух сторон: демон обязан отдать страницу
 * витрины на этот путь (см. `src/ui/server.ts`), а витрина — узнать в нём
 * прогон. Разъедься они, и ссылка молча перестанет открывать прогон, поэтому
 * разбор живёт одним модулем: сервер импортирует его напрямую, витрина —
 * относительным путём из `ui/`.
 *
 * Модуль не зависит ни от React, ни от `window`: всё, что зависит от браузера
 * (хук на History API), лежит в `ui/src/router.tsx`.
 */

export type Route =
  | { readonly page: 'pipelines' }
  | { readonly page: 'settings' }
  | { readonly page: 'cleanup' }
  | { readonly page: 'run'; readonly projectKey: string; readonly runId: string };

/**
 * Экраны верхнего меню в порядке показа.
 *
 * Список здесь, а не в разметке: меню и разбор адреса обязаны знать об одних и
 * тех же экранах, и разъехаться им негде, пока имя пункта берётся оттуда же,
 * откуда маршрут.
 */
export const MENU: readonly { readonly page: Route['page']; readonly href: string; readonly title: string }[] = [
  { page: 'pipelines', href: '/', title: 'Пайплайны' },
  { page: 'cleanup', href: '/cleanup', title: 'Уборка' },
  { page: 'settings', href: '/settings', title: 'Настройки' },
];

/**
 * Сегмент раскладки журнала: ключ проекта или идентификатор прогона. Оба идут
 * прямо в путь на сервере, поэтому ни разделителя, ни шага вверх по дереву в
 * них быть не должно.
 */
export function isSafeSegment(value: string): boolean {
  return value !== '' && !value.includes('..') && !value.includes('/') && !value.includes('\\');
}

/**
 * Адрес под `/api/` — обращение к API, а не к странице витрины. Голый `/api`
 * считается тем же обращением: корня у API нет, и отдать на него страницу
 * значило бы ответить разметкой тому, кто ошибся в адресе запроса — ровно тот
 * случай, который эта развилка и должна называть ошибкой.
 */
export function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

/** Адрес страницы прогона: `/runs/<проект>/<прогон>`, сегменты экранированы. */
export function runHref(projectKey: string, runId: string): string {
  return `/runs/${encodeURIComponent(projectKey)}/${encodeURIComponent(runId)}`;
}

/**
 * Путь в маршрут. Неизвестный путь — включая `/runs/<проект>` без
 * идентификатора прогона и `/runs/<проект>/<прогон>/...` с хвостом — даёт
 * первый экран: витрина не обязана объяснять форму адреса, ей достаточно не
 * потерять пользователя на пустой странице.
 */
export function parseRoute(pathname: string): Route {
  const parts = pathname.split('/').filter((part) => part !== '');

  if (parts.length === 1) {
    if (parts[0] === 'settings') return { page: 'settings' };
    if (parts[0] === 'cleanup') return { page: 'cleanup' };
  }

  if (parts[0] === 'runs' && parts.length === 3) {
    const rawKey = parts[1] as string;
    const rawRunId = parts[2] as string;
    let projectKey: string;
    let runId: string;
    try {
      projectKey = decodeURIComponent(rawKey);
      runId = decodeURIComponent(rawRunId);
    } catch {
      return { page: 'pipelines' };
    }
    if (isSafeSegment(projectKey) && isSafeSegment(runId)) {
      return { page: 'run', projectKey, runId };
    }
  }

  return { page: 'pipelines' };
}
