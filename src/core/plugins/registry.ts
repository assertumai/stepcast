import { hasPredicateEvaluator, hasStepExecutor, isNativePredicate, isNativeStepKind, type BackendContribution, type CommandContribution, type LoadedPlugin, type PredicateContribution, type PredicateKind, type StepKind, type StepKindContribution } from './contract.js';
import { BUILTIN_OWNER, type Kernel } from './kernel.js';

/**
 * Реестр вкладов: то, чем движок расширяется.
 *
 * Больше не снимок, собранный один раз на вызов команды из встроенных вкладов
 * и вкладов загруженных плагинов, — вид над контекстом ядра (`kernel.ts`).
 * Каждое поле читает контекст заново при обращении: снятие области плагина
 * видно здесь немедленно, без пересборки реестра. Для CLI разницы нет — за
 * время команды ничего не снимается, — для демона это и есть желаемое
 * поведение.
 *
 * Встроенное описано тем же контрактом, что и плагинное, не для красоты: это
 * единственный способ проверить, что контракта достаточно. Если через него
 * нельзя выразить `claude`, через него нельзя выразить и второй бэкенд.
 */
export interface Registry {
  readonly backends: ReadonlyMap<string, BackendContribution>;
  /**
   * Предикаты — встроенные и плагинные вместе, тем же вкладом в сервис
   * `predicates` (`builtin-predicates-as-row`, design.md, решение 1, решение
   * 2): встроенные — настоящие вклады, внесённые строкой встроенного слоя, а
   * не резерв без содержания, и у них есть внутренняя форма `native`, которую
   * отличает `isNativePredicate`.
   */
  readonly predicates: ReadonlyMap<string, PredicateKind>;
  readonly commands: ReadonlyMap<string, CommandContribution>;
  /**
   * Виды шага — встроенные (`agent`, `run`, `script`, `uses`) и плагинные
   * вместе, тем же вкладом в сервис `steps` (design.md, решение 1, решение 2).
   * Встроенные виды — настоящие вклады, а не резерв без содержания: у них
   * есть внутренняя форма `native`, которую отличает `isNativeStepKind`.
   */
  readonly steps: ReadonlyMap<string, StepKind>;
  /** Загруженные плагины в порядке загрузки. Пустой список — только встроенное. */
  readonly plugins: readonly LoadedPlugin[];
  /**
   * Кто внёс вклад: ключ «вид:имя», значение — имя плагина либо «встроенный».
   * Выводится из области, зарегистрировавшей имя, а не ведётся отдельной
   * картой (design.md, Решение 5).
   */
  readonly owners: ReadonlyMap<string, string>;
}

type ContributionKind = 'backends' | 'predicates' | 'commands' | 'steps';

const KINDS: readonly ContributionKind[] = ['backends', 'predicates', 'commands', 'steps'];

/**
 * Ядро, из которого выведен реестр, — на случай, если код вне `Registry`
 * (например, `CommandEnv.ctx`) должен добраться до контекста, не расширяя
 * публичный интерфейс чтения самого `Registry` полем, которого у него
 * никогда не было.
 */
const kernels = new WeakMap<Registry, Kernel>();

/** Реестр как вид поверх ядра — то, что раньше строил `createRegistry`/`addPlugin`. */
export function registryFromKernel(kernel: Kernel): Registry {
  const { ctx } = kernel;
  const registry: Registry = {
    get backends() {
      return ctx.backends.contributions;
    },
    get predicates() {
      return ctx.predicates.contributions;
    },
    get commands() {
      return ctx.commands.contributions;
    },
    get steps() {
      return ctx.steps.contributions;
    },
    get plugins() {
      return kernel.plugins;
    },
    get owners() {
      const out = new Map<string, string>();
      for (const kind of KINDS) {
        const service = ctx[kind];
        for (const name of service.contributions.keys()) {
          const owner = service.owner(name);
          if (owner !== undefined) out.set(`${kind}:${name}`, owner);
        }
      }
      return out;
    },
  };
  kernels.set(registry, kernel);
  return registry;
}

/** Ядро, породившее реестр, — для `CommandEnv.ctx` и подобного (см. `kernels` выше). */
export function kernelFromRegistry(registry: Registry): Kernel {
  const kernel = kernels.get(registry);
  if (kernel === undefined) {
    throw new Error('Registry не связан с ядром: он не был построен registryFromKernel');
  }
  return kernel;
}

/** Имя владельца встроенных вкладов — им помечено всё, что даёт сам движок. */
export { BUILTIN_OWNER };

