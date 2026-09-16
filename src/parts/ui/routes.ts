/**
 * Разбор адресов витрины — общий для демона и браузера (`ui-routes`, design.md
 * Решение 9).
 *
 * Таблица маршрутов приходит сюда уже собранной: чтение трёх файлов слоёв,
 * проверка схемой, слияние по `id` и диагностика — забота `src/parts/ui/routesFile.ts`
 * (модуля демона, у которого есть диск). Этот модуль — чистые функции над
 * готовой таблицей, без единого импорта Node: сервер импортирует его напрямую,
 * витрина — относительным путём из `ui/`.
 *
 * Вид цели (`RouteTarget.kind`) — не перечисление здесь, а ключ, который
 * читает браузерный слот `route.target` (`ui-routes`, design.md Решение 5):
 * этот модуль не знает ни `screen`, ни `widget` по имени.
 */

/** Цель маршрута: вид (`screen`, `widget`, …) и идентификатор внутри вида. */
export interface RouteTarget {
  readonly kind: string;
  readonly id: string;
}

/** Место маршрута в навигации. Нет объявления — пункта меню нет, адрес всё равно открывается. */
export interface RouteNav {
  readonly title?: string;
  readonly order?: number;
  /** Маршруты, на которых пункт этого маршрута остаётся подсвеченным. */
  readonly activeFor?: readonly string[];
}

/**
 * Действующий маршрут — итог слияния слоёв, готовый к разбору и сборке ссылок.
 * `params` несёт литералы и подстановки `${params.<имя>}`, ещё не применённые:
 * применяются они на каждое сопоставление своими значениями параметров пути.
 */
export interface RouteDefinition {
  readonly id: string;
  readonly path: string;
  readonly target: RouteTarget;
  readonly params?: Readonly<Record<string, string>>;
  readonly values?: Readonly<Record<string, readonly string[]>>;
  readonly nav?: RouteNav;
}

/** Таблица маршрутов: порядок — порядок слоёв и файлов (design.md, Решение 8). */
export type RouteTable = readonly RouteDefinition[];

export interface MatchedRoute {
  readonly route: RouteDefinition;
  /** Значения параметров, снятые с сегментов адреса, по именам шаблона пути. */
  readonly pathParams: Readonly<Record<string, string>>;
  /** Параметры цели с применёнными подстановками. */
  readonly targetParams: Readonly<Record<string, string>>;
}

export type TemplateSegment =
  | { readonly kind: 'static'; readonly value: string }
  | { readonly kind: 'param'; readonly name: string; readonly optional: boolean };

/**
 * Разбор шаблона пути на сегменты: `:имя` — обязательный параметр, `:имя?` —
 * необязательный. Необязательным считается только последний сегмент шаблона —
 * `?` в любом другом месте остаётся частью имени, как и до появления файла
 * маршрутов.
 */
export function parseTemplate(path: string): readonly TemplateSegment[] {
  const parts = path.split('/').filter((part) => part !== '');
  return parts.map((part, index): TemplateSegment => {
    if (!part.startsWith(':')) return { kind: 'static', value: part };
    const isLast = index === parts.length - 1;
    const optional = isLast && part.endsWith('?');
    const name = optional ? part.slice(1, -1) : part.slice(1);
    return { kind: 'param', name, optional };
  });
}

/**
 * Ключ сравнения путей: имя параметра — дело маршрута, адрес от него не
 * зависит (`ui-routes`, «Путь принадлежит одному маршруту»). Два шаблона с
 * одинаковым нормализованным ключом — конфликт, даже если различаются только
 * именами параметров.
 */
export function normalizedTemplate(path: string): string {
  return parseTemplate(path)
    .map((segment) => (segment.kind === 'static' ? segment.value : segment.optional ? ':?' : ':'))
    .join('/');
}

/** Имена параметров, объявленных шаблоном (без учёта необязательности). */
export function templateParamNames(path: string): readonly string[] {
  return parseTemplate(path)
    .filter((segment): segment is Extract<TemplateSegment, { kind: 'param' }> => segment.kind === 'param')
    .map((segment) => segment.name);
}

const PARAM_PLACEHOLDER = /\$\{params\.([A-Za-z0-9_]+)\}/g;

/** Имена параметров, на которые ссылается значение подстановкой `${params.<имя>}`. */
export function paramPlaceholderNames(value: string): readonly string[] {
  return [...value.matchAll(PARAM_PLACEHOLDER)].map((match) => match[1] as string);
}

/** Применить подстановки `${params.<имя>}` значениями параметров пути. Имя обязано существовать — проверено при сборке таблицы. */
export function substituteParams(value: string, pathParams: Readonly<Record<string, string>>): string {
  return value.replace(PARAM_PLACEHOLDER, (_match, name: string) => pathParams[name] ?? '');
}

/**
 * Сегмент раскладки журнала: ключ проекта или идентификатор прогона. Оба идут
 * прямо в путь на сервере, поэтому ни разделителя, ни шага вверх по дереву в
 * них быть не должно.
 */
export function isSafeSegment(value: string): boolean {
  return value !== '' && !value.includes('..') && !value.includes('/') && !value.includes('\\');
}

interface Candidate {
  readonly route: RouteDefinition;
  readonly pathParams: Record<string, string>;
  /** Специфичность по сегментам: 1 — статический, 0 — параметр, слева направо. */
  readonly specificity: readonly number[];
  /** Шаблону пришлось опустить свой хвостовой необязательный сегмент, чтобы подойти. */
  readonly omittedOptional: boolean;
}

