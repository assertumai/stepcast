import type { BackendContribution, CommandContribution, LoadedPlugin, PredicateContribution } from './contract.js';
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
  readonly predicates: ReadonlyMap<string, PredicateContribution>;
  readonly commands: ReadonlyMap<string, CommandContribution>;
  /**
   * Имена встроенных предикатов. Вкладов у них нет (см. `builtin.ts`), но имя
   * занято: предикат плагина под знакомым именем — та же подмена, что и
   * бэкенд `claude` от плагина.
   */
  readonly builtinPredicates: readonly string[];
  /** Загруженные плагины в порядке загрузки. Пустой список — только встроенное. */
  readonly plugins: readonly LoadedPlugin[];
  /**
   * Кто внёс вклад: ключ «вид:имя», значение — имя плагина либо «встроенный».
   * Выводится из области, зарегистрировавшей имя, а не ведётся отдельной
   * картой (design.md, Решение 5).
   */
  readonly owners: ReadonlyMap<string, string>;
}

type ContributionKind = 'backends' | 'predicates' | 'commands';

const KINDS: readonly ContributionKind[] = ['backends', 'predicates', 'commands'];

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
    get builtinPredicates() {
      return ctx.predicates.reserved;
    },
    get plugins() {
      return kernel.plugins;
    },
    get owners() {
      const out = new Map<string, string>();
      for (const kind of KINDS) {
        const service = ctx[kind];
        for (const name of [...service.contributions.keys(), ...service.reserved]) {
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
 * плагинные вместе. Перечень доступного в диагностике обязан называть оба —
 * пользователь не обязан знать, что из этого чем предоставлено.
 */
export function predicateNames(registry: Registry): string[] {
  return [...registry.builtinPredicates, ...registry.predicates.keys()].sort();
}
