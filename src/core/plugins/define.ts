import type { EvaluationInput } from '../expect/evaluate.js';
import type { PredicateResult } from '../journal/schema.js';
import type {
  BackendContribution,
  LintSite,
  PluginDiagnostic,
  PredicateContribution,
  StepcastPlugin,
  StepKindContribution,
  StepKindInput,
  StepKindOutcome,
} from './contract.js';

/**
 * Четыре хелпера объявления вклада (design.md, Решение 1): каждый — тождество
 * в рантайме. Ни один не оборачивает `evaluate`/`execute`/`create`, не
 * проверяет форму вклада и не регистрирует его — форму проверяет загрузка
 * (`StepcastPluginSchema`), а вторая проверка здесь разошлась бы с ней.
 * Хелперы дают только сигнатуру: параметр типа виден компилятору автора, а
 * движок получает ровно тот же объект, что написал автор.
 */

/** Плагин целиком: тождество, которое проверяет литерал на лишние и опечатанные поля (design.md, Решение 3). */
export function definePlugin(plugin: StepcastPlugin): StepcastPlugin {
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
 * (design.md, Решение 2, отвергнутая альтернатива).
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
 */
export function defineStepKind<F>(contribution: TypedStepKindContribution<F>): StepKindContribution {
  return contribution as StepKindContribution;
}
