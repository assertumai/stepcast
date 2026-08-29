import { realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

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
  /**
   * Объявленный состав вложенных репозиториев (`project.nested_repos`).
   * Приходит значением, а не конфигурацией целиком: предстартовым проверкам
   * не нужно ничего, кроме состава, и тянуть сюда `Config` значило бы тянуть
   * зависимость, которой здесь не место.
   */
  readonly nestedRepos?: readonly string[];
}

export type PreflightCheck = (options: PreflightOptions) => void;

/** Режим рабочей директории должен быть подготавливаемым в этом окружении. */
export const checkWorkspaceMode: PreflightCheck = ({ expanded, cwd, nestedRepos }) => {
  checkWorkspaceAvailability({ pipeline: expanded.pipeline, cwd, ...(nestedRepos === undefined ? {} : { nestedRepos }) });
};

/**
 * Разрешить путь до реального, поднимаясь к первому существующему предку.
 * `realpathSync` требует, чтобы путь существовал целиком, а `runsRoot` на
 * первом прогоне ещё не создан — резолвим то, что есть, и дописываем остаток
 * буквально: несуществующий хвост не может содержать симлинков.
 */
function realOrLiteral(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return join(realOrLiteral(parent), absolute.slice(parent.length + 1));
  }
}

/**
 * Журнал прогона обязан лежать вне рабочего дерева.
 *
 * Иначе он попадает в якорь состояния: каждый шаг «меняет дерево» самим фактом
 * записи собственного журнала, отпечатки перестают совпадать, `changed_only`
 * срабатывает на `events.ndjson`, а возобновление перестаёт переиспользовать
 * что-либо. Поймать это по симптомам почти невозможно, поэтому проверяем.
 *
 * Сравнение идёт по разрешённым (без символических ссылок) путям: `cwd`
 * приходит от `process.cwd()`, который на POSIX уже резолвит симлинки, а
 * `runsRoot` строится из `homedir()` в исходном виде — если домашний каталог
 * сам достижим через ссылку (например, `/tmp` → `/private/tmp` на macOS),
 * буквальное сравнение молчит там, где должно сработать.
 */
export const checkRunsRootOutsideTree: PreflightCheck = ({ expanded, cwd, runsRoot }) => {
  const tree = realOrLiteral(cwd);
  const runs = realOrLiteral(runsRoot);
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
