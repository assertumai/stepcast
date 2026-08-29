import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, readdirSync, rmdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  createAnchorer,
  detectAnchorKind,
  type Anchor,
  type AnchorKind,
  type TreeAnchorer,
} from '../anchor/index.js';
import { fingerprintInputs } from '../anchor/fingerprint.js';
import { effectivePermissions } from '../backend/permissions.js';
import { resolveAdapter } from '../backend/registry.js';
import { createBackendSlots, type BackendSlots } from '../backend/slots.js';
import {
  BACKEND_REFUSAL_PREDICATE,
  describeRefusal,
  extractRefusal,
  sumUsage,
  type BackendAdapter,
  type BackendRefusal,
} from '../backend/types.js';
import {
  UsageAccumulator,
  ZERO_USAGE_SNAPSHOT,
  describeExceeded,
  type BudgetScope,
  type Exceeded,
  type UsageSnapshot,
} from '../budget/accumulator.js';
import type { Config } from '../config/resolve.js';
import { inline } from '../text.js';
import { formatDuration } from '../units.js';
import { assembleContext, type UpstreamOutput } from '../context/assemble.js';
import { resolveLate, type JobScopeEntry } from '../pipeline/late.js';
import { ExitCode, StepcastError, isStepcastError, type ExitCodeValue } from '../errors.js';
import { createSessionRegistry, executeAgentStep } from '../exec/agentStep.js';
import { buildStepEnv, injectedVariables } from '../exec/env.js';
import { executeRunStep } from '../exec/runStep.js';
import { runJudgePass } from '../exec/judgePass.js';
import { evaluatePredicates } from '../expect/evaluate.js';
import { buildGraph, upstreamOutputs, type Graph } from '../graph.js';
import { bookkeep } from './bookkeeping.js';
import { buildIterationNote, type IterationNoteTruncation } from './iterationNote.js';
import { HaltCause, type HaltCauseValue } from './halt.js';
import { resolveInheritSource, type CompletedJob } from './inherit.js';
import { preflight } from './preflight.js';
import { buildPreviousFailure } from './previousFailure.js';
import type { ResumePlan, SourceRun, StepPlan } from './resumePlan.js';
import { computeStepKey, upstreamForKey } from './stepKey.js';
import { prepareWorkspace, type PreparedWorkspace } from './workspace.js';
import { createWaitState } from './waitState.js';
import { jobDataPath, readJobData, writeJobData } from '../journal/data.js';
import { jobDir, jobScratchDir, shortRunId } from '../journal/paths.js';
import { findStepDir } from '../journal/reader.js';
import { RunJournal } from '../journal/writer.js';
import { jobLockHash, serializeLock } from '../pipeline/lock.js';
import type {
  AgentStep,
  ContextEntry,
  ExpandedPipeline,
  Job,
  Pipeline,
  Step,
} from '../pipeline/model.js';
import type {
  Event,
  JobRecord,
  PredicateResult,
  RunManifest,
  RunStatus,
  StatusValue,
  StepRecord,
  Usage,
} from '../journal/schema.js';
import { schedule, type JobOutcome } from './scheduler.js';

export interface RunOptions {
  readonly expanded: ExpandedPipeline;
  readonly config: Config;
  readonly projectRoot: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  /** Подмена адаптера бэкенда: тесты подставляют поддельный. */
  readonly adapterFor?: (name: string) => BackendAdapter;
  /**
   * Подмена якоря состояния дерева. Нужна, чтобы проверить главное свойство
   * учёта: отказ фиксации не меняет исход прогона.
   */
  /** План переиспользования: исполнитель не знает, что это возобновление. */
  readonly resume?: ResumeContext;
  readonly anchorerFor?: (options: {
    readonly dir: string;
    readonly stateDir: string;
    readonly kind: AnchorKind;
    readonly scope: string;
    readonly repoDir?: string;
  }) => TreeAnchorer;
  /**
   * Наблюдение за потоком событий: вызывается синхронно с записью каждого
   * события в журнал, рядом со снимком накопленного расхода прогона.
   * Событие `run.started` доставляется раньше, чем накопитель расхода
   * создан, — со снимком `ZERO_USAGE_SNAPSHOT`, а не падением.
   */
  readonly onEvent?: (event: Event, usage: UsageSnapshot) => void;
}

export interface ResumeContext {
  readonly plan: ResumePlan;
  readonly source: SourceRun;
}

export interface RunResult {
  readonly journal: RunJournal;
  readonly status: StatusValue;
  readonly exitCode: ExitCodeValue;
  /**
   * Денежный потолок объявлен, но ни одна попытка за прогон не сообщила
   * цены: потолок фактически не применялся. Код возврата от этого не меняется.
   */
  readonly costLimitUnapplied: boolean;
}

const EXIT_BY_STATUS: Record<string, ExitCodeValue> = {
  success: ExitCode.ok,
  skipped: ExitCode.ok,
  failed: ExitCode.jobFailed,
  budget_exceeded: ExitCode.budgetExceeded,
  canceled: ExitCode.canceled,
};

/**
 * Код возврата прогона. Отказ аутентификации отличает неисполнимость
 * окружения от отказа самого пайплайна: он переопределяет код по причине, а
 * не по статусу работы, который у обоих одинаково `failed`. Отмена
 * пользователем остаётся самой внешней причиной — `overallStatus` ставит её
 * выше отказа, и код возврата не должен с ним расходиться.
 */
export function resolveExitCode(
  status: string,
  settled: readonly { readonly cause?: string }[],
): ExitCodeValue {
  const authRefused =
    status !== 'canceled' &&
    settled.some((job) => job.cause === HaltCause.backendUnauthenticated);
  return authRefused ? ExitCode.backendUnavailable : (EXIT_BY_STATUS[status] ?? ExitCode.jobFailed);
}

