import type { Context, Fiber } from 'cordis';

/**
 * Обход объявленных и запрошенных сервисов контекста — общий для осмотра
 * серверной половины (`introspect.ts`) и отчёта страницы о слотах
 * (`ui/src/slotsReport.ts`, design.md, Решение 4, 6). Модуль без зависимостей,
 * тем же правилом, что `fibers.ts`: компилируется и корневым `tsc`
 * (NodeNext, ручной `src/core/plugins/cordis.d.ts`), и браузерным (bundler,
 * настоящие `.d.ts` пакета из `node_modules/cordis`).
 *
 * Объявленные сервисы читаются из `ctx.reflect.store`, а не ведутся отдельным
 * учётом: перехватить `ctx.provide` плагина нечем, любой параллельный учёт
 * разошёлся бы с ним ровно в тех случаях, ради которых обход и заведён
 * (design.md, Решение 4, «Почему не свой учёт»).
 */

/** Префикс, под которым имя слота витрины живёт как имя сервиса контекста (`ui/src/slots.ts`). */
const SLOT_PREFIX = 'slot:';

/** Один объявленный сервис: имя, область, зарегистрировавшая его, и признак «это имя слота». */
export interface DeclaredService {
  readonly name: string;
  readonly fiber: Fiber;
  readonly slot: boolean;
}

/**
 * Сервисы, объявленные в дереве контекста, — по всем символьным ключам
 * `ctx.reflect.store` (см. комментарий у `ReflectService` в `cordis.d.ts`:
 * обычные `Object.keys`/`Object.values` их не видят).
 */
export function declaredServices(ctx: Context): readonly DeclaredService[] {
  const store = ctx.reflect.store;
  // `Object.getOwnPropertySymbols(store)` возвращает ровно ключи, под
  // которыми `store` хранит значения, — индексация ими не может дать
  // `undefined`, но `noUncheckedIndexedAccess` этого не знает про
  // символьный индекс.
  return Object.getOwnPropertySymbols(store).map((key) => {
    const impl = store[key]!;
    return { name: impl.name, fiber: impl.fiber, slot: impl.name.startsWith(SLOT_PREFIX) };
  });
}

/** Один запрошенный сервис области: имя и признак разрешённости. */
export interface RequestedService {
  readonly name: string;
  readonly resolved: boolean;
}

/**
 * Сервисы, запрошенные областью (`fiber.inject`), с признаком разрешённости —
 * тем же правилом, каким его считает `unresolvedFibers` (`fibers.ts`):
 * `fiber.ctx.get(name) === undefined`.
 */
export function requestedServices(fiber: Fiber): readonly RequestedService[] {
  return Object.keys(fiber.inject).map((name) => ({ name, resolved: fiber.ctx.get(name) !== undefined }));
}
