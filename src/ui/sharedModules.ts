/**
 * Таблица общих модулей витрины: закрытый перечень имён, которые плагин или
 * виджет вправе импортировать голым специфаком, и тексты модулей-переходников,
 * которые демон отдаёт по адресам `/shared/<сегмент>.js` (design.md, Решения
 * 1—4).
 *
 * Общий модуль демона и страницы: сервер строит из него тела переходников
 * (`sharedModuleText`), а `ui/src/main.tsx` — объект, который страница
 * публикует на `window` до первой отрисовки (`WIDGET_RUNTIME_GLOBAL`).
 * Разъедься они, и импортирующий получил бы `undefined` вместо значения без
 * единой строки лога: оба места читают один и тот же перечень записей, а не
 * два похожих.
 */

import { isSafeSegment, sharedModuleHref } from './routes.js';

/**
 * Из таблицы выводятся все её применения (design.md, Решение 1): карта имён
 * страницы (`ui/index.html`, сверяется тестом — разметка единственное место,
 * которое вывести нельзя), объект публикации экземпляров (`ui/src/main.tsx`),
 * диспетчер адреса у демона (`src/ui/server.ts`), записи прокси дев-сервера
 * (`vite.config.ts`) и перечень `external` при сборке половины
 * (`src/ui/widgets.ts`). Имя входит в таблицу тогда и только тогда, когда два
 * экземпляра на одной странице ломают поведение (design.md, Решение 2) — не
 * вес бандла и не удобство.
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

export type SharedModuleSpecifier =
  | 'react'
  | 'react-dom'
  | 'react/jsx-runtime'
  | 'cordis'
  | '@stepcast/slots'
  | '@stepcast/ui';

/**
 * Запись таблицы (design.md, Решение 1): сегмент адреса не выводится из имени
 * механически — у `react/jsx-runtime` в имени есть `/`, у `@stepcast/ui` — `@`
 * и `/`, — а объявляется явно и проверяется на безопасность тем же
 * `isSafeSegment`, что и прочие пути витрины (`src/ui/routes.ts`).
 */
export interface SharedModuleEntry {
  readonly specifier: SharedModuleSpecifier;
  readonly routeSegment: string;
  /**
   * Реэкспортируемые имена — объявленная поверхность API, а не всё, что
   * экспортирует модуль (design.md, Решение 4): сверяется тестом с тем, что
   * реально экспортирует установленная версия (для `react`, `react-dom`,
   * `react/jsx-runtime`, `cordis` — узловым тестом; для `@stepcast/slots` и
   * `@stepcast/ui`, живущих в `ui/`, — браузерным).
   */
  readonly names: readonly string[];
  /**
   * Есть ли у модуля экспорт по умолчанию. `import React, { useState } from
   * 'react'` — самая распространённая идиома React-модуля, и переходник без
   * `default` ронял бы её при связывании.
   */
  readonly hasDefault: boolean;
}

/**
 * Таблица общих модулей (design.md, Решение 2): ровно шесть имён, каждое —
 * потому что два экземпляра на странице ломают поведение, а не увеличивают
 * вес. Пополнение — правилом в `docs/plugins.md`: имя заводит все места сразу.
 */
