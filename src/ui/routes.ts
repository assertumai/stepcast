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
  | { readonly page: 'runs' }
  | { readonly page: 'pipelines' }
  | { readonly page: 'usage'; readonly days?: number }
  | { readonly page: 'settings' }
  | { readonly page: 'cleanup' }
  | { readonly page: 'run'; readonly projectKey: string; readonly runId: string };

/**
 * Период экрана расхода: пресеты, а не произвольные даты (design.md,
 * Решение 5). `days` отсутствует у `all` — весь период наблюдений, без
 * нижней границы. Разбор адреса и переключатель периода на экране обязаны
 * знать один и тот же набор — тем же приёмом, что и `MENU`.
 */
export interface UsagePeriod {
  readonly key: string;
  readonly days?: number;
  readonly label: string;
}

/** Голый `/usage` без периода в пути — этот же период (design.md, Решение 5). */
const DEFAULT_USAGE_DAYS = 30;

export const USAGE_PERIODS: readonly UsagePeriod[] = [
  { key: '7d', days: 7, label: '7 дней' },
  { key: '30d', days: DEFAULT_USAGE_DAYS, label: '30 дней' },
  { key: '90d', days: 90, label: '90 дней' },
  { key: 'all', label: 'всё время' },
];

/**
 * Экраны бокового меню в порядке, в каком к ним обращаются: сначала
 * происходящее.
 *
 * Список здесь, а не в разметке: меню и разбор адреса обязаны знать об одних и
 * тех же экранах, и разъехаться им негде, пока имя пункта берётся оттуда же,
 * откуда маршрут.
 *
 * `pages` — экраны, на которых пункт считается текущим: страница прогона
 * своего пункта не имеет и подсвечивает тот, из которого на неё приходят.
 */
export const MENU: readonly {
  readonly page: Route['page'];
  readonly href: string;
  readonly title: string;
  readonly pages: readonly Route['page'][];
}[] = [
  { page: 'runs', href: '/', title: 'Прогоны', pages: ['runs', 'run'] },
  { page: 'pipelines', href: '/pipelines', title: 'Пайплайны', pages: ['pipelines'] },
  { page: 'usage', href: '/usage', title: 'Расход', pages: ['usage'] },
  { page: 'cleanup', href: '/cleanup', title: 'Уборка', pages: ['cleanup'] },
  { page: 'settings', href: '/settings', title: 'Настройки', pages: ['settings'] },
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
 * первый экран, прогоны: витрина не обязана объяснять форму адреса, ей
 * достаточно не потерять пользователя на пустой странице.
 */
export function parseRoute(pathname: string): Route {
  const parts = pathname.split('/').filter((part) => part !== '');

  if (parts.length === 1) {
    if (parts[0] === 'pipelines') return { page: 'pipelines' };
    if (parts[0] === 'settings') return { page: 'settings' };
    if (parts[0] === 'cleanup') return { page: 'cleanup' };
    // Голый `/usage` — умолчание в 30 дней, тот же период, что и пресет `30d`.
    if (parts[0] === 'usage') return { page: 'usage', days: DEFAULT_USAGE_DAYS };
  }

  if (parts[0] === 'usage' && parts.length === 2) {
    const period = USAGE_PERIODS.find((candidate) => candidate.key === parts[1]);
    if (period === undefined) return { page: 'runs' };
    return period.days === undefined ? { page: 'usage' } : { page: 'usage', days: period.days };
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
      return { page: 'runs' };
    }
    if (isSafeSegment(projectKey) && isSafeSegment(runId)) {
      return { page: 'run', projectKey, runId };
    }
  }

  return { page: 'runs' };
}