/** Кто внёс вклад этого вида с этим именем: имя плагина либо «встроенный». */
export function contributionOwner(registry: Registry, kind: ContributionKind, name: string): string | undefined {
  return registry.owners.get(`${kind}:${name}`);
}

/** Имена вкладов вида, отсортированные, — для перечня в диагностике. */
export function availableNames(registry: Registry, kind: ContributionKind): string[] {
  return [...registry[kind].keys()].sort();
}

/**
 * Все имена предикатов, которые примет разбор документа: встроенные и
 * плагинные вместе, одним списком, без деления по происхождению
 * (`builtin-predicates-as-row`, design.md, решение 1) — оба уже вклады
 * одного сервиса `predicates`, второго перечня не нужно.
 */
export function predicateNames(registry: Registry): string[] {
  return [...registry.predicates.keys()].sort();
}

/**
 * Все имена видов шага — встроенных и плагинных вместе, отсортированные.
 */
export function stepKindNames(registry: Registry): string[] {
  return [...registry.steps.keys()].sort();
}

/**
 * Имена предикатов внутренней формы `native` действующего реестра, в порядке
 * регистрации (`builtin-predicates-as-row`, design.md, Решение 4; тот же
 * приём, что и `nativeStepKindNames`): подаются `buildDocumentSchemas`/
 * `buildPublishedSchemas` четвёртым параметром — ветвь схемы документа
 * собирается только по предикатам, которых состав не снял. Порядок — порядок
 * вставки `Map`, то есть порядок регистрации строки встроенных предикатов
 * (`src/parts/expect/row.ts`).
 */
export function nativePredicateNames(registry: Registry): string[] {
  return [...registry.predicates.entries()].filter(([, kind]) => isNativePredicate(kind)).map(([name]) => name);
}

/**
 * Имена плагинных предикатов — вкладов с вычислителем, без встроенных
 * (`builtin-predicates-as-row`, design.md, решение 4): подаются
 * `buildDocumentSchemas` первым параметром — ветвь их ключа в схеме
 * документа собирается сверх ветвей внутренней формы, а не вместо них.
 */
export function pluginPredicateNames(registry: Registry): string[] {
  return [...registry.predicates.entries()]
    .filter((entry): entry is [string, PredicateContribution] => hasPredicateEvaluator(entry[1]))
    .map(([name]) => name);
}

/** Дескриптор вида шага, приносящего свою ветвь схемы документа: имя и занятые им ключи. */
export interface PluginStepKindDescriptor {
  readonly name: string;
  readonly keys: readonly string[];
}

/**
 * Плагин, вместе с которым снято имя вида шага, — пока живо ядро, помнящее
 * прежнего владельца (`ContributionService.formerOwner`). `undefined`, если
 * имя занято сейчас, если ядро такого имени не знало вовсе или если реестр
 * построен не поверх ядра: отказ, называющий вид шага, обязан работать и там,
 * где памяти нет, — просто без имени плагина.
 */
export function formerStepKindOwner(registry: Registry, name: string): string | undefined {
  return kernels.get(registry)?.ctx.steps.formerOwner(name);
}

/**
 * Имена видов внутренней формы `native` действующего реестра, в порядке
 * регистрации (`builtin-step-kinds-as-rows`, design.md, Решение 4): подаются
 * `buildDocumentSchemas`/`buildPublishedSchemas` третьим параметром — ветвь
 * схемы документа собирается только по видам, которых состав не снял.
 * Порядок — порядок вставки `Map`, то есть порядок применения строк
 * (`src/parts/rows.ts`), а не алфавитный, в отличие от `stepKindNames`: он же
 * порядок узнавания шага, и подавать его нужно как есть.
 */
export function nativeStepKindNames(registry: Registry): string[] {
  return [...registry.steps.entries()].filter(([, kind]) => isNativeStepKind(kind)).map(([name]) => name);
}

/**
 * Виды шага, приносящие свою ветвь схемы документа, — их занятые ключи, без
 * вопроса о происхождении (design.md изменения `step-kind-document-contract`,
 * Решение 4): вид собирается из объявленного, будь он внесён плагином или
 * встроенной строкой дерева (`decision`).
 */
export function pluginStepKindDescriptors(registry: Registry): PluginStepKindDescriptor[] {
  return [...registry.steps.entries()]
    .filter((entry): entry is [string, StepKindContribution] => hasStepExecutor(entry[1]))
    .map(([name, kind]) => ({ name, keys: kind.document?.keys ?? [name] }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
