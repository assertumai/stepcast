import { z } from 'zod';

import type { ExitCodeValue } from '../errors.js';
import type { BackendAdapter, ModelDiscovery } from '../backend/types.js';
import type { BackendConfig, Config } from '../config/resolve.js';
import type { RawBackend } from '../config/schema.js';
import type { EvaluationInput } from '../expect/evaluate.js';
import type { PredicateResult } from '../journal/schema.js';
import type { CliIo, CommandSpec, ParsedArgs } from './cli-types.js';
// Ссылки на реестр и контекст — только типом: в рантайме импорт стирается, и
// круга между контрактом, реестром и контекстом не возникает. Контекст берётся
// из `context.js`, а не из ядра: публикуемая поверхность плагина не должна
// тянуть за собой ни `cordis`, ни его типы (см. `context.ts`).
import type { RowOutcome } from './load.js';
import type { Registry } from './registry.js';
import type { Context, Inject } from './context.js';
import type { TreeRow } from './tree.js';

/**
 * Контракт плагина.
 *
 * Плагин ничего не вызывает у движка при загрузке — он экспортирует описание
 * своих вкладов, а движок его читает. Так конфликт имён и валидность формы
 * проверяются целиком до того, как исполнится хоть одна строка плагина сверх
 * импорта, и результат не зависит от порядка загрузки.
 *
 * Плагин — код с правами процесса движка. Песочницы нет и не обещано: список
 * `plugins` лежит в конфигурации репозитория и попадает в ревью там же, где
 * `project.check`.
 */

/** Вклад бэкенда: фабрика адаптера и умолчания его записи в конфигурации. */
export interface BackendContribution {
  /**
   * Собрать адаптер по действующей записи `backends.<имя>`. Здесь и только
   * здесь живут флаги конкретного CLI — контракт `BackendAdapter` этого
   * требует и от встроенного `claude`, и от плагинного.
   */
  create(config: BackendConfig): BackendAdapter;
  /**
   * Умолчания записи `backends.<имя>`: слой между встроенными значениями и
   * глобальным конфигом. Без них каждый пользователь плагина переписывал бы
   * `sessions`/`structured_output` из его README себе в конфигурацию.
   */
  readonly defaults?: Partial<RawBackend>;
  /**
   * Перечисление моделей CLI: проба и разбор её вывода (`docs/plugins.md`).
   *
   * Необязательно — в отличие от `sessionIdSource` и `mcp` в
   * `BackendCapabilities`, где молчание запрещено намеренно. Там отсутствие
   * поля было бы тихой деградацией исполнения: движок повёл бы шаг иначе, чем
   * думал автор адаптера, и заметить это было бы негде. Здесь отсутствие поля
   * не меняет ни одного прогона — оно даёт странице «Агенты» честную фразу
   * «этот агент перечислять модели не умеет» вместо списка (design.md,
   * решение 3).
   */
  readonly models?: ModelDiscovery;
}

/** Где объявлен предикат: адрес для диагностики статической проверки. */
export interface LintSite {
  /** Файл, в котором объявлен предикат. */
  readonly file: string;
  /** Путь внутри документа, например `jobs.build.steps.0.expect.1`. */
  readonly at: string;
  /** Каталог, относительно которого разрешаются пути значения. */
  readonly cwd: string;
}

/** Диагностика, которую вправе вернуть статическая проверка плагина. */
export interface PluginDiagnostic {
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly hint?: string;
}

/** Вклад предиката: новый ключ в `expect` и `until.check`. */
export interface PredicateContribution {
  /** Ключ предиката в документе. Слаг в kebab-case или snake_case. */
  readonly name: string;
  /**
   * Форма значения — JSON Schema, а не zod-модель: у плагина своя версия
   * zod, и модель чужой версии в объединении схем документа даёт
   * неотлаживаемые отказы. Схема — данные, и `ajv` уже зависимость движка.
   */
  readonly schema: Readonly<Record<string, unknown>>;
  /**
   * Жёсткий предикат отклоняет попытку и отменяет вызов судьи. По умолчанию
   * `true`: предикат, заведённый ради проверки, обычно и есть гейт.
   */
  readonly hard?: boolean;
  /**
   * Вычислить предикат. Промис допустим: проверка, обращающаяся к внешней
   * системе, иначе невозможна.
   */
  evaluate(value: unknown, input: EvaluationInput): PredicateResult | Promise<PredicateResult>;
  /** Статическая проверка значения — то, что видно до первого токена. */
  lint?(value: unknown, site: LintSite): readonly PluginDiagnostic[];
}