function matchTemplate(
  route: RouteDefinition,
  actual: readonly string[],
): Candidate | undefined {
  const template = parseTemplate(route.path);
  const last = template[template.length - 1];
  const lastOptional = last !== undefined && last.kind === 'param' && last.optional;
  const omittedOptional = lastOptional && actual.length === template.length - 1;
  if (actual.length !== template.length && !omittedOptional) return undefined;

  const pathParams: Record<string, string> = {};
  const specificity: number[] = [];
  for (let i = 0; i < actual.length; i++) {
    const segment = template[i] as TemplateSegment;
    const actualSegment = actual[i] as string;
    if (segment.kind === 'static') {
      if (segment.value !== actualSegment) return undefined;
      specificity.push(1);
      continue;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(actualSegment);
    } catch {
      return undefined;
    }
    if (!isSafeSegment(decoded)) return undefined;
    const allowed = route.values?.[segment.name];
    if (allowed !== undefined && !allowed.includes(decoded)) return undefined;
    pathParams[segment.name] = decoded;
    specificity.push(0);
  }
  return { route, pathParams, specificity, omittedOptional };
}

/** `a` более конкретен, чем `b`, для одного и того же адреса (`ui-routes`, Решение 4). */
function moreSpecific(a: Candidate, b: Candidate): boolean {
  if (a.omittedOptional !== b.omittedOptional) return !a.omittedOptional;
  for (let i = 0; i < Math.max(a.specificity.length, b.specificity.length); i++) {
    const av = a.specificity[i] ?? 0;
    const bv = b.specificity[i] ?? 0;
    if (av !== bv) return av > bv;
  }
  return false;
}

/**
 * Путь в маршрут по действующей таблице: выбор идёт по конкретности шаблона,
 * а не по порядку строк (`ui-routes`, Решение 4). Неразобранный адрес отдаёт
 * `undefined` — вызывающий код показывает перечень маршрутов, а не подменяет
 * цель.
 */
export function parseRoute(pathname: string, table: RouteTable): MatchedRoute | undefined {
  const actual = pathname.split('/').filter((part) => part !== '');

  let best: Candidate | undefined;
  for (const route of table) {
    const candidate = matchTemplate(route, actual);
    if (candidate === undefined) continue;
    if (best === undefined || moreSpecific(candidate, best)) best = candidate;
  }
  if (best === undefined) return undefined;

  const targetParams: Record<string, string> = {};
  for (const [name, value] of Object.entries(best.route.params ?? {})) {
    targetParams[name] = substituteParams(value, best.pathParams);
  }
  return { route: best.route, pathParams: best.pathParams, targetParams };
}

/**
 * Ссылка на цель по параметрам: первый по таблице маршрут, способный принять
 * названные параметры (`ui-routes`, Решение 8). Нет ни одного — `undefined`, а
 * не корень: место вызова обязано показать отсутствие ссылки с причиной.
 */
export function hrefFor(
  target: RouteTarget,
  params: Readonly<Record<string, string>>,
  table: RouteTable,
): string | undefined {
  for (const route of table) {
    if (route.target.kind !== target.kind || route.target.id !== target.id) continue;
    const built = buildPath(route.path, params);
    if (built !== undefined) return built;
  }
  return undefined;
}

/**
 * Адрес самого маршрута по его параметрам — для мест, которые знают, какой
 * именно маршрут открывают: пункт меню собирается из своей строки таблицы, а
 * не поиском по цели. Два маршрута на одну цель — законное состояние
 * (`ui-routes`, Решение 8), и пункт пользовательского `/release` обязан вести
 * на свой путь, а не на первый по таблице адрес той же цели.
 *
 * `undefined` — шаблон требует параметра, которого в `params` нет: собрать
 * адрес нечем, и место вызова обязано назвать это, а не подставлять корень.
 */
export function hrefForRoute(
  route: RouteDefinition,
  params: Readonly<Record<string, string>> = {},
): string | undefined {
  return buildPath(route.path, params);
}

function buildPath(path: string, params: Readonly<Record<string, string>>): string | undefined {
  const built: string[] = [];
  for (const segment of parseTemplate(path)) {
    if (segment.kind === 'static') {
      built.push(segment.value);
      continue;
    }
    const value = params[segment.name];
    if (value === undefined) {
      if (segment.optional) continue;
      return undefined;
    }
    built.push(encodeURIComponent(value));
  }
  return `/${built.join('/')}`;
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
 * Адрес под `/widgets/` — содержимое, разбираемое демоном (`src/parts/ui/daemon/server.ts`),
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

/**
 * Адрес под `/shared/` — переходники общих модулей витрины (`src/parts/ui/daemon/sharedModules.ts`,
 * design.md изменения `shared-module-table`, Решение 3): перечень перестал
 * быть про виджеты в тот момент, когда в нём появился `cordis`, и адрес,
 * говорящий обратное, вводил бы в заблуждение того, кто по нему и придёт
 * разбираться — автора плагина, читающего сетевую вкладку. Голый `/shared`
 * (без хвостового разделителя) под предикат не подпадает, тем же приёмом, что
 * и у `isWidgetPath`/`isPluginPath`.
 */
export function isSharedPath(pathname: string): boolean {
  return pathname.startsWith('/shared/');
}

/** Адрес переходника общего модуля по сегменту записи таблицы (`SharedModuleEntry.routeSegment`). */
export function sharedModuleHref(routeSegment: string): string {
  return `/shared/${routeSegment}.js`;
}

/**
 * Путь, зарезервированный под адреса, которые разбирает сам демон: страница
 * витрины по ним не открывается никогда (`ui-routes`, «Путь принадлежит
 * одному маршруту»).
 */
export function isReservedPath(pathname: string): boolean {
  return isApiPath(pathname) || isWidgetPath(pathname) || isPluginPath(pathname) || isSharedPath(pathname);
}