export async function runPipeline(options: RunOptions): Promise<RunResult> {
  const { pipeline } = options.expanded;
  const { config } = options;

  // До создания журнала: отказ на этом этапе не оставляет за собой директории
  // прогона, потому что прогона ещё нет.
  preflight({
    expanded: options.expanded,
    projectRoot: options.projectRoot,
    cwd: options.cwd,
    runsRoot: config.runs.root,
  });

  // Способ фиксации выбирается один раз на прогон: якоря разных способов
  // несравнимы, и смешивать их в пределах прогона нельзя.
  const anchorKind = detectAnchorKind(options.cwd);

  const lock = serializeLock(pipeline);
  const lockHash = createHash('sha256').update(lock).digest('hex').slice(0, 16);

  // Накопитель расхода создаётся ниже, после первых событий манифеста —
  // `run.started` доставляется наблюдателю раньше, чем он существует.
  // Ссылка через объект, а не порядком создания: событие не должно ждать
  // накопитель, а накопитель не должен создаваться раньше журнала.
  const usageForEvents: { current: UsageAccumulator | undefined } = { current: undefined };
  const journal = RunJournal.create({
    runsRoot: config.runs.root,
    projectRoot: options.projectRoot,
    ...(options.onEvent === undefined
      ? {}
      : {
          onEvent: (event) =>
            options.onEvent?.(event, usageForEvents.current?.snapshot() ?? ZERO_USAGE_SNAPSHOT),
        }),
  });
  journal.writeLock(lock);

  const manifest: RunManifest = {
    run_id: journal.paths.runId,
    pipeline: pipeline.name,
    pipeline_file: pipeline.file,
    lock_hash: lockHash,
    project_root: options.projectRoot,
    workspace: pipeline.workspace,
    anchor_kind: anchorKind,
    ...(options.resume === undefined ? {} : { resumed_from: options.resume.source.manifest.run_id }),
    inputs: pipeline.inputs,
    git: {},
    backends: Object.fromEntries(
      Object.entries(config.backends).map(([name, backend]) => [name, { command: backend.command }]),
    ),
    started_at: new Date().toISOString(),
    // До запуска первой работы: планировщик расписания отличает идущий
    // прогон от брошенного по факту существования этого процесса, а не по
    // свежести записи в журнале (шаг агента легко молчит час).
    pid: process.pid,
  };
  journal.writeManifest(manifest);
  journal.event({ kind: 'run.started', pipeline: pipeline.name, run_id: journal.paths.runId });

  const usage = new UsageAccumulator(
    (backend) => config.backends[backend]?.cacheReadWeight ?? 1,
  );
  usageForEvents.current = usage;
  const records = new Map<string, JobRecord>(
    pipeline.jobs.map((job) => [
      job.id,
      { id: job.id, status: 'pending', ...(job.lane === undefined ? {} : { lane: job.lane }), steps: [] },
    ]),
  );
  const outputs: UpstreamOutput[] = [];
  const adapters = new Map<string, BackendAdapter>();
  const reportedDenials = new Set<string>();
  const graph = buildGraph(pipeline).graph;
  // Каталог и последний якорь каждой завершившейся работы: источник, из
  // которого наследование выбирает и разрешает дерево зависимой работы.
  // Читается по зависимостям работы, а они к её началу уже отдали исход, —
  // одновременность соседей записи в карте не касается.
  const completedWorkspaces = new Map<string, CompletedJob>();

  // Момент пробуждения: дописывается на диск до начала сна и снимается после
  // продолжения — состояние спящего прогона доступно снаружи, пока он спит.
  const waitState = createWaitState();

  // Общий на прогон счёт мест по имени бэкенда: один агентский шаг и вызов
  // судьи того же бэкенда делят предел, а не удваивают его.
  const backendSlots = createBackendSlots((name) => config.backends[name]?.concurrency ?? 1);

  const context: RunContext = {
    ...options,
    journal,
    records,
    usage,
    outputs,
    adapters,
    backendSlots,
    reportedDenials,
    lockHash,
    anchorKind,
    runCwd: options.cwd,
    graph,
    completedWorkspaces,
    failureNote: { pending: options.resume === undefined ? undefined : previousFailureText(options.resume) },
    ...(options.resume === undefined
      ? {}
      : { observedInputs: options.resume.plan.observedInputs }),
    beginWait: (wakeAt) => {
      const release = waitState.begin(wakeAt);
      writeStatus('running');
      return () => {
        release();
        writeStatus('running');
      };
    },
    // Состояние переписывается после каждого шага: это единственный файл, по
    // изменению которого витрина узнаёт о ходе прогона, и данные, записанные
    // работой, доезжают до подписи узла только вместе с ним.
    refreshStatus: () => writeStatus('running'),
  };

  warnAboutDegradedBackends(context);
  requireStrictPermissionsSupport(context);

  const writeStatus = (status: StatusValue): void => {
    // Перерасход бюджета останавливает прогон так же, как отказ, и точка
    // возобновления нужна ровно так же: без неё прогон, упёршийся в потолок,
    // остался бы единственным законченным исходом без подсказки, как его
    // продолжить.
    const blocked = [...records.values()].find(
      (record) => record.status === 'failed' || record.status === 'budget_exceeded',
    );
    journal.writeStatus({
      run_id: journal.paths.runId,
      pipeline: pipeline.name,
      lock_hash: lockHash,
      status,
      workspace: pipeline.workspace,
      ...(options.resume === undefined
        ? {}
        : { resumed_from: options.resume.source.manifest.run_id }),
      inputs: pipeline.inputs,
      jobs: [...records.values()],
      budget: {
        tokens_used: usage.runTokens(),
        ...(pipeline.budget?.tokens === undefined ? {} : { tokens_limit: pipeline.budget.tokens }),
        cost_used_usd: usage.runCostMicroUsd() / 1_000_000,
        ...(pipeline.budget?.costMicroUsd === undefined
          ? {}
          : { cost_limit_usd: pipeline.budget.costMicroUsd / 1_000_000 }),
        ...(usage.costUnreportedAttemptCount() === 0
          ? {}
          : { cost_unreported_attempts: usage.costUnreportedAttemptCount() }),
        wallclock_ms: usage.elapsedMs(),
        ...(pipeline.budget?.wallclockMs === undefined
          ? {}
          : { wallclock_limit_ms: pipeline.budget.wallclockMs }),
      },
      ...(blocked === undefined
        ? {}
        : {
            resume: {
              command: `stepcast resume ${shortRunId(journal.paths.runId)} --from ${blocked.id}`,
              blocked_by: blocked.id,
            },
          }),
      ...(waitState.earliest() === undefined ? {} : { wake_at: waitState.earliest() as string }),
      updated_at: new Date().toISOString(),
    } satisfies RunStatus);
  };

  // Выходы переиспользованных работ публикуются не здесь, а по ходу
  // исполнения: каждая работа проходит через `executeJob` в обычном порядке
  // графа, даже если все её шаги переиспользованы, и публикует выход в
  // `runJobSteps` — так же, как исполненная. Предзаполнение записи об
  // артефакте путём, по которому файл ещё не записан, было бы ложью.
  if (options.resume !== undefined) {
    restoreForResume(options.resume, journal, options.cwd, anchorKind);
    carryOverRunDir(options.resume, journal);
  }

  writeStatus('running');

  const result = await schedule({
    pipeline,
    graph,
    // Потолок конфигурации применяет сам прогон: линт отклоняет превышение,
    // но прогон не обязан полагаться на то, что линт был.
    concurrency: Math.min(pipeline.concurrency, config.limits.concurrency),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    scopeExtras: { run: { id: journal.paths.runId, dir: journal.paths.dir }, env: {} },
    // Данные берутся из записи работы, а не читаются с диска заново: движок
    // складывает их туда после каждого шага, и второй путь к тому же
    // значению разошёлся бы с первым при первой же уборке прогона.
    jobData: (jobId) => records.get(jobId)?.data,
    execute: async (job, scope) => executeJob(job, scope, context),
    onSettled: async (job, outcome) => {
      const record = records.get(job.id) as JobRecord;
      records.set(job.id, {
        ...record,
        status: outcome.status,
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        ...(outcome.cause === undefined ? {} : { cause: outcome.cause }),
        ...(outcome.lastCheck === undefined ? {} : { last_check: [...outcome.lastCheck] }),
        finished_at: new Date().toISOString(),
      });
      journal.event({
        kind: 'job.finished',
        job: job.id,
        status: outcome.status,
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      });
      writeStatus('running');
    },
  });

  if (context.failureNote.pending !== undefined) {
    const addressee = options.resume?.plan.failureNoteJob;
    journal.event({
      kind: 'resume.note_undelivered',
      ...(addressee === undefined ? {} : { job: addressee }),
      detail:
        addressee === undefined
          ? 'в плане возобновления нет переисполняемых агентских шагов'
          : `агентский шаг работы ${addressee} не исполнялся`,
    });
  }

  writeStatus(result.status);
  journal.writeUsage(usage.report(journal.paths.runId));

  const exitCode = resolveExitCode(result.status, result.settled);
  journal.writeManifest({
    ...manifest,
    finished_at: new Date().toISOString(),
    status: result.status,
    exit_code: exitCode,
  });
  journal.event({ kind: 'run.finished', status: result.status, exit_code: exitCode });

  const costLimitUnapplied = anyCostBudgetDeclared(pipeline) && usage.runCostNeverReported();

  return { journal, status: result.status, exitCode, costLimitUnapplied };
}

interface RunContext extends RunOptions {
  readonly journal: RunJournal;
  readonly records: Map<string, JobRecord>;
  readonly usage: UsageAccumulator;
  readonly outputs: UpstreamOutput[];
  readonly adapters: Map<string, BackendAdapter>;
  /** Предел одновременных вызовов бэкенда, общий на прогон. */
  readonly backendSlots: BackendSlots;
  /** Одна и та же переменная вычёркивается на каждом шаге — сообщаем однажды. */
  readonly reportedDenials: Set<string>;
  readonly lockHash: string;
  /** Способ фиксации состояния: определён один раз на прогон. */
  readonly anchorKind: AnchorKind;
  /**
   * Каталог запуска. В отличие от `cwd`, который ниже по коду означает рабочую
   * директорию текущей работы, этот остаётся каталогом прогона: якорю рабочей
   * копии он нужен как репозиторий, чью базу объектов брать.
   */
  readonly runCwd: string;
  /** Граф работ: наследованию нужны зависимости и число потомков. */
  readonly graph: Graph;
  /** Каталог и последний якорь уже завершившихся работ — источник наследования. */
  readonly completedWorkspaces: Map<string, CompletedJob>;
  /** Наблюдённые входы шагов прошлого прогона: `<работа>/<шаг>` → пути. */
  readonly observedInputs?: ReadonlyMap<string, readonly string[]>;
  /**
   * Выдержка о прошлом отказе. Достаётся первому агентскому шагу работы,
   * названной планом возобновления (`plan.failureNoteJob`), и на этом исчезает:
   * повторять её остальным — значит навязывать всему прогону разбор одной
   * чужой неудачи, а отдавать «первому, кто успел» при параллельном
   * исполнении значит не отдавать никому определённому.
   */
  readonly failureNote: { pending: string | undefined };
  /** Результаты непрошедшего `check` предыдущей итерации текущей работы. */
  readonly iterationCheck?: readonly PredicateResult[];
  /**
   * Уход в ожидание: состояние прогона должно быть на диске до начала сна, а
   * не после — иначе спящий прогон неотличим от зависшего. Возвращённое
   * снятие убирает ровно это ожидание, не трогая чужих: ожидающих работ может
   * быть несколько.
   */
  readonly beginWait: (wakeAt: string) => () => void;
  /**
   * Переписать `status.json` по текущим записям работ. Файлом владеет движок и
   * только он: подпроцесс `stepcast data` пишет свой `data.json`, а состояние
   * прогона переписывается здесь — конкурентная запись двух процессов в один
   * файл была бы гонкой.
   */
  readonly refreshStatus: () => void;
}

/** Отсутствие поддержки сессий не отказ, а деградация с предупреждением. */
function warnAboutDegradedBackends(context: RunContext): void {
  const { pipeline } = context.expanded;
  const needed = new Set(
    pipeline.jobs
      .filter((job) => job.session === 'shared')
      .flatMap((job) => job.steps.filter((step) => step.kind === 'agent').map((step) => step.agent)),
  );

  for (const name of needed) {
    const adapter = adapterOf(name, context);
    if (adapter.capabilities.sessions) continue;
    context.journal.event({
      kind: 'backend.degraded',
      backend: name,
      capability: 'sessions',
      detail: 'session: shared исполняется как per_step',
    });
  }
}

/**
 * Отсутствие поддержки жёсткого режима не деградирует, а останавливает прогон
 * до первого шага: молча исполнить `enforce: strict` бэкендом, который его не
 * умеет, значило бы оставить пайплайн с границей, которой нет. Спрашивается
 * возможность самого адаптера, а не флаг в конфигурации: флаг — то, что о
 * бэкенде объявили, возможность — то, что он умеет, и расходиться они могут.
 */
function requireStrictPermissionsSupport(context: RunContext): void {
  for (const job of context.expanded.pipeline.jobs) {
    for (const step of job.steps) {
      if (step.kind !== 'agent') continue;
      const permissions = effectivePermissions(
        step.permissions,
        context.config.backends[step.agent]?.permissions,
      );
      if (permissions?.enforce !== 'strict') continue;
      if (adapterOf(step.agent, context).capabilities.strictPermissions) continue;
      throw new StepcastError(
        `Бэкенд ${step.agent} не умеет применять enforce: strict, объявленный у шага ${job.id}/${step.id}`,
        {
          file: job.source,
          hint: 'Снимите enforce: strict либо переведите шаг на бэкенд, объявляющий эту возможность',
        },
      );
    }
  }
}

function adapterOf(name: string, context: RunContext): BackendAdapter {
  const existing = context.adapters.get(name);
  if (existing !== undefined) return existing;
  const created = (context.adapterFor ?? ((backend) => resolveAdapter(backend, context.config)))(name);
  context.adapters.set(name, created);
  return created;
}

/**
 * Работа целиком: заведение каталогов работы, её исполнение и снятие пустого
 * каталога черновиков.
 *
 * Каталог черновиков заводится в `prepareJob` — до подготовки рабочей
 * директории и до раскрытия подстановок, каждое из которых может отказать.
 * Поэтому его снятие висит здесь, на общем `finally` вокруг всей работы, а не
 * внутри `runJob`: иначе работа, отказавшая на подготовке, оставляла бы в
 * раскладке пустой каталог, а правило «пустого нет — значит не писал»
 * держалось бы только на удачных путях.
 */
