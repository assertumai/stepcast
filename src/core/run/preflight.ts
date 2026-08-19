import { resolve, sep } from 'node:path';

import { StepcastError } from '../errors.js';
import type { ExpandedPipeline } from '../pipeline/model.js';
import { checkWorkspaceAvailability } from './workspace.js';

/**
 * Предстартовые проверки.
 *
 * Всё, что делает прогон заведомо неисполнимым и видно заранее, проверяется
 * здесь — один раз, до запуска первой работы. Отказ на пятой работе из семи
 * после сорока минут работы агента недопустим, если то же самое было видно на
 * нулевой секунде.
 *
 * Проверки возвращают ошибку конфигурации: работа не начиналась, терять
 * нечего. Всё, что нельзя узнать до старта, здесь не проверяется и на
 * исполнение не влияет — см. `bookkeeping.ts`.
 */
export interface PreflightOptions {
  readonly expanded: ExpandedPipeline;
  readonly projectRoot: string;
  readonly cwd: string;
  /** Корень каталога прогонов: он обязан лежать вне рабочего дерева. */
  readonly runsRoot: string;
}

export type PreflightCheck = (options: PreflightOptions) => void;

/** Режим рабочей директории должен быть подготавливаемым в этом окружении. */
export const checkWorkspaceMode: PreflightCheck = ({ expanded, cwd }) => {
  checkWorkspaceAvailability({ pipeline: expanded.pipeline, cwd });
};

/**
 * Журнал прогона обязан лежать вне рабочего дерева.
 *
 * Иначе он попадает в якорь состояния: каждый шаг «меняет дерево» самим фактом
 * записи собственного журнала, отпечатки перестают совпадать, `changed_only`
 * срабатывает на `events.ndjson`, а возобновление перестаёт переиспользовать
 * что-либо. Поймать это по симптомам почти невозможно, поэтому проверяем.
 */
export const checkRunsRootOutsideTree: PreflightCheck = ({ expanded, cwd, runsRoot }) => {
  const tree = resolve(cwd);
  const runs = resolve(runsRoot);
  if (runs !== tree && !runs.startsWith(`${tree}${sep}`)) return;

  throw new StepcastError(`Каталог прогонов лежит внутри рабочего дерева: ${runs}`, {
    file: expanded.pipeline.file,
    at: 'runs.root',
    hint: 'Журнал прогона попал бы в состояние дерева и обесценил бы каждый шаг. Вынесите runs.root за пределы проекта',
  });
};

const CHECKS: readonly PreflightCheck[] = [checkWorkspaceMode, checkRunsRootOutsideTree];

export function preflight(options: PreflightOptions): void {
  for (const check of CHECKS) check(options);
}
