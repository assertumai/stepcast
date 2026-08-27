import { StepcastError } from '../errors.js';
import { interpolateTree } from './interpolate.js';
import type { Job } from './model.js';

/**
 * Раскрытие отложенных подстановок перед исполнением работы.
 *
 * Пространства `jobs`, `run` и `env` при разборе документа остаются текстом:
 * их значения появляются только по ходу прогона. Раскрываются они здесь, одним
 * проходом по определению работы.
 *
 * Проход по готовой модели, а не повторная сборка из сырого тела, возможен
 * благодаря тому, что отложенный текст переживает подстановку параметров:
 * `with: { change: "${jobs.plan.output.slug}" }` кладёт в `params.change`
 * литерал, `${params.change}` внутри файла работы раскрывается в него же, и к
 * этому моменту поля работы содержат `${jobs.plan.output.slug}` напрямую.
 */

/** Состав пространства `run`. Величины уровня шага приходят переменными
 * окружения `STEPCAST_JOB_DIR` и `STEPCAST_STEP_DIR`: на уровне работы у них
 * нет значения, и обещать их подстановкой было бы неправдой. */
export interface RunScope {
  readonly id: string;
  readonly dir: string;
  readonly workspace: string;
  /** Каталог черновиков работы — тот же, что доходит до шага `STEPCAST_SCRATCH`. */
  readonly scratch: string;
}

export interface JobScopeEntry {
  readonly status: string;
  readonly output?: unknown;
}

export interface LateScope {
  /** Исходы и выходы завершившихся работ. Незавершённых здесь нет. */
  readonly jobs: Readonly<Record<string, JobScopeEntry>>;
  readonly run: RunScope;
  readonly env: Readonly<Record<string, string>>;
}

const RUN_NAMES = ['id', 'dir', 'workspace', 'scratch'];

/**
 * Почему значения нет. Отсутствующее поле выглядит одинаково во всех трёх
 * случаях, а означает разное, и разбираться с этим по пути контекста, который
 * получился с пустотой посередине, пришлось бы уже на три шага дальше.
 */
function explain(scope: LateScope) {
  return (expression: string, namespace: string, path: string): string | undefined => {
    if (namespace === 'run') {
      return `Пространство run содержит только ${RUN_NAMES.join(', ')}; величины уровня шага приходят переменными STEPCAST_JOB_DIR и STEPCAST_STEP_DIR`;
    }

    if (namespace !== 'jobs') return undefined;

    const [jobId] = path.split('.');
    if (jobId === undefined || !(jobId in scope.jobs)) {
      return `Работа ${jobId ?? '?'} к этому моменту не завершилась: подстановка доступна только из работы ниже по графу`;
    }

    const entry = scope.jobs[jobId] as JobScopeEntry;
    if (entry.output === undefined) {
      return entry.status === 'success'
        ? `Работа ${jobId} завершилась успехом, но выхода не публикует: объявите output в её определении`
        : `Работа ${jobId} завершилась со статусом ${entry.status}, а выход упавшей работы не публикуется`;
    }

    return `Проверьте состав выхода работы ${jobId}`;
  };
}

/** Раскрыть отложенные подстановки в определении работы. */
export function resolveLate(job: Job, scope: LateScope): Job {
  try {
    return interpolateTree(
      job,
      {
        values: { jobs: scope.jobs, run: scope.run, env: scope.env },
        deferred: new Set(),
        mode: 'late',
        explain: explain(scope),
      },
      `jobs.${job.id}`,
    ).value;
  } catch (error) {
    // Файл, из которого пришло определение, интерполятору неизвестен, а без
    // него сообщение не говорит, где искать.
    if (error instanceof StepcastError && error.file === undefined) {
      throw new StepcastError(error.message, {
        file: job.source,
        ...(error.at === undefined ? {} : { at: error.at }),
        ...(error.hint === undefined ? {} : { hint: error.hint }),
      });
    }
    throw error;
  }
}
