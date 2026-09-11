import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  findStepDir,
  readManifestSoft,
  readStatusSoft,
  readUsageSoft,
  type JournalProblem,
  type readStatus,
} from '../core/journal/reader.js';
import type { RunPaths } from '../core/journal/paths.js';
import { ContextReportSchema, type StatusValue, type UsageRecord, type UsageReport } from '../core/journal/schema.js';
import { renderDisplay, type DisplayData } from '../core/pipeline/display.js';
import { readLockJobs, type LockJob, type LockStep } from '../core/pipeline/lockRead.js';
import { layoutJobs, type JobGraph } from './graph.js';
import { readJournalJson } from './file.js';

/**
 * Детальный снимок одного прогона: что каждая работа получила на вход и что
 * отдала на выход.
 *
 * Три источника. `status.json` — исполнение (статусы, попытки, причины).
 * `pipeline.lock.yml` — определение (промпт, команда, `needs`, объявленный
 * выход), нужное, чтобы показать работу, которая ещё не исполнялась. Файлы
 * шага — фактические данные.
 */

/** Уровни контекста в том же порядке, в каком их склеивает `assembleContext`. */
export type ContextLevel = 'upstream' | 'pipeline' | 'job' | 'step';

export interface ContextBreakdown {
  readonly levels: Readonly<Record<ContextLevel, number>>;
  readonly total: number;
}

export interface JournalFileRef {
  readonly name: string;
  /** Путь относительно каталога прогона — абсолютные наружу не отдаются. */
  readonly path: string;
  readonly bytes: number;
}

/** Расход, взятый из сводки: `null`, пока сводка не записана или не читается. */
export interface UsageSnapshot {
  readonly billableTokens: number | null;
  readonly wallclockMs: number | null;
  /** `null` также означает «ни одна попытка не сообщила цены», а не ноль. */
  readonly costUsd: number | null;
}

/** Модель одной попытки шага, как её сообщил бэкенд в `usage.json`. */
export interface AttemptModel {
  readonly attempt: number;
  /** Отсутствует, если бэкенду не передавали `--model` вовсе — движок этого не подменяет. */
  readonly model?: string;
}

export interface StepSnapshot {
  readonly id: string;
  readonly kind: 'agent' | 'run' | 'script';
  readonly agent?: string;
  /** Модель, объявленная определением, — из `pipeline.lock.yml`. */
  readonly model?: string;
  /**
   * Модели попыток, которыми шаг фактически исполнился, — из `usage.json`.
   * Это факт, а не намерение: ступень эскалации вправе сменить модель между
   * попытками, и объявленная `model` этого не покажет. Живёт рядом с ней, а
   * не вместо: `usage.json` переживает `stepcast gc`, `pipeline.lock.yml` —
   * нет, и убранный прогон обязан сохранить хотя бы это (design.md, Решение 4).
   */
  readonly attemptModels: readonly AttemptModel[];
  readonly status?: StatusValue;
  readonly reason?: string;
  readonly attempts: number;
  /**
   * Отрезок исполнения шага: начало первой попытки и конец последней.
   * Собственных времён у записи шага нет — она пишется целиком по его
   * завершении, — а попытки свои времена несут.
   */
  readonly startedAt?: string;
  readonly finishedAt?: string;
  /** Промпт агентского шага из лока. */
  readonly prompt?: string;
  /** Команда командного шага из лока. */
  readonly command?: string;
  /** Путь скрипта, объявленный документом, — у шага script. */
  readonly scriptPath?: string;
  /** Имя раннера, которым скрипт разрешён исполниться. */
  readonly scriptRunner?: string;
  /** Объявлен ли вход контракта (`input`) — у шага script. */
  readonly hasScriptInput?: boolean;
  /** Путь объявленной схемы выхода — у script означает проверку файла, а не разбор stdout. */
  readonly scriptOutputSchemaPath?: string;
  readonly context: readonly string[];
  /** Разрез контекста: есть только у исполнившегося агентского шага. */
  readonly contextBreakdown?: ContextBreakdown;
  readonly files: readonly JournalFileRef[];
  readonly usage: UsageSnapshot;
}

