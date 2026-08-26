import { createHash } from 'node:crypto';
import { join } from 'node:path';

import {
  createAnchorer,
  detectAnchorKind,
  type Anchor,
  type AnchorKind,
  type TreeAnchorer,
} from '../anchor/index.js';
import { fingerprintInputs } from '../anchor/fingerprint.js';
import { resolveAdapter } from '../backend/registry.js';
import { sumUsage, type BackendAdapter } from '../backend/types.js';
import { UsageAccumulator, describeExceeded, type BudgetScope, type Exceeded } from '../budget/accumulator.js';
import type { Config } from '../config/resolve.js';
import { formatDuration } from '../units.js';
import { assembleContext, type UpstreamOutput } from '../context/assemble.js';
import { resolveLate, type JobScopeEntry } from '../pipeline/late.js';
import { ExitCode, isStepcastError, type ExitCodeValue } from '../errors.js';
import { createSessionRegistry, executeAgentStep } from '../exec/agentStep.js';
import { buildStepEnv, injectedVariables } from '../exec/env.js';
import { executeRunStep } from '../exec/runStep.js';
import { runJudgePass } from '../exec/judgePass.js';
import { evaluatePredicates } from '../expect/evaluate.js';
import { buildGraph } from '../graph.js';
import { bookkeep } from './bookkeeping.js';
import { buildIterationNote, type IterationNoteTruncation } from './iterationNote.js';
import { HaltCause, type HaltCauseValue } from './halt.js';
import { preflight } from './preflight.js';
import { buildPreviousFailure } from './previousFailure.js';
import type { ResumePlan, SourceRun, StepPlan } from './resumePlan.js';
import { computeStepKey } from './stepKey.js';
import { prepareWorkspace, type PreparedWorkspace } from './workspace.js';
import { shortRunId } from '../journal/paths.js';
import { RunJournal } from '../journal/writer.js';
import { serializeLock } from '../pipeline/lock.js';
import type {
  AgentStep,
  ContextEntry,
  ExpandedPipeline,
  Job,
  Step,
} from '../pipeline/model.js';
import type {
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
  }) => TreeAnchorer;
}

export interface ResumeContext {
  readonly plan: ResumePlan;
  readonly source: SourceRun;
}

export interface RunResult {
  readonly journal: RunJournal;
  readonly status: StatusValue;
  readonly exitCode: ExitCodeValue;
}

