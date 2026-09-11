/**
 * Модули-переходники: три имени, которые виджет вправе импортировать, и
 * тексты модулей, которые демон отдаёт по адресам `/widgets/runtime/<имя>.js`
 * (design.md, Решения 3 и 4).
 *
 * Общий модуль демона и витрины: сервер строит из него тела переходников
 * (`widgetRuntimeModuleText`), а `ui/src/main.tsx` — объект, который страница
 * публикует на `window` до первой отрисовки (`WIDGET_RUNTIME_GLOBAL`). Разъедься
 * они, и виджет получил бы `undefined` вместо хука без единой строки лога:
 * оба места читают один и тот же перечень имён, а не два похожих.
 *
 * Перечень имён — не всё, что экспортирует React, а объявленная поверхность
 * API виджета (design.md, Решение 4): что в нём есть, тем виджет и
 * пользуется. Сверяется тестом (`test/ui-widgets.test.ts`) с тем, что
 * реально экспортирует установленная версия каждого пакета — иначе
 * обновление React тихо отняло бы у виджетов имя.
 */

/** Ключ, под которым страница публикует свои экземпляры на `window` (`ui/src/main.tsx`). */
export const WIDGET_RUNTIME_GLOBAL = '__stepcastWidgetRuntime';

/**
 * Имя экспорта модуля ошибки компиляции (`errorModuleText`, `src/ui/widgets.ts`)
 * — здесь, а не там, потому что имя читает и браузер (`ui/src/widgetHost.tsx`),
 * а модуль `widgets.ts` в браузерную сборку не попадает: он держит `node:fs`.
 */
export const WIDGET_ERROR_EXPORT = '__stepcastWidgetError';

/**
 * Имя экспорта стилей собранной браузерной половины плагина (`src/ui/widgets.ts`,
 * режим сборки бандла) — рядом с `WIDGET_ERROR_EXPORT` по той же причине:
 * сборщик демона (дописывает экспорт в текст модуля) и хост страницы
 * (`ui/src/services/plugins.ts`, читает его после загрузки модуля) обязаны
 * брать имя из одного места (design.md изменения `hot-swap-preserves-data`,
 * Решение 7). CSS, объявленный половиной (`import './styles.css'`), приходит
 * этим экспортом, а не побочным эффектом импорта — так стиль можно снять
 * вместе с областью строки, а не оставить в документе навсегда.
 */
export const WIDGET_STYLE_EXPORT = '__stepcastWidgetStyle';

export type WidgetRuntimeSpecifier = 'react' | 'react-dom' | 'react/jsx-runtime';

/**
 * Сегмент адреса `/widgets/runtime/<route>.js` для каждого специфика. У
 * `react/jsx-runtime` в специфике есть `/` — в адрес он идти не может, отсюда
 * отдельное route-имя `jsx-runtime`.
 */
export const WIDGET_RUNTIME_ROUTES: Readonly<Record<string, WidgetRuntimeSpecifier>> = {
  react: 'react',
  'react-dom': 'react-dom',
  'jsx-runtime': 'react/jsx-runtime',
};

/** Префикс адреса переходников — один литерал на весь спайк: и адрес карты имён, и разбор пути демоном идут от него. */
export const WIDGET_RUNTIME_PATH_PREFIX = '/widgets/runtime/';

/** Адрес переходника по route-имени. */
export function widgetRuntimeHref(routeName: string): string {
  return `${WIDGET_RUNTIME_PATH_PREFIX}${routeName}.js`;
}

/**
 * Карта имён страницы — выведенная, а не написанная дважды: разметка
 * (`ui/index.html`) обязана нести ровно это соответствие, и тест
 * (`test/ui-widgets.test.ts`) сверяет её с этим объектом. Переименование
 * route-имени или четвёртое имя в перечне иначе тихо разъехались бы с
 * разметкой, а виджет получил бы «неизвестный спецификатор» вместо хука
 * (требование ui-dashboard: «перечень имён в карте и перечень форм адреса,
 * отдаваемых демоном, MUST совпадать»).
 */