export interface JobSnapshot {
  readonly id: string;
  readonly description?: string;
  readonly status?: StatusValue;
  readonly reason?: string;
  /**
   * Отрезок исполнения работы. Это не то же, что `usage.wallclockMs`: там
   * оплачиваемое время попыток, здесь — реальный отрезок от начала работы до
   * её конца. У идущей работы конца ещё нет, и по одному началу витрина
   * считает, сколько работа идёт.
   */
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly needs: readonly string[];
  /** Условие исполнения работы: показывает, почему работа может не выполниться. */
  readonly if?: string;
  readonly on: 'success' | 'failure' | 'always';
  /** Дорожка, объявленная на месте подключения работы. */
  readonly lane?: string;
  /** Группа сессий, объявленная на месте подключения работы. */
  readonly sessionGroup?: string;
  readonly context: readonly string[];
  /** Выходы предшественников, доступные этой работе. */
  readonly inputs: readonly JournalFileRef[];
  /** Собственный опубликованный выход, если работа его объявляет и уже дала. */
  readonly output?: JournalFileRef;
  /** Работа объявляет выход, но ещё не опубликовала его. */
  readonly outputDeclared: boolean;
  /**
   * Подпись работы, раскрытая против данных прогона. Отсутствует и когда
   * подпись не объявлена, и когда ни одно её поле не раскрылось.
   */
  readonly display?: Readonly<Record<string, string>>;
  /** Данные, опубликованные самой работой (`stepcast data`). */
  readonly data?: Readonly<Record<string, string>>;
  readonly steps: readonly StepSnapshot[];
  readonly usage: UsageSnapshot;
}

export interface RunSnapshot {
  readonly runId: string;
  readonly projectKey: string;
  readonly pipeline: string;
  readonly status?: StatusValue;
  readonly jobs: readonly JobSnapshot[];
  /** Раскладка работ по зависимостям: браузеру остаётся отрисовка. */
  readonly graph: JobGraph;
  /** Прогон убран: остались только манифест, состояние и расход. */
  readonly swept: boolean;
  /**
   * У прогона нет каталога вовсе — снимок собран по записи хранилища расхода
   * (Решение 12 изменения run-stats-retention). Работы, шаги и их расход
   * показаны по записи; контекста, файлов и попыток у них нет — запись их не
   * несёт (Решение 5).
   */
  readonly filesGone: boolean;
  /** Итог прогона — только у снимка, собранного по записи (`filesGone: true`). */
  readonly total?: UsageSnapshot;
  /** Разрез по моделям — только у снимка, собранного по записи. */
  readonly models?: readonly { readonly model: string; readonly billableTokens: number; readonly costUsd: number | null }[];
  /**
   * Диагноз беды чтения журнала: манифеста, состояния или сводки расхода — в
   * этом же порядке. Отсутствует, когда файлы прогона читаются штатно.
   */
  readonly problem?: JournalProblem;
}

function fileRef(runDir: string, absolute: string): JournalFileRef | undefined {
  let bytes: number;
  try {
    bytes = statSync(absolute).size;
  } catch {
    return undefined;
  }
  return {
    name: relative(runDir, absolute).split(/[\\/]/).pop() ?? '',
    path: relative(runDir, absolute).replace(/\\/g, '/'),
    bytes,
  };
}

/** Все файлы каталога шага: перечисляются как есть, а не по ожидаемым именам. */
function stepFiles(runDir: string, dir: string | undefined): JournalFileRef[] {
  if (dir === undefined || !existsSync(dir)) return [];
  const out: JournalFileRef[] = [];
  for (const name of readdirSync(dir).sort()) {
    const ref = fileRef(runDir, join(dir, name));
    if (ref !== undefined) out.push(ref);
  }
  return out;
}

