import { AGENT_STEP_KIND } from '../../../core/pipeline/expand.js';
import type { BuiltinRow } from '../../../core/plugins/load.js';

/**
 * Строка встроенного слоя: вид шага `agent` (`builtin-step-kinds-as-rows`,
 * design.md, Решение 1). Внутренняя форма разбора остаётся в
 * `src/core/pipeline/expand.ts` (design.md, «Альтернатива — переселить разбор
 * вместе со строкой», отклонена).
 *
 * Импорт верхнего уровня, обращение к `AGENT_STEP_KIND` — внутри тела
 * `apply`: тот же приём разводки цикла модулей, что у строки `step-run`.
 *
 * Вклад вносится на корневой области ядра, а не через `kernel.ctx.plugin`:
 * владелец встроенного вклада — признак области ядра (`BUILTIN_OWNER`), а не
 * имя строки (`plugin-tree`, design.md, Решение 1).
 */
export const row: BuiltinRow = {
  id: 'step-agent',
  apply(kernel) {
    kernel.ctx.steps.register('agent', AGENT_STEP_KIND);
  },
};