export const WIDGET_RUNTIME_IMPORT_MAP: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(WIDGET_RUNTIME_ROUTES).map(([routeName, specifier]) => [
    specifier,
    widgetRuntimeHref(routeName),
  ]),
);

/**
 * Реэкспортируемые имена — подмножество, которого хватает представительному
 * виджету (хук, эффект, JSX) и ближайшим следующим: `react-dom/client` в
 * перечень не входит (design.md, Open Questions) — виджет не получает своей
 * точки входа, его отрисовывает хост витрины (`ui/src/widgetHost.tsx`), и
 * `createRoot`/`hydrateRoot` виджету не нужны в спайке.
 */
export const WIDGET_RUNTIME_NAMES: Readonly<Record<WidgetRuntimeSpecifier, readonly string[]>> = {
  react: [
    'Fragment',
    'StrictMode',
    'Suspense',
    'Children',
    'Component',
    'PureComponent',
    'createContext',
    'createElement',
    'createRef',
    'cloneElement',
    'forwardRef',
    'isValidElement',
    'lazy',
    'memo',
    'startTransition',
    'useCallback',
    'useContext',
    'useDebugValue',
    'useDeferredValue',
    'useEffect',
    'useId',
    'useImperativeHandle',
    'useInsertionEffect',
    'useLayoutEffect',
    'useMemo',
    'useReducer',
    'useRef',
    'useState',
    'useSyncExternalStore',
    'useTransition',
    'version',
  ],
  'react-dom': ['createPortal', 'flushSync', 'unstable_batchedUpdates', 'version'],
  'react/jsx-runtime': ['Fragment', 'jsx', 'jsxs'],
};

/**
 * Имена, у которых есть и экспорт по умолчанию. `import React, { useState }
 * from 'react'` — самая распространённая идиома React-модуля, и переходник без
 * `default` ронял бы её при связывании («does not provide an export named
 * 'default'»), то есть на самом обычном способе написать виджет. У
 * `react/jsx-runtime` экспорта по умолчанию нет и у самого пакета — его здесь
 * нет тем же основанием, каким перечень имён не выдумывает имён сверх
 * реального экспорта.
 */
export const WIDGET_RUNTIME_DEFAULT_EXPORT: Readonly<Record<WidgetRuntimeSpecifier, boolean>> = {
  react: true,
  'react-dom': true,
  'react/jsx-runtime': false,
};

/**
 * Текст модуля-переходника: читает опубликованный страницей объект и
 * реэкспортирует из него объявленные имена; отсутствие объекта — названная
 * ошибка, а не обращение к неопределённому значению (design.md, Решение 3).
 *
 * Страница публикует пространство имён модуля (`import * as`), у которого под
 * сборщиком есть поле `default` — сам объект React; отсюда `mod.default ??
 * mod`: чем бы страница ни опубликовала своё имя — пространством имён или
 * самим объектом, — виджет получает объект, а не пространство имён вокруг него.
 */
export function widgetRuntimeModuleText(specifier: WidgetRuntimeSpecifier): string {
  const names = WIDGET_RUNTIME_NAMES[specifier];
  const lines = [
    `const runtime = globalThis[${JSON.stringify(WIDGET_RUNTIME_GLOBAL)}];`,
    `const mod = runtime === undefined ? undefined : runtime[${JSON.stringify(specifier)}];`,
    'if (mod === undefined) {',
    `  throw new Error(${JSON.stringify(
      `Экземпляр «${specifier}» не опубликован витриной: откройте этот адрес со страницы stepcast, а не напрямую`,
    )});`,
    '}',
    ...names.map((name) => `export const ${name} = mod[${JSON.stringify(name)}];`),
    ...(WIDGET_RUNTIME_DEFAULT_EXPORT[specifier] ? ['export default mod.default ?? mod;'] : []),
  ];
  return `${lines.join('\n')}\n`;
}
