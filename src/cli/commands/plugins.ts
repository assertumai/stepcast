import type { ResolvedConfig } from '../../core/config/resolve.js';
import { ExitCode, type ExitCodeValue } from '../../core/errors.js';
import { inspectPluginTree, type LoadOptions, type RowOutcome } from '../../core/plugins/load.js';
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

function describeLayer(row: RowOutcome['row']): string {
  return row.source.kind === 'builtin' ? 'встроенный' : row.source.path;
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
 * Путь успеха: дерево приходит то самое, которым точка входа собрала реестр
 * (`CommandEnv.pluginTree`), а не прочитанное со слоёв заново — иначе правка
 * патча между разрешением и вызовом команды развела бы напечатанное дерево с
 * загруженным составом. Состояние каждой строки — прямо из её `enabled`:
 * загрузка уже прошла целиком без отказа, раз команда сюда дошла обычным
 * путём.
 */
export function runPluginsCommand(
  write: (line: string) => void,
  tree: readonly TreeRow[],
): ExitCodeValue {
  const outcomes: RowOutcome[] = tree.map((row) => ({
    row,
    status: row.enabled ? 'active' : 'disabled',
  }));
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
