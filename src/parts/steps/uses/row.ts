import { USES_STEP_KIND } from '../../../core/pipeline/expand.js';
import { partRow } from '../../pipeline/services.js';

/**
 * Строка встроенного слоя: вид шага `uses` (`builtin-step-kinds-as-rows`,
 * design.md, Решение 1). Внутренняя форма разбора остаётся в
 * `src/core/pipeline/expand.ts` (design.md, «Альтернатива — переселить разбор
 * вместе со строкой», отклонена).
 *
 * Место строки в перечне (`src/parts/rows.ts`) раньше `step-script` не
 * случайно: `uses` обязан узнавать свой шаг раньше `script` (design.md,
 * Решение 2, комментарий у `parseUsesStep`).
 *
 * Импорт верхнего уровня, обращение к `USES_STEP_KIND` — внутри тела `apply`:
 * тот же приём разводки цикла модулей, что у строки `step-run`.
 *
 * Строка-потребитель сервиса `steps` (design.md `pipeline-owns-services`,
 * Решение 2): применяется собственной областью с объявленным `inject`.
 * Порядок относительно строки-поставщика (`pipeline`) её применения не
 * решает — решает только место среди прочих потребителей (см. выше). Владелец
 * вклада остаётся «встроенным»: признак — не корневая область, а пометка
 * области строки этого каталога (Решение 3).
 */
export const row = partRow('step-uses', ['steps'], (ctx) => {
  ctx.steps.register('uses', USES_STEP_KIND);
});
