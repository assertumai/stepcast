import { SCRIPT_STEP_KIND } from '../../../core/pipeline/expand.js';
import type { BuiltinRow } from '../../../core/plugins/load.js';

/**
 * Строка встроенного слоя: вид шага `script` (`builtin-step-kinds-as-rows`,
 * design.md, Решение 1). Внутренняя форма разбора остаётся в
 * `src/core/pipeline/expand.ts` (design.md, «Альтернатива — переселить разбор
 * вместе со строкой», отклонена).
 *
 * Место строки в перечне (`src/parts/rows.ts`) — после `step-uses`: ключ
 * `script` объявлен схемой `uses` как занятый манифестом, и по одному его
 * присутствию два вида уже не различаются (design.md, Решение 2, комментарий
 * у `parseUsesStep`).
 *
 * Импорт верхнего уровня, обращение к `SCRIPT_STEP_KIND` — внутри тела
 * `apply`: тот же приём разводки цикла модулей, что у строки `step-run`.
 *
 * Вклад вносится на корневой области ядра, а не через `kernel.ctx.plugin`:
 * владелец встроенного вклада — признак области ядра (`BUILTIN_OWNER`), а не
 * имя строки (`plugin-tree`, design.md, Решение 1).
 */
export const row: BuiltinRow = {
  id: 'step-script',
  apply(kernel) {
    kernel.ctx.steps.register('script', SCRIPT_STEP_KIND);
  },
};
