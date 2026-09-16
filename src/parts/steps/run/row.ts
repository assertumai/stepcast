import { RUN_STEP_KIND } from '../../../core/pipeline/expand.js';
import { partRow } from '../../pipeline/services.js';

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
 * Строка-потребитель сервиса `steps` (design.md `pipeline-owns-services`,
 * Решение 2): применяется собственной областью с объявленным `inject`, а не
 * прямо на корне. Владелец вклада остаётся «встроенным»: признак — не
 * корневая область, а пометка области строки этого каталога (Решение 3).
 */
export const row = partRow('step-run', ['steps'], (ctx) => {
  ctx.steps.register('run', RUN_STEP_KIND);
});