async function executeJob(
  declared: Job,
  scope: Record<string, unknown>,
  context: RunContext,
): Promise<JobOutcome> {
  const { journal } = context;

  journal.prepareJob(declared.id);
  journal.event({ kind: 'job.started', job: declared.id });
  context.records.set(declared.id, {
    ...(context.records.get(declared.id) as JobRecord),
    status: 'running',
    started_at: new Date().toISOString(),
  });

  try {
    return await runJob(declared, scope, context);
  } finally {
    // Пустой каталог черновиков не несёт материала для разбора и не должен
    // копиться в раскладке прогона годами; непустой остаётся — в нём мог лечь
    // след отказа. Отказ снятия — учётная операция, не исход работы: агент,
    // которому запрещено трогать что-либо за пределами дерева, права на
    // уборку здесь и не давалось.
    bookkeep({ journal, job: declared.id }, 'снятие каталога черновиков', () => {
      const dir = jobScratchDir(journal.paths, declared.id);
      // Убрать каталог за собой шагу никто не запрещал, и сделанное им — не
      // отказ учёта: жаловаться в журнал на достигнутый результат незачем.
      if (!existsSync(dir)) return;
      if (readdirSync(dir).length === 0) rmdirSync(dir);
    });
  }
}

/**
 * Исполнение работы: подготовка рабочей директории и внешний цикл `until`.
 *
 * Работа без цикла — вырожденный случай с одной итерацией и без уровня
 * итерации в раскладке журнала.
 */
