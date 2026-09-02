import { StepcastError } from '../errors.js';
import type {
  BackendContribution,
  CommandContribution,
  LoadedPlugin,
  PredicateContribution,
  StepcastPlugin,
} from './contract.js';

/**
 * Реестр вкладов: то, чем движок расширяется.
 *
 * Собирается один раз на вызов команды — из встроенных вкладов и вкладов
 * загруженных плагинов — и передаётся туда, где раньше стоял закрытый
 * перечень: разбор документа, линт, вычисление предикатов, подбор адаптера,
 * диспетчеризация команд.
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
   * Часть контракта, а не внутренность: отчёт `stepcast config` и слой
   * умолчаний обязаны называть автора вклада, а не выводить его догадкой.
   */
  readonly owners: ReadonlyMap<string, string>;
}

interface MutableRegistry {
  /** Та же карта, что в `Registry`, но изменяемая на время сборки. */
  readonly backends: Map<string, BackendContribution>;
  readonly predicates: Map<string, PredicateContribution>;
  readonly commands: Map<string, CommandContribution>;
  readonly builtinPredicates: readonly string[];
  readonly plugins: LoadedPlugin[];
  /** Кто внёс вклад с этим именем: «встроенный» либо имя плагина. */
  readonly owners: Map<string, string>;
}

/** Названия видов вкладов в родительном падеже: «Имя команды run занято». */
const KIND_NAMES = {
  backends: 'бэкенда',
  predicates: 'предиката',
  commands: 'команды',
} as const;

type ContributionKind = keyof typeof KIND_NAMES;

const BUILTIN_OWNER = 'встроенный';

function ownerKey(kind: ContributionKind, name: string): string {
  return `${kind}:${name}`;
}

function claim(target: MutableRegistry, kind: ContributionKind, name: string, owner: string): void {
  const key = ownerKey(kind, name);
  const existing = target.owners.get(key);
  if (existing !== undefined) {
    // Тихая подмена `claude` или `exit_code` сделала бы лжецом и `stepcast
    // config`, и журнал прогона: и тот и другой называют имя, а не источник.
    throw new StepcastError(
      `Имя ${KIND_NAMES[kind]} ${name} занято: его объявляют ${describeOwner(existing)} и ${describeOwner(owner)}`,
      {
        hint: 'Переопределение вклада не предусмотрено: снимите один из плагинов либо попросите автора переименовать вклад',
      },
    );
  }
  target.owners.set(key, owner);
}

function describeOwner(owner: string): string {
  return owner === BUILTIN_OWNER ? 'встроенный вклад' : `плагин ${owner}`;
}

/** Пустой изменяемый реестр: основа и для встроенного, и для тестов. */
function emptyRegistry(builtinPredicates: readonly string[]): MutableRegistry {
  return {
    backends: new Map(),
    predicates: new Map(),
    commands: new Map(),
    builtinPredicates,
    plugins: [],
    owners: new Map(),
  };
}

/**
 * Добавить вклады плагина в реестр. Конфликт имён — отказ, называющий вид
 * вклада, имя и обоих претендентов: разобраться, чей вклад победил, по одному
 * лишь имени потом невозможно.
 */
export function addPlugin(target: Registry, plugin: StepcastPlugin, source: string): Registry {
  const mutable = target as unknown as MutableRegistry;

  for (const [name, contribution] of Object.entries(plugin.backends ?? {})) {
    claim(mutable, 'backends', name, plugin.name);
    mutable.backends.set(name, contribution);
  }
  for (const contribution of plugin.predicates ?? []) {
    claim(mutable, 'predicates', contribution.name, plugin.name);
    mutable.predicates.set(contribution.name, contribution);
  }
  for (const contribution of plugin.commands ?? []) {
    claim(mutable, 'commands', contribution.name, plugin.name);
    mutable.commands.set(contribution.name, contribution);
  }

  mutable.plugins.push({
    name: plugin.name,
    ...(plugin.version === undefined ? {} : { version: plugin.version }),
    source,
  });
  return target;
}

/** Реестр из одних встроенных вкладов. Заводится заново на каждый вызов. */
export function createRegistry(
  builtin: StepcastPlugin,
  builtinPredicates: readonly string[] = [],
): Registry {
  const registry = emptyRegistry(builtinPredicates);
  // Имена встроенных предикатов заняты, хотя вкладов у них нет: плагин,
  // объявивший `exit_code`, обязан получить тот же отказ, что и плагин,
  // объявивший бэкенд `claude`.
  for (const name of builtinPredicates) claim(registry, 'predicates', name, BUILTIN_OWNER);
  for (const [name, contribution] of Object.entries(builtin.backends ?? {})) {
    claim(registry, 'backends', name, BUILTIN_OWNER);
    registry.backends.set(name, contribution);
  }
  for (const contribution of builtin.predicates ?? []) {
    claim(registry, 'predicates', contribution.name, BUILTIN_OWNER);
    registry.predicates.set(contribution.name, contribution);
  }
  for (const contribution of builtin.commands ?? []) {
    claim(registry, 'commands', contribution.name, BUILTIN_OWNER);
    registry.commands.set(contribution.name, contribution);
  }
  return registry as Registry;
}

/** Кто внёс вклад этого вида с этим именем: имя плагина либо «встроенный». */
export function contributionOwner(
  registry: Registry,
  kind: ContributionKind,
  name: string,
): string | undefined {
  return registry.owners.get(ownerKey(kind, name));
}

/** Имя владельца встроенных вкладов — им помечено всё, что даёт сам движок. */
export { BUILTIN_OWNER };

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
