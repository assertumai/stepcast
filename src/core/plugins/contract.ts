import { z } from 'zod';

import type { ExitCodeValue } from '../errors.js';
import type { BackendAdapter, ModelDiscovery } from '../backend/types.js';
import type { BackendConfig, Config } from '../config/resolve.js';
import type { RawBackend } from '../config/schema.js';
import type { EvaluationInput } from '../expect/evaluate.js';
import type { PredicateResult, Usage } from '../journal/schema.js';
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

/**
 * Эффект решения — закрытый набор движка (design.md изменения
 * `user-decision-steps`, решение 1): судьбу прогона решает движок, а не
 * вклад. `continue` — шаг успешен, прогон идёт дальше; `reject` — прогон
 * останавливается с названной причиной; `restart` — прогон продолжается
 * возобновлением с выбранного человеком шага. Закрытость набора — типом:
 * вклад не в силах придумать четвёртый эффект, даже если попытается.
 */
export type DecisionEffect = 'continue' | 'reject' | 'restart';

/** Один допустимый исход ожидания: эффект из закрытого набора и подпись для витрины. */
export interface DecisionOutcome {
  readonly effect: DecisionEffect;
  readonly label?: string;
}

/**
 * Запрос на ожидание решения человека — параметр `StepKindDecisions.request`.
 * Вклад решения — вида шага `decision` — собирает его из своих полей
 * (`prompt`, `outcomes`, `deadline`, `on_expire`) и не знает ничего сверх.
 */
export interface StepKindDecisionRequest {
  /** Допустимые исходы по имени — тот же перечень, что уйдёт в журнал и в витрину. */
  readonly outcomes: Readonly<Record<string, DecisionOutcome>>;
  /** Вопрос, показываемый человеку. */
  readonly prompt?: string;
  /**
   * Срок ожидания в миллисекундах, считается от начала ожидания (design.md,
   * решение 7) — не от объявления пайплайна. Без срока ожидание бессрочно.
   */
  readonly deadlineMs?: number;
  /** Исход по истечении срока — имя из `outcomes`, обязателен вместе с `deadlineMs`. */
  readonly onExpire?: string;
}

/** Результат применённого решения — то, что вернёт `request()` для эффекта `continue`. */
export interface StepKindDecisionResult {
  readonly outcome: string;
  readonly effect: DecisionEffect;
  /** Кто применил исход: человек либо истёкший срок (design.md, решение 7). */
  readonly by: 'user' | 'deadline';
  readonly reason?: string;
  /** Адрес шага перезапуска — только у эффекта `restart`. */
  readonly restartFrom?: string;
}

/**
 * Способность ожидания решения — во входе исполнителя вида шага с
 * `waits: true` (design.md изменения `user-decision-steps`, решение 1, решение
 * 5). `request` разрешается результатом только для эффекта `continue`: исходы
 * `reject` и `restart` отдаются отказом обещания движка (`DecisionHalt` ниже),
 * который движок узнаёт по типу раньше, чем управление вернётся исполнителю, —
 * защёлку эффекта вклад отменить не в силах, даже поймав и проглотив отказ.
 */
export interface StepKindDecisions {
  request(request: StepKindDecisionRequest): Promise<StepKindDecisionResult>;
}

/**
 * Отказ обещания `decision.request()` для исходов `reject` и `restart` —
 * узнаваемый по типу (`instanceof`), а не по тексту сообщения (design.md
 * изменения `user-decision-steps`, решение 5). Заводится и ловится только
 * внутри движка: автору вида шага конструировать или ловить его не за чем —
 * вклад решения лишь дожидается `request()` и отдаёт её исход как есть.
 */
export class DecisionHalt extends Error {
  readonly result: StepKindDecisionResult;

  constructor(result: StepKindDecisionResult) {
    super(`decision: ${result.effect} (${result.outcome})`);
    this.name = 'DecisionHalt';
    this.result = result;
  }
}

/**
 * Вход исполнителя вида шага (design.md, решение 6): то, чем исполняется
 * попытка, — не модель шага, работы или прогона целиком. Публикация модели
 * движка в контракт сделала бы любую её правку ломающей для плагинов; вклад
 * получает ровно то же по объёму, что получает `BackendAdapter` — описание
 * вызова, а не шаг.
 */
