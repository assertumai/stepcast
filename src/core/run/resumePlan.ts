import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import {
  createAnchorer,
  detectAnchorKind,
  manifestStore,
  type Anchor,
  type AnchorKind,
  type TreeAnchorer,
} from '../anchor/index.js';
import type { Config } from '../config/resolve.js';
import { StepcastError } from '../errors.js';
import type { RunPaths } from '../journal/paths.js';
import { readManifest, readStatus } from '../journal/reader.js';
import type { JobRecord, RunManifest, RunStatus, StepRecord } from '../journal/schema.js';
import { expandPipeline } from '../pipeline/expand.js';
import { jobLockHash } from '../pipeline/lock.js';
import { definitionFiles, type ExpandedPipeline, type Job, type Pipeline, type Step } from '../pipeline/model.js';
import { buildGraph, executionOrder, upstreamOutputs } from '../graph.js';
import { computeStepKey, upstreamForKey } from './stepKey.js';

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
   * Чужие правки выше точки `--from`, проигнорированные решением запускающего.
   * Пусто, если `--from` не указан или выше точки правок не было.
   */
  readonly ignoredEdits: readonly string[];
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
  /**
   * Работа, которой достаётся выдержка о прошлом отказе: первая в порядке
   * исполнения, чей **агентский** шаг переисполняется. Названа планом, а не
   * выведена из прогона: выдержку разбирает тот, кто отказ переигрывает, а при
   * параллельном исполнении «первый переисполняемый шаг» — это тот, кто успел,
   * то есть никто определённый.
   *
   * Требование про агентский шаг здесь не украшение: у работы из одних `run`
   * выдержку читать некому, и назвав её адресатом, план потерял бы выдержку
   * молча. Пусто, если переисполняемых агентских шагов в плане нет вовсе.
   */
  readonly failureNoteJob?: string;
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

/**
 * Последнее зафиксированное состояние дерева прошлого прогона.
 *
 * Последняя — та, что **завершилась** последней, а не та, что стоит последней
 * в состоянии прогона: работы перечислены там в порядке объявления, а
 * исполняются в порядке графа. Взять анкер по месту в списке значило бы у
 * пайплайна, где работа объявлена раньше своей зависимости, объявить конечным
 * состоянием промежуточное — и весь вывод исполнившихся позже работ выглядел
 * бы правкой пользователя.
 */
