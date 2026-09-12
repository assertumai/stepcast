import { Context, Service, type Fiber } from 'cordis';

import { StepcastError } from '../errors.js';
import { BUILTIN_STEP_KIND_KEY_OWNERS, STEP_COMMON_KEYS } from '../pipeline/schema.js';
import type { Context as PluginContext, ContributionRegistrar } from './context.js';
import type {
  BackendContribution,
  CommandContribution,
  LoadedPlugin,
  PredicateContribution,
  StepKind,
} from './contract.js';
import { settle, topLevelFibers, unresolvedFibers, type UnresolvedFiber } from './fibers.js';

export { unresolvedFibers, type UnresolvedFiber };

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
 *
 * Успокоение контекста и поиск зависших областей (`settle`, `unresolvedFibers`)
 * живут в `./fibers.js` — модуле без зависимостей, общем с браузерным ядром
 * витрины (design.md `cordis-kernel-browser`, Решение 6); здесь только
 * реэкспорт и использование.
 */

/** Имена служебных сервисов ядра. Плагину заводить сервис с этим именем нельзя. */
export const KERNEL_RESERVED_NAMES: readonly string[] = ['backends', 'predicates', 'commands', 'steps'];

/** Владелец встроенного вклада в тексте отказа — не имя строки, а признак области ядра. */
export const BUILTIN_OWNER = 'встроенный';

const KIND_NAMES = {
  backends: 'бэкенда',
  predicates: 'предиката',
  commands: 'команды',
  steps: 'вида шага',
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
  /**
   * Владелец имени, снятого вместе с областью, — на время жизни этого ядра
   * (design.md, решение 8). Заведена ровно ради одного сообщения: пайплайн,
   * раскрывавшийся минуту назад, обязан отказать не «неизвестный вид http», а
   * «вид шага http снят вместе с плагином http-steps». Новый процесс (плагин
   * убран из конфигурации между запусками) об этом не помнит вовсе — карта
   * живёт в памяти этого объекта и не сериализуется никуда.
   */
  private readonly formerOwners = new Map<string, string>();

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

  /**
   * Кто в последний раз нёс это имя, если сейчас оно свободно, — только для
   * текста отказа (см. `formerOwners` выше). Занятое имя не имеет «прежнего»:
   * возвращается `undefined`, чтобы не путать действующего владельца с ушедшим.
   */
  formerOwner(name: string): string | undefined {
    return this.owner(name) === undefined ? this.formerOwners.get(name) : undefined;
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

    // Запрет на имя вида шага, пересекающееся с ключом документа (design.md,
    // решение 3), касается только плагина: встроенные виды регистрируют себя
    // на корневой области ровно под этими же именами (`run`, `script`, …), и
    // это не конфликт, а определение.
    if (this.kind === 'steps' && owner !== BUILTIN_OWNER) {
      assertStepKindNameAvailable(name);
    }

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
        this.formerOwners.set(name, owner);
      };
    }, `${this.kind}.register(${name})`);
  }
}

/**
 * Отказ регистрации вида шага плагином на имени, занятом ключом документа
 * (design.md, решение 3): ключом общей части шага либо ключом встроенного
 * вида. Проверка — при регистрации, а не при первом разборе документа: имя
 * `expect` не должно дожить до первого пайплайна, который его использует.
 */
function assertStepKindNameAvailable(name: string): void {
  if (STEP_COMMON_KEYS.includes(name)) {
    throw new StepcastError(`Имя вида шага ${name} занято ключом общей части шага`, {
      hint: 'Ключи общей части (id, env, context, timeout, expect, attempts, …) не могут стать именем вида шага',
    });
  }
  const owningKinds = BUILTIN_STEP_KIND_KEY_OWNERS[name];
  if (owningKinds !== undefined) {
    throw new StepcastError(
      `Имя вида шага ${name} занято ключом встроенного вида шага ${owningKinds.join(', ')}`,
      { hint: 'Выберите другое имя: ключи встроенных видов не могут стать именем плагинного вида шага' },
    );
  }
}

declare module 'cordis' {
  interface Context {
    backends: ContributionService<BackendContribution>;
    predicates: ContributionService<PredicateContribution>;
    commands: ContributionService<CommandContribution>;
    steps: ContributionService<StepKind>;
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
  new ContributionService<StepKind>(ctx, 'steps', builtinFiber);

  const plugins: LoadedPlugin[] = [];
  /** Запись, сделанная областью: нужна `forgetPlugin` — см. её объяснение. */
  const recorded = new WeakMap<Fiber, LoadedPlugin>();

  const forget = (meta: LoadedPlugin): void => {
    const index = plugins.indexOf(meta);
    if (index >= 0) plugins.splice(index, 1);
  };

  return {
    ctx,
    reservePredicate: (name) => predicates[reserveName](name),
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
  };
}
