import { Context, Service, type Fiber } from 'cordis';

import { StepcastError } from '../errors.js';
import type { Context as PluginContext, ContributionRegistrar } from './context.js';
import type { CommandContribution, LoadedPlugin } from './contract.js';
import { settle, topLevelFibers, unresolvedFibers, type UnresolvedFiber } from './fibers.js';
import { declaredServices } from './services.js';

export { unresolvedFibers, type UnresolvedFiber };

/**
 * Ядро движка — корневой контекст cordis.
 *
 * Единственный служебный сервис, который заводит сама сборка ядра, —
 * `commands`: каркас CLI, разбор аргументов и диспетчер команд — собственная
 * работа ядра, а не домен (design.md, Решение 5). Служебные сервисы движка
 * пайплайнов (`backends`, `predicates`, `steps`) заводит строка состава
 * `pipeline` (`src/parts/pipeline/services.ts`), а не ядро, — ядро ни одного
 * их имени не знает и не объявляет занятым.
 *
 * `register(имя, вклад)` оформлен `ctx.effect` вызывающей области, так что
 * снятие области плагина снимает вклад без единой строки учёта здесь
 * (design.md, Решение 2).
 *
 * Встроенные вклады (`builtin.ts`) регистрируются тем же вызовом, что и
 * плагинные. Признак «это вклад встроенного слоя» — параметр конструктора
 * сервиса (`isBuiltinFiber`, ниже): для `commands` это идентичность корневой,
 * изначально активной области ядра (её `ctx.effect` исполняется синхронно, в
 * отличие от `ctx.plugin()`, всегда проходящего через микрозадачу, — поэтому
 * `createKernel()` остаётся синхронной функцией), для сервисов строки
 * `pipeline` — принадлежность фибера множеству помеченных областей встроенного
 * слоя (design.md, Решение 3).
 *
 * Успокоение контекста и поиск зависших областей (`settle`, `unresolvedFibers`)
 * живут в `./fibers.js` — модуле без зависимостей, общем с браузерным ядром
 * витрины (design.md `cordis-kernel-browser`, Решение 6); здесь только
 * реэкспорт и использование.
 */

/** Владелец встроенного вклада в тексте отказа — не имя строки, а признак области встроенного слоя. */
export const BUILTIN_OWNER = 'встроенный';

function describeOwner(owner: string): string {
  return owner === BUILTIN_OWNER ? 'встроенный вклад' : `плагин ${owner}`;
}

/**
 * Проверка имени вклада перед регистрацией — вызываемая, а не перечень
 * данных (design.md, Решение 1): текст отказа и подсказка остаются там, где
 * живёт знание о занятых именах (`pipeline/schema.ts`), а не приходят в ядро
 * доменными строками. Отказывает исключением; имя, которое проверка приняла,
 * ничем не подтверждается.
 *
 * Вклад и уже занятые вклады переданы непрозрачными значениями (design.md
 * изменения `step-kind-document-contract`, Решение 7): проверке вида шага
 * нужно прочесть объявленные вкладом ключи (`StepKindContribution.document`) и
 * сверить их с ключами, занятыми другими вкладами того же вида, — а ядро
 * доменного типа по-прежнему не узнаёт (`kernel-domain-free-imports`).
 */
export type ContributionNameGuard = (
  name: string,
  contribution: unknown,
  taken: ReadonlyMap<string, unknown>,
) => void;

/**
 * Сервис вида вклада: `register` — эффект вызывающей области, конфликт имён —
 * именованный отказ. Механизм без доменных имён (design.md `pipeline-owns-services`,
 * Решение 5): имя сервиса, слово для текстов отказа («бэкенда», «вида шага») и
 * признак встроенной области — параметры конструктора, а не перечень,
 * зашитый в ядро. Ядро заводит им единственный сервис — `commands`; служебные
 * сервисы движка пайплайнов заводит строка `pipeline`
 * (`src/parts/pipeline/services.ts`), передавая свои слово и признак.
 */
export class ContributionService<T> extends Service implements ContributionRegistrar<T> {
  /**
   * `ownerFiber` рядом с `owner` (design.md, Решение 3) — осмотр (`introspect.ts`)
   * приписывает вклад строке по области, а имя владельца одно на все строки
   * плагина не различило бы их. `Registry.owners` этим полем не пользуется и
   * не расширяется: его читает `stepcast config`, которому фибер не нужен.
   */
  private readonly entries = new Map<string, { readonly value: T; readonly owner: string; readonly ownerFiber: Fiber }>();
  /** Слово для текстов отказа («бэкенда», «вида шага», …) — не имя сервиса, которое ушло бы в текст сырым. */
  private readonly word: string;
  /** Признак «эта область — область встроенного слоя»: идентичность корня для `commands`, пометка фибера для сервисов строки `pipeline` (design.md, Решение 3). */
  private readonly isBuiltinFiber: (fiber: Fiber) => boolean;
  /**
   * Владелец имени, снятого вместе с областью, — на время жизни этого ядра
   * (design.md, решение 8). Заведена ровно ради одного сообщения: пайплайн,
   * раскрывавшийся минуту назад, обязан отказать не «неизвестный вид http», а
   * «вид шага http снят вместе с плагином http-steps». Новый процесс (плагин
   * убран из конфигурации между запусками) об этом не помнит вовсе — карта
   * живёт в памяти этого объекта и не сериализуется никуда.
   */
  private readonly formerOwners = new Map<string, string>();
  private readonly nameGuard: ContributionNameGuard | undefined;
  /** Имя сервиса — для метки эффекта регистрации (`ctx.effect`), а не для текстов отказа: те несут `word`. */
  private readonly serviceName: string;

