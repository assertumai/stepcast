import type { ResolvedConfig } from '../../core/config/resolve.js';
import { ExitCode, type ExitCodeValue } from '../../core/errors.js';
import { inspectPluginTree, rowFailureError, type LoadOptions, type RowOutcome } from '../../core/plugins/load.js';
import type { TreeRow } from '../../core/plugins/tree.js';
import { formatColumns } from '../output.js';

/**
 * Команда осмотра дерева плагинов (`plugin-tree`, design.md, Решение 8):
 * печатает итоговый состав — порядок, `id`, слой, модуль, состояние — тем же
 * образом, каким `stepcast config` печатает действующую конфигурацию.
 *
 * Флаг `--dump` объявлен ради совместимости с пунктом очереди и с
 * `plugin-introspection`, но поведение команды от него не зависит: печать
 * дерева — единственное, что она умеет.
 */

/** Слой строки: «встроенный», путь файла либо каталог плагина с его слоем (`user-plugins`, задача 3.3). */
function describeLayer(row: RowOutcome['row']): string {
  switch (row.source.kind) {
    case 'builtin':
      return 'встроенный';
    case 'file':
      return row.source.path;
    case 'directory':
      return `${row.source.dir} (${row.source.layer === 'project' ? 'проект' : 'дом'})`;
  }
}

function describeState(outcome: RowOutcome): string {
  switch (outcome.status) {
    case 'active':
      return 'действует';
    case 'disabled':
      return 'отключена';
    case 'not-attempted':
      return 'не загружалась';
    case 'failed':
      return `отказ: ${outcome.error?.message ?? 'неизвестная причина'}`;
  }
}

/**
 * Итог строки, выведенный из неё самой, — для вызывающего, который плагинов не
 * загружал (реестр пришёл готовым, `resolveWithPlugins` с полем `registry`).
 * Заведомый отказ (`TreeRow.failure`) виден и здесь, со своей причиной: иначе
 * каталог, названный именем встроенной строки, печатался бы действующим.
 */
export function outcomeWithoutLoad(row: TreeRow): RowOutcome {
  const failure = rowFailureError(row);
  if (failure !== undefined) return { row, status: 'failed', error: failure };
  return { row, status: row.enabled ? 'active' : 'disabled' };
}

/** Печать дерева столбцами: место, id, слой, модуль, состояние. */
export function renderPluginTree(outcomes: readonly RowOutcome[]): string[] {
  const rows = outcomes.map((outcome, index) => [
    String(index + 1),
    outcome.row.id,
    describeLayer(outcome.row),
    outcome.row.use,
    describeState(outcome),
  ]);
  return formatColumns(rows);
}

/**
 * Путь успеха: итоги строк приходят те самые, которыми точка входа собрала
 * реестр (`CommandEnv.pluginOutcomes`, `resolveWithPlugins`), а не выведенные
 * из дерева заново — иначе отказ каталожной строки, ставший её состоянием
 * (design.md, Решение 10), не был бы виден в печати вовсе: с одним `enabled`
 * такая строка неотличима от действующей. Отказ отдельной каталожной строки
 * не меняет код возврата — команда исполнилась, дерево напечатано целиком
 * (`plugin-tree`, «Отказ найденной обходом строки не прекращает команду»).
 */
export function runPluginsCommand(
  write: (line: string) => void,
  outcomes: readonly RowOutcome[],
): ExitCodeValue {
  for (const line of renderPluginTree(outcomes)) write(line);
  return ExitCode.ok;
}

/**
 * Путь после отказа загрузки (design.md, Решение 8): дерево берётся заново из
 * уже разрешённой конфигурации (`resolved`, разобрана точкой входа до того,
 * как определилось, что это команда `plugins`), а per-строчный итог — из
 * `inspectPluginTree`, которая не бросает на первом отказе.
 */
export async function runPluginsCommandAfterLoadFailure(
  write: (line: string) => void,
  resolved: ResolvedConfig,
  loadOptions: LoadOptions,
): Promise<ExitCodeValue> {
  const outcomes = await inspectPluginTree(resolved, loadOptions);
  for (const line of renderPluginTree(outcomes)) write(line);
  return ExitCode.configError;
}
