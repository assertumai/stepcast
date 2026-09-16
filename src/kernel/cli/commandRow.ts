import type { Context, Kernel } from '../kernel.js';
import { rowScope, type BuiltinRow } from '../load.js';
import type { CommandContribution, CommandEnv } from '../contract.js';

/**
 * Помощник объявления строки команды — отдельным модулем от `src/parts/cli/rows.ts`
 * (design.md изменения `cli-commands-as-rows`, Решение 2): перечень только
 * называет модули команд, ни одного тела строки не неся, а каждый модуль
 * команды импортирует этот помощник обратно. Ядро не несёт перечня доменных
 * сервисов пайплайна (`PIPELINE_SERVICES`) — он объявлен у строки-поставщика
 * (`src/parts/pipeline/services.ts`, design.md `source-tree-microkernel-layout`,
 * Решение 7), а строки доменных команд подают его этому помощнику параметром
 * `inject`.
 */

/**
 * Строка встроенной команды CLI (`plugin-tree`, design.md изменения
 * `cli-commands-as-rows`, Решение 1): одна строка — одна команда, `id`
 * выводится из имени вклада механически. Тело строки регистрирует ровно
 * объявленный вклад через `rowScope` (`src/kernel/load.ts`) — тем же
 * помощником, каким заводят свою область строки движка (`partRow`,
 * `src/parts/pipeline/services.ts`) и строки поставки витрины (`screenRow`,
 * `src/parts/ui/screens/registry.ts`).
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