export function finalAnchorOf(status: RunStatus, fallback: AnchorKind): Anchor | undefined {
  const byFinish = [...status.jobs]
    .map((job, index) => ({ job, index }))
    .sort((a, b) => {
      const left = a.job.finished_at ?? '';
      const right = b.job.finished_at ?? '';
      return left === right ? a.index - b.index : left < right ? -1 : 1;
    })
    .map((item) => item.job);

  for (const job of byFinish.reverse()) {
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
  readonly changed: ChangedSince;
  /** Каталог, относительно которого сравнение якорей отдаёт пути. */
  readonly cwd: string;
  readonly from?: ResumeFrom;
  /**
   * Пути, которые шаг изменил в прошлом прогоне. Нужны, чтобы не переиспользовать
   * шаг, чей результат пользователь успел поправить вручную, и чтобы
   * восстановить ровно эти пути, не трогая остальное дерево.
   */
  readonly producedPaths?: (step: StepRecord) => readonly string[] | undefined;
  /**
   * Причина, которой снабжается инвалидация каждого шага, когда `changed`
   * пришёл значением `'all'`. По умолчанию — «состояние дерева установить не
   * удалось». Несовпадение состава вложенных репозиториев исходного прогона
   * с сегодняшним — другой случай «сравнить нечем», и называет обе стороны
   * состава, а не путает читателя с обычным отказом снятия якоря
   * (`planResume`).
   */
  readonly allReason?: string;
}

export function buildResumePlan(options: BuildPlanOptions): ResumePlan {
  const { expanded, source, from, cwd } = options;
  const { pipeline } = expanded;

  // Файл пайплайна и файлы работ уже учтены ключом шага: их правка даёт
  // несовпадение ключа ровно у тех шагов, чьё определение изменилось. Оставить
  // их в множестве изменений значило бы гасить весь пайплайн любой правкой
  // любой работы.
  const changed = excludeDefinitionFiles(options.changed, pipeline, cwd);
  // Порядок обхода — тот, в котором работы доходили до исполнения: от него
  // зависят и каскад пересчёта, и состав выходов работ выше по графу.
  const graph = buildGraph(pipeline).graph;
  const order = executionOrder(graph);
  // Что произвёл сам исходный прогон: считается один раз на план, а не на
  // каждый шаг.
  const producedFrom = attributionIndex(source, options.producedPaths, order);

  const steps: StepPlan[] = [];
  const outputs = new Map<string, unknown>();
  const observedInputs = new Map<string, readonly string[]>();
  const ignoredEdits = new Set<string>();
  const upstream: { job: string; value: unknown }[] = [];
  const produced = new Set<string>();
  let lastReused: StepRecord | undefined;
  let poisoned: string | undefined;
  // Обход идёт в порядке исполнения, а не объявления: и каскад пересчёта, и
  // выходы работ выше по графу описывают то, что к этому моменту уже
  // завершилось. Работа, объявленная раньше своей зависимости, в порядке
  // объявления получила бы и пустой `upstream`, и невидимый каскад. Точка
  // `--from` отмечается по ходу того же прохода.
  let reachedFrom = false;

  for (const job of order) {
    const record = source.status.jobs.find((item) => item.id === job.id);
    // Работа объявила выход, и артефакт исходного прогона недоступен —
    // удалён уборкой или испорчен. Переиспользовать её значило бы отдать
    // нижележащим `${jobs.<id>.output.*}`, разрешающийся в ничто.
    //
    // Работа, не опубликовавшая выход вовсе, сюда не относится: её запись
    // пути к артефакту не содержит, и переиспользование воспроизводит ровно
    // то состояние, в каком исходный прогон и был. Считать этот случай
    // недоступностью значило бы вечно переисполнять работу, чей агентский шаг
    // просто не вернул структурированный вывод, — с причиной, называющей
    // несуществующую пропажу.
    const outputUnrecoverable =
      job.output !== undefined && record?.output !== undefined && outputValue(record) === undefined;

    for (const step of job.steps) {
      const previous = record?.steps.find((item) => item.id === step.id);
      const address = `${job.id}/${step.id}`;

      if (previous?.observed_inputs !== undefined) {
        observedInputs.set(address, previous.observed_inputs);
      }

      const isFromPoint =
        from !== undefined && from.job === job.id && (from.step ?? step.id) === step.id;
      if (isFromPoint) reachedFrom = true;
      // Всё до точки `--from` в порядке исходного прогона — «верх графа»:
      // изменения дерева и каскад пересчёта его не касаются.
      const isAbove = from !== undefined && !reachedFrom;

      const outcome = invalidationReason({
        job,
        step,
        previous,
        poisoned,
        from,
        isAbove,
        isFromPoint,
        options,
        // Тот же состав, что видит исполнитель: работы выше по графу, а не
        // всё, что успело завершиться. Иначе ключ, посчитанный планом, не
        // совпал бы с записанным прогоном, и переиспользование отказало бы.
        upstream: upstreamOutputs(graph, job.id, upstream),
        changed,
        producedAfter: producedFrom.get(address) ?? EMPTY_SET,
        outputUnrecoverable,
      });

      for (const path of outcome.ignoredEdits ?? []) ignoredEdits.add(path);

      if (outcome.reason === undefined && previous !== undefined) {
        steps.push({ job: job.id, step: step.id, decision: { kind: 'reuse', record: previous } });
        for (const path of options.producedPaths?.(previous) ?? []) produced.add(path);
        lastReused = previous;
        continue;
      }

      steps.push({ job: job.id, step: step.id, decision: { kind: 'rerun', reason: outcome.reason ?? '' } });
      // Переисполненный шаг меняет дерево непредсказуемо: всё ниже по графу
      // теряет основание для переиспользования. Выше точки `--from` каскад
      // тоже нужен, и подавлять его там нельзя: дерево выше точки не судится,
      // поэтому переисполнение там вызвано не правкой файлов, а существом —
      // записи нет, ключ разошёлся, прошлый статус не success. Такой шаг
      // производит новый вывод, и переиспользовать поверх него следующий
      // значило бы объявить действительным заведомо устаревшее.
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
  const agentAddresses = new Set(
    pipeline.jobs.flatMap((job) =>
      job.steps.filter((step) => step.kind === 'agent').map((step) => `${job.id}/${step.id}`),
    ),
  );
  const failureNoteJob = coarsened.find(
    (plan) => plan.decision.kind === 'rerun' && agentAddresses.has(`${plan.job}/${plan.step}`),
  )?.job;
  const anchor =
    lastReused?.tree_id === undefined
      ? undefined
      : { kind: lastReused.anchor_kind ?? 'git', id: lastReused.tree_id };

  // Чужая правка выше точки `--from` попадает в `produced` вместе с прочим
  // выводом переиспользованного шага — по происхождению пути, а не по тому,
  // тронул ли его кто-то после прогона. Восстановить такой путь значит стереть
  // ровно ту правку, ради которой чаще всего и возобновляют: `--from` обещает
  // её проигнорировать, а не отменить.
  const restorable = [...produced].filter((path) => !ignoredEdits.has(path));

  return {
    sourceRunId: source.manifest.run_id,
    steps: coarsened,
    outputs,
    observedInputs,
    ignoredEdits: [...ignoredEdits].sort(),
    ...(anyReuse && anchor !== undefined && restorable.length > 0
      ? { restore: { anchor, paths: restorable.sort() } }
      : {}),
    fromScratch: !anyReuse,
    ...(failureNoteJob === undefined ? {} : { failureNoteJob }),
  };
}

const EMPTY_SET: ReadonlySet<string> = new Set();

function describeComposition(nestedRepos: readonly string[]): string {
  return nestedRepos.length === 0 ? '(без вложенных репозиториев)' : nestedRepos.join(', ');
}

function outputValue(record: JobRecord | undefined): unknown {
  if (record?.output === undefined || !existsSync(record.output)) return undefined;
  try {
    return JSON.parse(readFileSync(record.output, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Файлы определения прогона исключаются из множества изменений: их вклад уже
 * учтён ключом шага, и правка одной работы не должна гасить остальные.
 */
function excludeDefinitionFiles(changed: ChangedSince, pipeline: Pipeline, cwd: string): ChangedSince {
  if (changed === 'all') return 'all';
  const definitions = new Set(definitionFiles(pipeline).map((path) => toProjectRelative(cwd, path)));
  return changed.filter((path) => !definitions.has(path));
}

function toProjectRelative(cwd: string, path: string): string {
  return relative(cwd, path).split('\\').join('/');
}

/**
 * Для каждого шага исходного прогона — пути, произведённые им и всеми
 * шагами, исполнявшимися после него. Отпечаток входов шага снимался на
 * `tree_before`, и всё, что дерево получило позже от самого же прогона, ещё
 * не было его входом.
 *
 * «Позже» — по порядку исполнения, а не по порядку записей в состоянии
 * прогона: состояние перечисляет работы в порядке объявления, и работа,
 * объявленная раньше своей зависимости, отдала бы вывод исполнившейся до неё
 * работы за чужую правку дерева.
 */
function attributionIndex(
  source: SourceRun,
  producedPaths: BuildPlanOptions['producedPaths'],
  order: readonly Job[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const addresses: string[] = [];
  const own: (readonly string[])[] = [];
  for (const { id } of order) {
    const job = source.status.jobs.find((item) => item.id === id);
    if (job === undefined) continue;
    for (const step of job.steps) {
      addresses.push(`${job.id}/${step.id}`);
      own.push(producedPaths?.(step) ?? []);
    }
  }

  const index = new Map<string, ReadonlySet<string>>();
  let suffix = new Set<string>();
  for (let i = addresses.length - 1; i >= 0; i -= 1) {
    suffix = new Set(suffix);
    for (const path of own[i] ?? []) suffix.add(path);
    index.set(addresses[i] as string, suffix);
  }
  return index;
}

interface ReasonOptions {
  readonly job: Job;
  readonly step: Step;
  readonly previous: StepRecord | undefined;
  readonly poisoned: string | undefined;
  readonly from: ResumeFrom | undefined;
  readonly isAbove: boolean;
  readonly isFromPoint: boolean;
  readonly options: BuildPlanOptions;
  /** Выходы работ, переиспользованных целиком, в порядке исполнения. */
  readonly upstream: readonly { job: string; value: unknown }[];
  readonly changed: ChangedSince;
  /** Пути, произведённые этим шагом и всеми шагами после него в источнике. */
  readonly producedAfter: ReadonlySet<string>;
  readonly outputUnrecoverable: boolean;
}

interface ReasonOutcome {
  /** `undefined` — шаг переиспользуется. */
  readonly reason?: string;
  /** Чужие правки, задевающие шаг выше точки `--from`, но проигнорированные флагом. */
  readonly ignoredEdits?: readonly string[];
}

function invalidationReason(input: ReasonOptions): ReasonOutcome {
  const {
    job,
    step,
    previous,
    poisoned,
    from,
    isAbove,
    isFromPoint,
    options,
    upstream,
    changed,
    producedAfter,
    outputUnrecoverable,
  } = input;

  if (previous === undefined) return { reason: 'в прошлом прогоне шага не было' };
  if (previous.status !== 'success') return { reason: `в прошлом прогоне шаг завершился: ${previous.status}` };
  if (previous.anchor_missing !== undefined) {
    return { reason: 'нет якоря состояния дерева — переиспользовать нечего' };
  }
  if (outputUnrecoverable) {
    return { reason: 'выход работы не восстановить: артефакт исходного прогона недоступен' };
  }

  // Каскад действует по обе стороны точки: он говорит о предшественнике,
  // который уже переисполнен, а не о состоянии дерева. Сам флаг `--from` —
  // решение о том, что случилось *ниже* точки; выше неё дерево не судится.
  if (poisoned !== undefined) return { reason: poisoned };
  if (!isAbove && isFromPoint) {
    return { reason: `указано --from ${from?.job}${from?.step === undefined ? '' : `/${from.step}`}` };
  }

  // Отпечаток берётся из записи: он нейтрализует вклад дерева, и расхождение
  // ключа после этого означает изменение самого шага, а не состояния вокруг.
  // Хеш определения — только этой работы: правка файла другой не должна
  // задевать её ключ.
  const key = computeStepKey({
    lockHash: jobLockHash(options.expanded.pipeline, job),
    jobId: job.id,
    step,
    inputsFingerprint: previous.inputs_fingerprint,
    backendCommand:
      step.kind === 'agent' ? options.config.backends[step.agent]?.command : undefined,
    upstream: upstreamForKey(upstream),
  });
  const keyChanged = key !== previous.key;

  if (isAbove) {
    // Ключ шага проверяется и выше точки: `--from` берёт на себя решение о
    // дереве, но не о том, что источник описывает другой шаг.
    if (keyChanged) return { reason: 'изменилось определение шага, промпт или бэкенд' };

    const touched = touchedInputs(job, previous, changed, producedAfter, options.allReason);
    const clobbered = clobberedPaths(previous, changed, options.producedPaths);
    const ignored = dedupe([...(touched?.paths ?? []), ...clobbered]);
    return ignored.length > 0 ? { ignoredEdits: ignored } : {};
  }

  const touched = touchedInputs(job, previous, changed, producedAfter, options.allReason);
  if (touched !== undefined) return { reason: touched.reason };

  // Путь, который произвёл этот шаг, входит в число изменившихся после
  // завершения прогона. Кто именно его тронул — неизвестно и не проверяется:
  // сравнение чисто временное, по хешам содержимого между концом прогона и
  // моментом возобновления. Автором может быть разработчик, хук, линтер или
  // любой другой процесс — переиспользовать результат в любом из этих случаев
  // значило бы объявить действительным то, чего в дереве уже нет.
  const clobbered = clobberedPaths(previous, changed, options.producedPaths);
  if (clobbered.length > 0) {
    return { reason: `результат шага тронут после завершения прогона (${list(clobbered)})` };
  }

  return keyChanged ? { reason: 'изменилось определение шага, промпт или бэкенд' } : {};
}

/**
 * Задевают ли изменения пользователя входы шага.
 *
 * Из множества изменений сперва вычитается то, что произвёл сам исходный
 * прогон этим шагом и всеми последующими: это не входы шага, а его
 * собственный либо более поздний вывод. Ширина оставшейся области — то же
 * трёхуровневое правило, что и у отпечатка: объявленные пути работы,
 * наблюдённые файлы прошлого исполнения, иначе — всё дерево.
 */
function touchedInputs(
  job: Job,
  previous: StepRecord,
  changed: ChangedSince,
  producedAfter: ReadonlySet<string>,
  allReason?: string,
): { reason: string; paths: readonly string[] } | undefined {
  if (changed === 'all') {
    return { reason: allReason ?? 'состояние дерева установить не удалось — считаем изменённым', paths: [] };
  }

  const attributable = changed.filter((path) => !producedAfter.has(path));
  if (attributable.length === 0) return undefined;

  const scope = job.inputs.length > 0 ? job.inputs : previous.observed_inputs;

  if (scope === undefined) {
    return { reason: `дерево изменилось (${list(attributable)})`, paths: attributable };
  }

  const hit = attributable.filter((path) => scope.some((entry) => covers(entry, path)));
  return hit.length === 0 ? undefined : { reason: `изменились входы шага (${list(hit)})`, paths: hit };
}

/** Пути, произведённые самим шагом, которые кто-то тронул после прогона. */
function clobberedPaths(
  previous: StepRecord,
  changed: ChangedSince,
  producedPaths: BuildPlanOptions['producedPaths'],
): readonly string[] {
  if (changed === 'all') return [];
  const produced = producedPaths?.(previous) ?? [];
  return changed.filter((path) => produced.includes(path));
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

function dedupe(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)].sort();
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
  const jobs = [...new Set(plan.steps.map((step) => step.job))];

  const lines: string[] = [];
  for (const job of jobs) {
    const jobSteps = plan.steps.filter((step) => step.job === job);
    lines.push(jobVerdict(job, jobSteps, plan.sourceRunId));

    for (const item of jobSteps) {
      const address = `${item.job}/${item.step}`.padEnd(width);
      lines.push(
        item.decision.kind === 'reuse'
          ? `  ${address}  переиспользуется из ${plan.sourceRunId.slice(-6)}`
          : `  ${address}  переисполняется — ${item.decision.reason}`,
      );
    }
  }

  if (plan.ignoredEdits.length > 0) {
    lines.push(`--from игнорирует чужие правки выше точки: ${list(plan.ignoredEdits)}`);
  }

  if (plan.fromScratch) lines.push('переиспользовать нечего: пайплайн исполняется с начала');
  return lines;
}

/** Вердикт по работе: переиспользуется целиком, переисполняется целиком или с шага. */
function jobVerdict(job: string, steps: readonly StepPlan[], sourceRunId: string): string {
  if (steps.every((item) => item.decision.kind === 'reuse')) {
    return `${job}  переиспользуется из ${sourceRunId.slice(-6)}`;
  }

  const firstRerun = steps.find((item) => item.decision.kind === 'rerun');
  const reason = (firstRerun?.decision as { reason: string } | undefined)?.reason ?? '';

  if (steps.every((item) => item.decision.kind === 'rerun')) {
    return `${job}  переисполняется — ${reason}`;
  }

  return `${job}  переисполняется частично, с шага ${firstRerun?.step} — ${reason}`;
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

export interface ResumeRequest {
  readonly cwd: string;
  readonly config: Config;
  readonly source: SourceRun;
  /** `--set`: переопределение входов прошлого прогона. */
  readonly overrides?: Readonly<Record<string, string>>;
  /** `--from`, ещё не разобранный: команды получают его прямо из CLI-флагов. */
  readonly from?: string;
}

export interface ResumePlanResult {
  readonly expanded: ExpandedPipeline;
  readonly plan: ResumePlan;
}

/**
 * Собрать план возобновления от исходного прогона до готового `ResumePlan`.
 *
 * Общий путь для `stepcast resume` и `stepcast status --explain`: раскрытие
 * пайплайна, снятие якоря дерева и вычисление изменений, вызов
 * `buildResumePlan` — один и тот же код, чтобы объяснение и решение не могли
 * разойтись.
 */
export function planResume(request: ResumeRequest): ResumePlanResult {
  const { cwd, config, source } = request;

  const inputs: Record<string, string> = {};
  for (const [name, value] of Object.entries(source.manifest.inputs)) inputs[name] = String(value);
  for (const [name, value] of Object.entries(request.overrides ?? {})) inputs[name] = value;

  const expanded = expandPipeline({ pipelinePath: source.manifest.pipeline_file, config, inputs });

  const from = request.from === undefined ? undefined : parseFrom(request.from);
  if (from !== undefined) {
    // Неизвестное имя обязано быть отказом, а не пустой точкой: точка `--from`
    // отключает суд над деревом для всего, что выше неё, и точка, которая
    // никогда не наступает, отключает его для всего пайплайна разом. Прогон
    // тогда переиспользует всё и не исполняет ничего — молча и с видом успеха.
    const target = expanded.pipeline.jobs.find((item) => item.id === from.job);
    if (target === undefined) {
      throw new StepcastError(`Работа ${from.job} в пайплайне не объявлена`, {
        hint: `Доступны: ${expanded.pipeline.jobs.map((item) => item.id).join(', ')}`,
      });
    }
    if (from.step !== undefined && !target.steps.some((item) => item.id === from.step)) {
      throw new StepcastError(`Работа ${from.job} не объявляет шаг ${from.step}`, {
        hint: `Шаги работы: ${target.steps.map((item) => item.id).join(', ')}`,
      });
    }
  }
  if (from?.step !== undefined) {
    const job = expanded.pipeline.jobs.find((item) => item.id === from.job);
    if (job !== undefined && job.session === 'shared') {
      throw new StepcastError(
        `Работа ${job.id} объявляет session: shared — возобновление с отдельного шага невозможно`,
        { hint: `Результат шага зависит от диалога, которого при частичном повторе нет. Укажите --from ${job.id}` },
      );
    }
  }

  const declaredToday = config.project.nestedRepos ?? [];
  const declaredBefore = source.manifest.nested_repos ?? [];
  // Состав вложенных репозиториев — форма состояния дерева (design.md,
  // решение 2): якорь другого состава несравним с сегодняшним по устройству
  // (разный отпечаток в tree_id), но называть *обе* стороны различия он не
  // может — состав исходного прогона в самом якоре не записан, только его
  // отпечаток. Обе стороны известны здесь: сегодняшняя — из конфигурации,
  // прошлая — из манифеста исходного прогона.
  const compositionMatches =
    declaredToday.length === declaredBefore.length &&
    declaredToday.every((relDir, index) => relDir === declaredBefore[index]);

  const anchorKind = detectAnchorKind(cwd, config.project.nestedRepos);
  const stateDir = mkdtempSync(join(tmpdir(), 'stepcast-plan-'));
  const anchorer = createAnchorer({
    dir: cwd,
    stateDir,
    kind: anchorKind,
    scope: 'plan',
    ...(config.project.nestedRepos === undefined ? {} : { nested: config.project.nestedRepos }),
    readStores: [manifestStore(source.paths.anchors)],
  });

  let changed: ChangedSince;
  let allReason: string | undefined;
  if (!compositionMatches) {
    changed = 'all';
    allReason = `состав вложенных репозиториев не совпадает: сегодня — ${describeComposition(declaredToday)}, в прошлом прогоне — ${describeComposition(declaredBefore)}`;
  } else {
    try {
      changed = changedSince(anchorer, finalAnchorOf(source.status, anchorKind), anchorer.capture());
    } catch {
      changed = 'all';
    }
  }

  // При несовпавшем составе якоря исходного прогона сегодняшнему не значат
  // ничего: разбирать их — значит спрашивать у якоря чужого состава, что
  // произвёл каждый шаг. Ответ всё равно не пригодится (переиспользовать
  // нечего, восстанавливать нечего), а цена — обход всего прогона git-ом
  // ради заведомо несравнимых пар.
  const producedPaths = compositionMatches
    ? (step: StepRecord): readonly string[] | undefined => producedBy(anchorer, step)
    : undefined;

  const plan = buildResumePlan({
    expanded,
    config,
    source,
    changed,
    cwd,
    ...(producedPaths === undefined ? {} : { producedPaths }),
    ...(from === undefined ? {} : { from }),
    ...(allReason === undefined ? {} : { allReason }),
  });

  // Якорь нужен плану для вычисления произведённых путей, поэтому
  // освобождается только теперь.
  anchorer.dispose();

  return { expanded, plan };
}
