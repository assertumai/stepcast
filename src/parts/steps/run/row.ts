import { RUN_STEP_KIND } from '../../../core/pipeline/expand.js';
import type { BuiltinRow } from '../../../core/plugins/load.js';

/**
 * Строка встроенного слоя: вид шага `run` (`builtin-step-kinds-as-rows`,
 * design.md, Решение 1). Внутренняя форма разбора (`native.test`/`native.parse`)
 * остаётся в `src/core/pipeline/expand.ts` — её физический переезд в этот
 * каталог ничем не обусловлен этим пунктом (design.md, «Альтернатива —
 * переселить разбор вместе со строкой», отклонена).
 *
 * Импорт верхнего уровня, обращение к `RUN_STEP_KIND` — внутри тела `apply`:
 * `rows.ts` → `row.ts` → `expand.ts` → `parts/builtin.ts` → `rows.ts`
 * замыкается в цикл, и связывание модулей ES разводит его без ошибки только
 * для обращений, происходящих после инициализации всех модулей (тот же приём,
 * что у нынешнего `registerBuiltinStepKinds`, design.md, Решение 1).
 *
 * Вклад вносится на корневой области ядра, а не через `kernel.ctx.plugin`:
 * владелец встроенного вклада — признак области ядра (`BUILTIN_OWNER`), а не
 * имя строки (`plugin-tree`, design.md, Решение 1).
 */
export const row: BuiltinRow = {
  id: 'step-run',
  apply(kernel) {
    kernel.ctx.steps.register('run', RUN_STEP_KIND);
  },
};