export interface StepKindInput<F = unknown> {
  /** Поля шага под ключом вида — уже проверенные схемой вклада, после позднего раскрытия. */
  readonly fields: F;
  readonly step: { readonly id: string; readonly index: number; readonly timeoutMs: number };
  readonly job: { readonly id: string };
  /** Номер попытки — тот же цикл `runAttempts`, что и у командного шага. */
  readonly attempt: number;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  /** Каталог шага в журнале: файлы попытки исполнитель пишет только сюда. */
  readonly stepDir: string;
  /**
   * Взводится движком по истечении `step.timeoutMs` либо при отмене прогона.
   * Исполнитель, не уважающий сигнал, движок не останавливает: внутри своего
   * процесса убивать нечего (design.md, риски).
   */
  readonly signal: AbortSignal;
  /** Журнал попытки: событие и файл рядом со `stdout.log` попытки. */
  readonly log: StepKindLog;
  /**
   * Контекст ядра процесса, исполняющего прогон, — не демона (design.md,
   * решение 6): им исполнитель достаёт сервис, заведённый своим же плагином.
   */
  readonly ctx: Context;
  /**
   * Способность объявить ожидание решения и дождаться его — только у вида,
   * объявившего `waits: true` (design.md изменения `user-decision-steps`,
   * решение 1). У прочих видов поле отсутствует: движок не даёт способности
   * ожидания тому, кто сам распоряжается своим таймаутом.
   */
  readonly decision?: StepKindDecisions;
}

/** Записать в журнал попытки — событие либо файл рядом с `stdout.log`. */
export interface StepKindLog {
  /** Свободное сообщение в журнал прогона — событие рядом с прочими. */
  note(message: string): void;
  /** Записать файл в каталог попытки, вернув его путь. */
  file(name: string, content: string): string;
}

/** Результат попытки, отданный исполнителем вида шага (design.md, решение 6). */
export interface StepKindOutcome {
  /** Умолчание `0`. Предикат `exit_code` читает его же. */
  readonly exitCode?: number;
  /** Текст результата: пишется в `stdout.log` попытки, питает `matches` и судью. */
  readonly text?: string;
  /** Структурированный выход: проверяется схемой `output` вклада, доступен `${jobs.*.output}`. */
  readonly structured?: unknown;
  /** Расход, если вид шага его несёт, — копится тем же счётчиком, что расход судьи. */
  readonly usage?: Usage;
}

/**
 * Вклад вида шага — публикуемая форма (design.md, решение 1, решение 2).
 * Единственная, которую видит автор плагина: `stepcast/plugin` экспортирует
 * ровно этот тип. Форма полей — JSON Schema, той же причиной, что и у формы
 * значения предиката: у плагина своя версия zod, и модель чужой версии в
 * объединении схем документа даёт неотлаживаемые отказы.
 */
export interface StepKindContribution {
  /** Имя вида — оно же единственный ключ шага в документе (design.md, решение 3). */
  readonly name: string;
  /** Название для витрины и диагностики. */
  readonly title: string;
  /** JSON Schema значения под ключом вида. */
  readonly fields: Readonly<Record<string, unknown>>;
  /** JSON Schema структурированного выхода — движок проверяет ей `outcome.structured`. */
  readonly output?: Readonly<Record<string, unknown>>;
  /**
   * «Сроком распоряжаюсь сам» (design.md изменения `user-decision-steps`,
   * решение 6): движок не гонит исполнителя этого вида против
   * `step.timeoutMs` — иначе тридцатиминутное умолчание таймаута шага убивало
   * бы ожидание решения человека. `step.timeoutMs` при этом остаётся во входе
   * исполнителя справочным значением. Только вклад с этим полем получает во
   * входе способность `StepKindInput.decision`.
   */
  readonly waits?: true;
  /** Статическая проверка полей — то, что видно до первого токена. */
  lint?(fields: unknown, site: LintSite): readonly PluginDiagnostic[];
  /** Исполнить попытку. Исключение — непройденная попытка, а не крушение шага. */
  execute(input: StepKindInput): Promise<StepKindOutcome> | StepKindOutcome;
}