  constructor(ctx: Context, name: string, word: string, isBuiltinFiber: (fiber: Fiber) => boolean, nameGuard?: ContributionNameGuard) {
    super(ctx, name);
    this.serviceName = name;
    this.word = word;
    this.isBuiltinFiber = isBuiltinFiber;
    this.nameGuard = nameGuard;
  }

  /** Вклады вида — то, чем сегодня был `registry[kind]`. */
  get contributions(): ReadonlyMap<string, T> {
    return new Map([...this.entries].map(([name, entry]) => [name, entry.value]));
  }

  /**
   * Вклады вида с фибером их области — то, чем осмотр (`introspect.ts`)
   * приписывает вклад строке дерева (design.md, Решение 3). Не заменяет
   * `contributions`/`owner`: `stepcast config` и текст отказов фибер не
   * читают, а `Registry.owners` им не расширяется.
   */
  entriesWithFiber(): readonly { readonly name: string; readonly value: T; readonly owner: string; readonly ownerFiber: Fiber }[] {
    return [...this.entries].map(([name, entry]) => ({ name, ...entry }));
  }

  /** Кто внёс вклад с этим именем — имя плагина либо `BUILTIN_OWNER`. */
  owner(name: string): string | undefined {
    return this.entries.get(name)?.owner;
  }

  /**
   * Кто в последний раз нёс это имя, если сейчас оно свободно, — только для
   * текста отказа (см. `formerOwners` выше). Занятое имя не имеет «прежнего»:
   * возвращается `undefined`, чтобы не путать действующего владельца с ушедшим.
   */
  formerOwner(name: string): string | undefined {
    return this.owner(name) === undefined ? this.formerOwners.get(name) : undefined;
  }

  register(name: string, contribution: T): () => void {
    const owner = this.isBuiltinFiber(this.ctx.fiber) ? BUILTIN_OWNER : this.ctx.fiber.name;

    // Проверка имени касается только плагина: встроенные вклады регистрируют
    // себя на области встроенного слоя ровно под теми же именами (`run`,
    // `script`, …), и это не конфликт, а определение (design.md, Решение 1).
    // Уже занятые вклады переданы тем же неявным видом, что и регистрируемый
    // (design.md изменения `step-kind-document-contract`, Решение 7) —
    // проверке нужен доступ к их содержанию (например, к занятым ключам), а
    // не только к перечню имён.
    if (owner !== BUILTIN_OWNER) this.nameGuard?.(name, contribution, this.contributions);

    const existingOwner = this.owner(name);
    if (existingOwner !== undefined) {
      // Тихая подмена `claude` или `exit_code` сделала бы лжецом и `stepcast
      // config`, и журнал прогона: и тот и другой называют имя, а не источник.
      throw new StepcastError(
        `Имя ${this.word} ${name} занято: его объявляют ${describeOwner(existingOwner)} и ${describeOwner(owner)}`,
        {
          hint: 'Переопределение вклада не предусмотрено: снимите один из плагинов либо попросите автора переименовать вклад',
        },
      );
    }
    return this.ctx.effect(() => {
      this.entries.set(name, { value: contribution, owner, ownerFiber: this.ctx.fiber });
      return () => {
        this.entries.delete(name);
        this.formerOwners.set(name, owner);
      };
    }, `${this.serviceName}.register(${name})`);
  }
}

declare module 'cordis' {
  interface Context {
    commands: ContributionService<CommandContribution>;
  }
}

export type { Context, Fiber };

/**
 * Стык двух объявлений контекста: настоящий `Context` cordis обязан
 * соответствовать тому, что публикует `context.ts` подпутём `stepcast/plugin`.
 * Расхождение — обновление версии cordis, правка публикуемого типа — становится
 * ошибкой компиляции здесь, у нас, а не у автора плагина (design.md, Решение 8).
 */
export function pluginContext(ctx: Context): PluginContext {
  return ctx;
}

