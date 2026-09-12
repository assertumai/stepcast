/**
 * Собственные `.d.ts` пакета `cordis@4.0.0-rc.10` реэкспортируют друг друга
 * относительными путями без расширения (`export * from './context'`), что
 * `moduleResolution: NodeNext` этого проекта запрещает (TS2834) — сборка
 * пакета рассчитана на резолвер терпимее нашего. `skipLibCheck` эту ошибку не
 * снимает: `Context`/`Service`/`Fiber` не разрешились бы вовсе, не только не
 * проверились (design.md, Решение 1, риск не по плану).
 *
 * Это ручное объявление — не замена типов пакета, а обход одного резолвера:
 * оно подставляется вместо цепочки реэкспортов и описывает ровно ту
 * поверхность рантайма, которой пользуется ядро, подтверждённую чтением
 * исходных `.d.ts` пакета и пробным запуском на установленной версии. Рантайм
 * не тронут — исполняется настоящий `node_modules/cordis`; расходится только
 * то, откуда берёт типы компилятор.
 */
declare module 'cordis' {
  /** Форма поля `inject` плагина контекста — список имён либо карта имя→конфиг. */
  export type Inject = string[] | Record<string, unknown>;

  export enum FiberState {
    PENDING = 0,
    LOADING = 1,
    ACTIVE = 2,
    FAILED = 3,
    DISPOSED = 4,
    UNLOADING = 5,
  }

  export namespace Plugin {
    interface Base {
      name?: string;
      inject?: Inject;
    }
    interface Function<T = unknown> extends Base {
      (ctx: Context, config: T): unknown;
    }
    interface Object<T = unknown> extends Base {
      apply(ctx: Context, config: T): unknown;
    }
    interface Runtime {
      name?: string;
      fibers: Iterable<Fiber>;
    }
  }
  export type Plugin<T = unknown> = Plugin.Function<T> | Plugin.Object<T>;

  export class RegistryService {
    values(): IterableIterator<Plugin.Runtime>;
  }

  export class Fiber {
    readonly ctx: Context;
    /** Контекст, которым эта область заведена — `ctx.plugin()`/`ctx.inject()` звали на нём. */
    readonly parent: Context;
    readonly runtime: Plugin.Runtime | null;
    readonly inject: Record<string, unknown>;
    state: FiberState;
    readonly inertia: Promise<void> | undefined;
    get name(): string;
    effect<T = unknown>(execute: () => (() => T) | void, label?: string): () => T;
    await(): Promise<this>;
    dispose(): Promise<void>;
  }

  export abstract class Service {
    protected ctx: Context;
    readonly name: string;
    constructor(ctx: Context, name: string);
  }

  /**
   * Одна реализация сервиса в `ReflectService.store` (design.md, Решение 4):
   * ровно то, чем пользуется обход объявленных сервисов (`services.ts`) —
   * имя и область, зарегистрировавшая его. Настоящий `Impl` несёт ещё `value`
   * и `check`, но обход в них не заглядывает — не объявлены и здесь.
   */
  export interface Impl {
    readonly name: string;
    readonly fiber: Fiber;
  }

  /**
   * `store` хранит реализации по символьным ключам (по одному на имя сервиса
   * в изоляте) — обычные `Object.keys`/`Object.values` их не видят, обход
   * обязан идти `Object.getOwnPropertySymbols` (проверено рантаймом,
   * `test/plugin-kernel.test.ts`). Прочая поверхность `ReflectService`
   * (`props`, `get`, `provide`, …) обходу не нужна и здесь не объявлена.
   */
  export class ReflectService {
    readonly store: Record<symbol, Impl>;
  }

  // `interface Context` + `class Context` ниже — то же слияние, каким
  // объявлен реальный `Context` в собственных `.d.ts` cordis (он мутирует
  // прототип класса методами сервисов): здесь оно воспроизведено намеренно,
  // а не по ошибке, и линт предупреждает о нём зря.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
  export interface Context {
    readonly fiber: Fiber;
    readonly registry: RegistryService;
    readonly reflect: ReflectService;
    effect: Fiber['effect'];

    plugin<P extends Plugin>(plugin: P, config?: unknown): Fiber & PromiseLike<Fiber>;
    inject(deps: Inject, callback: (ctx: Context) => void): Fiber & PromiseLike<Fiber>;

    get(name: string, strict?: boolean): unknown;
    set(name: string, value: unknown): void;
    provide(name: string, value?: unknown): () => void;
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
  export class Context {
    constructor();
  }
}
