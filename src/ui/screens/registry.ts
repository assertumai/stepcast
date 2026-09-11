import type { IncomingMessage, ServerResponse } from 'node:http';

import { Service, type Context, type Fiber } from 'cordis';

import type { Config } from '../../core/config/resolve.js';
import { StepcastError } from '../../core/errors.js';
import type { BuiltinRow } from '../../core/plugins/builtin.js';
import type { Kernel } from '../../core/plugins/kernel.js';
import type { KernelCache } from '../pipelines.js';
import type { PluginsOverview } from '../plugins.js';
import type { Watcher } from '../watcher.js';
import type { ScreenDeclaration } from './declaration.js';

export type { ScreenDeclaration, ScreenListing, ScreenNav } from './declaration.js';

/**
 * Реестры экранов и маршрутов API — механизм состава витрины (`ui-screens`,
 * design.md Решение 3, 4).
 *
 * Два сервиса, а не один: `screens` отвечает на вопрос «что показать
 * пользователю и как собрать маршрут» (его читает `GET /api/screens`), `api` —
 * «куда послать запрос» (его читает диспетчер `src/ui/server.ts`). Оба
 * заводит строка каркаса `ui-shell` (`rows.ts`) вызовом `ctx.provide`, а не
 * ядро демона: тип обработчика маршрута тянет за собой окружение демона
 * (наблюдатель, кеш ядер), которого у ядра нет и не будет (design.md, Решение 4).
 *
 * Регистрация в обоих — `ctx.effect` вызывающей области, тем же приёмом, что
 * `ContributionService.register` (`src/core/plugins/kernel.ts`): владелец
 * определяется по имени фибера вызвавшего, а не по параметру, который вызвавший
 * мог бы подделать. Встроенный экран получает собственный фибер тем же
 * вызовом, каким его получил бы плагин пользователя, — `screenRow()` ниже
 * оборачивает фабрику в `kernel.ctx.plugin(...)`, а не регистрирует вклады
 * прямо на корне: иначе все встроенные экраны делили бы один и тот же фибер
 * (корневой) и отказ о занятом маршруте не смог бы назвать, какие две строки
 * спорят (`ui-screens`, «Маршрут принадлежит одной строке»).
 */

/** Окружение демона на вызов обработчика — не из сервиса (design.md, Решение 5). */
export interface RequestEnv {
  readonly runsRoot: string;
  readonly watcher: Watcher;
  readonly config: Config | undefined;
  readonly home: string | undefined;
  readonly kernelCache: KernelCache;
  /**
   * Действующий состав экранов и причина отказа последней сборки дерева —
   * то, что знает только `src/ui/kernel.ts` (единая точка сборки), не сам
   * обработчик. Нужны почти всем обработчикам не более чем `GET /api/screens`
   * (`ui-shell`), но окружение собирается одним и тем же вызовом на все
   * маршруты (design.md, Решение 5) — отдельного окружения для одного
   * маршрута заводить не стали.
   */
  readonly screens: ReadonlyMap<string, ActiveScreen>;
  readonly buildError: string | undefined;
  /**
   * Действующий состав браузерных строк — тот же, которым гейтится адрес
   * `/plugins/<id>.js` (`src/ui/server.ts`): строка, отключённая патчем или
   * отказавшая при применении, не уходит ни в поток, ни в ответ по адресу.
   *
   * Функция, а не значение: поток событий (`handleEvents`, `rows.ts`) спрашивает
   * состав на каждом такте наблюдателя, а не один раз на запрос, — за время
   * жизни соединения и дерево, и отпечатки каталогов успевают измениться.
   * Собирает её сервер: `currentDaemonKernel` — его забота, а обработчику
   * маршрута знать о кеше ядер незачем (design.md, Решение 5).
   */
  readonly activePlugins: () => Promise<PluginsOverview>;
}

export type ApiHandler = (req: IncomingMessage, res: ServerResponse, env: RequestEnv) => void | Promise<void>;

/** Экран действующего состава: объявление и то, чьей строкой оно внесено. */
export interface ActiveScreen {
  readonly declaration: ScreenDeclaration;
  /**
   * Объявление внесла строка поставки витрины (`src/ui/screens/rows.ts`), а
   * не чужой модуль. По этому признаку страница решает, вправе ли она взять
   * браузерную половину из своего бандла: у строки-замены `id` тот же самый
   * (`ui-screens`, «Экран отключается и заменяется патчем состава»).
   */
  readonly builtin: boolean;
}

interface ScreenEntry extends ActiveScreen {
  readonly owner: string;
}

/**
 * Области, заведённые строками поставки витрины (`screenRow` ниже). Модульное
 * множество, не поле сервиса и не параметр `register`: признак происхождения
 * обязан быть неподделываемым — чужой модуль вправе назваться как угодно и
 * назвать себя встроенным, но дотянуться до этого множества ему нечем.
 * Область помечается изнутри применения самой строки, до первой регистрации.
 */
const builtinFibers = new WeakSet<Fiber>();

/** Сервис `screens`: объявления экранов действующего состава. */
export class ScreensService extends Service {
  private readonly entries = new Map<string, ScreenEntry>();

  constructor(ctx: Context) {
    super(ctx, 'screens');
  }

  /** Действующий состав: объявление и происхождение по каждому `id`. */
  get active(): ReadonlyMap<string, ActiveScreen> {
    return new Map([...this.entries].map(([id, entry]) => [id, { declaration: entry.declaration, builtin: entry.builtin }]));
  }