export interface Kernel {
  readonly ctx: Context;
  /**
   * Дождаться, пока контекст перестанет применять области: повторный обход
   * `ctx.registry` (сервис на весь контекст, не на область — видит и вложенные
   * `ctx.inject`), пока число известных областей не перестанет расти
   * (design.md, ответ на первый открытый вопрос). Отдельная область или её
   * `.await()` для этого недостаточны: `Fiber`, чья зависимость никогда не
   * появится, остаётся `PENDING`, а `.await()` на ней разрешается немедленно,
   * не дождавшись ничего.
   */
  settle(): Promise<readonly Fiber[]>;
  /** Загруженные плагины в порядке загрузки — живой список, как и сервисы вкладов. */
  readonly plugins: readonly LoadedPlugin[];
  /**
   * Записать плагин в перечень загруженных эффектом области `ctx`: снятие
   * этой области снимает и запись — тем же приёмом, что и всякий вклад.
   */
  recordPlugin(ctx: Context, meta: LoadedPlugin): void;
  /**
   * Плагин, применённый этой областью, — то, чем осмотр (`introspect.ts`)
   * называет применённую строку её именем и версией: строка дерева и
   * `LoadedPlugin` связаны фибером, а не порядком или именем.
   */
  pluginOf(fiber: Fiber): LoadedPlugin | undefined;
  /**
   * Забыть запись плагина, чья область так и осталась `PENDING`, — область,
   * которая ждёт сервис и не дождалась. Снятие такой области эффектов не
   * разматывает: cordis снимает их, только выходя из `ACTIVE`
   * (`Fiber._setEpoch`, ветка `epoch === oldEpoch`), а `PENDING` в него и не
   * входила. Вкладов за такой областью нет — её тело не исполнялось вовсе, —
   * но запись в перечне загруженных сделана снаружи, вызывающим, и снять её
   * тоже приходится ему. Для области, снятой обычным путём, вызов
   * безвреден: запись уже убрана её же эффектом.
   */
  forgetPlugin(fiber: Fiber): void;
  /**
   * Снять все области, заведённые плагинами этого ядра, — то, чем демон
   * останавливает ядро проекта при `close()` (design.md, Решение 6). Снимаются
   * только верхнеуровневые области (`fiber.parent === ctx`): их собственное
   * снятие каскадно снимает всё, что они завели вложенным `ctx.inject`. Сам
   * корневой `Context` не «снимается» — снимать в нём, кроме областей плагинов,
   * нечего, и он остаётся обычным объектом для сборщика мусора.
   */
  dispose(): Promise<void>;
}

/**
 * Отказ cordis на попытке занять уже поданное имя сервиса — тем же вызовом,
 * которым плагин попытался бы завести сервис `commands` или любой из
 * сервисов строки `pipeline` напрямую (`ctx.provide`/`ctx.set`), минуя вклад.
 * Сообщение — внутренний формат cordis (`service "<имя>" has been registered
 * at <…>`); распознаётся по нему. Владелец имени выводится из действующего
 * состава (`declaredServices`), а не из перечня, зашитого в ядро (design.md,
 * Решение 7): корневая область — «ядро», любая другая — строка, чьё имя несёт
 * её фибер (`ctx.plugin({ name: id, … })`). Имя, не найденное среди
 * объявленных сервисов (гонка снятия области), и форма, не подошедшая под
 * разбор, возвращаются как есть — переводить нечего.
 */
const RESERVED_SERVICE_RE = /^service "([^"]+)" has been registered/;

export function translateReservedNameConflict(error: unknown, ctx: Context): unknown {
  if (!(error instanceof Error)) return error;
  const match = RESERVED_SERVICE_RE.exec(error.message);
  const name = match?.[1];
  if (name === undefined) return error;
  const owner = declaredServices(ctx).find((service) => service.name === name);
  if (owner === undefined) return error;
  const isKernel = owner.fiber === ctx.fiber;
  const message = isKernel
    ? `Имя сервиса ${name} занято: оно принадлежит ядру`
    : `Имя сервиса ${name} занято: его объявляет строка ${owner.fiber.name}`;
  return new StepcastError(message, {
    hint: isKernel
      ? `Имя ${name} принадлежит ядру — заведите сервис под другим именем`
      : `Имя ${name} объявляет строка ${owner.fiber.name} — заведите сервис под другим именем либо отключите эту строку составом`,
    cause: error,
  });
}

export function createKernel(): Kernel {
  const ctx = new Context();
  const rootFiber = ctx.fiber;

  new ContributionService<CommandContribution>(ctx, 'commands', 'команды', (fiber) => fiber === rootFiber);

  const plugins: LoadedPlugin[] = [];
  /** Запись, сделанная областью: нужна `forgetPlugin` — см. её объяснение. */
  const recorded = new WeakMap<Fiber, LoadedPlugin>();

  const forget = (meta: LoadedPlugin): void => {
    const index = plugins.indexOf(meta);
    if (index >= 0) plugins.splice(index, 1);
  };

  return {
    ctx,
    settle: () => settle(ctx),
    plugins,
    async dispose() {
      await Promise.all(topLevelFibers(ctx).map((fiber) => fiber.dispose()));
    },
    recordPlugin(pluginCtx, meta) {
      recorded.set(pluginCtx.fiber, meta);
      pluginCtx.effect(() => {
        plugins.push(meta);
        return () => forget(meta);
      }, `plugins.record(${meta.name})`);
    },
    forgetPlugin(fiber) {
      const meta = recorded.get(fiber);
      if (meta !== undefined) forget(meta);
    },
    pluginOf: (fiber) => recorded.get(fiber),
  };
}
