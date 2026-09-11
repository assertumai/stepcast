import { Context, FiberState, Service, type Fiber } from 'cordis';

import { StepcastError } from '../errors.js';
import type { Context as PluginContext, ContributionRegistrar } from './context.js';
import type { BackendContribution, CommandContribution, LoadedPlugin, PredicateContribution } from './contract.js';

/**
 * Ядро движка — корневой контекст cordis.
 *
 * Три служебных сервиса — `backends`, `predicates`, `commands` — те самые три
 * вида вклада контракта плагина; `register(имя, вклад)` оформлен `ctx.effect`
 * вызывающей области, так что снятие области плагина снимает вклад без
 * единой строки учёта здесь (design.md, Решение 2). Эти три имени сервисов
 * объявлены занятыми: плагин, попытавшийся завести сервис с любым из них,
 * получает отказ, называющий имя и его принадлежность ядру (Решение 3).
 *
 * Встроенные вклады (`builtin.ts`) регистрируются тем же вызовом, что и
 * плагинные, но на самом корневом контексте, а не внутри `ctx.plugin()`:
 * `ctx.effect` корневой, изначально активной области исполняется синхронно
 * (в отличие от `ctx.plugin()`, всегда проходящего через микрозадачу), так что
 * `createKernel()` остаётся синхронной функцией, как была `createRegistry()`.
 * Область самого ядра — фиксированная область корня, и признак «это она»
 * несёт идентичность её `Fiber`, а не имя (Решение 5).
 */

/** Имена служебных сервисов ядра. Плагину заводить сервис с этим именем нельзя. */
export const KERNEL_RESERVED_NAMES: readonly string[] = ['backends', 'predicates', 'commands'];

/** Владелец встроенного вклада в тексте отказа — не имя строки, а признак области ядра. */
export const BUILTIN_OWNER = 'встроенный';

const KIND_NAMES = {
  backends: 'бэкенда',
  predicates: 'предиката',
  commands: 'команды',
} as const;

type ContributionKind = keyof typeof KIND_NAMES;

function describeOwner(owner: string): string {
  return owner === BUILTIN_OWNER ? 'встроенный вклад' : `плагин ${owner}`;
}

/**
 * Резерв имени без вклада — встроенные предикаты (Решение 11). Ключ метода —
 * символ, не экспортируемый ни из этого модуля, ни тем более из
 * `stepcast/plugin`: сервис доступен плагину как `ctx.predicates`, и публичный
 * метод `reserve` дал бы любому плагину занять произвольное имя навсегда —
 * резерв не эффект, disposer не возвращает и снятием области не снимается.
 * Символ делает «доступен только ядру при сборке» свойством устройства, а не
 * соглашения: назвать этот ключ снаружи нечем.
 */
const reserveName = Symbol('kernel.reserve');

/**
 * Сервис вида вклада: `register` — эффект вызывающей области, конфликт имён —
 * именованный отказ. Резерв имени (см. `reserveName` выше) ядро делает через
 * `Kernel.reservePredicate`, плагину он недоступен.
 */
export class ContributionService<T> extends Service implements ContributionRegistrar<T> {
  private readonly entries = new Map<string, { readonly value: T; readonly owner: string }>();
  private readonly reservedNames = new Set<string>();
  private readonly kind: ContributionKind;
  private readonly builtinFiber: Fiber;

  constructor(ctx: Context, kind: ContributionKind, builtinFiber: Fiber) {
    super(ctx, kind);
    this.kind = kind;
    this.builtinFiber = builtinFiber;
  }

  /** Вклады вида — то, чем сегодня был `registry[kind]`. */
  get contributions(): ReadonlyMap<string, T> {
    return new Map([...this.entries].map(([name, entry]) => [name, entry.value]));
  }

  /** Кто внёс вклад с этим именем — имя плагина либо `BUILTIN_OWNER`. */
  owner(name: string): string | undefined {
    return this.entries.get(name)?.owner ?? (this.reservedNames.has(name) ? BUILTIN_OWNER : undefined);
  }

  /** Имена, занятые без вклада (встроенные предикаты). */
  get reserved(): readonly string[] {
    return [...this.reservedNames];
  }

  [reserveName](name: string): void {
    this.reservedNames.add(name);
  }

  register(name: string, contribution: T): () => void {
    const owner = this.ctx.fiber === this.builtinFiber ? BUILTIN_OWNER : this.ctx.fiber.name;
    const existingOwner = this.owner(name);
    if (existingOwner !== undefined) {
      // Тихая подмена `claude` или `exit_code` сделала бы лжецом и `stepcast
      // config`, и журнал прогона: и тот и другой называют имя, а не источник.
      throw new StepcastError(
        `Имя ${KIND_NAMES[this.kind]} ${name} занято: его объявляют ${describeOwner(existingOwner)} и ${describeOwner(owner)}`,
        {
          hint: 'Переопределение вклада не предусмотрено: снимите один из плагинов либо попросите автора переименовать вклад',
        },
      );
    }
    return this.ctx.effect(() => {
      this.entries.set(name, { value: contribution, owner });
      return () => {
        this.entries.delete(name);
      };
    }, `${this.kind}.register(${name})`);
  }
}

