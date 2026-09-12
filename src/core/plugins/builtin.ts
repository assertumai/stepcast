import { claudeModelDiscovery, createClaudeAdapter } from '../backend/claude.js';
// Разбор — модуль `pipeline`, ядро — модуль `plugins`; связь одна и не по
// кругу, несмотря на то, что `pipeline/expand.ts` тоже читает отсюда
// `builtinRegistry` — оба обращения происходят внутри вызова функции, не на
// верхнем уровне модуля, и загрузчик ES-модулей разводит их без ошибки (см.
// комментарий у `registerBuiltinStepKinds`).
import { registerBuiltinStepKinds } from '../pipeline/expand.js';
import { stepDecisionContribution } from '../../steps/decision/index.js';
import type { CommandContribution } from './contract.js';
import { createKernel, type Fiber, type Kernel } from './kernel.js';
import { registryFromKernel, type Registry } from './registry.js';

/**
 * Встроенные вклады движка.
 *
 * Регистрируются тем же вызовом, что и плагинные — `ctx.backends.register` —
 * это единственный способ проверить, что контракта
 * достаточно: если через вклад нельзя выразить `claude`, через него нельзя
 * выразить и второй бэкенд. Разница только в том, на каком контексте вызов
 * исполняется: на корневом, а не внутри `ctx.plugin()`, — поэтому владелец
 * вклада выходит «встроенным», а не «плагином» (kernel.ts, идентичность
 * корневой области).
 *
 * Встроенные вклады описываются строками того же формата, что и вклады
 * плагинов (`plugin-tree`, design.md, Решение 5): таблица `id → фабрика`
 * ниже — и есть встроенный слой дерева. Загрузчик (`load.ts`) находит фабрику
 * по имени формы `use: stepcast:<id>`, а не по диску: строка, заменённая
 * патчем, эту таблицу не спрашивает вовсе и потому не применяется.
 *
 * Встроенные предикаты — исключение, и оно осознанное. Их модель
 * (`Predicate`) — размеченное объединение с типизированными полями, а
 * вычисление — `switch` по `kind`, полноту которого проверяет компилятор.
 * Вклад с сигнатурой `evaluate(value: unknown, …)` заменил бы девять
 * проверенных ветвей на девять приведений типа — обмен не в пользу движка.
 * Реестру от встроенных предикатов нужно только их имена: перечень
 * доступного в диагностике и запрет занять то же имя плагином. Резерв имени
 * делается через ядро (`kernel.reservePredicate`), а не через сервис: сервис
 * виден плагину, и публичный `reserve` на нём дал бы любому плагину занять
 * произвольное имя несъёмным резервом. Ветви схемы документа остаются в
 * `pipeline/schema.ts`, где и были. Строками дерева имена предикатов не
 * становятся: заменить или отключить их патчем нельзя (`plugin-tree`,
 * design.md, Решение 5).
 */

/**
 * Имена встроенных предикатов. Плагин не вправе занять ни одно: предикат под
 * знакомым именем, ведущий себя иначе, — то же, что подменённый `claude`.
 */
export const BUILTIN_PREDICATE_NAMES: readonly string[] = [
  'exit_code',
  'file_exists',
  'schema',
  'matches',
  'not_matches',
  'changed_only',
  'knowledge_valid',
  'cmd',
  'judge',
];

/**
 * Встроенная строка дерева: id и фабрика, вносящая вклады.
 *
 * Строка движка вносит их прямо на корневой области ядра, синхронно, и не
 * возвращает область — её вклады приписываются осмотром (`introspect.ts`) по
 * окну применения (design.md, Решение 2, второе правило), а не по фиберу.
 * Строка поставки витрины (`src/ui/screens/registry.ts`, `screenRow()`)
 * заводит для себя область плагина внутри `apply` и возвращает её: без этого
 * осмотр приписывал бы её вклады тоже окну, а не собственной строке (`row-fiber`,
 * design.md, Решение 2, первое правило) — отсюда `Fiber | void`, а не голый
 * `void`.
 */
export interface BuiltinRow {
  readonly id: string;
  apply(kernel: Kernel): Fiber | void | Promise<Fiber | void>;
}

export const BUILTIN_ROWS: readonly BuiltinRow[] = [
  {
    id: 'backend-claude',
    apply(kernel) {
      kernel.ctx.backends.register('claude', {
        create: (config) => createClaudeAdapter(config),
        models: claudeModelDiscovery,
      });
    },
  },
  {
    // Первый плагинный вид шага в поставке (`user-decision-steps`, design.md):
    // остановка прогона на решении человека. Строка, а не вид ядра, — её
    // отключение патчем снимает вид `decision`, освобождая имя.
    id: 'step-decision',
    apply(kernel) {
      kernel.ctx.steps.register('decision', stepDecisionContribution);
    },
  },
];

/** Id встроенных строк — то, чем `config/resolve.ts` заводит семя дерева (design.md, Решение 5). */
export const BUILTIN_ROW_IDS: readonly string[] = BUILTIN_ROWS.map((row) => row.id);

/** Найти фабрику встроенной строки по имени формы `stepcast:<имя>` (задача 3.2, `load.ts`). */
export function findBuiltinRow(id: string): BuiltinRow | undefined {
  return BUILTIN_ROWS.find((row) => row.id === id);
}

/**
 * Ядро без применённых строк встроенного слоя: предикаты зарезервированы,
 * команды внесены, но ни одна фабрика `BUILTIN_ROWS` не вызвана. Загрузчик
 * (`load.ts`) применяет их сам, построчно, по дереву — иначе строка,
 * заменённая патчем, всё равно получила бы своё встроенное умолчание.
 */
export function createKernelShell(commands: readonly CommandContribution[] = []): Kernel {
  const kernel = createKernel();
  for (const name of BUILTIN_PREDICATE_NAMES) kernel.reservePredicate(name);
  for (const command of commands) kernel.ctx.commands.register(command.name, command);
  // `agent`, `run`, `script`, `uses` — виды шага ядра, не строки дерева: их
  // нельзя ни отключить, ни заменить патчем, в отличие от `step-http`
  // (design.md, решение 10). Регистрируются здесь же, а не в `BUILTIN_ROWS`,
  // ровно как резерв имён предикатов выше.
  registerBuiltinStepKinds(kernel);
  return kernel;
}

/**
 * Ядро со всеми встроенными вкладами. Команды приходят параметром, а не
 * объявлены здесь: они живут в `src/cli`, а ядру запрещено зависеть от
 * поверхности.
 *
 * Библиотечное умолчание (задача 3.4): `expand.ts`, `lint.ts`,
 * `backend/registry.ts`, `runner.ts` и тесты зовут его без чтения файлов и
 * получают полное встроенное дерево, как и до появления патчей.
 */
export function createBuiltinKernel(commands: readonly CommandContribution[] = []): Kernel {
  const kernel = createKernelShell(commands);
  for (const row of BUILTIN_ROWS) row.apply(kernel);
  return kernel;
}

/**
 * Реестр из одних встроенных вкладов. Заводится заново на каждый вызов:
 * реестр живёт ровно столько, сколько команда, и общий изменяемый экземпляр
 * протёк бы между тестами.
 */
export function builtinRegistry(commands: readonly CommandContribution[] = []): Registry {
  return registryFromKernel(createBuiltinKernel(commands));
}