async function runJob(
  declared: Job,
  scope: Record<string, unknown>,
  context: RunContext,
): Promise<JobOutcome> {
  const { journal } = context;

  // Отложенные подстановки раскрываются ниже, после подготовки рабочей
  // директории: её путь входит в область видимости как `run.workspace`, и
  // раньше он неизвестен. До этого момента работа адресуется объявленной —
  // подстановок в идентификаторе и топологии не бывает по устройству формата.
  let job = declared;

  // Рабочая директория готовится до первого шага. Её отказ означает, что шаги
  // запустить негде, — это `spawn_failed` из закрытого перечня, а не новая
  // причина остановки.
  const source = resolveInheritSource(context.graph, job, context.completedWorkspaces);
  let prepared: PreparedWorkspace;
  try {
    prepared = prepareWorkspace({
      job,
      cwd: context.cwd,
      runDir: journal.paths.dir,
      source,
      anchorKind: context.anchorKind,
      anchorsDir: journal.paths.anchors,
      ...(context.anchorerFor === undefined ? {} : { anchorerFor: context.anchorerFor }),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      status: 'failed',
      reason: `рабочую директорию в режиме ${job.workspace.mode} подготовить не удалось: ${detail}`,
      cause: HaltCause.spawnFailed,
    };
  }

  context.records.set(job.id, {
    ...(context.records.get(job.id) as JobRecord),
    workspace: {
      mode: prepared.mode,
      path: prepared.dir,
      ...(prepared.inheritedFrom === undefined ? {} : { inherited_from: prepared.inheritedFrom }),
      ...(prepared.continued === undefined ? {} : { continued: prepared.continued }),
    },
  });

  if (prepared.inheritedFrom !== undefined) {
    journal.event({
      kind: 'workspace.inherited',
      job: job.id,
      source: prepared.inheritedFrom,
      via: prepared.continued === true ? 'continue' : 'seed',
    });
  }

  try {
    job = resolveLate(declared, {
      jobs: (scope.jobs ?? {}) as Readonly<Record<string, JobScopeEntry>>,
      run: {
        id: journal.paths.runId,
        dir: journal.paths.dir,
        workspace: prepared.dir,
        scratch: jobScratchDir(journal.paths, job.id),
      },
      env: declared.env,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      status: 'failed',
      reason: `подстановку раскрыть не удалось: ${detail}`,
      cause: HaltCause.spawnFailed,
    };
  }

  // Раскрытое определение кладётся рядом с записью работы: иначе ответ на
  // вопрос, с каким путём шаг на самом деле пошёл в файловую систему,
  // восстанавливается только из логов.
  journal.writeJobJson(job.id, 'resolved.json', job);

  // Данные переиспользованных шагов переносятся до первого шага: работа ниже
  // по графу читает их подстановкой, и пустота здесь ломала бы её ровно при
  // возобновлении.
  transferJobData(context, job.id);

  // Ниже по коду `context` — контекст работы: у него своя рабочая директория.
  const jobContext: RunContext = { ...context, cwd: prepared.dir };
  const anchorState: { anchorer: TreeAnchorer | undefined; lastAnchor: Anchor | undefined } = {
    anchorer: undefined,
    lastAnchor: undefined,
  };
  const jobStartedAt = Date.now();
  const maxIterations = job.until?.maxIterations ?? 1;
  let previousCheck: readonly PredicateResult[] | undefined;

  try {
    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      if (job.until !== undefined) {
        journal.event({ kind: 'iteration.started', job: job.id, iteration });
      }

      const outcome = await runJobSteps(job, declared, jobContext, anchorState, {
        jobStartedAt,
        ...(job.until === undefined ? {} : { iteration }),
        ...(previousCheck === undefined ? {} : { previousCheck }),
      });

      // Отказ шага прекращает цикл немедленно: новой итерации нет, `check` не
      // вычисляется. Повторять то, что уже исчерпало попытки, незачем.
      if (outcome.status !== 'success' || job.until === undefined) {
        if (job.until !== undefined) {
          journal.event({
            kind: 'iteration.finished',
            job: job.id,
            iteration,
            passed: false,
            reason: outcome.reason ?? outcome.status,
          });
        }
        return outcome;
      }

      const results = await evaluateCheck(job, jobContext);
      const passed = results.every((item) => item.passed || !item.hard);
      journal.event({ kind: 'iteration.finished', job: job.id, iteration, passed });

      context.records.set(job.id, {
        ...(context.records.get(job.id) as JobRecord),
        iterations: iteration,
      });

      if (passed) return outcome;
      previousCheck = results;

      if (context.usage.check(jobScopes(job, context)) !== undefined) {
        return {
          status: 'budget_exceeded',
          reason: `цикл прекращён: бюджет работы ${job.id} исчерпан`,
          cause: HaltCause.budgetExceeded,
        };
      }
    }

    return {
      status: 'failed',
      reason: `предикаты until не прошли за ${maxIterations} итераций`,
      cause: HaltCause.untilNotMet,
      ...(previousCheck === undefined ? {} : { lastCheck: previousCheck }),
    };
  } catch (error) {
    // Ошибка внутри работы — её отказ, а не крушение прогона. Иначе состояние
    // остаётся в `running`, статусы отработавших работ теряются, а работы с
    // `needs: all` не выполняются — то есть разбирать случившееся нечем ровно
    // тогда, когда разбор нужнее всего.
    //
    // Ловится любое исключение: ошибки учёта сюда не доходят, их отделяет
    // `bookkeep`. Значит это либо объявленная ошибка конфигурации, которую
    // нельзя было выявить заранее (путь с подстановкой статически не
    // проверяется), либо дефект движка — и во втором случае унести с собой
    // бухгалтерию прогона хуже, чем отказать одной работой.
    const detail = error instanceof Error ? error.message : String(error);
    journal.event({ kind: 'job.errored', job: job.id, detail });
    return {
      status: 'failed',
      reason: `работа прервана ошибкой: ${detail}`,
      cause: HaltCause.spawnFailed,
    };
  } finally {
    // Каталог и последний якорь записываются независимо от исхода: наследник
    // может продолжить дерево даже упавшей работы, а работа без единого
    // снятого якоря пропускается по цепочке (`resolveInheritSource`).
    context.completedWorkspaces.set(job.id, {
      dir: prepared.dir,
      ...(anchorState.lastAnchor === undefined ? {} : { anchor: anchorState.lastAnchor }),
    });
    // Индексный файл живёт ровно столько, сколько работа.
    anchorState.anchorer?.dispose();
  }
}

/**
 * Проверки цикла. Вычисляются после всех шагов итерации, в рабочей директории
 * работы. Время идёт в бюджет работы, токены — только если проверка обращается
 * к агентскому бэкенду.
 */
async function evaluateCheck(job: Job, context: RunContext): Promise<PredicateResult[]> {
  const until = job.until;
  if (until === undefined) return [];

  return evaluatePredicates(until.check, {
    exitCode: 0,
    text: '',
    structured: undefined,
    cwd: context.cwd,
    // Проверка цикла запускает настоящую команду сборки или тестов, и без
    // окружения она не найдёт ни одного инструмента: `execaSync` зовётся с
    // `extendEnv: false`, поэтому пустой набор означает буквально пустой —
    // ни PATH, ни HOME.
    env: jobEnv(job, context),
  });
}

/**
 * Окружение работы: то же, что у её шагов, но без переменных уровня шага.
 * Проверка цикла шагом не является, и объявлять `STEPCAST_STEP` для неё было
 * бы неправдой.
 */
function jobEnv(job: Job, context: RunContext): Record<string, string> {
  const { pipeline } = context.expanded;
  const { env } = buildStepEnv({
    base: context.baseEnv ?? process.env,
    envFiles: pipeline.envFiles,
    pipeline: pipeline.env,
    job: job.env,
    step: {},
    injected: injectedVariables({
      runId: context.journal.paths.runId,
      runDir: context.journal.paths.dir,
      binPath: process.argv[1] ?? '',
      jobId: job.id,
      jobDir: context.journal.prepareJob(job.id),
      attempt: 1,
      workspace: context.cwd,
      artifacts: context.journal.paths.artifacts,
      scratch: jobScratchDir(context.journal.paths, job.id),
    }),
    deny: pipeline.envDeny,
    cwd: context.cwd,
  });
  return env;
}

/** Области бюджета работы и прогона: цикл ограничен ими обеими. */
function jobScopes(job: Job, context: RunContext): BudgetScope[] {
  return [
    { kind: 'job', name: `работа ${job.id}`, jobId: job.id, budget: job.budget },
    { kind: 'run', name: 'пайплайн', budget: context.expanded.pipeline.budget },
  ];
}

/**
 * Работа и шаг, от имени которых пишется запись журнала. При чередующихся
 * работах запись без них разбирается только догадкой.
 */
interface StepAddress {
  readonly job: string;
  readonly step: string;
}

/** Исход ожидания сброса окна лимита. */
type WaitOutcome =
  | { readonly kind: 'resumed' }
  | { readonly kind: 'canceled' }
  | { readonly kind: 'stopped'; readonly exceeded: Exceeded };

/**
 * Ждать сброса окна лимита, упёршегося в потолок с `on_exceed: wait`.
 *
 * Вырождается в остановку, если ждать нечего — момент сброса не сообщён,
 * отстоит дальше предела ожидания, или суммарное ожидание за прогон уже
 * исчерпало предел. Сон прерывается сигналом прогона немедленно.
 */
async function waitForReset(
  exceeded: Exceeded,
  context: RunContext,
  where?: StepAddress,
): Promise<WaitOutcome> {
  if (exceeded.resetsAt === undefined) {
    return {
      kind: 'stopped',
      exceeded: {
        ...exceeded,
        onExceed: 'stop',
        waitDegeneration: 'бэкенд не сообщил момент сброса окна лимита',
      },
    };
  }

  const now = Date.now();
  const waitMs = exceeded.resetsAt - now;
  // Момент сброса в прошлом сном не считается: следующая попытка либо
  // покажет упавший процент, либо упрётся снова — в пределах общего предела.
  if (waitMs <= 0) return { kind: 'resumed' };

  const maxWaitMs = context.config.defaults.maxWaitMs;
  if (context.usage.wouldExceedMaxWait(waitMs, maxWaitMs)) {
    return {
      kind: 'stopped',
      exceeded: {
        ...exceeded,
        onExceed: 'stop',
        waitDegeneration: `предел ожидания ${formatDuration(maxWaitMs)} исчерпан; сброс сообщён на ${new Date(exceeded.resetsAt).toISOString()}`,
      },
    };
  }

  const wakeAt = new Date(exceeded.resetsAt).toISOString();
  const endWait = context.beginWait(wakeAt);
  context.journal.event({
    kind: 'budget.waiting',
    scope: exceeded.scope,
    ...(where === undefined ? {} : { job: where.job, step: where.step }),
    dimension: 'rate_limit',
    threshold: exceeded.limit,
    resets_at: exceeded.resetsAt,
    wait_ms: waitMs,
  });

  const started = Date.now();
  const canceled = await sleepInterruptibly(waitMs, context.signal);
  const actualMs = Date.now() - started;

  context.usage.recordWait(started, started + actualMs);
  endWait();
  if (canceled) return { kind: 'canceled' };

  context.journal.event({
    kind: 'budget.resumed',
    ...(where === undefined ? {} : { job: where.job, step: where.step }),
    actual_ms: actualMs,
  });
  return { kind: 'resumed' };
}

/** Исход попытки, упёршейся в неустранимый отказ бэкенда — шага или судьи. */
type RefusalOutcome = { readonly kind: 'retry' } | { readonly kind: 'final'; readonly outcome: StepOutcome };

/**
 * Режим для отказа по лимиту: у ближайшей *объявившей* его области — шаг →
 * работа → пайплайн. Берётся написанное в документе, а не действующее
 * значение бюджета: умолчание `stop` стоит в каждом объявленном бюджете, и по
 * действующему значению шаг с одним лишь `tokens` молча отменял бы
 * пайплайновый `on_exceed: wait`.
 */
function resolveOnExceedForRateLimit(job: Job, step: Step, context: RunContext): 'wait' | 'stop' {
  return (
    step.budget?.declaredOnExceed ??
    job.budget?.declaredOnExceed ??
    context.expanded.pipeline.budget?.declaredOnExceed ??
    'stop'
  );
}

/**
 * Ждать сброса окна лимита, когда бэкенд отказал упором в лимит подписки, а
 * не когда прогон сам измерил превышение `rate_limit_pct`. Механика та же,
 * что у `waitForReset` (предел `defaults.max_wait`, немедленное прерывание
 * сигналом отмены, невычитание сна из `wallclock`), но `used`/`limit`
 * измеренного процента здесь нет и подделывать их нечем: отказ бэкенда не
 * есть измеренная доля окна.
 */
async function waitForBackendRateLimit(
  refusal: BackendRefusal,
  scopeName: string,
  where: StepAddress,
  context: RunContext,
): Promise<{ readonly kind: 'resumed' } | { readonly kind: 'canceled' } | { readonly kind: 'stopped'; readonly reason: string }> {
  if (refusal.resetAt === undefined) {
    return {
      kind: 'stopped',
      reason: `${scopeName}: бэкенд не сообщил момент сброса окна лимита — ${refusal.message}`,
    };
  }

  const now = Date.now();
  const waitMs = refusal.resetAt - now;
  if (waitMs <= 0) return { kind: 'resumed' };

  const maxWaitMs = context.config.defaults.maxWaitMs;
  if (context.usage.wouldExceedMaxWait(waitMs, maxWaitMs)) {
    return {
      kind: 'stopped',
      reason: `${scopeName}: предел ожидания ${formatDuration(maxWaitMs)} исчерпан; сброс сообщён на ${new Date(refusal.resetAt).toISOString()} — ${refusal.message}`,
    };
  }

  const wakeAt = new Date(refusal.resetAt).toISOString();
  const endWait = context.beginWait(wakeAt);
  context.journal.event({
    kind: 'budget.waiting',
    scope: scopeName,
    job: where.job,
    step: where.step,
    dimension: 'rate_limit',
    resets_at: refusal.resetAt,
    wait_ms: waitMs,
  });

  const started = Date.now();
  const canceled = await sleepInterruptibly(waitMs, context.signal);
  const actualMs = Date.now() - started;

  context.usage.recordWait(started, started + actualMs);
  endWait();
  if (canceled) return { kind: 'canceled' };

  context.journal.event({
    kind: 'budget.resumed',
    job: where.job,
    step: where.step,
    actual_ms: actualMs,
  });
  return { kind: 'resumed' };
}

/**
 * Обработать неустранимый отказ бэкенда — общий путь для шага и судьи внутри
 * него. Событие журнала пишется здесь же: причина видна без чтения
 * `stdout.log` шага.
 */
async function resolveBackendRefusal(
  refusal: BackendRefusal,
  job: Job,
  step: Step,
  attempt: number,
  context: RunContext,
  base: Pick<StepOutcome, 'attempts' | 'results' | 'session'>,
): Promise<RefusalOutcome> {
  context.journal.event({
    kind: 'backend.refused',
    job: job.id,
    step: step.id,
    attempt,
    class: refusal.class,
    ...(refusal.statusCode === undefined ? {} : { status_code: refusal.statusCode }),
    message: refusal.message,
    ...(refusal.resetAt === undefined ? {} : { resets_at: refusal.resetAt }),
  });

  if (refusal.class === 'unauthenticated') {
    return {
      kind: 'final',
      outcome: {
        ...base,
        status: 'failed',
        reason: describeRefusal(refusal),
        cause: HaltCause.backendUnauthenticated,
      },
    };
  }

  const scopeName = `${job.id}/${step.id}`;
  const mode = resolveOnExceedForRateLimit(job, step, context);
  const waited =
    mode === 'wait'
      ? await waitForBackendRateLimit(refusal, scopeName, { job: job.id, step: step.id }, context)
      : ({
          kind: 'stopped',
          reason: `${scopeName}: упор в окно лимита подписки бэкенда — ${refusal.message}`,
        } as const);

  if (waited.kind === 'resumed') {
    // Расход оборванной попытки запечатывается перед переисполнением: иначе
    // новая попытка ляжет под тем же ключом `job/step#attempt` и разностный
    // учёт `UsageAccumulator.record` вычтет из потолков расход прерванной —
    // ровно то, чего требование «расход прерванной попытки остаётся
    // учтённым» запрещает.
    context.usage.sealStep(job.id, step.id);
    return { kind: 'retry' };
  }
  if (waited.kind === 'canceled') {
    return { kind: 'final', outcome: { ...base, status: 'canceled' } };
  }
  return {
    kind: 'final',
    outcome: {
      ...base,
      status: 'budget_exceeded',
      reason: waited.reason,
      cause: HaltCause.backendRateLimited,
    },
  };
}

/** Сон, прерываемый сигналом отмены. Возвращает true, если прерван. */
function sleepInterruptibly(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

interface IterationOptions {
  /**
   * Момент начала работы. Потолок времени работы меряет её саму, включая все
   * итерации цикла, а не прогон целиком.
   */
  readonly jobStartedAt: number;
  /** Номер итерации. Отсутствует у работы без цикла. */
  readonly iteration?: number;
  /** Результаты непрошедшего `check` предыдущей итерации. */
  readonly previousCheck?: readonly PredicateResult[];
}

async function runJobSteps(
  job: Job,
  declared: Job,
  context: RunContext,
  anchorState: { anchorer: TreeAnchorer | undefined; lastAnchor: Anchor | undefined },
  iterationOptions: IterationOptions,
): Promise<JobOutcome> {
  const { journal } = context;
  const iteration = iterationOptions.iteration;
  const jobStartedAt = iterationOptions.jobStartedAt;
  context =
    iterationOptions.previousCheck === undefined
      ? context
      : { ...context, iterationCheck: iterationOptions.previousCheck };

  // Якорь на работу: индексный файл переиспользуется между её шагами, поэтому
  // `add -A` платит только за изменившиеся файлы.
  const scope = { journal, job: job.id };
  const anchorer = bookkeep(scope, 'создание якоря', () =>
    (context.anchorerFor ?? createAnchorer)({
      dir: context.cwd,
      stateDir: journal.paths.anchors,
      kind: context.anchorKind,
      scope: job.id,
      // Рабочая копия сама рабочим деревом git не является: базу объектов ей
      // даёт репозиторий прогона.
      repoDir: context.runCwd,
    }),
  );
  anchorState.anchorer = anchorer;

  /** Снять якорь. Неудача — запись в журнал и `undefined`, статусы не трогает. */
  const capture = (step?: string): Anchor | undefined =>
    anchorer === undefined
      ? undefined
      : bookkeep({ ...scope, ...(step === undefined ? {} : { step }) }, 'снятие якоря', () =>
          anchorer.capture(),
        );

  let treeAnchor = capture();
  anchorState.lastAnchor = treeAnchor;

  const sessions = createSessionRegistry();
  // Сессии, в которые уже отправлен унаследованный контекст. Отслеживание
  // живёт в работе, а не в шаге: иначе каждый шаг общей сессии заново
  // получает свод правил, который агент уже прочитал, и весь смысл общей
  // сессии теряется.
  const contextSent = new Set<string>();
  const steps: StepRecord[] = [];
  let lastStructuredOutput: unknown;
  let outputFromStep: unknown;
  /** `output.from` назвал переиспользованный шаг, а его выход не перенёсся. */
  let outputFromStepMissing = false;

  for (const [position, step] of job.steps.entries()) {
    // Ключ шага держится на нераскрытом определении: отложенные подстановки
    // пространства `run` уникальны для каждого прогона, и раскрытый текст
    // сделал бы ключ невоспроизводимым. Соответствие — позиционное:
    // `resolveLate` обходит дерево работы, не добавляя, не убирая и не
    // переставляя шаги. По `step.id` его устанавливать нельзя — идентификатор
    // сам может содержать подстановку, и тогда раскрытый шаг не нашёл бы себя
    // в нераскрытом определении, а при совпадающих идентификаторах ключ
    // молча считался бы не от того шага.
    const declaredStep = declared.steps[position];
    if (declaredStep === undefined) {
      throw new Error(
        `внутренняя ошибка: шагу ${job.id}/${step.id} не найдено соответствие в нераскрытом определении работы`,
      );
    }

    const stepDirPath = journal.prepareStep(job.id, step.index, step.id, iteration);

    const planned = planFor(context, job.id, step.id);
    if (planned?.decision.kind === 'reuse') {
      const reused: StepRecord = {
        ...planned.decision.record,
        reused_from: context.resume?.source.manifest.run_id ?? 'неизвестно',
      };
      steps.push(reused);
      journal.writeStepJson(stepDirPath, 'step.json', reused);
      journal.event({
        kind: 'step.reused',
        job: job.id,
        step: step.id,
        source: reused.reused_from as string,
      });
      context.records.set(job.id, {
        ...(context.records.get(job.id) as JobRecord),
        steps: [...steps],
      });
      foldJobData(context, job.id);
      if (
        (step.kind === 'agent' || step.outputSchemaPath !== undefined) &&
        planned.decision.record.status === 'success'
      ) {
        // Переиспользованный шаг не исполнялся, структурированного вывода у
        // него в этом прогоне нет: он переносится из исходного прогона —
        // единственный источник `output.from` при частичном переиспользовании
        // работы, когда выход работы целиком не перенесён.
        const transferred = transferStepOutput(context, job.id, step.id, stepDirPath);
        lastStructuredOutput =
          transferred ?? context.resume?.plan.outputs.get(job.id) ?? lastStructuredOutput;
        if (job.output?.from === step.id) {
          // Перенос мог не удаться: файла выхода в исходном прогоне нет или он
          // не разбирается. Отметку нужно сохранить — иначе ниже сработает
          // запасной `lastStructuredOutput`, и работа опубликует как свой выход
          // другого, позже исполненного шага.
          outputFromStep = transferred;
          outputFromStepMissing = transferred === undefined;
        }
      }
      treeAnchor =
        reused.tree_id === undefined
          ? treeAnchor
          : { kind: reused.anchor_kind ?? context.anchorKind, id: reused.tree_id };
      anchorState.lastAnchor = treeAnchor;
      continue;
    }

    journal.event({ kind: 'step.started', job: job.id, step: step.id, attempt: 1 });

    const treeBefore = treeAnchor;
    // Отпечаток считается до запуска: он отвечает на вопрос о валидности шага,
    // а вопрос этот имеет смысл только перед исполнением.
    const fingerprint = fingerprintInputs({
      dir: context.cwd,
      treeAnchor: treeBefore,
      declared: job.inputs,
      observed: context.observedInputs?.get(`${job.id}/${step.id}`),
    });

    // Начало шага — здесь: потолок времени шага меряет шаг, а не прогон.
    const stepStartedAt = Date.now();

    const budgetScopes = (): BudgetScope[] => [
      {
        kind: 'step',
        name: `${job.id}/${step.id}`,
        jobId: job.id,
        stepId: step.id,
        startedAt: stepStartedAt,
        budget: step.budget,
      },
      {
        kind: 'job',
        name: `работа ${job.id}`,
        jobId: job.id,
        startedAt: jobStartedAt,
        budget: job.budget,
      },
      { kind: 'run', name: 'пайплайн', budget: context.expanded.pipeline.budget },
    ];

    let exceeded = context.usage.check(budgetScopes());

    // Пути, изменившиеся за время шага, нужны только предикату границ —
    // считаем их лениво и только когда он объявлен.
    const wantsChanged = step.expect.some((predicate) => predicate.kind === 'changed_only');
    const changedPaths = (): readonly string[] | undefined => {
      if (!wantsChanged || anchorer === undefined || treeBefore === undefined) return undefined;
      const now = bookkeep({ ...scope, step: step.id }, 'снятие якоря для changed_only', () =>
        anchorer.capture(),
      );
      if (now === undefined) return undefined;
      const comparison = bookkeep({ ...scope, step: step.id }, 'сравнение состояний', () =>
        anchorer.changedPaths(treeBefore, now),
      );
      return comparison?.comparable === true ? comparison.paths : undefined;
    };

    const outcome =
      step.kind === 'run'
        ? await runCommandStep(step, job, context, stepDirPath, sessions, budgetScopes, changedPaths)
        : await runAgentStep(
            step,
            job,
            context,
            stepDirPath,
            sessions,
            contextSent,
            budgetScopes,
            changedPaths,
          );

    // Превышение, обнаруженное за время шага, приписывается ему, только если
    // его собственный расход потолок и перевёл. Успевшая попытка соседа,
    // ничего в этот потолок не добавившая, остаётся успешной: её результат
    // получен и оплачен. Новых попыток и шагов после этого всё равно не
    // будет — следующий шаг упрётся в проверку до запуска.
    if (exceeded === undefined && outcome.exceeded !== undefined) {
      const own =
        outcome.status !== 'success' ||
        context.usage.crossedBy(outcome.exceeded, job.id, step.id);
      if (own) exceeded = outcome.exceeded;
    }

    for (const [index, results] of outcome.results.entries()) {
      journal.writeExpectReport(stepDirPath, { attempt: index + 1, results: [...results] });
    }

    const status: StatusValue = exceeded !== undefined ? 'budget_exceeded' : outcome.status;
    const reason = exceeded !== undefined ? describeExceeded(exceeded) : outcome.reason;
    const cause = causeOf(status, outcome.results, outcome.cause);

    // Якорь снимается при любом исходе, включая отказ, отмену и превышение
    // бюджета: разбирать упавший прогон без состояния дерева нечем.
    const treeAfter = capture(step.id);
    treeAnchor = treeAfter ?? treeAnchor;
    anchorState.lastAnchor = treeAnchor;

    if (anchorer !== undefined && treeBefore !== undefined && treeAfter !== undefined) {
      const patch = bookkeep({ ...scope, step: step.id }, 'вычисление diff.patch', () =>
        anchorer.diff(treeBefore, treeAfter),
      );
      if (patch !== undefined) journal.writeStepFile(stepDirPath, 'diff.patch', patch);
    }

    const stepRecord: StepRecord = {
      id: step.id,
      index: step.index,
      kind: step.kind,
      key: computeStepKey({
        // Хеш определения именно этой работы, а не всего пайплайна: правка
        // файла другой работы не должна менять ключ шагов, которые её не
        // касаются. Оба входа — нераскрытые: раскрытие подставляет величины
        // пространства `run`, уникальные для каждого прогона.
        lockHash: jobLockHash(context.expanded.pipeline, declared),
        jobId: job.id,
        step: declaredStep,
        inputsFingerprint: fingerprint?.value,
        backendCommand:
          declaredStep.kind === 'agent'
            ? context.config.backends[declaredStep.agent]?.command
            : undefined,
        // Порядок завершения работ у исполнителя свой, у планировщика
        // возобновления свой; общая функция приводит оба к одному виду.
        // Состав берётся по графу, а не по тому, что успело завершиться:
        // иначе ключ шага, а с ним и решение о переиспользовании, зависели бы
        // от длительности соседних работ.
        upstream: upstreamForKey(upstreamOutputs(context.graph, job.id, context.outputs)),
      }),
      status,
      ...(treeAfter === undefined
        ? { anchor_missing: 'якорь состояния дерева снять не удалось' }
        : { tree_id: treeAfter.id, anchor_kind: treeAfter.kind }),
      ...(treeBefore === undefined ? {} : { tree_before: treeBefore.id }),
      ...(fingerprint === undefined
        ? {}
        : { inputs_fingerprint: fingerprint.value, inputs_origin: fingerprint.origin }),
      ...(reason === undefined ? {} : { reason }),
      ...(cause === undefined ? {} : { cause }),
      ...(outcome.session === undefined ? {} : { session: outcome.session }),
      attempts: [...outcome.attempts],
      ...(outcome.observedInputs === undefined || outcome.observedInputs.length === 0
        ? {}
        : { observed_inputs: [...outcome.observedInputs] }),
      ...(outcome.backendInit === undefined ? {} : { backend_init: outcome.backendInit }),
    };
    steps.push(stepRecord);
    journal.writeStepJson(stepDirPath, 'step.json', stepRecord);

    if ((step.kind === 'agent' || step.outputSchemaPath !== undefined) && outcome.structured !== undefined) {
      lastStructuredOutput = outcome.structured;
      journal.writeStepJson(stepDirPath, 'output.json', outcome.structured);
    }
    if (job.output?.from === step.id) outputFromStep = outcome.structured;

    journal.event({
      kind: 'step.finished',
      job: job.id,
      step: step.id,
      attempt: outcome.attempts.length,
      status,
      ...(reason === undefined ? {} : { reason }),
    });

    context.records.set(job.id, {
      ...(context.records.get(job.id) as JobRecord),
      steps: [...steps],
    });
    foldJobData(context, job.id);

    if (status !== 'success') {
      return {
        status,
        ...(reason === undefined ? {} : { reason: `шаг ${step.id}: ${reason}` }),
        ...(cause === undefined ? {} : { cause }),
      };
    }
  }

  if (outputFromStepMissing) {
    return {
      status: 'failed',
      reason: `выход шага ${job.output?.from} не перенесён из исходного прогона: файла нет или он не разбирается`,
    };
  }

  const published = job.output === undefined ? undefined : (outputFromStep ?? lastStructuredOutput);
  if (job.output !== undefined && published !== undefined) {
    const path = journal.writeArtifact(job.id, published);
    // Выходом работы с циклом становится результат последней выполненной
    // итерации: запись замещается, а не накапливается по итерациям.
    const existing = context.outputs.findIndex((output) => output.job === job.id);
    const entry = { job: job.id, path, value: published };
    if (existing === -1) context.outputs.push(entry);
    else context.outputs[existing] = entry;
    context.records.set(job.id, {
      ...(context.records.get(job.id) as JobRecord),
      output: path,
    });
    return { status: 'success', output: published };
  }

  return { status: 'success' };
}

interface StepOutcome {
  readonly status: StatusValue;
  readonly reason?: string;
  readonly attempts: readonly StepRecord['attempts'][number][];
  readonly results: readonly (readonly PredicateResult[])[];
  readonly structured?: unknown;
  readonly session?: string;
  readonly observedInputs?: readonly string[];
  readonly backendInit?: Record<string, unknown>;
  readonly exceeded?: ReturnType<UsageAccumulator['check']>;
  /**
   * Причина неуспеха, назначенная самим исходом, а не выводимая из статуса
   * позже: неустранимый отказ бэкенда определяет её точнее, чем это умеет
   * `causeOf` по одному статусу и результатам предикатов.
   */
  readonly cause?: HaltCauseValue;
}

/**
 * Комбинированный сигнал шага: аборт по отмене прогона *или* по превышению
 * бюджета с `on_exceed: wait` по `rate_limit`. Разделены, чтобы после
 * исполнения отличить настоящую отмену от прерывания ради ожидания — только
 * второе ведёт в переисполнение шага, а не в статус `canceled`.
 */
function stepAbort(context: RunContext): {
  readonly controller: AbortController;
  readonly trigger: (found: Exceeded | undefined) => void;
  readonly dispose: () => void;
  waitTrigger: Exceeded | undefined;
} {
  const controller = new AbortController();
  const onRunAbort = (): void => controller.abort();
  context.signal?.addEventListener('abort', onRunAbort, { once: true });

  const state = {
    controller,
    waitTrigger: undefined as Exceeded | undefined,
    trigger(found: Exceeded | undefined) {
      if (found === undefined || controller.signal.aborted) return;
      if (found.onExceed === 'wait' && found.dimension === 'rate_limit') state.waitTrigger = found;
      controller.abort();
    },
    dispose() {
      context.signal?.removeEventListener('abort', onRunAbort);
    },
  };
  return state;
}

/** Денежный потолок объявлен хоть на одном из трёх уровней, охватывающих шаг. */
function costBudgetDeclared(context: RunContext, job: Job, step: Step): boolean {
  return (
    step.budget?.costMicroUsd !== undefined ||
    job.budget?.costMicroUsd !== undefined ||
    context.expanded.pipeline.budget?.costMicroUsd !== undefined
  );
}

/** Денежный потолок объявлен хоть где-то в пайплайне: пайплайн, работа или шаг. */
function anyCostBudgetDeclared(pipeline: Pipeline): boolean {
  if (pipeline.budget?.costMicroUsd !== undefined) return true;
  return pipeline.jobs.some(
    (job) =>
      job.budget?.costMicroUsd !== undefined ||
      job.steps.some((step) => step.budget?.costMicroUsd !== undefined),
  );
}

/**
 * Вход отклонённого вызова инструмента в текст для журнала. Полный вход
 * остаётся в `stdout.log` — сюда идёт только то, что помогает опознать вызов
 * в ленте и в `events.ndjson`, до обрезки общим правилом `inline()`.
 */
function describePermissionDenialInput(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

/**
 * Вызывается ровно там, где расход попытки уже окончателен — после того как
 * и сам шаг, и все его судьи отчитались. Раньше отсюда цена ещё не пришла бы
 * никогда: она приходит один раз, в финальной записи попытки.
 */
function checkCostUnreported(context: RunContext, job: Job, step: Step, attempt: number): void {
  if (context.usage.takeCostUnreportedEvent(costBudgetDeclared(context, job, step))) {
    context.journal.event({ kind: 'budget.cost_unreported', job: job.id, step: step.id, attempt });
  }
}

async function runCommandStep(
  step: Extract<Step, { kind: 'run' }>,
  job: Job,
  context: RunContext,
  stepDirPath: string,
  _sessions: ReturnType<typeof createSessionRegistry>,
  budgetScopes: () => BudgetScope[],
  changedPaths: () => readonly string[] | undefined,
): Promise<StepOutcome> {
  const { journal, config } = context;
  // Разобранный выход командного шага. Заполняется только когда объявлен
  // output_schema — без него у командного шага структурированного выхода
  // нет, и поле остаётся неопределённым до конца функции.
  let structuredOutput: unknown;

  for (;;) {
    let exceeded: ReturnType<UsageAccumulator['check']>;
    let judgeCallCount = 0;
    const nextCallIndex = (): number => {
      judgeCallCount += 1;
      return judgeCallCount;
    };
    const onStall = (silentMs: number): void =>
      journal.event({ kind: 'step.stalled', job: job.id, step: step.id, silent_ms: silentMs });

    const abort = stepAbort(context);

    const result = await executeRunStep({
      step,
      cwd: context.cwd,
      stepDir: stepDirPath,
      stallTimeoutMs: config.defaults.stallTimeoutMs,
      signal: abort.controller.signal,
      env: (plan) => stepEnv(step, job, plan.attempt, context, stepDirPath),
      evaluate: async (target, process_, plan) => {
        // Разбор строгий: только пробелы по краям снимаются, без поиска
        // первого объекта и без склейки последней строки — вывод либо один
        // JSON-документ целиком, либо отказ попытки.
        let structured: unknown;
        if (target.outputSchemaPath !== undefined) {
          try {
            structured = JSON.parse(process_.stdout.trim());
          } catch (error) {
            return [
              {
                predicate: 'output_schema',
                passed: false,
                hard: true,
                detail: `шаг ${target.id} объявляет output_schema, но stdout не разбирается как JSON: ${(error as Error).message}`,
              },
            ];
          }
          structuredOutput = structured;
        }

        const firstPass = evaluatePredicates(target.expect, {
          exitCode: process_.exitCode,
          text: process_.stdout,
          structured,
          cwd: context.cwd,
          env: stepEnv(step, job, 1, context, stepDirPath),
          changedPaths: changedPaths(),
        });

        if (!target.expect.some((predicate) => predicate.kind === 'judge')) return firstPass;

        // Командный шаг сам расхода не несёт: расход попытки — это расход
        // судей, накапливаемый по мере их вызовов, а не заменяемый последним.
        let attemptUsage: Usage | undefined;
        const judgeResults = await runJudgePass({
          predicates: target.expect,
          firstPass,
          task: describeStepTask(target),
          text: process_.stdout,
          structured: structured ?? process_.stdout,
          cwd: context.cwd,
          stepDir: stepDirPath,
          attempt: plan.attempt,
          timeoutMs: target.timeoutMs,
          stallTimeoutMs: config.defaults.stallTimeoutMs,
          signal: abort.controller.signal,
          onStall,
          adapterFor: (name) => adapterOf(name, context),
          defaultAgent: config.defaults.agent,
          backendSlots: context.backendSlots,
          journal,
          nextCallIndex,
          canCall: () => {
            const found = context.usage.check(budgetScopes());
            exceeded ??= found;
            abort.trigger(found);
            return found === undefined;
          },
          onUsage: (usage) => {
            attemptUsage = attemptUsage === undefined ? usage : sumUsage(attemptUsage, usage);
            context.usage.record(job.id, step.id, plan.attempt, attemptUsage);
            const found = context.usage.check(budgetScopes());
            exceeded ??= found;
            abort.trigger(found);
          },
        });
        if (attemptUsage !== undefined) checkCostUnreported(context, job, step, plan.attempt);
        return judgeResults;
      },
      onStall,
      onExpectFailed: (plan, failure) =>
        journal.event({
          kind: 'expect.failed',
          job: job.id,
          step: step.id,
          attempt: plan.attempt,
          predicate: failure.predicate,
          ...(failure.detail === undefined ? {} : { detail: failure.detail }),
        }),
    });

    abort.dispose();
    if (exceeded === undefined) {
      const found = context.usage.check(budgetScopes());
      exceeded = found;
      abort.trigger(found);
    }

    // Отказ бэкенда добирается сюда только через судью: командный шаг сам
    // агентский бэкенд не зовёт.
    const refusal = extractRefusal(result.results.at(-1) ?? []);
    if (refusal !== undefined) {
      const resolved = await resolveBackendRefusal(
        refusal,
        job,
        step,
        result.attempts.at(-1)?.attempt ?? result.attempts.length,
        context,
        { attempts: result.attempts, results: result.results },
      );
      if (resolved.kind === 'retry') continue;
      return resolved.outcome;
    }

    if (abort.waitTrigger !== undefined) {
      // Реальная отмена уже настигла прогон — ждать нечего, шаг canceled.
      // `exceeded` в этом исходе не отдаётся: иначе runJobSteps прочёл бы
      // его как основание для budget_exceeded и затёр бы canceled, который
      // важнее.
      if (context.signal?.aborted === true) {
        return { status: 'canceled', attempts: result.attempts, results: result.results };
      }
      context.usage.sealStep(job.id, step.id);
      const waited = await waitForReset(abort.waitTrigger, context, { job: job.id, step: step.id });
      if (waited.kind === 'resumed') continue;
      if (waited.kind === 'stopped') {
        return { status: 'budget_exceeded', attempts: result.attempts, results: result.results, exceeded: waited.exceeded };
      }
      return { status: 'canceled', attempts: result.attempts, results: result.results };
    }

    return {
      status: result.status,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      attempts: result.attempts,
      results: result.results,
      ...(structuredOutput === undefined ? {} : { structured: structuredOutput }),
      ...(exceeded === undefined ? {} : { exceeded }),
    };
  }
}

async function runAgentStep(
  step: AgentStep,
  job: Job,
  context: RunContext,
  stepDirPath: string,
  sessions: ReturnType<typeof createSessionRegistry>,
  contextSent: Set<string>,
  budgetScopes: () => BudgetScope[],
  changedPaths: () => readonly string[] | undefined,
): Promise<StepOutcome> {
  const { journal, config } = context;
  const { pipeline } = context.expanded;
  const adapter = adapterOf(step.agent, context);

  for (;;) {
  let exceeded: ReturnType<UsageAccumulator['check']>;
  let judgeCallCount = 0;
  const nextCallIndex = (): number => {
    judgeCallCount += 1;
    return judgeCallCount;
  };
  const onStall = (silentMs: number): void =>
    journal.event({ kind: 'step.stalled', job: job.id, step: step.id, silent_ms: silentMs });

  const abort = stepAbort(context);

  // Промпт собирается заново на каждой попытке шага, а выдержка на всех
  // попытках одна и та же: событие об её усечении пишется однажды, иначе
  // разбор по журналу насчитает усечений больше, чем их было.
  let noteTruncationReported = false;

  const result = await executeAgentStep({
    step,
    adapter,
    cwd: context.cwd,
    stepDir: stepDirPath,
    scratchDir: jobScratchDir(journal.paths, job.id),
    sessions,
    backendSlots: context.backendSlots,
    stallTimeoutMs: config.defaults.stallTimeoutMs,
    signal: abort.controller.signal,
    env: (plan) => stepEnv(step, job, plan.attempt, context, stepDirPath),
    buildPrompt: (_plan, previousFailure) => {
      // Унаследованный контекст уходит в первое сообщение сессии: повторять
      // агенту то, что он уже прочитал в этой же сессии, незачем.
      const first = !contextSent.has(step.session);
      contextSent.add(step.session);

      const stepEntries = withIterationNote(
        context,
        job.id,
        step.context,
        context.iterationCheck,
        (truncation) => {
          if (noteTruncationReported) return;
          noteTruncationReported = true;
          journal.event({
            kind: 'context.note_truncated',
            job: job.id,
            step: step.id,
            original_tokens: truncation.originalTokens,
            final_tokens: truncation.finalTokens,
          });
        },
      );

      const assembled = assembleContext({
        workspace: context.cwd,
        pipeline: first ? pipeline.context : [],
        job: first ? job.context : [],
        step: stepEntries.entries,
        upstream: first ? upstreamOutputs(context.graph, job.id, context.outputs) : [],
        contextUpstream: job.contextUpstream,
        inherit: step.contextInherit,
        exclude: step.contextExclude,
        deny: config.context.deny,
        inlineThreshold: config.context.inlineThreshold,
        maxTokens: step.contextMaxTokens ?? config.context.maxTokens,
        // Предел выдержки объявляется сборке только тогда, когда выдержка в
        // контексте есть: иначе шаг с узким пределом контекста отказывал бы
        // из-за настройки, которая его не касается.
        ...(stepEntries.hasNote ? { noteMaxTokens: config.context.noteMaxTokens } : {}),
        onDenied: (path, pattern) =>
          journal.event({ kind: 'context.denied', job: job.id, step: step.id, path, pattern }),
        onDowngraded: (path, tokens) =>
          journal.event({
            kind: 'context.downgraded',
            job: job.id,
            step: step.id,
            path,
            tokens,
          }),
      });

      journal.writeContextReport(stepDirPath, {
        session: step.session,
        ...assembled.report,
      });

      return [assembled.text, step.prompt, failureBlock(previousFailure)]
        .filter((part) => part !== undefined && part !== '')
        .join('\n\n');
    },
    evaluate: async (target, outcome, plan) => {
      // Неустранимый отказ проверяется раньше кода возврата: у обоих
      // настоящих конвертов отказа (упор в лимит подписки, отказ
      // аутентификации) код возврата ненулевой, и без этой проверки они
      // ушли бы в «бэкенд завершился кодом N», не назвав действительной
      // причины. Судья здесь не вызывается: попытка отклонена в любом случае.
      if (outcome.refusal !== undefined) {
        return [
          {
            predicate: BACKEND_REFUSAL_PREDICATE,
            passed: false,
            hard: true,
            detail: describeRefusal(outcome.refusal),
            actual: outcome.refusal,
          },
        ];
      }

      // Ненулевой код возврата означает, что бэкенд не отработал, и жалобы
      // предикатов на отсутствующий вывод только уводят от причины. Настоящую
      // причину бэкенд написал в stderr — её и показываем первой. Судья здесь
      // не вызывается: попытка отклонена в любом случае.
      if (outcome.process.exitCode !== 0) {
        const detail = outcome.process.stderr.trim().split('\n').slice(-3).join('\n');
        return [
          {
            predicate: 'backend',
            passed: false,
            hard: true,
            actual: outcome.process.exitCode,
            detail:
              detail === ''
                ? `бэкенд завершился кодом ${outcome.process.exitCode ?? 'нет'}`
                : detail,
          },
        ];
      }

      const firstPass = evaluatePredicates(target.expect, {
        exitCode: outcome.process.exitCode,
        text: outcome.text ?? '',
        structured: outcome.structured,
        cwd: context.cwd,
        env: stepEnv(step, job, 1, context, stepDirPath),
        changedPaths: changedPaths(),
      });

      if (!target.expect.some((predicate) => predicate.kind === 'judge')) {
        checkCostUnreported(context, job, step, plan.attempt);
        return firstPass;
      }

      // Расход попытки уже включает расход самого шага (`outcome.usage`) —
      // судьи добавляются к нему, а не подменяют его.
      let attemptUsage = outcome.usage;
      const results = await runJudgePass({
        predicates: target.expect,
        firstPass,
        task: target.prompt,
        text: outcome.text ?? '',
        structured: outcome.structured,
        cwd: context.cwd,
        stepDir: stepDirPath,
        attempt: plan.attempt,
        timeoutMs: target.timeoutMs,
        stallTimeoutMs: config.defaults.stallTimeoutMs,
        signal: abort.controller.signal,
        onStall,
        adapterFor: (name) => adapterOf(name, context),
        defaultAgent: config.defaults.agent,
        backendSlots: context.backendSlots,
        journal,
        nextCallIndex,
        canCall: () => {
          const found = context.usage.check(budgetScopes());
          exceeded ??= found;
          abort.trigger(found);
          return found === undefined;
        },
        onUsage: (usage) => {
          attemptUsage = sumUsage(attemptUsage, usage);
          context.usage.record(job.id, step.id, plan.attempt, attemptUsage);
          const found = context.usage.check(budgetScopes());
          exceeded ??= found;
          abort.trigger(found);
        },
      });
      checkCostUnreported(context, job, step, plan.attempt);
      return results;
    },
    onUsage: (current, attempt) => {
      context.usage.record(job.id, step.id, attempt, current);
      const found = context.usage.check(budgetScopes(), current);
      exceeded ??= found;
      abort.trigger(found);
    },
    onUnparsed: (line) =>
      journal.event({ kind: 'backend.unparsed', job: job.id, step: step.id, line }),
    onPermissionDenied: (plan, tool, input) => {
      const detail = describePermissionDenialInput(input);
      journal.event({
        kind: 'permission.denied',
        job: job.id,
        step: step.id,
        attempt: plan.attempt,
        tool,
        ...(detail === undefined ? {} : { detail: inline(detail) }),
      });
    },
    onStall,
    onExpectFailed: (plan, failure) =>
      journal.event({
        kind: 'expect.failed',
        job: job.id,
        step: step.id,
        attempt: plan.attempt,
        predicate: failure.predicate,
        ...(failure.detail === undefined ? {} : { detail: failure.detail }),
      }),
    canContinue: () => {
      const found = exceeded ?? context.usage.check(budgetScopes());
      exceeded ??= found;
      abort.trigger(found);
      return exceeded === undefined;
    },
  });

  abort.dispose();

  if (exceeded !== undefined) {
    journal.event({
      kind: 'budget.exceeded',
      scope: exceeded.scope,
      job: job.id,
      step: step.id,
      dimension: exceeded.dimension,
      used: exceeded.used,
      limit: exceeded.limit,
    });
  }

  // Отказ бэкенда — свой либо доставшийся судье внутри `evaluate` — приходит
  // тем же именем предиката: источник дальше не различается.
  const refusal = extractRefusal(result.results.at(-1) ?? []);
  if (refusal !== undefined) {
    const resolved = await resolveBackendRefusal(
      refusal,
      job,
      step,
      result.attempts.at(-1)?.attempt ?? result.attempts.length,
      context,
      { attempts: result.attempts, results: result.results, session: result.sessionId },
    );
    if (resolved.kind === 'retry') continue;
    return resolved.outcome;
  }

  if (abort.waitTrigger !== undefined) {
    // Реальная отмена уже настигла прогон — ждать нечего, шаг canceled.
    // `exceeded` в этом исходе не отдаётся: иначе runJobSteps прочёл бы его
    // как основание для budget_exceeded и затёр бы canceled, который важнее.
    if (context.signal?.aborted === true) {
      return {
        status: 'canceled',
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        attempts: result.attempts,
        results: result.results,
        session: result.sessionId,
      };
    }
    context.usage.sealStep(job.id, step.id);
    const waited = await waitForReset(abort.waitTrigger, context, { job: job.id, step: step.id });
    if (waited.kind === 'resumed') continue;
    if (waited.kind === 'stopped') {
      return {
        status: 'budget_exceeded',
        attempts: result.attempts,
        results: result.results,
        session: result.sessionId,
        exceeded: waited.exceeded,
      };
    }
    return {
      status: 'canceled',
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      attempts: result.attempts,
      results: result.results,
      session: result.sessionId,
    };
  }

  return {
    status: result.status,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    attempts: result.attempts,
    results: result.results,
    ...(result.last?.structured === undefined ? {} : { structured: result.last.structured }),
    session: result.sessionId,
    ...(result.last?.observedInputs === undefined
      ? {}
      : { observedInputs: result.last.observedInputs }),
    ...(result.last?.backendInit === undefined ? {} : { backendInit: result.last.backendInit }),
    ...(exceeded === undefined ? {} : { exceeded }),
  };
  }
}

/** Задание шага без блока контекста — вход судьи на командном шаге. */
function describeStepTask(step: Step): string {
  if (step.kind === 'agent') return step.prompt;
  return typeof step.command === 'string' ? step.command : step.command.join(' ');
}

function failureBlock(previousFailure: string | undefined): string {
  if (previousFailure === undefined) return '';
  return `## Прошлая попытка не прошла проверку\n\n${previousFailure}\n\nПочини причину, а не симптом.`;
}

function stepEnv(
  step: Step,
  job: Job,
  attempt: number,
  context: RunContext,
  stepDirPath: string,
): Record<string, string> {
  const { pipeline } = context.expanded;
  const { env, denied } = buildStepEnv({
    base: context.baseEnv ?? process.env,
    envFiles: pipeline.envFiles,
    pipeline: pipeline.env,
    job: job.env,
    step: step.env,
    injected: injectedVariables({
      runId: context.journal.paths.runId,
      runDir: context.journal.paths.dir,
      binPath: process.argv[1] ?? '',
      jobId: job.id,
      jobDir: context.journal.prepareJob(job.id),
      stepId: step.id,
      stepDir: stepDirPath,
      attempt,
      workspace: context.cwd,
      artifacts: context.journal.paths.artifacts,
      scratch: jobScratchDir(context.journal.paths, job.id),
    }),
    deny: pipeline.envDeny,
    cwd: context.cwd,
  });

  for (const item of denied) {
    const seen = `${item.name}|${item.pattern}`;
    if (context.reportedDenials.has(seen)) continue;
    context.reportedDenials.add(seen);
    context.journal.event({
      kind: 'env.denied',
      name: item.name,
      pattern: item.pattern,
      scope: `jobs.${job.id}.steps.${step.id}`,
    });
  }

  return env;
}

/** Ключ шага: записывается сейчас, используется возобновлением позже. */
/**
 * Причина неуспеха из закрытого перечня `halt.ts`.
 *
 * Выводится из статуса и результатов предикатов, а не назначается в каждой
 * точке отдельно: так место, где заводится новая причина отказа, ровно одно и
 * его видно в обзоре.
 */
function causeOf(
  status: StatusValue,
  results: readonly (readonly PredicateResult[])[],
  assigned?: HaltCauseValue,
): HaltCauseValue | undefined {
  if (assigned !== undefined) return assigned;
  if (status === 'canceled') return HaltCause.canceled;
  if (status === 'budget_exceeded') return HaltCause.budgetExceeded;
  if (status !== 'failed') return undefined;

  const failed = results.at(-1)?.find((item) => !item.passed && item.hard);
  if (failed?.predicate === 'timeout') return HaltCause.timeout;
  if (failed?.predicate === 'spawn_failed') return HaltCause.spawnFailed;
  return HaltCause.expectFailed;
}

/** Решение плана по конкретному шагу, если возобновление вообще идёт. */
function planFor(context: RunContext, jobId: string, stepId: string): StepPlan | undefined {
  return context.resume?.plan.steps.find((item) => item.job === jobId && item.step === stepId);
}

/**
 * Перенести структурированный выход переиспользованного шага из исходного
 * прогона в директорию нового. Без этого файла `output.from` при частичном
 * переиспользовании работы публикует пустоту: выход работы целиком
 * переносится только когда переиспользована вся работа.
 */
function transferStepOutput(
  context: RunContext,
  jobId: string,
  stepId: string,
  stepDirPath: string,
): unknown {
  const source = context.resume?.source;
  if (source === undefined) return undefined;

  const sourceDir = findStepDir(source.paths, jobId, stepId);
  if (sourceDir === undefined) return undefined;

  const sourceFile = join(sourceDir, 'output.json');
  if (!existsSync(sourceFile)) return undefined;

  try {
    const raw = readFileSync(sourceFile, 'utf8');
    context.journal.writeStepFile(stepDirPath, 'output.json', raw);
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Сложить данные, опубликованные работой, в её запись и переписать состояние.
 *
 * Зовётся после каждого шага — и исполненного, и переиспользованного. Файл
 * `data.json` пишет подпроцесс `stepcast data`, состояние прогона —
 * исключительно движок: два процесса, пишущих один `status.json`, наступали
 * бы друг на друга. Отсюда же и живость витрины: она опрашивает корень
 * прогонов по mtime состояния, и данные доезжают до подписи узла ровно тем же
 * событием, что и статус шага.
 *
 * Следствие честное и его стоит знать: данные, записанные в середине долгого
 * шага, появятся в витрине по его завершении, а не в момент записи.
 */
function foldJobData(context: RunContext, jobId: string): void {
  const record = context.records.get(jobId);
  if (record === undefined) return;

  const data = readJobData(jobDir(context.journal.paths, jobId));
  context.records.set(jobId, {
    ...record,
    ...(Object.keys(data).length === 0 ? {} : { data }),
  });
  context.refreshStatus();
}

/**
 * Перенести данные работы из исходного прогона в новый.
 *
 * Возобновление заводит новый каталог прогона, а переиспользованный шаг не
 * исполняется и ничего не пишет — без переноса потребитель
 * `${jobs.X.data.*}` ломался бы на пустоте именно при возобновлении, то есть
 * там, где всё остальное как раз сохранено. Тот же перенос уже сделан для
 * выхода работы (`transferStepOutput`).
 *
 * Переносится всё, что успел записать исходный прогон, и только когда хотя бы
 * один шаг работы переиспользуется: работа, переисполняемая с начала, обязана
 * начать с чистого листа. Уже записанное в этом прогоне не затирается.
 */
function transferJobData(context: RunContext, jobId: string): void {
  const source = context.resume?.source;
  if (source === undefined) return;
  if (!context.resume?.plan.steps.some((step) => step.job === jobId && step.decision.kind === 'reuse')) {
    return;
  }

  const target = jobDir(context.journal.paths, jobId);
  if (existsSync(jobDataPath(target))) return;

  const carried = readJobData(jobDir(source.paths, jobId));
  if (Object.keys(carried).length === 0) return;

  bookkeep({ journal: context.journal, job: jobId }, 'перенос данных работы', () => {
    writeJobData(target, carried);
  });
}

/**
 * Перенести в новый прогон состояние каталога прогона, оставшееся от
 * переиспользованных шагов.
 *
 * Каталог прогона — такая же среда исполнения, как рабочее дерево, только
 * заведённая движком и своя у каждого прогона: шаг кладёт туда промежуточный
 * файл (`$STEPCAST_RUN_DIR/item.json`, `${run.dir}/…`), а соседний шаг читает
 * его оттуда же. Переиспользованный шаг ничего не кладёт — его побочный эффект
 * остался в каталоге исходного прогона, — и переисполняемый читатель не
 * находит файла, хотя ни определение, ни дерево не менялись. Рабочему дереву
 * ту же задачу решает восстановление по якорю; здесь якорей нет, и отвечает ей
 * копия.
 *
 * Копируется всё, чего нет в раскладке журнала: раскладку движок пишет сам, а
 * остальное в каталоге прогона могло появиться только от шага. Переисполняемый
 * шаг, который тот же путь пишет заново, перезаписывает копию до того, как её
 * кто-нибудь прочитает: работа выше по графу завершается раньше нижележащей, а
 * шаг — раньше следующего шага своей работы.
 */
function carryOverRunDir(resume: ResumeContext, journal: RunJournal): void {
  if (!resume.plan.steps.some((step) => step.decision.kind === 'reuse')) return;

  const paths = journal.paths;
  // Имена раскладки берутся из самих путей, а не списком литералов: список
  // разошёлся бы с раскладкой при первом же её пополнении, и новый служебный
  // файл поехал бы из прогона в прогон как чужое состояние.
  const own = new Set(
    [paths.manifest, paths.lock, paths.status, paths.events, paths.usage, paths.artifacts, paths.jobs, paths.workspace, paths.anchors].map(
      (path) => basename(path),
    ),
  );

  try {
    for (const entry of readdirSync(resume.source.paths.dir)) {
      if (own.has(entry)) continue;
      cpSync(join(resume.source.paths.dir, entry), join(paths.dir, entry), { recursive: true });
      journal.event({ kind: 'run_dir.carried', path: entry, source: resume.source.manifest.run_id });
    }
  } catch (error) {
    // Не отказ: без переноса переисполнится лишнее либо шаг честно упадёт на
    // отсутствующем файле — ровно то, что было бы и без возобновления.
    journal.event({
      kind: 'bookkeeping.failed',
      operation: 'перенос состояния каталога прогона',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Привести дерево к состоянию, на котором остановилось переиспользование.
 *
 * Недоступный якорь не отказ: возобновление отступает к ближайшему
 * предшествующему восстановимому состоянию, в пределе — к началу пайплайна.
 * Худший исход равен тому, что пользователь получил бы без `resume` вообще.
 */
function restoreForResume(
  resume: ResumeContext,
  journal: RunJournal,
  cwd: string,
  anchorKind: AnchorKind,
): void {
  const restore = resume.plan.restore;
  if (restore === undefined) return;

  const anchorer = createAnchorer({
    dir: cwd,
    stateDir: journal.paths.anchors,
    kind: anchorKind,
    scope: 'resume',
  });

  try {
    anchorer.restorePaths(restore.anchor, restore.paths);
    journal.event({ kind: 'tree.restored', anchor: restore.anchor.id, path: cwd });
  } catch (error) {
    // Недоступный якорь не отказ: переисполнить лишнее дороже, но это ровно
    // то, что пользователь получил бы без возобновления вообще.
    journal.event({
      kind: 'bookkeeping.failed',
      operation: 'восстановление дерева по якорю',
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    anchorer.dispose();
  }
}

/**
 * Контекст шага итерации: к его собственным записям добавляется результат
 * непрошедшего `check` **непосредственно предшествующей** итерации. Копить
 * результаты нескольких прошлых итераций незачем: они описывают состояние,
 * которого уже нет.
 */
function withIterationNote(
  context: RunContext,
  jobId: string,
  own: readonly ContextEntry[],
  previousCheck: readonly PredicateResult[] | undefined,
  onTruncated: (truncation: IterationNoteTruncation) => void,
): { entries: readonly ContextEntry[]; hasNote: boolean } {
  const entries = takeFailureNote(context, jobId, own);
  if (previousCheck === undefined) return { entries, hasNote: false };

  const failed = previousCheck.filter((item) => !item.passed && item.hard);
  if (failed.length === 0) return { entries, hasNote: false };

  const { text, truncation } = buildIterationNote(failed, context.config.context.noteMaxTokens);
  if (truncation !== undefined) onTruncated(truncation);

  return { entries: [{ kind: 'text', text }, ...entries], hasNote: true };
}

/** Текст выдержки о прошлом отказе, если прошлый прогон её заслуживает. */
function previousFailureText(resume: ResumeContext): string | undefined {
  return buildPreviousFailure(resume.source.paths, resume.source.status)?.text;
}

/**
 * Подложить выдержку о прошлом отказе первому агентскому шагу работы, с
 * которой возобновление начато. Запись входит в состав контекста наравне с
 * остальными и потому учитывается в пределе размера.
 */
function takeFailureNote(
  context: RunContext,
  jobId: string,
  own: readonly ContextEntry[],
): readonly ContextEntry[] {
  const note = context.failureNote.pending;
  if (note === undefined) return own;
  if (context.resume?.plan.failureNoteJob !== jobId) return own;

  context.failureNote.pending = undefined;
  return [{ kind: 'text', text: note }, ...own];
}

export { isStepcastError };