/**
 * Внутренняя форма вклада вида шага — только для встроенных `agent`, `run`,
 * `script` и `uses` (design.md, решение 2). В публикуемой поверхности плагина
 * её нет: у встроенных видов есть типизированная модель и типизированный
 * разбор, а `fields`/`execute` заставили бы их пройти через JSON Schema и
 * общий исполнитель ради симметрии, которой никто не пользуется, — вид,
 * которого автор плагина никогда не напишет своими руками.
 */
export interface BuiltinStepKindDocument {
  /**
   * Узнать шаг этого вида среди уже провалидированных документом: замена
   * дискриминанта размеченного объединения, которого у `RawStep` нет
   * (`pipeline/expand.ts`, `toStep`).
   */
  test(raw: Record<string, unknown>): boolean;
  /** Типизированный разбор — тело прежней ветви `toStep`, перенесённое без изменений в содержании. */
  parse(raw: unknown, ctx: unknown): unknown;
}

/** Встроенный вид шага в реестре: имя, название и внутренняя форма разбора. */
export interface BuiltinStepKind {
  readonly name: string;
  readonly title: string;
  readonly document: BuiltinStepKindDocument;
}

/**
 * Вид шага в реестре — плагинный либо встроенный (design.md, решение 2). Тип
 * внутренний: `stepcast/plugin` публикует только `StepKindContribution` —
 * автор плагина форму `document` не видит и завести её не может.
 */
export type StepKind = StepKindContribution | BuiltinStepKind;

/**
 * Встроенный вид (форма `document`) отличается от плагинного наличием этого
 * поля. Проверяется само содержание поля, а не одно его имя: вклад, случайно
 * назвавший поле `document`, иначе был бы принят за встроенный, и разбор звал
 * бы `document.test` на объекте без такого метода. Декларативному вкладу это
 * имя запрещено схемой (`StepKindContributionSchema`), плагину контекста —
 * ничем: он зовёт `ctx.steps.register` напрямую.
 */
export function isBuiltinStepKind(kind: StepKind): kind is BuiltinStepKind {
  const document = (kind as BuiltinStepKind).document as BuiltinStepKindDocument | undefined;
  return typeof document?.test === 'function' && typeof document.parse === 'function';
}

export interface StepcastPlugin {
  /** Имя плагина: слаг в kebab-case, уникальный среди загруженных. */
  readonly name: string;
  readonly version?: string;
  readonly backends?: Readonly<Record<string, BackendContribution>>;
  readonly predicates?: readonly PredicateContribution[];
  readonly commands?: readonly CommandContribution[];
  readonly steps?: readonly StepKindContribution[];
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

const StepKindContributionSchema = z
  .object({
    name: z.string().regex(SLUG, 'имя вида шага — слаг в kebab-case или snake_case'),
    title: z.string(),
    fields: z.record(z.string(), z.unknown()),
    output: z.record(z.string(), z.unknown()).optional(),
    // Способность ожидания даётся ровно по этому полю, и объявляется оно
    // только значением `true`: `waits: false` — не «как раньше», а попытка
    // объявить несуществующую третью возможность, и отказ обязан назвать её.
    waits: z
      .literal(true, 'вид либо распоряжается сроком сам (waits: true), либо не объявляет waits вовсе')
      .optional(),
    lint: z
      .custom<NonNullable<StepKindContribution['lint']>>((value) => typeof value === 'function', {
        message: 'должна быть функцией',
      })
      .optional(),
    execute: z.custom<StepKindContribution['execute']>((value) => typeof value === 'function', {
      message: 'должна быть функцией',
    }),
    /**
     * Поле внутренней формы встроенного вида (`BuiltinStepKindDocument`): по
     * его наличию `isBuiltinStepKind` отличает встроенный вид от плагинного.
     * Плагинный вклад, случайно несущий это имя, был бы принят за встроенный,
     * и разбор позвал бы `document.test` на объекте без него. Объект здесь
     * `.loose()` — остальные лишние поля вклада безобидны, — поэтому запрет
     * именной: он один и нужен.
     */
    document: z
      .undefined('поле document принадлежит внутренней форме встроенного вида шага и вкладу недоступно')
      .optional(),
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
    steps: z.array(StepKindContributionSchema).optional(),
  })
  .loose();
