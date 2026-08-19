import { existsSync, readFileSync } from 'node:fs';

import type { Anchor, AnchorKind, TreeAnchorer } from '../anchor/index.js';
import type { Config } from '../config/resolve.js';
import type { RunPaths } from '../journal/paths.js';
import { readManifest, readStatus } from '../journal/reader.js';
import type { JobRecord, RunManifest, RunStatus, StepRecord } from '../journal/schema.js';
import type { ExpandedPipeline, Job, Step } from '../pipeline/model.js';
import { computeStepKey } from './stepKey.js';

/**
 * План переиспользования: что взять из прошлого прогона, что переисполнить и
 * почему именно.
 *
 * План строится до первого шага и служит сразу двум целям — он же вывод
 * `--dry-run`, он же вход исполнителя. Так объяснение инвалидации и
 * фактическое решение гарантированно совпадают: это буквально один объект, а
 * не два согласованных вручную.
 *
 * Основание решения — **изменившиеся пути**, а не сравнение отпечатков.
 * Отпечаток шага снимался тогда, когда дерево было в другом состоянии, и
 * сравнивать его с сегодняшним значило бы сравнивать разные точки времени. А
 * вопрос, на который надо ответить, звучит иначе: что пользователь тронул с
 * тех пор, как прогон закончился, и задевает ли это входы шага.
 */
export type StepDecision =
  | { readonly kind: 'reuse'; readonly record: StepRecord }
  | { readonly kind: 'rerun'; readonly reason: string };

export interface StepPlan {
  readonly job: string;
  readonly step: string;
  readonly decision: StepDecision;
}

export interface ResumePlan {
  readonly sourceRunId: string;
  readonly steps: readonly StepPlan[];
  /** Выходы работ прошлого прогона: подставляются вместо переиспользованных. */
  readonly outputs: ReadonlyMap<string, unknown>;
  /** Наблюдённые входы прошлого прогона: `<работа>/<шаг>` → пути. */
  readonly observedInputs: ReadonlyMap<string, readonly string[]>;
  /**
   * Что и до какого состояния восстановить перед первым переисполнением.
   *
   * Восстанавливаются **только пути, произведённые переиспользованными
   * шагами**. Полный сброс дерева стёр бы то, что пользователь создал после
   * прогона, — в том числе правку, ради которой он и возобновляет.
   */
  readonly restore?: { readonly anchor: Anchor; readonly paths: readonly string[] };
  /** Ничего переиспользовать не удалось: пайплайн идёт с начала. */
  readonly fromScratch: boolean;
}

export interface SourceRun {
  readonly paths: RunPaths;
  readonly manifest: RunManifest;
  readonly status: RunStatus;
}

export function readSourceRun(paths: RunPaths): SourceRun {
  return { paths, manifest: readManifest(paths), status: readStatus(paths) };
}

/** Разобрать `--from`: работа целиком или конкретный шаг работы. */
export interface ResumeFrom {
  readonly job: string;
  readonly step?: string;
}

export function parseFrom(value: string): ResumeFrom {
  const separator = value.indexOf('/');
  if (separator === -1) return { job: value };
  return { job: value.slice(0, separator), step: value.slice(separator + 1) };
}

/**
 * Что пользователь изменил в дереве с момента окончания прошлого прогона.
 * `'all'` означает «неизвестно, считаем что всё»: режим отказа выбран грубым,
 * потому что лишнее переисполнение стоит денег, а тихо устаревший результат —
 * доверия ко всему инструменту.
 */
export type ChangedSince = readonly string[] | 'all';

/** Последнее зафиксированное состояние дерева прошлого прогона. */
export function finalAnchorOf(status: RunStatus, fallback: AnchorKind): Anchor | undefined {
  for (const job of [...status.jobs].reverse()) {
    for (const step of [...job.steps].reverse()) {
      if (step.tree_id !== undefined) {
        return { kind: step.anchor_kind ?? fallback, id: step.tree_id };
      }
    }
  }
  return undefined;
}

/** Пути, изменившиеся между концом прошлого прогона и текущим деревом. */
export function changedSince(
  anchorer: TreeAnchorer,
  from: Anchor | undefined,
  to: Anchor | undefined,
): ChangedSince {
  if (from === undefined || to === undefined) return 'all';
  const comparison = anchorer.changedPaths(from, to);
  return comparison.comparable ? comparison.paths : 'all';
}

export interface BuildPlanOptions {
  readonly expanded: ExpandedPipeline;
  readonly config: Config;
  readonly source: SourceRun;
  readonly lockHash: string;
  readonly changed: ChangedSince;
  readonly from?: ResumeFrom;
  /**
   * Пути, которые шаг изменил в прошлом прогоне. Нужны, чтобы не переиспользовать
   * шаг, чей результат пользователь успел поправить вручную, и чтобы
   * восстановить ровно эти пути, не трогая остальное дерево.
   */
  readonly producedPaths?: (step: StepRecord) => readonly string[] | undefined;
}

