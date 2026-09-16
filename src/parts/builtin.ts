// Цикл «встроенный слой поставки ↔ разбор» не исчез переносом регистрации
// видов шага в строки (`builtin-step-kinds-as-rows`) — он перестал проходить
// через этот файл и через `registerBuiltinStepKinds`, но замкнулся между
// `parts/rows.ts` и `parts/pipeline/document/expand.ts`: `expand.ts` читает
// `builtinRegistry` отсюда, а строки `step-run`/`step-uses`/`step-script`/
// `step-agent` (`src/parts/pipeline/steps/*/row.ts`), перечисленные в `rows.ts`, читают
// внутренние формы разбора из `expand.ts`. Разрывает его физический переезд
// разбора (шаг 10 плана `docs/microkernel-target.md`) либо снятие умолчания
// `registry` у `expandPipeline` — не этот пункт (design.md, «Risks»).
import { StepcastError } from '../kernel/errors.js';
import { createKernel, type Kernel } from '../kernel/kernel.js';
import { registryFromKernel, type Registry } from '../kernel/registry.js';
import type { PartRow } from './pipeline/services.js';
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
 * `src/parts/pipeline/steps/decision/row.ts`), а перечень `BUILTIN_ROWS` (`./rows.js`)
 * только называет эти модули — встроенный слой дерева. Загрузчик
 * (`src/kernel/load.ts`) находит фабрику по имени формы
 * `use: stepcast:<id>` среди строк, поданных ему параметром
 * (`kernel-domain-free-imports`, Решение 3), а не по диску и не по
 * собственной таблице — единственный, кто эту таблицу знает, это состав
 * дефолта (`src/parts/load.ts`).
 *
 * Встроенные предикаты — такой же вклад, как и три прочих вида, а не резерв
 * имени без содержания (`builtin-predicates-as-row`, design.md, Решение 1,
 * Решение 2): их модель (`Predicate`) и `switch` вычисления по `kind`
 * (`expect/evaluate.ts`) не тронуты — вклад несёт внутреннюю форму `native`
 * (узнать свою запись, разобрать в типизированную модель), а не сигнатуру
 * `evaluate(value: unknown, …)`, которая заменила бы десять проверенных
 * ветвей на десять приведений типа. Все десять вносит одна строка
 * (`src/parts/pipeline/expect/row.ts`), перечисленная в `BUILTIN_ROWS` наравне с
 * прочими: сборка ядра сама не занимает ни одного имени предиката.
 */

// Поиска фабрики по имени здесь больше нет (`findBuiltinRow` до
// `kernel-domain-free-imports`): фабрику строки формы `stepcast:<имя>` ищет
// обход дерева и только среди поданных ему строк (`src/kernel/load.ts`,
// Решение 3). Отдельный поиск по одному `BUILTIN_ROWS` вёл бы мимо настоящего
// пути разрешения — мимо строк вызывающего и мимо замены строки патчем.

/**
 * Ядро без применённых строк встроенного слоя: ни одна фабрика
 * `BUILTIN_ROWS` не вызвана — сборка ядра не занимает ни одного имени
 * предиката сама (`builtin-predicates-as-row`, design.md, Решение 1) и ни
 * одного имени команды (`cli-commands-as-rows`, Решение 1): команды —
 * строки того же встроенного слоя, вносимые точкой входа (`src/parts/cli/rows.ts`),
 * а не параметр сборки. Ядро (`createKernel()`) не принимает опций вовсе:
 * проверка имени вида шага — доменное знание, которое сегодня несёт строка
 * `pipeline` (`src/parts/pipeline/row.ts`), а не сборка ядра
 * (`pipeline-owns-services`, design.md, Решение 1). Загрузчик
 * (`src/parts/load.ts`) применяет строки сам, построчно, по дереву — иначе
 * строка, заменённая патчем, всё равно получила бы своё встроенное умолчание.
 */
export function createKernelShell(): Kernel {
  return createKernel();
}

/**
 * Отказ синхронного умолчания на строке, чей `inject` не разрешился в
 * порядке перечня (design.md `pipeline-owns-services`, Решение 4): в отличие
 * от формы дерева (`applyTreeRow`), здесь нет отложенного разрешения — тело
 * строки зовётся сразу, и поставщик обязан стоять в `BUILTIN_ROWS` раньше
 * своих потребителей. Названный отказ вместо `TypeError` на обращении к
 * `ctx.<имя>.register`.
 */
function synchronousInjectFailure(row: PartRow, name: string): StepcastError {
  return new StepcastError(
    `Строка ${row.id} ждёт сервис ${name}: в синхронной сборке умолчания строки применяются в порядке перечня — поставщик обязан стоять раньше`,
    { at: 'plugins', hint: 'Проверьте порядок строк в src/parts/rows.ts: строка-поставщик обязана предшествовать своим потребителям' },
  );
}

/**
 * Применить тело строки прямо на корневом контексте, в обход дерева (design.md,
 * Решение 4): та же функция `register`, что и форма дерева (`row.apply`)
 * зовёт внутри собственной области строки, — здесь она зовётся на области
 * ядра. Синхронное применение не умеет ждать: `inject` строки проверяется
 * заранее, по тому, что уже зарегистрировано предыдущими строками перечня.
 *
 * Экспортирована ради теста порядка (design.md, задача 5.4): `createBuiltinKernel`
 * зовёт её только перечнем `BUILTIN_ROWS` как есть, а тест обязан провести
 * переставленный перечень через ту же проверку, а не копировать её логику.
 */
export function applyRowOnRoot(kernel: Kernel, row: PartRow): void {
  for (const name of row.inject) {
    if (kernel.ctx.get(name) === undefined) throw synchronousInjectFailure(row, name);
  }
  row.register(kernel.ctx);
}

/**
 * Ядро со всеми встроенными вкладами движка — без команд: они живут в
 * `src/parts/cli/rows.ts`, а ядру запрещено зависеть от поверхности
 * (`cli-commands-as-rows`, Решение 2). Вызывающий, которому нужны и команды
 * (`src/parts/load.ts`, `defaultComposition`), подаёт их строками обхода
 * дерева, а не параметром этой функции.
 *
 * Библиотечное умолчание (design.md `pipeline-owns-services`, Решение 4):
 * `expand.ts`, `lint.ts`, `backend/registry.ts`, `runner.ts` и тесты зовут его
 * без чтения файлов и без дерева, и получают полное встроенное дерево, как и
 * до появления патчей. Остаётся синхронной функцией именно поэтому:
 * `expandPipeline` синхронна и берёт реестр умолчанием параметра, а сделать
 * её асинхронной значило бы переписать раскрытие, линт, прогон, реестр
 * бэкендов, генератор схемы и десятки тестов — чужую работу за пределами
 * этого пункта. Тела строк применяются здесь прямо на корне, в порядке
 * перечня `BUILTIN_ROWS`, где `pipeline` стоит первой, — то же тело, что
 * применяет форма дерева на собственной области строки, владелец вклада в
 * обоих случаях «встроенный» (на корне — по идентичности корня, в дереве —
 * по пометке, `src/parts/pipeline/services.ts`).
 */
export function createBuiltinKernel(): Kernel {
  const kernel = createKernelShell();
  for (const row of BUILTIN_ROWS) applyRowOnRoot(kernel, row);
  return kernel;
}

/**
 * Реестр из одних встроенных вкладов движка, без команд. Заводится заново на
 * каждый вызов: реестр живёт ровно столько, сколько команда, и общий
 * изменяемый экземпляр протёк бы между тестами.
 */
export function builtinRegistry(): Registry {
  return registryFromKernel(createBuiltinKernel());
}
