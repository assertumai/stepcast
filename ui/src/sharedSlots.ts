import { createElement, type ComponentType, type ReactElement } from 'react';

import type { BacklogOverview, Overview, ProposalsStreamEvent, RunSnapshot, WidgetsOverview } from './api';
import type { RouteDefinition, RouteTarget } from '../../src/parts/ui/routes.ts';
// Дополнение типов контекста: `declare module 'cordis'` в `services/screens.ts`,
// `services/routes.ts` и `services/live.ts` типизирует `ctx.screens`,
// `ctx.routes` и `ctx.live` (реестр слотов — в `slots.ts`, откуда эта
// поверхность и так берёт `slot()`). Импорт только ради побочного эффекта
// декларации — поверхность не отдаёт сами сервисы (design.md, Решение 5):
// плагин получает типизированный `ctx`, а не доступ к
// `LiveService`/`ScreensService`/`RoutesService`.
import type {} from './services/screens';
import type {} from './services/routes';
import type {} from './services/live';
import {
  slot,
  type AnySlotDescriptor,
  type ChainLinkProps,
  type Contribution,
  type SlotDescriptor,
  type SlotKind,
} from './slots.ts';

/**
 * `@stepcast/slots` — типизированный доступ к композиции витрины, а не весь
 * реестр (design.md изменения `shared-module-table`, Решение 5). Отдаёт
 * `slot()`, виды и типы вклада, дескрипторы встроенных слотов и адаптер
 * веб-компонента — ровно то, чем плагин пишет вклад и вид которого не
 * приходится угадывать строкой.
 *
 * Чего здесь нет: `SlotsService`, `KernelRoot`, `<Slot>`,
 * `createBrowserKernel`. Плагин не рисует корня и не заводит ядра — отдать
 * ему рендерер значило бы обещать поверхность, которой некому пользоваться.
 *
 * Каркас (`ui/src/plugins/shell.tsx`) и ядро (`ui/src/kernel.ts`) берут
 * дескрипторы отсюда, а не объявляют свои копии: имя таблицы иначе указывало
 * бы плагину на другой объект с тем же именем слота, а Решение 2 таблицы
 * прямо называет копию дескриптора поломкой.
 */

export { slot };
export type { AnySlotDescriptor, ChainLinkProps, Contribution, SlotDescriptor, SlotKind };

/** Слот, которому некуда встать, кроме как на сам корень (design.md `cordis-kernel-browser`, Решение 7). */
export const ROOT = slot<Record<string, never>, 'single'>('root', 'single');

/**
 * Пункт навигации — ключ слота теперь `id` маршрута, а не список
 * (`ui-routes`, design.md Решение 13): каркас рисует общий вид по `nav`
 * каждого маршрута действующей таблицы, а экран, желающий свой вид (значок,
 * счётчик), вносит вклад по этому же ключу и заменяет общий вид только для
 * своего маршрута. `active` — вычислен каркасом по `nav.active_for`, а не
 * знанием одного экрана о другом.
 */
export interface NavItemProps {
  readonly route: RouteDefinition;
  readonly title: string;
  readonly href: string | undefined;
  readonly active: boolean;
  readonly navigate: (href: string) => void;
}

export const NAV = slot<NavItemProps, 'keyed'>('nav', 'keyed');

/** Данные витрины, общие экрану и хосту виджета — раздаются props, а не через контекст (design.md `cordis-kernel-browser`, Решение 10). */
export interface LiveDataProps {
  readonly overview: Overview | undefined;
  readonly navigate: (href: string) => void;
  readonly backlog: BacklogOverview | undefined;
  readonly widgets: WidgetsOverview | undefined;
  readonly snapshot: RunSnapshot | undefined;
  readonly proposals: ProposalsStreamEvent | undefined;
}

/**
 * Экран по ключу маршрута — данные витрины раздаются props, а не через
 * контекст (design.md `cordis-kernel-browser`, Решение 10).
 *
 * Тип раскрыт заново, а не через пересечение с `LiveDataProps`: тип-пересечение
 * не проходит проверку ограничения `Props extends Record<string, unknown>`
 * дженерика `elementSlotComponent` (`examples/plugins/element`) — там, где
 * плоский литерал объекта проходит её сам.
 */
export const SCREEN = slot<
  {
    readonly overview: Overview | undefined;
    readonly navigate: (href: string) => void;
    /** Параметры адреса, разобранные по шаблону пути маршрута (`ui-screens`, «Параметры доезжают до экрана»). */
    readonly params: Readonly<Record<string, string>>;
    readonly backlog: BacklogOverview | undefined;
    readonly widgets: WidgetsOverview | undefined;
    readonly snapshot: RunSnapshot | undefined;
    readonly proposals: ProposalsStreamEvent | undefined;
  },
  'keyed'
>('screen', 'keyed');

/**
 * Ключ, которым экран «Маршруты» вносит перечень маршрутов на место экрана —
 * тем же слотом `SCREEN`, что и любой другой экран (`ui-routes`, design.md
 * Решение 12). Каркас показывает его, когда открытый адрес не разобран ни
 * одним маршрутом.
 */
export const ROUTES_LISTING_KEY = '__routes-listing__';

/**
 * Вид цели маршрута — ключ слота — `target.kind` (`ui-routes`, design.md
 * Решение 5): строка, приносящая новый вид цели (дашборд —
 * `dashboards-as-files`), вносит сюда свой вклад, не меняя ни каркаса, ни
 * разбора адреса. Маршрут на вид, которого действующий состав не знает, —
 * ключ без вкладчика, и `default` вызова `<Slot of={ROUTE_TARGET}>` называет
 * причину.
 */
export interface RouteTargetSlotProps extends LiveDataProps {
  readonly target: RouteTarget;
  /** Значения параметров пути, снятые с адреса. */
  readonly pathParams: Readonly<Record<string, string>>;
  /** Параметры цели маршрута с применёнными подстановками `${params.<имя>}`. */
  readonly targetParams: Readonly<Record<string, string>>;
}

export const ROUTE_TARGET = slot<RouteTargetSlotProps, 'keyed'>('route.target', 'keyed');

/** Обрамление экрана — цепочка звеньев вокруг `SCREEN` (design.md `cordis-kernel-browser`). */
export const SCREEN_FRAME = slot<Record<string, never>, 'chain'>('screen.frame', 'chain');

/**
 * Адаптер веб-компонента (design.md, Решение 10): превращает имя
 * пользовательского элемента в вкладчика слота, отрисовывающего этот элемент
 * с props слота. Плагин на другом фреймворке (Preact, Lit) регистрирует
 * элемент сам (`customElements.define`, проверив `customElements.get(tag)` —
 * реестр элементов браузера неизменен, как и реестр модулей замены) и не
 * импортирует ни одного другого имени таблицы.
 *
 * Тонкий адаптер — `createElement(tag, props)` с приведением типов, а не свой
 * цикл присваивания свойств в эффекте: React 19 сам решает, ставить ли
 * значение свойством элемента или атрибутом, и собственный цикл был бы
 * источником рассинхрона с тем, что React уже делает.
 */
export function elementSlotComponent<Props extends Record<string, unknown>>(tag: string): ComponentType<Props> {
  return function ElementSlotComponent(props: Props): ReactElement {
    return createElement(tag, props as Record<string, unknown>);
  };
}
