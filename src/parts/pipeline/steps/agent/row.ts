import { AGENT_STEP_KIND } from '../../document/expand.js';
import { partRow } from '../../services.js';

/**
 * Строка встроенного слоя: вид шага `agent` (`builtin-step-kinds-as-rows`,
 * design.md, Решение 1). Внутренняя форма разбора остаётся в
 * `src/parts/pipeline/document/expand.ts` (design.md, «Альтернатива — переселить разбор
 * вместе со строкой», отклонена).
 *
 * Импорт верхнего уровня, обращение к `AGENT_STEP_KIND` — внутри тела
 * `apply`: тот же приём разводки цикла модулей, что у строки `step-run`.
 *
 * Строка-потребитель сервиса `steps` (design.md `pipeline-owns-services`,
 * Решение 2): применяется собственной областью с объявленным `inject`.
 * Владелец вклада остаётся «встроенным»: признак — не корневая область, а
 * пометка области строки этого каталога (Решение 3).
 */
export const row = partRow('step-agent', ['steps'], (ctx) => {
  ctx.steps.register('agent', AGENT_STEP_KIND);
});
