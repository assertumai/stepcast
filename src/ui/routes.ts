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
 *
 * `parseRoute` и `hrefFor` — чистые функции над таблицей объявленных экранов
 * (`ui-screens`, «Навигация и разбор адреса собираются из зарегистрированных
 * экранов»): ни то ни другое не перечисляет экраны по имени. Таблицу держит
 * реестр экранов демона (`src/ui/screens/registry.ts`) и браузерный сервис
 * `screens` (`ui/src/plugins/screens.tsx`) — этот модуль знает только форму
 * записи, минимально нужную для разбора и сборки ссылки.
 */

/** Часть объявления экрана, нужная разбору адреса и сборке ссылки (design.md, Решение 10). */
export interface RouteScreen {
  readonly id: string;
  /** Место в навигации: по нему выбирается экран по умолчанию (`defaultScreenId`). Нет — не участвует в выборе. */
  readonly nav?: { readonly order: number };
  /**
   * Шаблон адреса: сегмент `:имя` — обязательный параметр, `:имя?` —
   * необязательный (допустим только последним сегментом).
   */
  readonly path: string;
  /**
   * Закрытые перечни значений параметров, объявленные самим экраном
   * (`ScreenDeclaration.paramValues`). Значение вне перечня шаблону не
   * подходит: адрес разбирается дальше и достаётся экрану по умолчанию, а не
   * открывает экран с подставленным умолчанием.
   */
  readonly paramValues?: Readonly<Record<string, readonly string[]>>;
}

export interface ParsedRoute {
  /** `undefined` — ни один экран действующего состава не подошёл и нет ни одного экрана с местом в навигации. */
  readonly screenId: string | undefined;
  readonly params: Readonly<Record<string, string>>;
}

/**
 * Экран по умолчанию — не литерал имени, а тот, у кого меньше всего `nav.order`
 * действующего состава: неразобранный путь и ключ, которого нет в слоте экранов
 * (`ui-kernel`, «Ключа нет в слоте экранов»), ведут на один и тот же экран этим
 * правилом, а замена или отключение экрана с наименьшим `order` меняют
 * умолчание сами, без правки кода.
 */
export function defaultScreenId(screens: ReadonlyMap<string, RouteScreen>): string | undefined {
  let best: { readonly id: string; readonly order: number } | undefined;
  for (const screen of screens.values()) {
    if (screen.nav === undefined) continue;
    if (best === undefined || screen.nav.order < best.order) best = { id: screen.id, order: screen.nav.order };
  }
  return best?.id;
}

function templateSegments(path: string): readonly string[] {
  return path.split('/').filter((part) => part !== '');
}

/** Сопоставить сегменты действующего пути шаблону экрана — `undefined`, если не подошёл. */
function matchTemplate(
  template: readonly string[],
  actual: readonly string[],
  paramValues: Readonly<Record<string, readonly string[]>> | undefined,
): Record<string, string> | undefined {
  const last = template[template.length - 1];
  const lastOptional = last !== undefined && last.startsWith(':') && last.endsWith('?');
  if (actual.length !== template.length && !(lastOptional && actual.length === template.length - 1)) {
    return undefined;
  }

  const params: Record<string, string> = {};
  for (let i = 0; i < actual.length; i++) {
    const templateSegment = template[i] as string;
    const actualSegment = actual[i] as string;
    if (!templateSegment.startsWith(':')) {
      if (templateSegment !== actualSegment) return undefined;
      continue;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(actualSegment);
    } catch {
      return undefined;
    }
    if (!isSafeSegment(decoded)) return undefined;
    const name = templateSegment.slice(1).replace(/\?$/, '');
    const allowed = paramValues?.[name];
    // Закрытый перечень: значение вне его — не этот экран. Так `/usage/вчера`
    // остаётся неизвестным адресом и ведёт на экран по умолчанию, как вёл до
    // перевода экранов в строки состава.
    if (allowed !== undefined && !allowed.includes(decoded)) return undefined;
    params[name] = decoded;
  }
  return params;
}

/**
 * Путь в маршрут по таблице действующих экранов. Путь, не разобранный ни
 * одним из них, ведёт на экран по умолчанию (`defaultScreenId`) — включая
 * лишний хвост сегментов или сегмент, не прошедший `isSafeSegment`.
 */
export function parseRoute(pathname: string, screens: ReadonlyMap<string, RouteScreen>): ParsedRoute {
  const actual = templateSegments(pathname);

  for (const screen of screens.values()) {
    const params = matchTemplate(templateSegments(screen.path), actual, screen.paramValues);
    if (params !== undefined) return { screenId: screen.id, params };
  }

  return { screenId: defaultScreenId(screens), params: {} };
}

/**
 * Ссылка на экран по его `id` и параметрам. `id`, которого в таблице нет,
 * либо параметр, не заполнивший обязательный сегмент шаблона, дают корень —
 * вызывающий код не должен строить адрес по несуществующему экрану, а отказ
 * посреди отрисовки меню хуже неверной ссылки.
 */
export function hrefFor(
  id: string,
  params: Readonly<Record<string, string>>,
  screens: ReadonlyMap<string, RouteScreen>,
): string {
  const screen = screens.get(id);
  if (screen === undefined) return '/';

  const built: string[] = [];
  for (const segment of templateSegments(screen.path)) {
    if (!segment.startsWith(':')) {
      built.push(segment);
      continue;
    }
    const optional = segment.endsWith('?');
    const value = params[segment.slice(1).replace(/\?$/, '')];
    if (value === undefined) {
      if (optional) continue;
      return '/';
    }
    built.push(encodeURIComponent(value));
  }
  return `/${built.join('/')}`;
}

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

/**
 * Адрес под `/widgets/` — содержимое, разбираемое демоном (`src/ui/server.ts`),
 * а не подменяемое страницей витрины: обе объявленные формы адреса виджета
 * лежат под этим префиксом (design.md изменения `ui-runtime-widget-spike`,
 * Решение 10). Голый `/widgets` (без хвостового разделителя) под предикат не
 * подпадает — это адрес экрана меню «Виджеты», его отдаёт та же страница, что
 * и остальные экраны.
 */
export function isWidgetPath(pathname: string): boolean {
  return pathname.startsWith('/widgets/');
}

/**
 * Адрес модуля виджета с версией — сегменты экранированы, версия идёт
 * параметром запроса. Реестр модулей браузера неизменен: замена виджета
 * возможна только переимпортом по новому адресу (design.md, Решение 6).
 */
export function widgetModuleHref(projectKey: string, id: string, version: string): string {
  return `/widgets/${encodeURIComponent(projectKey)}/${encodeURIComponent(id)}.js?v=${encodeURIComponent(version)}`;
}

/**
 * Адрес под `/plugins/` — браузерная половина плагина домашнего слоя
 * (design.md изменения `hot-swap-preserves-data`, Решение 8, 13), тем же
 * приёмом, что и `isWidgetPath`: голый `/plugins` без хвостового разделителя
 * под предикат не подпадает.
 */
export function isPluginPath(pathname: string): boolean {
  return pathname.startsWith('/plugins/');
}

/**
 * Адрес модуля браузерной половины плагина с версией — сегмент экранирован,
 * версия параметром запроса, тем же устройством, что и `widgetModuleHref`:
 * реестр модулей браузера неизменен, замена возможна только переимпортом по
 * новому адресу (design.md, Решение 8, 12).
 */
export function pluginModuleHref(id: string, version: string): string {
  return `/plugins/${encodeURIComponent(id)}.js?v=${encodeURIComponent(version)}`;
}
