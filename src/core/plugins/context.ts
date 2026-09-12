import type { BackendContribution, CommandContribution, PredicateContribution, StepKindContribution } from './contract.js';

/**
 * Контекст глазами плагина — публикуемая поверхность подпути `stepcast/plugin`.
 *
 * Объявлен здесь, а не взят из `cordis`, и это не дублирование ради красоты.
 * Собственные `.d.ts` пакета реэкспортируют друг друга относительными путями
 * без расширения, чего `moduleResolution: NodeNext` не разрешает: под таким
 * резолвером `import { Context } from 'cordis'` не даёт ни одного имени, и
 * `skipLibCheck` этого не лечит — он пропускает проверку чужих объявлений, а не
 * чинит их разрешение. Наш собственный компилятор обходит это ручным
 * объявлением (`cordis.d.ts` рядом), но это объявление живёт в `src` и в `dist`
 * не эмитится: автор плагина, собирающий свой модуль с `NodeNext`, остался бы с
 * поверхностью, чей главный тип не разрешается. Поэтому тип контекста —
 * степкастовский: `dist/src/core/plugins/context.d.ts` не ссылается на `cordis`
 * вовсе, и плагину не нужна ни библиотека, ни её типы (design.md, Решение 8).
 *
 * Это объявление — контракт, а не описание чужого класса: здесь ровно то, чем
 * плагину разрешено пользоваться. Что настоящий контекст ему соответствует,
 * проверяет компилятор в единственной точке стыка — `createKernel()` отдаёт
 * `ctx` этим типом, — и он же ловит расхождение при обновлении версии cordis.
 */

/** Форма объявления зависимостей плагина: список имён либо карта имя→конфиг. */
export type Inject = string[] | Record<string, unknown>;

/**
 * Служебный сервис вида вклада: `backends`, `predicates`, `commands`. Регистрация
 * возвращает disposer и принадлежит области вызвавшего — снятие области снимает
 * вклад (`docs/plugins.md`, «Контекст, область и сервис»).
 */
export interface ContributionRegistrar<T> {
  /** Вклады вида по имени — то же, что читает `Registry`. */
  readonly contributions: ReadonlyMap<string, T>;
  /** Имена, занятые без вкладов (встроенные предикаты). */
  readonly reserved: readonly string[];
  /** Кто внёс вклад с этим именем: имя плагина либо «встроенный». */
  owner(name: string): string | undefined;
  /** Внести вклад. Отказывает на занятом имени; возвращает disposer. */
  register(name: string, contribution: T): () => void;
}

/**
 * Регистратор видов шага — то немногое из `ContributionRegistrar`, что видит
 * автор плагина. Не переиспользует сам `ContributionRegistrar<T>`: реестр
 * ядра хранит виды шага одним общим типом, включающим встроенную форму
 * `document` (`kernel.ts`), а плагину эта форма недоступна вовсе — узкий
 * интерфейс с одним `register` избегает необходимости объяснять компилятору,
 * что читать `contributions`/`owner` для `steps` плагину незачем.
 */
export interface StepKindRegistrar {
  /** Внести вид шага. Отказывает на занятом имени; возвращает disposer. */
  register(name: string, contribution: StepKindContribution): () => void;
}

/** Контекст ядра: то, чем располагает плагин контекста и команда плагина. */
export interface Context {
  readonly backends: ContributionRegistrar<BackendContribution>;
  readonly predicates: ContributionRegistrar<PredicateContribution>;
  readonly commands: ContributionRegistrar<CommandContribution>;
  readonly steps: StepKindRegistrar;
  /**
   * Обратимое действие области: тело исполняется сразу, возвращённая им функция
   * вызывается при снятии области. Этим же оформлена каждая регистрация вклада.
   */
  effect<T = unknown>(execute: () => (() => T) | void, label?: string): () => T;
  /** Значение сервиса по имени либо `undefined`, если имя не разрешается. */
  get(name: string, strict?: boolean): unknown;
  set(name: string, value: unknown): void;
  /** Объявить имя сервиса своим. Пара `provide` + `set` заводит сервис плагина. */
  provide(name: string, value?: unknown): () => void;
  /**
   * Область, исполняемая только при доступных зависимостях: тело зовётся, когда
   * все имена разрешились, и снимается, когда любое из них исчезло.
   */
  inject(deps: Inject, callback: (ctx: Context) => void): PromiseLike<unknown>;
}
