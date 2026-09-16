import { StepcastError } from '../../../kernel/errors.js';
import { hasStepExecutor } from '../contract.js';
import type { Registry } from '../../../kernel/registry.js';
import { interpolateTree, interpolateTypedTree, type Scope } from './interpolate.js';
import type { Job, Step } from './model.js';

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
  /** Данные, опубликованные работой по ходу исполнения (`stepcast data`). */
  readonly data?: Readonly<Record<string, string>>;
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

    if (path.split('.')[1] === 'data') {
      const published = Object.keys(entry.data ?? {});
      return published.length === 0
        ? `Работа ${jobId} данных не публиковала: их пишет сама работа командой stepcast data`
        : `Работа ${jobId} опубликовала данные ${published.join(', ')}`;
    }

    if (entry.output === undefined) {
      return entry.status === 'success'
        ? `Работа ${jobId} завершилась успехом, но выхода не публикует: объявите output в её определении`
        : `Работа ${jobId} завершилась со статусом ${entry.status}, а выход упавшей работы не публикуется`;
    }

    return `Проверьте состав выхода работы ${jobId}`;
  };
}

/**
 * `input` шага `script` и блок `uses` сняты перед обходом — тем же приёмом,
 * что и `display`.
 *
 * `uses` снимается целиком, а не одним полем: он несёт **вторую копию** тех же
 * нераскрытых значений (`params` — сведённый `with`) и, сверх того, схему
 * параметров манифеста (`paramsSchema`). Общий `interpolateTree` раскрыл бы
 * `${jobs.plan.output.item}` в копии строкой — и упал бы на объекте и списке
 * прежде, чем работа дошла до шага; а `description` или `pattern` схемы, где
 * `${` — литерал автора манифеста, он принял бы за подстановку. Обе величины
 * возвращаются на место в `resolveLate` — `params` наравне с `input`,
 * `paramsSchema` нетронутой.
 */
function omitLateSkipped(step: Step): Step {
  // `fields` шага плагинного вида — та же забота, что и `input`/`uses` ниже
  // (design.md, решение 5): типизированный проход раскрывает его отдельно,
  // ниже в `resolveLate`. `fields` — обязательное поле модели (в отличие от
  // необязательных `input`/`uses`), поэтому снимается не destructure, а
  // подменой на нейтральный `null`, который общий обход пропустит нетронутым.
  if (step.kind === 'plugin') return { ...step, fields: null };
  if (step.kind !== 'script') return step;
  if (step.input === undefined && step.uses === undefined) return step;
  const { input: _input, uses: _uses, ...rest } = step;
  return rest;
}

/**
 * Раскрыть отложенные подстановки в определении работы.
 *
 * Блок `display` через раскрытие не проходит вовсе: его не потребляет ни один
 * шаг — его читает витрина, — а к этому моменту работа ещё не исполнялась и
 * собственных данных не публиковала. Раскрытый здесь, он навсегда застыл бы
 * пустым. Поэтому блок отделяется до обхода и возвращается на место как был.
 *
 * `input` шагов `script` отделяется по той же причине, что и при разборе
 * документа (`expand.ts`, `omitStepInputs`): общий `interpolateTree` раскрыл
 * бы `${jobs.plan.output.item}` строкой, а не объектом. Типизированный проход
 * зовётся здесь же, отдельно на каждый шаг, — теперь уже по-настоящему
 * отложенными `${jobs.*}`, `${run.*}` и `${env.*}`.
 *
 * Блок `uses` шага, собранного из манифеста, отделяется вместе с `input`
 * (`omitLateSkipped`) и возвращается с тем же раскрытым значением: `params`
 * там — та же величина, что и `input` шага, и разъехаться им нельзя, иначе
 * замок и витрина показали бы параметры, отличные от уехавших в `input.json`.
 *
 * Реестр нужен здесь одному — адресу непроходимой подстановки в полях шага
 * плагинного вида: у вклада с собственной формой записи имя вида в документе
 * не звучит вовсе, и `jobs.build.steps.0.deploy-kind` назвал бы путь, которого
 * в файле нет. Адрес поэтому тот же, что у всех прочих отказов этого вида, —
 * адрес самого шага (design.md изменения `step-kind-document-contract`,
 * Решение 6). Реестр необязателен: раскрытие вызывают и там, где плагинных
 * видов нет вовсе, а вклад без собственной формы записи адресуется своим
 * ключом и без него.
 */
export function resolveLate(job: Job, scope: LateScope, registry?: Registry): Job {
  const { display, ...resolvable } = job;
  const lateScope: Scope = {
    values: { jobs: scope.jobs, run: scope.run, env: scope.env },
    deferred: new Set(),
    mode: 'late',
    explain: explain(scope),
  };
  try {
    const stepsWithoutInput = resolvable.steps.map(omitLateSkipped);
    const resolved = interpolateTree(
      { ...resolvable, steps: stepsWithoutInput },
      lateScope,
      `jobs.${job.id}`,
    ).value;
    const resolvedSteps = resolved.steps.map((step, index) => {
      const original = resolvable.steps[index];
      if (original === undefined) return step;
      if (original.kind === 'plugin' && step.kind === 'plugin') {
        const contribution = registry?.steps.get(original.name);
        const ownDocument =
          contribution !== undefined && hasStepExecutor(contribution) && contribution.document !== undefined;
        const base = `jobs.${job.id}.steps.${index}`;
        const at = ownDocument ? base : `${base}.${original.name}`;
        return { ...step, fields: interpolateTypedTree(original.fields, lateScope, at).value };
      }
      if (original.kind !== 'script' || step.kind !== 'script') return step;
      if (original.input === undefined && original.uses === undefined) return step;
      // Место объявления в документе: у шага `uses` это `with`, у шага
      // `script` — `input`. Сообщение о непроходимой подстановке должно
      // называть ключ, который автор действительно писал.
      const at =
        original.uses === undefined
          ? `jobs.${job.id}.steps.${index}.input`
          : `jobs.${job.id}.steps.${index}.with`;
      const input =
        original.input === undefined
          ? undefined
          : interpolateTypedTree(original.input, lateScope, at).value;
      // `params` блока `uses` и `input` шага — одна и та же величина:
      // `expand.ts` кладёт в `input` ровно сведённый `with`. Раскрытая один
      // раз, она ставится обеим, чтобы замок и `input.json` не разъехались.
      const params =
        original.uses?.params === undefined
          ? undefined
          : original.uses.params === original.input
            ? (input as Readonly<Record<string, unknown>>)
            : interpolateTypedTree(original.uses.params, lateScope, at).value;
      return {
        ...step,
        ...(input === undefined ? {} : { input }),
        ...(original.uses === undefined
          ? {}
          : { uses: { ...original.uses, ...(params === undefined ? {} : { params }) } }),
      };
    });
    const withSteps = { ...resolved, steps: resolvedSteps };
    return display === undefined ? withSteps : { ...withSteps, display };
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
