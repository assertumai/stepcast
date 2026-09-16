import { stepDecisionContribution } from './index.js';
import type { BuiltinRow } from '../../../core/plugins/load.js';

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