function contextBreakdown(dir: string | undefined): ContextBreakdown | undefined {
  if (dir === undefined) return undefined;
  const parsed = ContextReportSchema.safeParse(readJournalJson(join(dir, 'context.json')));
  if (!parsed.success) return undefined;

  const levels: Record<ContextLevel, number> = { upstream: 0, pipeline: 0, job: 0, step: 0 };
  for (const entry of parsed.data.entries) levels[entry.origin] += entry.tokens;

  return { levels, total: parsed.data.total_tokens };
}

function stepUsage(summary: UsageReport | undefined, jobId: string, stepId: string): UsageSnapshot {
  const step = summary?.jobs[jobId]?.steps[stepId];
  return {
    billableTokens: step?.billable_tokens ?? null,
    wallclockMs: step?.wallclock_ms ?? null,
    costUsd: step?.cost_usd ?? null,
  };
}

/**
 * Модели попыток шага в порядке исполнения. Прежняя форма сводки хранит
 * `attempts` числом (см. `journal/schema.ts`), и препроцессор приводит его к
 * пустому списку — старый прогон отдаёт объявленную модель и не отдаёт
 * исполнявшихся, без отказа.
 */
function attemptModels(
  summary: UsageReport | undefined,
  jobId: string,
  stepId: string,
): readonly AttemptModel[] {
  const attempts = summary?.jobs[jobId]?.steps[stepId]?.attempts ?? [];
  return attempts.map((attempt) => ({
    attempt: attempt.attempt,
    ...(attempt.model === undefined ? {} : { model: attempt.model }),
  }));
}

function jobUsage(summary: UsageReport | undefined, jobId: string): UsageSnapshot {
  const job = summary?.jobs[jobId];
  return {
    billableTokens: job?.billable_tokens ?? null,
    wallclockMs: job?.wallclock_ms ?? null,
    costUsd: job?.cost_usd ?? null,
  };
}

function buildStep(
  paths: RunPaths,
  jobId: string,
  definition: LockStep | undefined,
  record: ReturnType<typeof readStatus>['jobs'][number]['steps'][number] | undefined,
  summary: UsageReport | undefined,
): StepSnapshot {
  const id = definition?.id ?? record?.id ?? '';
  const dir = findStepDir(paths, jobId, id);
  const kind = definition?.kind ?? record?.kind ?? 'run';
  const breakdown = kind === 'agent' ? contextBreakdown(dir) : undefined;

  return {
    id,
    kind,
    ...(record?.status === undefined ? {} : { status: record.status }),
    ...(record?.reason === undefined ? {} : { reason: record.reason }),
    attempts: record?.attempts.length ?? 0,
    ...(record?.attempts[0]?.started_at === undefined
      ? {}
      : { startedAt: record.attempts[0].started_at }),
    ...(record?.attempts.at(-1)?.finished_at === undefined
      ? {}
      : { finishedAt: record.attempts.at(-1)?.finished_at as string }),
    ...(definition?.agent === undefined ? {} : { agent: definition.agent }),
    ...(definition?.model === undefined ? {} : { model: definition.model }),
    attemptModels: attemptModels(summary, jobId, id),
    ...(definition?.prompt === undefined ? {} : { prompt: definition.prompt }),
    ...(definition?.command === undefined ? {} : { command: definition.command }),
    ...(definition?.scriptPath === undefined ? {} : { scriptPath: definition.scriptPath }),
    ...(definition?.scriptRunner === undefined ? {} : { scriptRunner: definition.scriptRunner }),
    ...(definition?.hasScriptInput === undefined ? {} : { hasScriptInput: definition.hasScriptInput }),
    ...(definition?.scriptOutputSchemaPath === undefined
      ? {}
      : { scriptOutputSchemaPath: definition.scriptOutputSchemaPath }),
    context: definition?.context ?? [],
    ...(breakdown === undefined ? {} : { contextBreakdown: breakdown }),
    files: stepFiles(paths.dir, dir),
    usage: stepUsage(summary, jobId, id),
  };
}

