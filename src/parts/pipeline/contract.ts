import { z } from 'zod';

import type { BackendAdapter, ModelDiscovery } from './backend/types.js';
import type { BackendConfig, Config } from './config/resolve.js';
import type { RawBackend } from './config/schema.js';
import type { EvaluationInput } from './expect/evaluate.js';
import type { PredicateResult, Usage } from './run/journal/schema.js';
import {
  CommandContributionSchema,
  SLUG,
  type CommandEnv,
  type PluginDiagnostic,
  type StepcastPlugin,
} from '../../kernel/contract.js';
import type { Context, ContributionRegistrar } from '../../kernel/context.js';
import type { Registry } from '../../kernel/registry.js';

/**
 * Контракт плагина — доменная половина (`plugin-surface-split`, design.md,
 * Решение 3): объявления, которые называют пайплайн — шаг, работу, прогон,
 * попытку, предикат, бэкенд, журнал или конфигурацию движка. Публикуются
 * подпутём `stepcast/pipeline` (`src/parts/pipeline/surface.ts`), чей модуль
 * принадлежит строке `pipeline` — той, что заводит служебные сервисы
 * `backends`/`predicates`/`steps`.
 *
 * Модуль лежит рядом с ядром (`contract.ts`), а не в `src/parts/pipeline/`, —
 * временно, и причина ровно одна и она механическая: доменные типы вклада
 * читают `registry.ts` и `load.ts` (таблица декларативной формы и её схема
 * загрузки), а ядру импортировать `src/parts/**` запрещено линтом — этим
 * запретом закрыт откат шага 2 (`kernel-domain-free-imports`). Соседний модуль
 * того же каталога под запрет не подпадает: он импортируется относительным
 * путём без сегмента `pipeline/`. Переезд в `src/parts/pipeline/` — шаг 10
 * плана (`docs/microkernel-target.md`), вместе с `registry.ts` и таблицей
 * декларативной формы.
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
 * Форма записи вклада в документе (design.md, Решение 1) — вторая, полная
 * форма объявления, рядом с одноключевой `fields`. Даёт вкладу то, что
 * движок сегодня выводит из имени и не позволяет переопределить: узнавание
 * шага (`test`), перечень занятых ключей документа (`keys`), форму записи
 * (`schema`) и разбор сырого шага в поля (`parse`).
 *
 * `fields` контракта остаётся обязательной и при объявленном `document`: она
 * описывает вход `execute`, а не запись документа, — и именно её движок
 * проверяет второй раз, по окончательным значениям, перед попыткой
 * (`exec/pluginStep.ts`). `parse` — превращение одной формы в другую.
 */
export interface StepKindDocumentForm {
  /** Узнать свой шаг среди сырых — замена «ключ равен имени вида». */
  test(raw: Readonly<Record<string, unknown>>): boolean;
  /** Ключи документа, которые вид занимает помимо общей части шага. */
  readonly keys: readonly string[];
  /** JSON Schema шага в этой форме — без ключей общей части. */
  readonly schema: Readonly<Record<string, unknown>>;
  /** Разобрать сырой шаг (уже после раскрытия подстановок) в поля вклада — вход `execute`. */
  parse(raw: Readonly<Record<string, unknown>>): unknown;
}

/**
 * Вклад вида шага — публикуемая форма (design.md, решение 1, решение 2).
 * Единственная, которую видит автор плагина: `stepcast/pipeline` экспортирует
 * ровно этот тип. Форма полей — JSON Schema, той же причиной, что и у формы
 * значения предиката: у плагина своя версия zod, и модель чужой версии в
 * объединении схем документа даёт неотлаживаемые отказы.
 */
