import { createElement, type ComponentType, type ReactElement } from 'react';

import type { BacklogOverview, Overview, RunSnapshot, WidgetsOverview } from './api';
import type { ParsedRoute } from '../../src/ui/routes.ts';
// Дополнение типов контекста: `declare module 'cordis'` в `services/screens.ts`
// и `services/live.ts` типизирует `ctx.screens` и `ctx.live` (реестр слотов —
// в `slots.ts`, откуда эта поверхность и так берёт `slot()`). Импорт только
// ради побочного эффекта декларации — поверхность не отдаёт сами сервисы
// (design.md, Решение 5): плагин получает типизированный `ctx`, а не доступ к
// `LiveService`/`ScreensService`.
import type {} from './services/screens';
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

/** Пункт навигации — по маршруту (design.md `cordis-kernel-browser`). */
export const NAV = slot<{ readonly route: ParsedRoute; readonly navigate: (href: string) => void }, 'list'>(
  'nav',
  'list',
);

/** Экран по ключу маршрута — данные витрины раздаются props, а не через контекст (design.md `cordis-kernel-browser`, Решение 10). */
export const SCREEN = slot<
  {
    readonly overview: Overview | undefined;
    readonly navigate: (href: string) => void;
    /** Параметры адреса, разобранные по объявлению экрана (`ui-screens`, «Параметры доезжают до экрана»). */
    readonly params: Readonly<Record<string, string>>;
    readonly backlog: BacklogOverview | undefined;
    readonly widgets: WidgetsOverview | undefined;
    readonly snapshot: RunSnapshot | undefined;
  },
  'keyed'
>('screen', 'keyed');

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
