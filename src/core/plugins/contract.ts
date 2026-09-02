import { z } from 'zod';

import type { ExitCodeValue } from '../errors.js';
import type { BackendAdapter } from '../backend/types.js';
import type { BackendConfig, Config } from '../config/resolve.js';
import type { RawBackend } from '../config/schema.js';
import type { EvaluationInput } from '../expect/evaluate.js';
import type { PredicateResult } from '../journal/schema.js';
import type { CliIo, CommandSpec, ParsedArgs } from './cli-types.js';
// Ссылка на реестр — только типом: в рантайме импорт стирается, и круга
// между контрактом и реестром не возникает.
import type { Registry } from './registry.js';

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

const SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

const BackendContributionSchema = z
  .object({
    create: z.custom<BackendContribution['create']>((value) => typeof value === 'function', {
      message: 'должна быть функцией',
    }),
    defaults: z.record(z.string(), z.unknown()).optional(),
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
