import { stepDecisionContribution } from './index.js';
import { partRow } from '../../pipeline/services.js';

/**
 * Строка встроенного слоя: вид шага `decision`. Реализация переехала соседом
 * (`builtin-step-kinds-as-rows`, design.md, Решение 8) — рядом с родственными
 * видами шага (`run`, `uses`, `script`, `agent`), которых каталог
 * `src/parts/steps/` до этого пункта не знал вовсе. Реализации по прежнему
 * адресу (`src/steps/decision/`) не осталось: там лежат пустые модули
 * (`export {}`) с объяснением переезда — снять отслеживаемый git файл
 * инструменты сессии переноса не смогли (`agent-cannot-clean-up`, Non-Goal
 * «право удалять файлы»), и удаление каталога остаётся отдельной правкой.
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