function buildJob(
  paths: RunPaths,
  definition: LockJob | undefined,
  record: ReturnType<typeof readStatus>['jobs'][number] | undefined,
  publishedJobs: ReadonlySet<string>,
  summary: UsageReport | undefined,
  data: DisplayData,
): JobSnapshot {
  const id = definition?.id ?? record?.id ?? '';
  const needs = definition?.needs ?? [];

  // Вход работы — выходы её предшественников: тот же источник, из которого
  // движок берёт ${jobs.*.output.*}. `needs: all` означает всех, кто опубликовал.
  const upstream = needs.includes('all')
    ? [...publishedJobs].filter((job) => job !== id)
    : needs.filter((job) => publishedJobs.has(job));

  const inputs = upstream
    .map((job) => fileRef(paths.dir, join(paths.artifacts, `${job}.json`)))
    .filter((ref): ref is JournalFileRef => ref !== undefined);

  const output = publishedJobs.has(id)
    ? fileRef(paths.dir, join(paths.artifacts, `${id}.json`))
    : undefined;

  const stepIds = definition?.steps.map((step) => step.id) ?? record?.steps.map((s) => s.id) ?? [];

  return {
    id,
    ...(definition?.description === undefined ? {} : { description: definition.description }),
    ...(record?.status === undefined ? {} : { status: record.status }),
    ...(record?.reason === undefined ? {} : { reason: record.reason }),
    ...(record?.started_at === undefined ? {} : { startedAt: record.started_at }),
    ...(record?.finished_at === undefined ? {} : { finishedAt: record.finished_at }),
    needs,
    ...(definition?.if === undefined ? {} : { if: definition.if }),
    on: definition?.on ?? 'success',
    ...(definition?.lane === undefined ? {} : { lane: definition.lane }),
    ...(definition?.sessionGroup === undefined ? {} : { sessionGroup: definition.sessionGroup }),
    context: definition?.context ?? [],
    inputs,
    ...(output === undefined ? {} : { output }),
    outputDeclared: definition?.publishesOutput ?? false,
    // Подпись раскрывается здесь и только здесь — против данных, записанных к
    // этому моменту. Отсюда и работает самоссылка `${jobs.<сам>.data.*}`:
    // движок раскрывает определение работы до её первого шага, а витрина —
    // после того, как работа успела записать.
    ...((): { display?: Readonly<Record<string, string>> } => {
      const rendered = renderDisplay(definition?.display, data);
      return rendered === undefined ? {} : { display: rendered };
    })(),
    ...(record?.data === undefined ? {} : { data: record.data }),
    steps: stepIds.map((stepId) =>
      buildStep(
        paths,
        id,
        definition?.steps.find((step) => step.id === stepId),
        record?.steps.find((step) => step.id === stepId),
        summary,
      ),
    ),
    usage: jobUsage(summary, id),
  };
}

/** Опубликованные выходы: файлы, реально лежащие в `artifacts/`. */
function publishedOutputs(paths: RunPaths): Set<string> {
  try {
    return new Set(
      readdirSync(paths.artifacts)
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -'.json'.length)),
    );
  } catch {
    return new Set();
  }
}