export function buildResumePlan(options: BuildPlanOptions): ResumePlan {
  const { expanded, source, from } = options;
  const { pipeline } = expanded;

  const steps: StepPlan[] = [];
  const outputs = new Map<string, unknown>();
  const observedInputs = new Map<string, readonly string[]>();
  const upstream: { job: string; value: unknown }[] = [];
  const produced = new Set<string>();
  let lastReused: StepRecord | undefined;
  let poisoned: string | undefined;

  for (const job of pipeline.jobs) {
    const record = source.status.jobs.find((item) => item.id === job.id);

    for (const step of job.steps) {
      const previous = record?.steps.find((item) => item.id === step.id);
      const address = `${job.id}/${step.id}`;

      if (previous?.observed_inputs !== undefined) {
        observedInputs.set(address, previous.observed_inputs);
      }

      const reason = invalidationReason({ job, step, previous, poisoned, from, options, upstream });

      if (reason === undefined && previous !== undefined) {
        steps.push({ job: job.id, step: step.id, decision: { kind: 'reuse', record: previous } });
        for (const path of options.producedPaths?.(previous) ?? []) produced.add(path);
        lastReused = previous;
        continue;
      }

      steps.push({ job: job.id, step: step.id, decision: { kind: 'rerun', reason: reason ?? '' } });
      // Переисполненный шаг меняет дерево непредсказуемо: всё ниже по графу
      // теряет основание для переиспользования.
      poisoned ??= `пересчитан ${address}`;
    }

    // Выход работы переносится, только если вся работа переиспользована.
    if (steps.filter((plan) => plan.job === job.id).every((plan) => plan.decision.kind === 'reuse')) {
      const value = outputValue(record);
      if (value !== undefined) {
        outputs.set(job.id, value);
        upstream.push({ job: job.id, value });
      }
    }
  }

  const coarsened = coarsenSharedSessions(pipeline.jobs, steps);
  const anyReuse = coarsened.some((plan) => plan.decision.kind === 'reuse');
  const anchor =
    lastReused?.tree_id === undefined
      ? undefined
      : { kind: lastReused.anchor_kind ?? 'git', id: lastReused.tree_id };

  return {
    sourceRunId: source.manifest.run_id,
    steps: coarsened,
    outputs,
    observedInputs,
    ...(anyReuse && anchor !== undefined && produced.size > 0
      ? { restore: { anchor, paths: [...produced].sort() } }
      : {}),
    fromScratch: !anyReuse,
  };
}

