import type { Context, Fiber } from 'cordis';

/**
 * Успокоение контекста и поиск зависших областей — общее для демона и
 * витрины (design.md `cordis-kernel-browser`, Решение 6). «Успокоился ли
 * контекст» — ровно то место, где обе половины обязаны вести себя
 * одинаково, и два независимых определения разошлись бы молча.
 *
 * Модуль без зависимостей и не бросает своих отказов: функции возвращают
 * данные, а отказ (в демоне — `StepcastError`, в витрине — запись для полосы
 * диагностик) строит вызывающая половина сама.
 *
 * Поверхность cordis, которой пользуется модуль, — `Context`, `Fiber`,
 * `FiberState`, `ctx.registry` — обязана компилироваться и корневым `tsc`
 * (NodeNext, ручной `src/kernel/cordis.d.ts`), и браузерным (bundler,
 * настоящие `.d.ts` пакета из `node_modules/cordis`); design.md, риск «Два
 * объявления типов cordis».
 */

/** Все области дерева — не только верхнего уровня, но и заведённые вложенным `ctx.inject`. */
export function allFibers(ctx: Context): Fiber[] {
  const fibers: Fiber[] = [];
  for (const runtime of ctx.registry.values()) {
    for (const fiber of runtime.fibers) fibers.push(fiber);
  }
  return fibers;
}

/** Верхнеуровневые области — заведённые на самом корне, а не вложенным `ctx.inject`. */
export function topLevelFibers(ctx: Context): Fiber[] {
  return allFibers(ctx).filter((fiber) => fiber.parent === ctx);
}

/**
 * Дождаться, пока контекст перестанет применять области: повторный обход
 * `ctx.registry`, пока число известных областей не перестанет расти. Тело
 * успокоившейся области могло завести новую (вложенный `ctx.inject`) —
 * поэтому счётчик обязан стабилизироваться, а не просто перестать расти за
 * один проход.
 */
export async function settle(ctx: Context): Promise<readonly Fiber[]> {
  let previous = -1;
  let fibers = allFibers(ctx);
  while (fibers.length !== previous) {
    previous = fibers.length;
    await Promise.allSettled(fibers.map((fiber) => fiber.await().catch(() => undefined)));
    fibers = allFibers(ctx);
  }
  return fibers;
}

/** Плагин, чья область осталась ждать сервис после успокоения дерева, — что называть в отказе. */
export interface UnresolvedFiber {
  readonly plugin: string;
  readonly missing: readonly string[];
  /** Сама область: по ней вызывающий находит объявление, которым плагин заведён. */
  readonly fiber: Fiber;
}

/**
 * `FiberState.PENDING` числом, а не именем. Настоящие `.d.ts` cordis
 * объявляют `FiberState` как `const enum` (`node_modules/cordis/lib/fiber.d.ts`),
 * а браузерный компилятор (`moduleResolution: bundler`) разрешает их, в
 * отличие от ручного `cordis.d.ts` этого проекта, где `FiberState` — обычный
 * `enum`; импорт значения `const enum` через границу модуля запрещает
 * `verbatimModuleSyntax` (TS2748) ровно у одной из двух половин — запасной
 * ход из design.md `cordis-kernel-browser`, Решение 6, риск «Два объявления
 * типов cordis». Значение сверено с обоими объявлениями и рантаймом
 * (`test/plugin-kernel.test.ts`, «ручное объявление cordis совпадает с
 * установленной версией по рантайму»).
 */
const FIBER_STATE_PENDING = 0;
/** См. комментарий у `FIBER_STATE_PENDING` — тот же запасной ход, значение `FiberState.FAILED`. */
const FIBER_STATE_FAILED = 3;

/** Области, зависшие в `PENDING` после успокоения: неудовлетворённое внедрение. */
export function unresolvedFibers(fibers: readonly Fiber[]): UnresolvedFiber[] {
  const out: UnresolvedFiber[] = [];
  for (const fiber of fibers) {
    if (fiber.state !== FIBER_STATE_PENDING) continue;
    const missing = Object.keys(fiber.inject).filter((name) => fiber.ctx.get(name) === undefined);
    out.push({ plugin: fiber.name, missing, fiber });
  }
  return out;
}

/**
 * Области, отказавшие броском при загрузке (`FiberState.FAILED`) — то, чем
 * cordis отмечает синхронный или асинхронный отказ тела `ctx.plugin()` /
 * `ctx.inject()`, включая повторное объявление имени сервиса (`ctx.provide`).
 * Причину несёт не сам `Fiber`, а его `.await()`: она бросает `_error`,
 * вызывающий обязан поймать её сам (design.md `cordis-kernel-browser`,
 * Решение 6).
 */
export function failedFibers(fibers: readonly Fiber[]): readonly Fiber[] {
  return fibers.filter((fiber) => fiber.state === FIBER_STATE_FAILED);
}