  /**
   * Внести объявление экрана. `id` принадлежит одной строке — тем же
   * правилом, что и пара «метод и путь» у `ApiService`: тихая подмена увела
   * бы у первой строки и место в навигации, и ключ слота, а снятие второй
   * унесло бы с собой запись первой, оставив её экран без объявления вовсе.
   * Строку, заменяющую встроенный экран, это не задевает: заменённой строки в
   * дереве нет, и её фабрика не зовётся (`plugin-tree`).
   */
  register(declaration: ScreenDeclaration): () => void {
    const owner = this.ctx.fiber.name;
    const existing = this.entries.get(declaration.id);
    if (existing !== undefined) {
      throw new StepcastError(
        `Экран ${declaration.id} объявлен дважды: его объявляют ${existing.owner} и ${owner}`,
        {
          hint: 'Переопределение экрана не предусмотрено: снимите одну из строк либо назовите экран иначе',
        },
      );
    }
    const builtin = builtinFibers.has(this.ctx.fiber);
    return this.ctx.effect(() => {
      this.entries.set(declaration.id, { declaration, owner, builtin });
      return () => {
        // Снимается только своя запись: на месте этого `id` к моменту снятия
        // может стоять уже другая строка.
        if (this.entries.get(declaration.id)?.owner === owner) this.entries.delete(declaration.id);
      };
    }, `screens.register(${declaration.id})`);
  }
}

interface RouteEntry {
  readonly handler: ApiHandler;
  readonly owner: string;
}

function routeKey(method: string, path: string): string {
  return `${method} ${path}`;
}

/**
 * Маршруты глазами диспетчера (`src/ui/server.ts`): только поиск, без
 * регистрации. Отдельный тип нужен `src/ui/kernel.ts`: состав, собранный без
 * строки каркаса, реестра не имеет вовсе, и на его месте стоит `NO_ROUTES`, а
 * не `undefined` — диспетчер не должен знать об этом случае ничего, кроме
 * того, что маршрут не нашёлся.
 */
export interface ApiRoutes {
  find(method: string, path: string): ApiHandler | undefined;
  hasAnyMethod(path: string): boolean;
}

/** Пустой реестр: маршрута нет ни одного, любой запрос под `/api/` получит 404. */
export const NO_ROUTES: ApiRoutes = {
  find: () => undefined,
  hasAnyMethod: () => false,
};

/**
 * Сервис `api`: пары «метод и путь» → обработчик (`ui-screens`, «Маршрут
 * принадлежит одной строке»). Повтор пары — именованный отказ на регистрации,
 * а не молчаливая подмена: тем же правилом, каким `ContributionService`
 * отказывает на занятом имени вклада.
 */
export class ApiService extends Service implements ApiRoutes {
  private readonly routes = new Map<string, RouteEntry>();

  constructor(ctx: Context) {
    super(ctx, 'api');
  }

  register(method: string, path: string, handler: ApiHandler): () => void {
    const owner = this.ctx.fiber.name;
    const key = routeKey(method, path);
    const existing = this.routes.get(key);
    if (existing !== undefined) {
      throw new StepcastError(
        `Маршрут ${method} ${path} занят: его объявляют ${existing.owner} и ${owner}`,
        {
          hint: 'Переопределение маршрута не предусмотрено: снимите одну из строк либо назовите путь иначе',
        },
      );
    }
    return this.ctx.effect(() => {
      this.routes.set(key, { handler, owner });
      return () => {
        this.routes.delete(key);
      };
    }, `api.register(${method} ${path})`);
  }

  /** Обработчик по методу и пути — `undefined`, если маршрут не объявлен ни одной действующей строкой. */
  find(method: string, path: string): ApiHandler | undefined {
    return this.routes.get(routeKey(method, path))?.handler;
  }

  /**
   * Путь известен хоть каким-то методом — различает 404 (адреса нет вовсе) и
   * 405 (адрес есть, но не этим методом) в диспетчере (`src/ui/server.ts`).
   */
  hasAnyMethod(path: string): boolean {
    for (const key of this.routes.keys()) {
      if (key.slice(key.indexOf(' ') + 1) === path) return true;
    }
    return false;
  }
}

declare module 'cordis' {
  interface Context {
    screens: ScreensService;
    api: ApiService;
  }
}

/**
 * Строка встроенного экрана: применяется тем же вызовом, каким применился бы
 * плагин пользователя (`kernel.ctx.plugin`), а не регистрацией прямо на
 * корневом контексте, — так у неё есть собственное имя фибера (`id`), и
 * `ScreensService`/`ApiService` видят в ней такого же вкладчика, как и
 * пользовательскую строку-замену (`ui-screens`, «Встроенные экраны
 * описываются тем же способом, каким описывается экран, принесённый строкой
 * пользователя»).
 */
export function screenRow(id: string, inject: readonly string[], apply: (ctx: Context) => void): BuiltinRow {
  return {
    id,
    async apply(kernel: Kernel) {
      const fiber = kernel.ctx.plugin({
        name: id,
        inject: [...inject],
        // Пометка происхождения — первым делом применения, до любой
        // регистрации: `ctx.fiber` здесь и есть область строки, и по ней
        // `ScreensService.register` отличает строку поставки от чужого модуля
        // (см. `builtinFibers` выше).
        apply(ctx) {
          builtinFibers.add(ctx.fiber);
          apply(ctx);
        },
      });
      try {
        await fiber;
      } catch (error) {
        await fiber.dispose().catch(() => undefined);
        throw error;
      }
    },
  };
}