const EXIT_BY_STATUS: Record<string, ExitCodeValue> = {
  success: ExitCode.ok,
  skipped: ExitCode.ok,
  failed: ExitCode.jobFailed,
  budget_exceeded: ExitCode.budgetExceeded,
  canceled: ExitCode.canceled,
};

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

  const journal = RunJournal.create({
    runsRoot: config.runs.root,
    projectRoot: options.projectRoot,
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
  };
  journal.writeManifest(manifest);
  journal.event({ kind: 'run.started', pipeline: pipeline.name, run_id: journal.paths.runId });

  const usage = new UsageAccumulator(
    (backend) => config.backends[backend]?.cacheReadWeight ?? 1,
  );
  const records = new Map<string, JobRecord>(
    pipeline.jobs.map((job) => [job.id, { id: job.id, status: 'pending', steps: [] }]),
  );
  const outputs: UpstreamOutput[] = [];
  const adapters = new Map<string, BackendAdapter>();
  const reportedDenials = new Set<string>();
  const graph = buildGraph(pipeline).graph;

  // Момент пробуждения: дописывается на диск до начала сна и снимается после
  // продолжения — состояние спящего прогона доступно снаружи, пока он спит.
  const waitState: { wakeAt: string | undefined } = { wakeAt: undefined };

  const context: RunContext = {
    ...options,
    journal,
    records,
    usage,
    outputs,
    adapters,
    reportedDenials,
    lockHash,
    anchorKind,
    failureNote: { pending: options.resume === undefined ? undefined : previousFailureText(options.resume) },
    ...(options.resume === undefined
      ? {}
      : { observedInputs: options.resume.plan.observedInputs }),
    onWait: (wakeAt) => {
      waitState.wakeAt = wakeAt;
      writeStatus('running');
    },
  };

  warnAboutDegradedBackends(context);

  const writeStatus = (status: StatusValue): void => {
    const blocked = [...records.values()].find((record) => record.status === 'failed');
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
      ...(waitState.wakeAt === undefined ? {} : { wake_at: waitState.wakeAt }),
      updated_at: new Date().toISOString(),
    } satisfies RunStatus);
  };

  if (options.resume !== undefined) {
    restoreForResume(options.resume, journal, options.cwd, anchorKind);
    for (const [jobId, value] of options.resume.plan.outputs) {
      const path = join(journal.paths.artifacts, `${jobId}.json`);
      outputs.push({ job: jobId, path, value });
    }
  }

  writeStatus('running');

  const result = await schedule({
    pipeline,
    graph,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    scopeExtras: { run: { id: journal.paths.runId, dir: journal.paths.dir }, env: {} },
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

  writeStatus(result.status);
  journal.writeUsage(usage.report(journal.paths.runId));

  const exitCode = EXIT_BY_STATUS[result.status] ?? ExitCode.jobFailed;
  journal.writeManifest({
    ...manifest,
    finished_at: new Date().toISOString(),
    status: result.status,
    exit_code: exitCode,
  });
  journal.event({ kind: 'run.finished', status: result.status, exit_code: exitCode });

  return { journal, status: result.status, exitCode };
}

interface RunContext extends RunOptions {
  readonly journal: RunJournal;
  readonly records: Map<string, JobRecord>;
  readonly usage: UsageAccumulator;
  readonly outputs: UpstreamOutput[];
  readonly adapters: Map<string, BackendAdapter>;
  /** Одна и та же переменная вычёркивается на каждом шаге — сообщаем однажды. */
  readonly reportedDenials: Set<string>;
  readonly lockHash: string;
  /** Способ фиксации состояния: определён один раз на прогон. */
  readonly anchorKind: AnchorKind;
  /** Наблюдённые входы шагов прошлого прогона: `<работа>/<шаг>` → пути. */
  readonly observedInputs?: ReadonlyMap<string, readonly string[]>;
  /**
   * Выдержка о прошлом отказе. Достаётся первому переисполняемому агентскому
   * шагу и на этом исчезает: повторять её остальным — значит навязывать всему
   * прогону разбор одной чужой неудачи.
   */
  readonly failureNote: { pending: string | undefined };
  /** Результаты непрошедшего `check` предыдущей итерации текущей работы. */
  readonly iterationCheck?: readonly PredicateResult[];
  /**
   * Уход в ожидание и пробуждение из него: состояние прогона должно быть на
   * диске до начала сна, а не после — иначе спящий прогон неотличим от
   * зависшего. `undefined` снимает момент пробуждения.
   */
  readonly onWait: (wakeAt: string | undefined) => void;
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

function adapterOf(name: string, context: RunContext): BackendAdapter {
  const existing = context.adapters.get(name);
  if (existing !== undefined) return existing;
  const created = (context.adapterFor ?? ((backend) => resolveAdapter(backend, context.config)))(name);
  context.adapters.set(name, created);
  return created;
}

/**
 * Работа целиком: подготовка рабочей директории и внешний цикл `until`.
 *
 * Работа без цикла — вырожденный случай с одной итерацией и без уровня
 * итерации в раскладке журнала.
 */
async function executeJob(
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

  journal.prepareJob(job.id);
  journal.event({ kind: 'job.started', job: job.id });
  context.records.set(job.id, {
    ...(context.records.get(job.id) as JobRecord),
    status: 'running',
    started_at: new Date().toISOString(),
  });

  // Рабочая директория готовится до первого шага. Её отказ означает, что шаги
  // запустить негде, — это `spawn_failed` из закрытого перечня, а не новая
  // причина остановки.
  let prepared: PreparedWorkspace;
  try {
    prepared = prepareWorkspace({ job, cwd: context.cwd, runDir: journal.paths.dir });
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
    workspace: { mode: prepared.mode, path: prepared.dir },
  });

  try {
    job = resolveLate(declared, {
      jobs: (scope.jobs ?? {}) as Readonly<Record<string, JobScopeEntry>>,
      run: { id: journal.paths.runId, dir: journal.paths.dir, workspace: prepared.dir },
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

  // Ниже по коду `context` — контекст работы: у него своя рабочая директория.
  const jobContext: RunContext = { ...context, cwd: prepared.dir };
  const anchorState = { anchorer: undefined as TreeAnchorer | undefined };
  const jobStartedAt = Date.now();
  const maxIterations = job.until?.maxIterations ?? 1;
  let previousCheck: readonly PredicateResult[] | undefined;

  try {
    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      if (job.until !== undefined) {
        journal.event({ kind: 'iteration.started', job: job.id, iteration });
      }

      const outcome = await runJobSteps(job, jobContext, anchorState, {
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
      jobId: job.id,
      jobDir: context.journal.prepareJob(job.id),
      attempt: 1,
      workspace: context.cwd,
      artifacts: context.journal.paths.artifacts,
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
async function waitForReset(exceeded: Exceeded, context: RunContext): Promise<WaitOutcome> {
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
  context.onWait(wakeAt);
  context.journal.event({
    kind: 'budget.waiting',
    scope: exceeded.scope,
    dimension: 'rate_limit',
    threshold: exceeded.limit,
    resets_at: exceeded.resetsAt,
    wait_ms: waitMs,
  });

  const started = Date.now();
  const canceled = await sleepInterruptibly(waitMs, context.signal);
  const actualMs = Date.now() - started;

  context.usage.recordWait(started, started + actualMs);
  context.onWait(undefined);
  if (canceled) return { kind: 'canceled' };

  context.journal.event({ kind: 'budget.resumed', actual_ms: actualMs });
  return { kind: 'resumed' };
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
  context: RunContext,
  anchorState: { anchorer: TreeAnchorer | undefined },
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

  const sessions = createSessionRegistry();
  // Сессии, в которые уже отправлен унаследованный контекст. Отслеживание
  // живёт в работе, а не в шаге: иначе каждый шаг общей сессии заново
  // получает свод правил, который агент уже прочитал, и весь смысл общей
  // сессии теряется.
  const contextSent = new Set<string>();
  const steps: StepRecord[] = [];
  let lastAgentStructured: unknown;
  let outputFromStep: unknown;

  for (const step of job.steps) {
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
      if (step.kind === 'agent' && planned.decision.record.status === 'success') {
        // Переиспользованный шаг не исполнялся, структурированного вывода у
        // него в этом прогоне нет: он берётся из выхода работы, если тот был
        // перенесён целиком.
        lastAgentStructured = context.resume?.plan.outputs.get(job.id) ?? lastAgentStructured;
      }
      treeAnchor =
        reused.tree_id === undefined
          ? treeAnchor
          : { kind: reused.anchor_kind ?? context.anchorKind, id: reused.tree_id };
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

    exceeded = outcome.exceeded ?? exceeded;

    for (const [index, results] of outcome.results.entries()) {
      journal.writeExpectReport(stepDirPath, { attempt: index + 1, results: [...results] });
    }

    const status: StatusValue = exceeded !== undefined ? 'budget_exceeded' : outcome.status;
    const reason = exceeded !== undefined ? describeExceeded(exceeded) : outcome.reason;
    const cause = causeOf(status, outcome.results);

    // Якорь снимается при любом исходе, включая отказ, отмену и превышение
    // бюджета: разбирать упавший прогон без состояния дерева нечем.
    const treeAfter = capture(step.id);
    treeAnchor = treeAfter ?? treeAnchor;

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
        lockHash: context.lockHash,
        jobId: job.id,
        step,
        inputsFingerprint: fingerprint?.value,
        backendCommand:
          step.kind === 'agent' ? context.config.backends[step.agent]?.command : undefined,
        upstream: context.outputs,
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

    if (step.kind === 'agent' && outcome.structured !== undefined) {
      lastAgentStructured = outcome.structured;
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

    if (status !== 'success') {
      return {
        status,
        ...(reason === undefined ? {} : { reason: `шаг ${step.id}: ${reason}` }),
        ...(cause === undefined ? {} : { cause }),
      };
    }
  }

  const published = job.output === undefined ? undefined : (outputFromStep ?? lastAgentStructured);
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
        const firstPass = evaluatePredicates(target.expect, {
          exitCode: process_.exitCode,
          text: process_.stdout,
          structured: undefined,
          cwd: context.cwd,
          env: stepEnv(step, job, 1, context, stepDirPath),
          changedPaths: changedPaths(),
        });

        if (!target.expect.some((predicate) => predicate.kind === 'judge')) return firstPass;

        // Командный шаг сам расхода не несёт: расход попытки — это расход
        // судей, накапливаемый по мере их вызовов, а не заменяемый последним.
        let attemptUsage: Usage | undefined;
        return runJudgePass({
          predicates: target.expect,
          firstPass,
          task: describeStepTask(target),
          text: process_.stdout,
          structured: process_.stdout,
          cwd: context.cwd,
          stepDir: stepDirPath,
          attempt: plan.attempt,
          timeoutMs: target.timeoutMs,
          stallTimeoutMs: config.defaults.stallTimeoutMs,
          signal: abort.controller.signal,
          onStall,
          adapterFor: (name) => adapterOf(name, context),
          defaultAgent: config.defaults.agent,
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

    if (abort.waitTrigger !== undefined) {
      // Реальная отмена уже настигла прогон — ждать нечего, шаг canceled.
      // `exceeded` в этом исходе не отдаётся: иначе runJobSteps прочёл бы
      // его как основание для budget_exceeded и затёр бы canceled, который
      // важнее.
      if (context.signal?.aborted === true) {
        return { status: 'canceled', attempts: result.attempts, results: result.results };
      }
      context.usage.sealStep(job.id, step.id);
      const waited = await waitForReset(abort.waitTrigger, context);
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
    sessions,
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
        upstream: first ? context.outputs : [],
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
        onDenied: (path, pattern) => journal.event({ kind: 'context.denied', path, pattern }),
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

      if (!target.expect.some((predicate) => predicate.kind === 'judge')) return firstPass;

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
      used: exceeded.used,
      limit: exceeded.limit,
    });
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
    const waited = await waitForReset(abort.waitTrigger, context);
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
      jobId: job.id,
      jobDir: context.journal.prepareJob(job.id),
      stepId: step.id,
      stepDir: stepDirPath,
      attempt,
      workspace: context.cwd,
      artifacts: context.journal.paths.artifacts,
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
): HaltCauseValue | undefined {
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
  own: readonly ContextEntry[],
  previousCheck: readonly PredicateResult[] | undefined,
  onTruncated: (truncation: IterationNoteTruncation) => void,
): { entries: readonly ContextEntry[]; hasNote: boolean } {
  const entries = takeFailureNote(context, own);
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
 * Подложить выдержку о прошлом отказе первому переисполняемому шагу с
 * контекстом. Запись входит в состав контекста наравне с остальными и потому
 * учитывается в пределе размера.
 */
function takeFailureNote(
  context: RunContext,
  own: readonly ContextEntry[],
): readonly ContextEntry[] {
  const note = context.failureNote.pending;
  if (note === undefined) return own;

  context.failureNote.pending = undefined;
  return [{ kind: 'text', text: note }, ...own];
}

export { isStepcastError };
