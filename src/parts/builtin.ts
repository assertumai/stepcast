// Цикл «встроенный слой поставки ↔ разбор» не исчез переносом регистрации
// видов шага в строки (`builtin-step-kinds-as-rows`) — он перестал проходить
// через этот файл и через `registerBuiltinStepKinds`, но замкнулся между
// `parts/rows.ts` и `core/pipeline/expand.ts`: `expand.ts` читает
// `builtinRegistry` отсюда, а строки `step-run`/`step-uses`/`step-script`/
// `step-agent` (`src/parts/steps/*/row.ts`), перечисленные в `rows.ts`, читают
// внутренние формы разбора из `expand.ts`. Разрывает его физический переезд
// разбора (шаг 10 плана `docs/microkernel-target.md`) либо снятие умолчания
// `registry` у `expandPipeline` — не этот пункт (design.md, «Risks»).
import { assertStepKindNameAvailable } from '../core/pipeline/schema.js';
import type { CommandContribution } from '../core/plugins/contract.js';
import { createKernel, type Kernel } from '../core/plugins/kernel.js';
import { registryFromKernel, type Registry } from '../core/plugins/registry.js';
import { BUILTIN_ROWS } from './rows.js';

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
 * плагинов (`plugin-tree`, design.md, Решение 1): каждая строка — модуль,
 * экспортирующий `row` (`src/parts/backends/claude/row.ts`,
 * `src/parts/steps/decision/row.ts`), а перечень `BUILTIN_ROWS` (`./rows.js`)
 * только называет эти модули — встроенный слой дерева. Загрузчик
 * (`src/core/plugins/load.ts`) находит фабрику по имени формы
 * `use: stepcast:<id>` среди строк, поданных ему параметром
 * (`kernel-domain-free-imports`, Решение 3), а не по диску и не по
 * собственной таблице — единственный, кто эту таблицу знает, это состав
 * дефолта (`src/parts/load.ts`).
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

// Поиска фабрики по имени здесь больше нет (`findBuiltinRow` до
// `kernel-domain-free-imports`): фабрику строки формы `stepcast:<имя>` ищет
// обход дерева и только среди поданных ему строк (`src/core/plugins/load.ts`,
// Решение 3). Отдельный поиск по одному `BUILTIN_ROWS` вёл бы мимо настоящего
// пути разрешения — мимо строк вызывающего и мимо замены строки патчем.

/**
 * Ядро без применённых строк встроенного слоя: предикаты зарезервированы,
 * команды внесены, но ни одна фабрика `BUILTIN_ROWS` не вызвана. Загрузчик
 * (`src/parts/load.ts`) применяет их сам, построчно, по дереву — иначе строка,
 * заменённая патчем, всё равно получила бы своё встроенное умолчание.
 */
export function createKernelShell(commands: readonly CommandContribution[] = []): Kernel {
  const kernel = createKernel({ nameGuards: { steps: assertStepKindNameAvailable } });
  for (const name of BUILTIN_PREDICATE_NAMES) kernel.reservePredicate(name);
  for (const command of commands) kernel.ctx.commands.register(command.name, command);
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