export interface StepKindContribution {
  /** Имя вида — оно же единственный ключ шага в документе, если вклад не объявил `document` (design.md, решение 3). */
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
  /**
   * Собственная форма записи в документе (design.md, Решение 1) — необязательна:
   * вклад без неё узнаётся ключом-именем, и движок сам синтезирует ту же
   * четвёрку из имени и `fields` (`pipeline/expand.ts`).
   */
  readonly document?: StepKindDocumentForm;
  /** Статическая проверка полей — то, что видно до первого токена. */
  lint?(fields: unknown, site: LintSite): readonly PluginDiagnostic[];
  /** Исполнить попытку. Исключение — непройденная попытка, а не крушение шага. */
  execute(input: StepKindInput): Promise<StepKindOutcome> | StepKindOutcome;
}

/**
 * Внутренняя форма вклада вида шага — только для встроенных `agent`, `run`,
 * `script` и `uses` (design.md, решение 2, решение 4). В публикуемой
 * поверхности плагина её нет: у встроенных видов есть типизированная модель и
 * типизированный разбор, а `fields`/`execute` заставили бы их пройти через
 * JSON Schema и общий исполнитель ради симметрии, которой никто не
 * пользуется, — вид, которого автор плагина никогда не напишет своими руками.
 */
export interface NativeStepKindForm {
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
export interface NativeStepKind {
  readonly name: string;
  readonly title: string;
  readonly native: NativeStepKindForm;
}

/**
 * Вид шага в реестре — плагинный либо встроенный (design.md, решение 2). Тип
 * внутренний: `stepcast/pipeline` публикует только `StepKindContribution` —
 * автор плагина внутреннюю форму `native` не видит и завести её не может.
 */
export type StepKind = StepKindContribution | NativeStepKind;

/**
 * Встроенный вид (внутренняя форма `native`) отличается от плагинного
 * наличием этого поля. Проверяется само содержание поля, а не одно его имя:
 * вклад, случайно назвавший поле `native`, иначе был бы принят за встроенный,
 * и разбор звал бы `native.test` на объекте без такого метода. Декларативному
 * вкладу это имя запрещено схемой (`StepKindContributionSchema`), плагину
 * контекста — ничем: он зовёт `ctx.steps.register` напрямую.
 */
export function isNativeStepKind(kind: StepKind): kind is NativeStepKind {
  const native = (kind as NativeStepKind).native as NativeStepKindForm | undefined;
  return typeof native?.test === 'function' && typeof native.parse === 'function';
}

/**
 * Вклад умеет исполняться сам — то, что отличает `StepKindContribution` от
 * внутренней формы встроенных видов, не спрашивая о происхождении (design.md,
 * Решение 4): узнавание, ветвь схемы документа, статическая проверка, выбор
 * исполнителя, печать схемы проекта и карточка витрины решают именно этим
 * вопросом, а не `isNativeStepKind`, — вид, внесённый строкой дерева
 * (`decision`), проходит через них наравне с плагинным.
 */
export function hasStepExecutor(kind: StepKind): kind is StepKindContribution {
  return typeof (kind as StepKindContribution).execute === 'function';
}

/**
 * Внутренняя форма вклада предиката — только для встроенных (`builtin-predicates-as-row`,
 * design.md, решение 2, решение 3): пара «узнать свою запись, разобрать в
 * типизированную модель `Predicate` движка», по образцу `NativeStepKindForm`.
 * В публикуемой поверхности плагина её нет: у встроенных предикатов есть
 * типизированная модель и типизированное вычисление (`switch` по `kind`),
 * которые `evaluate(value: unknown, …)` заставили бы пройти через `unknown`
 * ради симметрии, которой автор плагина никогда не напишет своими руками.
 */
export interface NativePredicateForm {
  /**
   * Узнать запись этого предиката среди сырых записей `expect`/`until.check`:
   * замена сужения `'exit_code' in builtin`, которым раньше велась цепочка
   * `toPredicate` (`pipeline/expand.ts`).
   */
  test(raw: Record<string, unknown>): boolean;
  /** Типизированный разбор — тело прежней ветви `toPredicate`, перенесённое без изменений в содержании. */
  parse(raw: unknown, ctx: unknown): unknown;
}

/** Встроенный предикат в реестре: имя и внутренняя форма разбора. */
export interface NativePredicate {
  readonly name: string;
  readonly native: NativePredicateForm;
}

/**
 * Предикат в реестре — плагинный либо встроенный (design.md, решение 2).
 * Тип внутренний: `stepcast/pipeline` публикует только `PredicateContribution` —
 * автор плагина внутреннюю форму `native` не видит и завести её не может.
 */
export type PredicateKind = PredicateContribution | NativePredicate;

/**
 * Встроенный предикат (внутренняя форма `native`) отличается от плагинного
 * наличием этого поля — тем же приёмом, что и `isNativeStepKind`: проверяется
 * содержание поля, а не одно его имя. Декларативному вкладу это имя запрещено
 * схемой (`PredicateContributionSchema`), плагину контекста — ничем: он зовёт
 * `ctx.predicates.register` напрямую.
 */
export function isNativePredicate(kind: PredicateKind): kind is NativePredicate {
  const native = (kind as NativePredicate).native as NativePredicateForm | undefined;
  return typeof native?.test === 'function' && typeof native.parse === 'function';
}

/**
 * Вклад умеет вычисляться сам — то, что отличает `PredicateContribution` от
 * внутренней формы встроенных предикатов, не спрашивая о происхождении, по
 * образцу `hasStepExecutor`: узнавание вне состава, отбор для печати схемы
 * проекта и сверки её устаревания решают именно этим вопросом.
 */
export function hasPredicateEvaluator(kind: PredicateKind): kind is PredicateContribution {
  return typeof (kind as PredicateContribution).evaluate === 'function';
}

/**
 * Доменная форма плагина: ядерная (`StepcastPlugin` — `name`, `version`,
 * `commands`) плюс вклад пайплайна. `definePipelinePlugin` (`surface.ts`)
 * типизирует именно её (design.md, Решение 8).
 */
export interface PipelinePlugin extends StepcastPlugin {
  readonly backends?: Readonly<Record<string, BackendContribution>>;
  readonly predicates?: readonly PredicateContribution[];
  readonly steps?: readonly StepKindContribution[];
}

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
    /**
     * Поле внутренней формы встроенного предиката (`NativePredicateForm`): по
     * его наличию `isNativePredicate` отличает встроенный предикат от
     * плагинного — тем же приёмом, что и `native` вида шага
     * (`StepKindContributionSchema`).
     */
    native: z
      .undefined('поле native принадлежит внутренней форме встроенного предиката и вкладу недоступно')
      .optional(),
  })
  .loose();