export const SHARED_MODULES: Readonly<Record<SharedModuleSpecifier, SharedModuleEntry>> = {
  react: {
    specifier: 'react',
    routeSegment: 'react',
    hasDefault: true,
    names: [
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
  },
  'react-dom': {
    specifier: 'react-dom',
    routeSegment: 'react-dom',
    hasDefault: true,
    names: ['createPortal', 'flushSync', 'unstable_batchedUpdates', 'version'],
  },
  'react/jsx-runtime': {
    specifier: 'react/jsx-runtime',
    // В специфике есть `/` — в адрес он идти не может, отсюда отдельное route-имя.
    routeSegment: 'jsx-runtime',
    // У самого пакета экспорта по умолчанию нет.
    hasDefault: false,
    names: ['Fragment', 'jsx', 'jsxs'],
  },
  cordis: {
    specifier: 'cordis',
    routeSegment: 'cordis',
    hasDefault: false,
    // `Context` и `Service` — то, чем плагин заводит свой сервис и получает
    // контекст в `apply`; `Fiber` — тип области, которым уже пользуется
    // встроенная половина (`ui/src/kernel.ts`, `ui/src/services/plugins.ts`).
    names: ['Context', 'Service', 'Fiber'],
  },
  '@stepcast/slots': {
    specifier: '@stepcast/slots',
    routeSegment: 'stepcast-slots',
    hasDefault: false,
    names: [
      'slot',
      'ROOT',
      'NAV',
      'SCREEN',
      'SCREEN_FRAME',
      'ROUTE_TARGET',
      'ROUTES_LISTING_KEY',
      'elementSlotComponent',
    ],
  },
  '@stepcast/ui': {
    specifier: '@stepcast/ui',
    routeSegment: 'stepcast-ui',
    hasDefault: false,
    names: [
      'Button',
      'Card',
      'CardHeader',
      'CardTitle',
      'CardDescription',
      'CardContent',
      'CardFooter',
      'Table',
      'TableHeader',
      'TableBody',
      'TableFooter',
      'TableRow',
      'TableHead',
      'TableCell',
      'TableCaption',
      'Dialog',
      'DialogTrigger',
      'DialogContent',
      'DialogHeader',
      'DialogFooter',
      'DialogTitle',
      'DialogDescription',
      'Tabs',
      'TabsList',
      'TabsTrigger',
      'TabsContent',
      'Select',
      'SelectTrigger',
      'SelectValue',
      'SelectContent',
      'SelectItem',
      'Input',
    ],
  },
};

/**
 * Сегмент записи, проверенный на безопасность пути (`isSafeSegment`,
 * `src/ui/routes.ts`) — тем же предикатом, каким сервер проверяет сегменты
 * виджета и плагина. Проверка стоит на выводе всех применений таблицы, а не в
 * диспетчере запроса: сегмент приходит не из запроса, а из самой таблицы, и
 * поймать `../react` надо у того, кто его написал, — при первом же импорте
 * модуля, а не в момент, когда демон соберёт из него путь. Отказ назван
 * записью, чтобы не искать, какая из шести строк таблицы виновата.
 */
export function checkedRouteSegment(entry: SharedModuleEntry): string {
  if (!isSafeSegment(entry.routeSegment)) {
    throw new Error(
      `Таблица общих модулей: сегмент адреса "${entry.routeSegment}" записи "${entry.specifier}" ` +
        `не годится сегментом пути (пустой, с разделителем или с шагом вверх по дереву)`,
    );
  }
  return entry.routeSegment;
}

/** Записи таблицы в порядке объявления — порядок карты имён и прочих выведенных мест берётся отсюда. */
export const SHARED_MODULE_LIST: readonly SharedModuleEntry[] = Object.values(SHARED_MODULES);

/** Сегмент адреса → специфик — обратная сторона таблицы, для разбора пути демоном. */
export const SHARED_MODULE_BY_SEGMENT: ReadonlyMap<string, SharedModuleEntry> = new Map(
  SHARED_MODULE_LIST.map((entry) => [checkedRouteSegment(entry), entry]),
);

/**
 * Карта имён страницы — выведенная, а не написанная дважды: разметка
 * (`ui/index.html`) обязана нести ровно это соответствие, и тест сверяет её с
 * этим объектом (`test/ui-shared-modules.test.ts`). Переименование сегмента
 * или седьмое имя в таблице иначе тихо разъехались бы с разметкой, и
 * импортирующий получил бы «неизвестный спецификатор» вместо значения
 * (`ui-dashboard`, «Перечень имён в карте... MUST выводиться из одной таблицы
 * и совпадать»).
 */
export const SHARED_MODULE_IMPORT_MAP: Readonly<Record<string, string>> = Object.fromEntries(
  SHARED_MODULE_LIST.map((entry) => [entry.specifier, sharedModuleHref(checkedRouteSegment(entry))]),
);

/**
 * Текст модуля-переходника: читает опубликованный страницей объект и
 * реэкспортирует из него объявленные имена; отсутствие объекта — названная
 * ошибка, а не обращение к неопределённому значению (design.md, Решение 4).
 *
 * Страница публикует пространство имён модуля (`import * as`), у которого под
 * сборщиком есть поле `default` — сам объект React; отсюда `mod.default ??
 * mod`: чем бы страница ни опубликовала своё имя — пространством имён или
 * самим объектом, — импортирующий получает объект, а не пространство имён
 * вокруг него.
 */
export function sharedModuleText(entry: SharedModuleEntry): string {
  const lines = [
    `const runtime = globalThis[${JSON.stringify(WIDGET_RUNTIME_GLOBAL)}];`,
    `const mod = runtime === undefined ? undefined : runtime[${JSON.stringify(entry.specifier)}];`,
    'if (mod === undefined) {',
    `  throw new Error(${JSON.stringify(
      `Экземпляр «${entry.specifier}» не опубликован витриной: откройте этот адрес со страницы stepcast, а не напрямую`,
    )});`,
    '}',
    ...entry.names.map((name) => `export const ${name} = mod[${JSON.stringify(name)}];`),
    ...(entry.hasDefault ? ['export default mod.default ?? mod;'] : []),
  ];
  return `${lines.join('\n')}\n`;
}
