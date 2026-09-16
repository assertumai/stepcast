import { SCRIPT_STEP_KIND } from '../../document/expand.js';
import { partRow } from '../../services.js';

/**
 * Строка встроенного слоя: вид шага `script` (`builtin-step-kinds-as-rows`,
 * design.md, Решение 1). Внутренняя форма разбора остаётся в
 * `src/parts/pipeline/document/expand.ts` (design.md, «Альтернатива — переселить разбор
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
 * Строка-потребитель сервиса `steps` (design.md `pipeline-owns-services`,
 * Решение 2): применяется собственной областью с объявленным `inject`.
 * Владелец вклада остаётся «встроенным»: признак — не корневая область, а
 * пометка области строки этого каталога (Решение 3).
 */
export const row = partRow('step-script', ['steps'], (ctx) => {
  ctx.steps.register('script', SCRIPT_STEP_KIND);
});
