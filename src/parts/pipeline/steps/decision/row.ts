import { stepDecisionContribution } from './index.js';
import { partRow } from '../../services.js';

/**
 * Строка встроенного слоя: вид шага `decision`. Реализация переехала соседом
 * (`builtin-step-kinds-as-rows`, design.md, Решение 8) — рядом с родственными
 * видами шага (`run`, `uses`, `script`, `agent`), которых каталог
 * `src/parts/pipeline/steps/` до этого пункта не знал вовсе. Прежнего адреса
 * (`src/steps/decision/`) не осталось вовсе: пустые модули-призраки
 * (`export {}`), которыми переезд обошёлся вместо удаления, сняты вместе с
 * каталогом (`source-tree-microkernel-layout`, ступень 2).
 *
 * Первый плагинный вид шага в поставке (`user-decision-steps`, design.md):
 * остановка прогона на решении человека. Строка, а не вид ядра, — её
 * отключение патчем снимает вид `decision`, освобождая имя.
 *
 * Строка-потребитель сервиса `steps` (design.md `pipeline-owns-services`,
 * Решение 2): применяется собственной областью с объявленным `inject`.
 * Владелец вклада остаётся «встроенным»: признак — не корневая область, а
 * пометка области строки этого каталога (Решение 3).
 */
export const row = partRow('step-decision', ['steps'], (ctx) => {
  ctx.steps.register('decision', stepDecisionContribution);
});