/** Окружение команды: то, что движок уже разрешил к моменту её вызова. */
export interface CommandEnv {
  readonly cwd: string;
  readonly config: Config;
  /**
   * Действующий реестр вкладов. Команде он нужен для того же, для чего
   * движку: раскрыть документ с плагинными предикатами, разрешить адаптер,
   * назвать доступное в своей справке.
   */
  readonly registry: Registry;
  /**
   * Контекст ядра. Команда плагина достаёт через него сервис, заведённый этим
   * же плагином, — реестр отдаёт только три служебных сервиса, а свой сервис
   * плагина в нём не виден (design.md, Решение 12).
   */
  readonly ctx: Context;
  /**
   * Итоговое дерево плагинов того же разрешения конфигурации, которым собран
   * `registry` (`plugin-tree`). Команде осмотра (`stepcast plugins`) оно нужно
   * целиком — со слоями, порядком и отключёнными строками, которых в реестре
   * нет вовсе, — и брать его вторым чтением слоёв нельзя: правка патча между
   * двумя чтениями развела бы напечатанное дерево с загруженным составом.
   */
  readonly pluginTree: readonly TreeRow[];
  /**
   * Итог применения каждой строки дерева (`RowOutcome`, `user-plugins`,
   * design.md Решение 10) — тот же состав, что уже собрала загрузка.
   * `undefined`, если реестр пришёл готовым, а не собран `loadPlugins` на этом
   * вызове (`resolveWithPlugins`, вариант с кешированным реестром) — на пути
   * CLI такого не бывает, но поле остаётся честным для прочих вызывающих.
   */
  readonly pluginOutcomes: readonly RowOutcome[] | undefined;
}

/** Вклад команды: новая подкоманда `stepcast <имя>`. */
export interface CommandContribution {
  readonly name: string;
  /** Описание позиционных аргументов и флагов — то же, что у встроенных. */
  readonly spec: CommandSpec;
  run(args: ParsedArgs, io: CliIo, env: CommandEnv): Promise<ExitCodeValue> | ExitCodeValue;
}

export interface StepcastPlugin {
  /** Имя плагина: слаг в kebab-case, уникальный среди загруженных. */
  readonly name: string;
  readonly version?: string;
  readonly backends?: Readonly<Record<string, BackendContribution>>;
  readonly predicates?: readonly PredicateContribution[];
  readonly commands?: readonly CommandContribution[];
}

/** Загруженный плагин: то, что движок пишет в манифест прогона и в отчёт. */
export interface LoadedPlugin {
  readonly name: string;
  readonly version?: string;
  /** Разрешённый путь модуля — по нему прогон воспроизводят. */
  readonly source: string;
}

/**
 * Вторая форма плагина: функция над контекстом либо объект с `apply` — то,
 * что не умеет декларативная форма: завести сервис с именем, которого ядро не
 * знает, и объявить зависимость от чужого через `inject` (design.md,
 * Решение 7). Имя обязано быть известно до применения: им подписан
 * `LoadedPlugin` и им же называет себя отказ о занятом имени ядра —
 * `Plugin.Base.name` объекта либо `Function.name` функции. Безымянная функция
 * именем не располагает: у `export default function (ctx) {…}` `Function.name`
 * равен `default`, и загрузчик отказывает такому плагину (`load.ts`).
 */
export interface ContextPluginObject {
  readonly name?: string;
  readonly version?: string;
  readonly inject?: Inject;
  apply(ctx: Context, config?: unknown): unknown;
}

export type ContextPluginFunction = ((ctx: Context, config?: unknown) => unknown) & {
  readonly name?: string;
  readonly version?: string;
  readonly inject?: Inject;
};

export type ContextPlugin = ContextPluginFunction | ContextPluginObject;

/** Плагин контекста опознаётся по форме экспорта: функция либо объект с `apply`. */
export function isContextPlugin(value: unknown): value is ContextPlugin {
  if (typeof value === 'function') return true;
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { apply?: unknown }).apply === 'function'
  );
}

const SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

const ModelDiscoverySchema = z
  .object({
    probe: z.custom<ModelDiscovery['probe']>((value) => typeof value === 'function', {
      message: 'должна быть функцией',
    }),
    parse: z.custom<ModelDiscovery['parse']>((value) => typeof value === 'function', {
      message: 'должна быть функцией',
    }),
  })
  .loose();

const BackendContributionSchema = z
  .object({
    create: z.custom<BackendContribution['create']>((value) => typeof value === 'function', {
      message: 'должна быть функцией',
    }),
    defaults: z.record(z.string(), z.unknown()).optional(),
    models: ModelDiscoverySchema.optional(),
  })
  .loose();

const PredicateContributionSchema = z
  .object({
    name: z.string().regex(SLUG, 'имя предиката — слаг в kebab-case или snake_case'),
    schema: z.record(z.string(), z.unknown()),
    hard: z.boolean().optional(),
    evaluate: z.custom<PredicateContribution['evaluate']>((value) => typeof value === 'function', {
      message: 'должна быть функцией',
    }),
    lint: z
      .custom<NonNullable<PredicateContribution['lint']>>((value) => typeof value === 'function', {
        message: 'должна быть функцией',
      })
      .optional(),
  })
  .loose();

const CommandContributionSchema = z
  .object({
    name: z.string().regex(SLUG, 'имя команды — слаг в kebab-case'),
    spec: z.object({ description: z.string() }).loose(),
    run: z.custom<CommandContribution['run']>((value) => typeof value === 'function', {
      message: 'должна быть функцией',
    }),
  })
  .loose();

/**
 * Форма объекта, экспортируемого модулем плагина по умолчанию. Проверяется
 * при загрузке: неверная форма обязана назвать поле, а не проявиться
 * исключением посреди прогона.
 */
export const StepcastPluginSchema = z
  .object({
    name: z.string().regex(SLUG, 'имя плагина — слаг в kebab-case'),
    version: z.string().optional(),
    backends: z.record(z.string(), BackendContributionSchema).optional(),
    predicates: z.array(PredicateContributionSchema).optional(),
    commands: z.array(CommandContributionSchema).optional(),
  })
  .loose();