/**
 * Форма `StepKindDocumentForm` при загрузке: перечень занятых ключей —
 * непустой список строк (design.md, Решение 2 — перечень объявляется, а не
 * выводится из схемы, и пустой список нечего было бы объявлять), `schema` —
 * объект, `test`/`parse` — функции. Формулировки отказов — тем же образцом,
 * что у соседних полей вклада.
 */
const StepKindDocumentFormSchema = z
  .object({
    test: z.custom<StepKindDocumentForm['test']>((value) => typeof value === 'function', {
      message: 'должна быть функцией',
    }),
    keys: z.array(z.string()).min(1, 'перечень занятых ключей не может быть пустым'),
    schema: z.record(z.string(), z.unknown()),
    parse: z.custom<StepKindDocumentForm['parse']>((value) => typeof value === 'function', {
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
    /** Собственная форма записи в документе (design.md, Решение 1) — необязательна. */
    document: StepKindDocumentFormSchema.optional(),
    lint: z
      .custom<NonNullable<StepKindContribution['lint']>>((value) => typeof value === 'function', {
        message: 'должна быть функцией',
      })
      .optional(),
    execute: z.custom<StepKindContribution['execute']>((value) => typeof value === 'function', {
      message: 'должна быть функцией',
    }),
    /**
     * Поле внутренней формы встроенного вида (`NativeStepKindForm`): по его
     * наличию `isNativeStepKind` отличает встроенный вид от плагинного.
     * Плагинный вклад, случайно несущий это имя, был бы принят за встроенный,
     * и разбор позвал бы `native.test` на объекте без него. Объект здесь
     * `.loose()` — остальные лишние поля вклада безобидны, — поэтому запрет
     * именной: он один и нужен.
     */
    native: z
      .undefined('поле native принадлежит внутренней форме встроенного вида шага и вкладу недоступно')
      .optional(),
  })
  .loose();

/**
 * Форма объекта, экспортируемого модулем плагина по умолчанию. Проверяется
 * при загрузке: неверная форма обязана назвать поле, а не проявиться
 * исключением посреди прогона. Несёт форму декларативного плагина целиком —
 * ядерные `name`/`version`/`commands` вместе с доменными
 * `backends`/`predicates`/`steps`: загрузчик (`load.ts`) не разбирает две
 * половины по отдельности, а разбирает объект автора одним проходом.
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

/**
 * Один вклад декларативной формы, приведённый к паре «имя, значение» —
 * общему виду, каким его примет `register` любого из четырёх сервисов.
 */
export interface DeclarativeContributionEntry {
  readonly name: string;
  readonly contribution: unknown;
}

/**
 * Форма таблицы `DECLARATIVE_CONTRIBUTION_FIELDS` — именованный тип для
 * параметра сборки (design.md изменения `cli-commands-as-rows`, Решение 11):
 * загрузчик (`toContextPlugin`, `kernel/load.ts`) больше не импортирует
 * эту таблицу значением, а получает её опцией обхода (`LoadOptions.declarativeFields`,
 * подаётся составом дефолта, `src/parts/load.ts`) — этим типом.
 */
export type DeclarativeContributionFields = {
  readonly [K in 'backends' | 'predicates' | 'commands' | 'steps']?: {
    /** Имя сервиса, в который идёт этот ключ формы. */
    readonly service: string;
    /** Вклады ключа, приведённые к паре «имя, значение» — пусто, если плагин ключ не объявил или объявил его пустым. */
    entries(plugin: PipelinePlugin): readonly DeclarativeContributionEntry[];
  };
};

/**
 * Ключ декларативной формы → служебный сервис → как достать из него имя
 * вклада (design.md изменения `pipeline-owns-services`, Решение 10). Живёт
 * рядом со `StepcastPluginSchema`, чьи ключи описывает: загрузчик
 * (`toContextPlugin`, `kernel/load.ts`) идёт по поданной ему таблице
 * этой же формы и только по ней — и регистрирует вклады, и объявляет
 * `inject`, — а не по двум независимым перечням имён в своём теле. Ключ,
 * которого таблица не знает, остаётся полем объекта плагина, ни к какой
 * регистрации не приводящим: то же самое молчание, каким `.loose()` уже
 * встречает лишний ключ схемы. Сама таблица — единственный экземпляр этой
 * формы, подаваемый составом дефолта (`src/parts/load.ts`) целиком.
 */
export const DECLARATIVE_CONTRIBUTION_FIELDS: DeclarativeContributionFields = {
  backends: {
    service: 'backends',
    entries: (plugin) =>
      Object.entries(plugin.backends ?? {}).map(([name, contribution]) => ({ name, contribution })),
  },
  predicates: {
    service: 'predicates',
    entries: (plugin) => (plugin.predicates ?? []).map((contribution) => ({ name: contribution.name, contribution })),
  },
  commands: {
    service: 'commands',
    entries: (plugin) => (plugin.commands ?? []).map((contribution) => ({ name: contribution.name, contribution })),
  },
  steps: {
    service: 'steps',
    entries: (plugin) => (plugin.steps ?? []).map((contribution) => ({ name: contribution.name, contribution })),
  },
};

/**
 * Регистратор видов шага — то немногое из `ContributionRegistrar`, что видит
 * автор плагина. Не переиспользует сам `ContributionRegistrar<T>`: реестр
 * ядра хранит виды шага одним общим типом, включающим внутреннюю форму
 * `native` (`kernel.ts`), а плагину эта форма недоступна вовсе — узкий
 * интерфейс с одним `register` избегает необходимости объяснять компилятору,
 * что читать `contributions`/`owner` для `steps` плагину незачем.
 *
 * `contribution.waits` (design.md изменения `user-decision-steps`, решение 6)
 * типизирован здесь тем же полем контракта: вклад, объявивший его, — и
 * только он — получает во входе исполнителя способность `decision`.
 */
export interface StepKindRegistrar {
  /** Внести вид шага. Отказывает на занятом имени; возвращает disposer. */
  register(name: string, contribution: StepKindContribution): () => void;
}

/**
 * Регистратор предикатов — то немногое из `ContributionRegistrar`, что видит
 * автор плагина, тем же приёмом, что и `StepKindRegistrar` (`builtin-predicates-as-row`,
 * design.md, решение 2). Не переиспользует сам `ContributionRegistrar<T>`:
 * реестр ядра хранит предикаты одним общим типом, включающим внутреннюю форму
 * `native` (`kernel.ts`), а плагину эта форма недоступна вовсе.
 */
export interface PredicateRegistrar {
  /** Внести предикат. Отказывает на занятом имени; возвращает disposer. */
  register(name: string, contribution: PredicateContribution): () => void;
}

/**
 * Контекст глазами доменного плагина — публикуемая поверхность подпути
 * `stepcast/pipeline`, расширение ядерного `Context` (`plugin-surface-split`,
 * design.md, Решение 4). Стык с настоящим контекстом проверяется компилятором
 * в одной точке рядом со строкой, заводящей эти сервисы, — `pluginContext()`
 * в `src/parts/pipeline/services.ts`, а не здесь и не в ядре.
 */
export interface PipelineContext extends Context {
  readonly backends: ContributionRegistrar<BackendContribution>;
  readonly predicates: PredicateRegistrar;
  readonly steps: StepKindRegistrar;
}

/**
 * Окружение команды пайплайна — расширение ядерного `CommandEnv` доменными
 * `config` и `registry` (design.md, Решение 6). Команда, объявленная этим
 * типом (`CommandContribution<PipelineCommandEnv>`), получает оба поля без
 * приведения; диспетчер (`src/parts/cli/main.ts`) собирает один объект окружения на
 * рантайме — деление на два типа только видом на него.
 */
export interface PipelineCommandEnv extends CommandEnv {
  readonly config: Config;
  /**
   * Действующий реестр вкладов. Команде он нужен для того же, для чего
   * движку: раскрыть документ с плагинными предикатами, разрешить адаптер,
   * назвать доступное в своей справке.
   */
  readonly registry: Registry;
}

/**
 * Доменный плагин целиком: тождество, которое проверяет литерал на лишние и
 * опечатанные поля (design.md, Решение 3, Решение 8) — тот же приём, что и у
 * ядерного `definePlugin` (`define.ts`), но для формы, несущей вклад
 * пайплайна.
 */
export function definePipelinePlugin(plugin: PipelinePlugin): PipelinePlugin {
  return plugin;
}

/** Вклад бэкенда: тождество, `create(config: BackendConfig)` уже типизирован контрактом. */
export function defineBackend(contribution: BackendContribution): BackendContribution {
  return contribution;
}

/**
 * Специализированная форма предиката: `evaluate` берёт `T`, а не `unknown`.
 * `evaluate` и `lint` объявлены свойствами-функциями, а не методами: только
 * так параметр `value` проверяется контравариантно (`strictFunctionTypes`), и
 * вклад с несовместимым `evaluate` не компилируется — метод синтаксиса
 * проверял бы параметр бивариантно и пропустил бы несовпадение молча
 * (design.md изменения `plugin-typed-helpers`, Решение 2, отвергнутая
 * альтернатива).
 */
export interface TypedPredicateContribution<T> extends Omit<PredicateContribution, 'evaluate' | 'lint'> {
  readonly evaluate: (value: T, input: EvaluationInput) => PredicateResult | Promise<PredicateResult>;
  /**
   * Первый параметр — `unknown`, не `T` (design.md, Решение 5): значение при
   * разборе документа схему вклада проходит всегда (`toPluginPredicate`) — но
   * проходит его нераскрытый вид, если автор написал в предикате отложенную
   * подстановку, — и правило делается одно для обоих хелперов, чтобы автору
   * не приходилось помнить, у какого из двух вкладов какая асимметрия.
   */
  readonly lint?: (value: unknown, site: LintSite) => readonly PluginDiagnostic[];
}

/**
 * `definePredicate<T>` типизирует `evaluate(value: T, …)`. Приведение
 * возвращаемого значения — единственное в хелпере (design.md, Решение 2):
 * специализированная форма не подтип контракта в общем случае, а значение
 * `value` схему вклада при разборе документа проходит (`expand.ts`,
 * `toPluginPredicate`) — приведение здесь опирается на ту же проверку, что и
 * весь контракт.
 *
 * Чего проверка не обещает: значение с отложенной подстановкой (`${jobs.*}`)
 * проверяется схемой нераскрытым, а раскрывает его позже `resolveLate`
 * (`pipeline/late.ts`) — второй проверки у предиката, в отличие от полей вида
 * шага (`exec/pluginStep.ts` зовёт `validateStepKindFields` перед попыткой),
 * нет. Тип значения при этом уцелеет (поздний проход подставляет строку в
 * строку), а ограничения схемы — `pattern`, `enum`, длина, формат — в
 * пришедшем в `evaluate` значении держаться перестают, и вычислителю нельзя
 * считать их проверенными за него.
 */
export function definePredicate<T>(contribution: TypedPredicateContribution<T>): PredicateContribution {
  return contribution as PredicateContribution;
}

/**
 * Специализированная форма вида шага: `execute` берёт `StepKindInput<F>`, а
 * не `StepKindInput<unknown>`. `execute` и `lint` — свойства-функции той же
 * причиной, что и у предиката выше: контравариантная проверка параметра.
 */
export interface TypedStepKindContribution<F> extends Omit<StepKindContribution, 'execute' | 'lint'> {
  readonly execute: (input: StepKindInput<F>) => Promise<StepKindOutcome> | StepKindOutcome;
  /**
   * Первый параметр — `unknown`, не `F` (design.md, Решение 5): поле с
   * отложенной подстановкой (`${jobs.*}`) при разборе схемой вклада ещё не
   * проверено — `stepcast lint` работает именно по этому, непроверенному
   * значению, и обещание `F` было бы здесь ложью.
   */
  readonly lint?: (fields: unknown, site: LintSite) => readonly PluginDiagnostic[];
}

/**
 * `defineStepKind<F>` типизирует `execute(input)` с `input.fields: F`.
 * Приведение возвращаемого значения — единственное в хелпере, той же причиной,
 * что и у `definePredicate`: значение полей к моменту вызова `execute` уже
 * проверено схемой вклада, после позднего раскрытия (`exec/pluginStep.ts`).
 *
 * `F` описывает именно результат `document.parse` (design.md изменения
 * `step-kind-document-contract`, Решение 1) — вклад без `document` разбирается
 * синтезированным `parse`, отдающим значение под ключом-именем, и в этом
 * случае `F` описывает как раз его. Хелпер не проверяет соответствие типов
 * `document.parse` и `F` — контракт объявляет `parse` возвращающим `unknown`
 * ровно потому, что связь между формой записи и формой полей знает только сам
 * автор вклада.
 */
export function defineStepKind<F>(contribution: TypedStepKindContribution<F>): StepKindContribution {
  return contribution as StepKindContribution;
}
