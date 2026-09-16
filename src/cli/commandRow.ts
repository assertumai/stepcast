import type { Context, Kernel } from '../core/plugins/kernel.js';
import { rowScope, type BuiltinRow } from '../core/plugins/load.js';
import type { CommandContribution, CommandEnv } from '../core/plugins/contract.js';

/**
 * Помощник объявления строки команды — отдельным модулем от `src/cli/rows.ts`
 * (design.md изменения `cli-commands-as-rows`, Решение 2): перечень только
 * называет модули команд, ни одного тела строки не неся, а каждый модуль
 * команды импортирует этот помощник обратно. Если бы помощник и перечень
 * жили в одном файле, `rows.ts` и любой из 25 модулей команд образовали бы
 * цикл импорта по значению — `PIPELINE_SERVICES` как `const` не переживает
 * такой цикл (`ReferenceError: Cannot access before initialization`), в
 * отличие от строк движка (`partRow`, `src/parts/pipeline/services.ts`) и
 * строк экранов витрины (`screenRow`, `src/ui/screens/registry.ts`), где
 * помощник и перечень разнесены по той же причине.
 */

/**
 * Сервисы, которые заводит строка `pipeline` — объявляют строки доменных
 * команд, читающие вклады пайплайна (design.md `pipeline-owns-services`,
 * Решение 9; `cli-commands-as-rows`, Решение 3). Команда, не знающая доменных
 * понятий движка, и команда, обязанная работать именно тогда, когда состав
 * сломан (`plugins`, `config` и подобные), этот перечень не объявляют.
 */
export const PIPELINE_SERVICES: readonly string[] = ['backends', 'predicates', 'steps'];

/**
 * Строка встроенной команды CLI (`plugin-tree`, design.md изменения
 * `cli-commands-as-rows`, Решение 1): одна строка — одна команда, `id`
 * выводится из имени вклада механически. Тело строки регистрирует ровно
 * объявленный вклад через `rowScope` (`src/core/plugins/load.ts`) — тем же
 * помощником, каким заводят свою область строки движка (`partRow`,
 * `src/parts/pipeline/services.ts`) и строки поставки витрины (`screenRow`,
 * `src/ui/screens/registry.ts`).
 */
export interface CommandRow extends BuiltinRow {
  /** Вклад команды — тем же контрактом, что несёт команда плагина. */
  readonly command: CommandContribution;
  /**
   * Независима ли команда от конфигурации (design.md, Решение 5, Решение 6):
   * `data`, `down`, `init` исполняются раньше, чем состав существует, и точка
   * входа берёт их вклад прямо из этого поля, минуя дерево.
   */
  readonly independent: boolean;
}

/**
 * Завести строку встроенной команды (design.md, Решение 1, Решение 9): `id` =
 * `command-<имя вклада>`, `inject` несёт строка — не сам вклад, поле
 * `CommandContribution.inject` встроенные команды не объявляют вовсе, его
 * смысл («не зови тело, пока сервиса нет») обеспечен тем, что без сервиса
 * строки нет вовсе (cordis не вызовет `apply`, пока `inject` не разрешится, а
 * незакрытое внедрение станет отказом загрузки или состоянием строки — тем же
 * правилом, что и у `backend-claude`).
 */
export function commandRow<E extends CommandEnv = CommandEnv>(
  contribution: CommandContribution<E>,
  options: { readonly inject?: readonly string[]; readonly independent?: boolean } = {},
): CommandRow {
  const id = `command-${contribution.name}`;
  const inject = options.inject ?? [];
  return {
    id,
    command: contribution,
    independent: options.independent ?? false,
    apply: (kernel: Kernel) =>
      rowScope(kernel, id, inject, (ctx: Context) => {
        ctx.commands.register(contribution.name, contribution);
      }),
  };
}