function outputValue(record: JobRecord | undefined): unknown {
  if (record?.output === undefined || !existsSync(record.output)) return undefined;
  try {
    return JSON.parse(readFileSync(record.output, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

interface ReasonOptions {
  readonly job: Job;
  readonly step: Step;
  readonly previous: StepRecord | undefined;
  readonly poisoned: string | undefined;
  readonly from: ResumeFrom | undefined;
  readonly options: BuildPlanOptions;
  readonly upstream: readonly { job: string; value: unknown }[];
}

/** Почему шаг признан невалидным. `undefined` — шаг переиспользуется. */
function invalidationReason(input: ReasonOptions): string | undefined {
  const { job, step, previous, poisoned, from, options, upstream } = input;

  if (previous === undefined) return 'в прошлом прогоне шага не было';
  if (previous.status !== 'success') return `в прошлом прогоне шаг завершился: ${previous.status}`;
  if (previous.anchor_missing !== undefined) {
    return 'нет якоря состояния дерева — переиспользовать нечего';
  }
  if (poisoned !== undefined) return poisoned;

  if (from !== undefined && from.job === job.id && (from.step ?? step.id) === step.id) {
    return `указано --from ${from.job}${from.step === undefined ? '' : `/${from.step}`}`;
  }

  const touched = touchedInputs(job, previous, options.changed);
  if (touched !== undefined) return touched;

  // Путь, который произвёл этот шаг, входит в число изменившихся после
  // завершения прогона. Кто именно его тронул — неизвестно и не проверяется:
  // сравнение чисто временное, по хешам содержимого между концом прогона и
  // моментом возобновления. Автором может быть разработчик, хук, линтер или
  // любой другой процесс — переиспользовать результат в любом из этих случаев
  // значило бы объявить действительным то, чего в дереве уже нет.
  if (options.changed !== 'all') {
    const produced = options.producedPaths?.(previous) ?? [];
    const clobbered = options.changed.filter((path) => produced.includes(path));
    if (clobbered.length > 0) return `результат шага тронут после завершения прогона (${list(clobbered)})`;
  }

  // Отпечаток берётся из записи: он нейтрализует вклад дерева, и расхождение
  // ключа после этого означает изменение самого шага, а не состояния вокруг.
  const key = computeStepKey({
    lockHash: options.lockHash,
    jobId: job.id,
    step,
    inputsFingerprint: previous.inputs_fingerprint,
    backendCommand:
      step.kind === 'agent' ? options.config.backends[step.agent]?.command : undefined,
    upstream,
  });

  return key === previous.key ? undefined : 'изменилось определение шага, промпт или бэкенд';
}

/**
 * Задевают ли изменения пользователя входы шага.
 *
 * Ширина входов определяется тем же трёхуровневым правилом, что и отпечаток:
 * объявленные пути работы, наблюдённые файлы прошлого исполнения, иначе — всё
 * дерево. Последнее означает, что любая правка обесценивает шаг: это заявленное
 * умолчание, а не дефект.
 */
function touchedInputs(
  job: Job,
  previous: StepRecord,
  changed: ChangedSince,
): string | undefined {
  if (changed === 'all') return 'состояние дерева установить не удалось — считаем изменённым';
  if (changed.length === 0) return undefined;

  const scope =
    job.inputs.length > 0
      ? job.inputs
      : previous.inputs_origin === 'observed'
        ? previous.observed_inputs
        : undefined;

  if (scope === undefined) {
    return `дерево изменилось (${list(changed)})`;
  }

  const hit = changed.filter((path) => scope.some((entry) => covers(entry, path)));
  return hit.length === 0 ? undefined : `изменились входы шага (${list(hit)})`;
}

/** Совпадает ли объявленный вход с изменившимся путём: файл или его каталог. */
function covers(entry: string, path: string): boolean {
  const normalized = entry.endsWith('/') ? entry.slice(0, -1) : entry;
  return path === normalized || path.startsWith(`${normalized}/`);
}

function list(paths: readonly string[]): string {
  return paths.length <= 3
    ? paths.join(', ')
    : `${paths.slice(0, 3).join(', ')} и ещё ${paths.length - 3}`;
}

/**
 * Огрубление для общей сессии.
 *
 * При `session: shared` результат шага зависит от диалога, которого при
 * частичном повторе не существует. Разрешить пошаговый повтор здесь означало бы
 * разрешить результат, полученный из другого разговора, чем записанный, —
 * поэтому единицей повтора становится работа целиком, и это не настройка.
 */
function coarsenSharedSessions(jobs: readonly Job[], steps: readonly StepPlan[]): StepPlan[] {
  const result = [...steps];

  for (const job of jobs) {
    if (job.session !== 'shared') continue;

    const indices = result
      .map((plan, index) => ({ plan, index }))
      .filter(({ plan }) => plan.job === job.id);
    if (!indices.some(({ plan }) => plan.decision.kind === 'rerun')) continue;

    for (const { plan, index } of indices) {
      if (plan.decision.kind === 'rerun') continue;
      result[index] = {
        ...plan,
        decision: {
          kind: 'rerun',
          reason: 'работа объявляет session: shared — единицей повтора является работа целиком',
        },
      };
    }
  }

  return result;
}

/** Человекочитаемый отчёт: он же вывод `--dry-run`, он же основание решения. */
export function describePlan(plan: ResumePlan): string[] {
  const width = Math.max(...plan.steps.map((step) => `${step.job}/${step.step}`.length), 0);

  const lines = plan.steps.map((item) => {
    const address = `${item.job}/${item.step}`.padEnd(width);
    return item.decision.kind === 'reuse'
      ? `${address}  переиспользуется из ${plan.sourceRunId.slice(-6)}`
      : `${address}  переисполняется — ${item.decision.reason}`;
  });

  if (plan.fromScratch) lines.push('переиспользовать нечего: пайплайн исполняется с начала');
  return lines;
}

/**
 * Пути, которые шаг изменил в прошлом прогоне: разница между его якорями на
 * начало и конец. Без этого нельзя ни заметить, что результат шага правили
 * руками, ни восстановить ровно его, не трогая остального дерева.
 */
export function producedBy(
  anchorer: TreeAnchorer,
  step: StepRecord,
): readonly string[] | undefined {
  if (step.tree_before === undefined || step.tree_id === undefined) return undefined;
  if (step.tree_before === step.tree_id) return [];

  const kind = step.anchor_kind ?? 'git';
  const comparison = anchorer.changedPaths(
    { kind, id: step.tree_before },
    { kind, id: step.tree_id },
  );
  return comparison.comparable ? comparison.paths : undefined;
}