declare module 'cordis' {
  interface Context {
    backends: ContributionService<BackendContribution>;
    predicates: ContributionService<PredicateContribution>;
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
   * Занять имя встроенного предиката без вклада (Решение 11). Живёт на ядре, а
   * не на сервисе: сервис виден плагину, ядро — нет.
   */
  reservePredicate(name: string): void;
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
  /** Загруженные плагины в порядке загрузки — живой список, как и три сервиса. */
  readonly plugins: readonly LoadedPlugin[];
  /**
   * Записать плагин в перечень загруженных эффектом области `ctx`: снятие
   * этой области снимает и запись — тем же приёмом, что и три вида вкладов.
   */
  recordPlugin(ctx: Context, meta: LoadedPlugin): void;
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

/** Все области дерева — не только верхнего уровня, но и заведённые вложенным `ctx.inject`. */
function allFibers(ctx: Context): Fiber[] {
  const fibers: Fiber[] = [];
  for (const runtime of ctx.registry.values()) {
    for (const fiber of runtime.fibers) fibers.push(fiber);
  }
  return fibers;
}

async function settle(ctx: Context): Promise<readonly Fiber[]> {
  let previous = -1;
  let fibers = allFibers(ctx);
  // Тело успокоившейся области могло завести новую (вложенный `ctx.inject`) —
  // поэтому счётчик областей должен стабилизироваться, а не просто перестать
  // расти за один проход.
  while (fibers.length !== previous) {
    previous = fibers.length;
    await Promise.allSettled(fibers.map((fiber) => fiber.await().catch(() => undefined)));
    fibers = allFibers(ctx);
  }
  return fibers;
}

/** Верхнеуровневые области — заведённые `ctx.plugin()` на самом корне, а не вложенным `ctx.inject`. */
function topLevelFibers(ctx: Context): Fiber[] {
  return allFibers(ctx).filter((fiber) => fiber.parent === ctx);
}

/** Плагин, чья область осталась ждать сервис после успокоения дерева, — что называть в отказе. */
export interface UnresolvedFiber {
  readonly plugin: string;
  readonly missing: readonly string[];
  /**
   * Сама область: по ней загрузчик находит объявление, которым плагин заведён,
   * и дописывает отказу файл конфигурации — тот же состав полей, что у прочих
   * отказов загрузки.
   */
  readonly fiber: Fiber;
}

/** Области, зависшие в `PENDING` после успокоения: неудовлетворённое внедрение (Решение 9). */
export function unresolvedFibers(fibers: readonly Fiber[]): UnresolvedFiber[] {
  const out: UnresolvedFiber[] = [];
  for (const fiber of fibers) {
    if (fiber.state !== FiberState.PENDING) continue;
    const missing = Object.keys(fiber.inject).filter((name) => fiber.ctx.get(name) === undefined);
    out.push({ plugin: fiber.name, missing, fiber });
  }
  return out;
}

/**
 * Отказ cordis на попытке занять уже поданное имя сервиса — тем же вызовом,
 * которым плагин попытался бы завести сервис `backends`, `predicates` или
 * `commands` напрямую (`ctx.provide`/`ctx.set`), минуя вклад. Сообщение —
 * внутренний формат cordis (`service "<имя>" has been registered at <…>`);
 * распознаётся по нему и переводится в именованный отказ ядра. Форма, не
 * подошедшая под этот разбор, возвращается как есть — переводить нечего.
 */
const RESERVED_SERVICE_RE = /^service "([^"]+)" has been registered/;

export function translateReservedNameConflict(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const match = RESERVED_SERVICE_RE.exec(error.message);
  const name = match?.[1];
  if (name === undefined || !KERNEL_RESERVED_NAMES.includes(name)) return error;
  return new StepcastError(`Имя сервиса ${name} занято: оно принадлежит ядру`, {
    hint: `Имена ${KERNEL_RESERVED_NAMES.join(', ')} зарезервированы ядром — заведите сервис под другим именем`,
    cause: error,
  });
}

export function createKernel(): Kernel {
  const ctx = new Context();
  const builtinFiber = ctx.fiber;

  new ContributionService<BackendContribution>(ctx, 'backends', builtinFiber);
  const predicates = new ContributionService<PredicateContribution>(ctx, 'predicates', builtinFiber);
  new ContributionService<CommandContribution>(ctx, 'commands', builtinFiber);

  const plugins: LoadedPlugin[] = [];

  return {
    ctx,
    reservePredicate: (name) => predicates[reserveName](name),
    settle: () => settle(ctx),
    plugins,
    async dispose() {
      await Promise.all(topLevelFibers(ctx).map((fiber) => fiber.dispose()));
    },
    recordPlugin(pluginCtx, meta) {
      pluginCtx.effect(() => {
        plugins.push(meta);
        return () => {
          const index = plugins.indexOf(meta);
          if (index >= 0) plugins.splice(index, 1);
        };
      }, `plugins.record(${meta.name})`);
    },
  };
}