export function buildSnapshot(paths: RunPaths, projectKeyValue: string): RunSnapshot {
  const { status, problem: statusProblem } = readStatusSoft(paths);
  // Манифест читается ради диагноза: беда `run.json` — тот самый случай, ради
  // которого страница и объясняет причину, и пользователь, перешедший сюда из
  // строки обзора за подробностями, обязан найти здесь тот же ответ. Порядок
  // тот же, что в обзоре: манифест первым, отсутствие ещё не записанного
  // состояния бедой не считается.
  const { problem: manifestProblem } = readManifestSoft(paths);
  const { summary, problem: usageProblem } = readUsageSoft(paths);
  const told = (candidate: JournalProblem | undefined): JournalProblem | undefined =>
    candidate?.kind === 'missing' ? undefined : candidate;
  const problem = manifestProblem ?? told(statusProblem) ?? told(usageProblem);

  // Уборка сносит всё, кроме манифеста, состояния и расхода: по отсутствию
  // каталога работ прогон и опознаётся как убранный.
  const swept = !existsSync(paths.jobs);
  const definitions = readLockJobs(paths.lock);
  const published = publishedOutputs(paths);

  // Порядок работ задаёт лок; работы, оставшиеся только в состоянии
  // (например, после уборки лока), дописываются следом.
  // Данные всех работ прогона: подпись одной работы вправе назвать другую.
  const data: DisplayData = Object.fromEntries(
    (status?.jobs ?? [])
      .filter((job) => job.data !== undefined)
      .map((job) => [job.id, { data: job.data as Readonly<Record<string, string>> }]),
  );

  const ids = [...definitions.map((job) => job.id)];
  for (const record of status?.jobs ?? []) {
    if (!ids.includes(record.id)) ids.push(record.id);
  }

  const jobs = ids.map((id) =>
    buildJob(
      paths,
      definitions.find((job) => job.id === id),
      status?.jobs.find((job) => job.id === id),
      published,
      summary,
      data,
    ),
  );

  return {
    runId: paths.runId,
    projectKey: projectKeyValue,
    pipeline: status?.pipeline ?? '',
    ...(status?.status === undefined ? {} : { status: status.status }),
    jobs,
    graph: layoutJobs(
      jobs.map((job) => ({
        id: job.id,
        needs: job.needs,
        on: job.on,
        ...(job.if === undefined ? {} : { if: job.if }),
        ...(job.status === undefined ? {} : { status: job.status }),
        ...(job.display === undefined ? {} : { display: job.display }),
      })),
    ),
    swept,
    filesGone: false,
    ...(problem === undefined ? {} : { problem }),
  };
}

/**
 * Снимок прогона, чей каталог удалён, — собранный по записи хранилища
 * расхода вместо файлов. Показывает то, что запись несёт: итог, работы,
 * шаги и модели (design.md изменения run-stats-retention, Решение 12).
 * Контекста, файлов, попыток и предикатов у такого снимка нет — запись их не
 * несёт (Решение 5), а не потому, что они были и потерялись.
 */
export function buildSnapshotFromRecord(record: UsageRecord, projectKeyValue: string): RunSnapshot {
  const jobs: JobSnapshot[] = Object.entries(record.jobs).map(([jobId, job]) => ({
    id: jobId,
    needs: [],
    on: 'success',
    context: [],
    inputs: [],
    outputDeclared: false,
    steps: Object.entries(job.steps).map(([stepId, step]) => ({
      id: stepId,
      // Вид шага (agent/run) запись не несёт (Решение 5) — «agent» ближе к
      // типичному шагу и не более неверен, чем любой другой выбор наугад;
      // на отображение расхода это поле не влияет.
      kind: 'agent' as const,
      attempts: 0,
      attemptModels: [],
      context: [],
      files: [],
      usage: {
        billableTokens: step.billable_tokens,
        wallclockMs: step.wallclock_ms,
        costUsd: step.cost_usd ?? null,
      },
    })),
    usage: {
      billableTokens: job.billable_tokens,
      wallclockMs: job.wallclock_ms,
      costUsd: job.cost_usd ?? null,
    },
  }));

  return {
    runId: record.run_id,
    projectKey: projectKeyValue,
    pipeline: record.pipeline.name,
    status: record.status,
    jobs,
    graph: layoutJobs(jobs.map((job) => ({ id: job.id, needs: job.needs, on: job.on }))),
    swept: false,
    filesGone: true,
    total: {
      billableTokens: record.total.billable_tokens,
      wallclockMs: record.total.wallclock_ms,
      costUsd: record.total.cost_usd ?? null,
    },
    models: Object.entries(record.models)
      .map(([model, slice]) => ({
        model,
        billableTokens: slice.billable_tokens,
        costUsd: slice.cost_usd ?? null,
      }))
      .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.billableTokens - a.billableTokens),
  };
}
