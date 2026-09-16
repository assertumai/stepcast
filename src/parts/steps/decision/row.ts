import { stepDecisionContribution } from '../../../steps/decision/index.js';
import type { BuiltinRow } from '../../../core/plugins/load.js';

/**
 * Строка встроенного слоя: вид шага `decision`. Реализация остаётся на
 * прежнем месте (`src/steps/decision/`) — её физический переезд в этот
 * каталог шаг 10 плана `docs/microkernel-target.md`; здесь заводится только
 * модуль строки по адресу целевой структуры (`plugin-tree`, design.md,
 * Решение 2).
 *
 * Первый плагинный вид шага в поставке (`user-decision-steps`, design.md):
 * остановка прогона на решении человека. Строка, а не вид ядра, — её
 * отключение патчем снимает вид `decision`, освобождая имя.
 *
 * Вклад вносится на корневой области ядра, а не через `kernel.ctx.plugin`:
 * владелец встроенного вклада — признак области ядра (`BUILTIN_OWNER`), а не
 * имя строки (`plugin-tree`, design.md, Решение 1).
 */
export const row: BuiltinRow = {
  id: 'step-decision',
  apply(kernel) {
    kernel.ctx.steps.register('decision', stepDecisionContribution);
  },
};
