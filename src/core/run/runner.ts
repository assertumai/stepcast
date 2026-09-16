import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

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
import { runPluginStep } from '../exec/pluginStep.js';
import { evaluatePredicates, validateAgainstSchema, validateAgainstSchemaFile } from '../expect/evaluate.js';
import { createKnowledgeSource } from '../knowledge/source.js';
import type { KnowledgeSource } from '../knowledge/types.js';
import { buildGraph, upstreamOutputs, type Graph } from '../graph.js';
import { bookkeep } from './bookkeeping.js';
import { buildIterationNote, type IterationNoteTruncation } from './iterationNote.js';
import { locateEngine, isEditableEngine, pinEngine, type EngineInfo, type EngineLocation } from './engine.js';
import { HaltCause, type HaltCauseValue } from './halt.js';
import { resolveInheritSource, type CompletedJob } from './inherit.js';
import { builtinRegistry } from '../../parts/builtin.js';
import { DecisionHalt, hasStepExecutor, type StepKindDecisionRequest, type StepKindDecisionResult } from '../plugins/contract.js';
import { contributionOwner, formerStepKindOwner, stepKindNames, type Registry } from '../plugins/registry.js';
import { preflight } from './preflight.js';
import { createScope, type ResourceScope } from './scope.js';
import { buildInterruptedNote, buildPreviousFailure } from './previousFailure.js';
import { createAwaitingState } from './awaitingState.js';
import { computeWaitId, pipelineStepAddresses, toDecisionRecord } from './decision.js';
import { carriedKey, collectPendingDecisions, type CarriedDecision } from './decisionCarry.js';
import { waitForDecision } from './decisionWait.js';
import type { ResumePlan, SourceRun, StepPlan } from './resumePlan.js';
import { computeStepKey, upstreamForKey } from './stepKey.js';
import { prepareWorkspace, type PreparedWorkspace } from './workspace.js';
import { syncLiveFiles, writebackLiveFiles } from './liveFiles.js';
import { createWaitState } from './waitState.js';
import { jobDataPath, readJobData, writeJobDataUnchecked } from '../journal/data.js';
import { jobDir, jobScratchDir, shortRunId } from '../journal/paths.js';
import { findStepDir } from '../journal/reader.js';
import { appendUsageRecord, usageRecord } from '../journal/usageStore.js';
import { RunJournal } from '../journal/writer.js';
import { jobLockHash, serializeLock } from '../pipeline/lock.js';
import { describeScriptUnresolved } from '../pipeline/expand.js';
import type {
  AgentStep,
  ContextEntry,
  ExpandedPipeline,
  Job,
  Pipeline,
  ScriptUnresolved,
  Step,
} from '../pipeline/model.js';
import type {
  AwaitingDecision,
  BudgetExceededState,
  DecisionRecord,
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

/** Адрес запущенного в решении шага — с идентичностью попытки и итерации цикла. */
export interface DecisionIdentity {
  readonly job: string;
  readonly step: string;
  readonly attempt: number;
  /** Итерация цикла until, если работа его объявляет. */
  readonly iteration?: number;
}

/** Запись состоявшегося отказа обещания решения — «кто и чем» для защёлки прогона. */
export interface DecisionLatchValue {
  readonly job: string;
  readonly step: string;
  readonly record: DecisionRecord;
}


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
   * Реестр вкладов: им разрешаются адаптеры бэкендов и вычисляются предикаты
   * плагинов. Без значения — только встроенные вклады: внешний потребитель
   * `stepcast` как библиотеки о плагинах знать не обязан.
   */
  readonly registry?: Registry;
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
    readonly nested?: readonly string[];
  }) => TreeAnchorer;
  /**
   * Подмена расположения движка. Тот же приём, что у `anchorerFor`: настоящий
   * `locateEngine()` всегда укажет на пакет, которым гоняются тесты, — а
   * сценариям снимка нужен движок то внутри временного дерева проекта, то
   * снаружи него, то в его `node_modules`.
   */
  readonly engineLocator?: () => EngineLocation;
  /**
   * Наблюдение за потоком событий: вызывается синхронно с записью каждого
   * события в журнал, рядом со снимком накопленного расхода прогона.
   * Событие `run.started` доставляется раньше, чем накопитель расхода
   * создан, — со снимком `ZERO_USAGE_SNAPSHOT`, а не падением.
   */
  readonly onEvent?: (event: Event, usage: UsageSnapshot) => void;
  /**
   * Интервал опроса каталога решений — константа `DEFAULT_DECISION_POLL_MS`,
   * подменяемая изнутри ради проверок (design.md изменения
   * `user-decision-steps`, решение 9), тем же приёмом, каким проверки демона
   * подменяют порождение процесса.
   */
  readonly decisionPollIntervalMs?: number;
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
  /**
   * Просьба о перезапуске — эффект `restart` решения человека (design.md
   * изменения `user-decision-steps`, решение 4). Цепочку ведёт вызывающая
   * команда (`stepcast run`/`stepcast resume`), а не сам `runPipeline`: она
   * планирует возобновление с этого места и исполняет его тем же процессом.
   */
  readonly restart?: { readonly from: string };
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
    ...(config.project.nestedRepos === undefined ? {} : { nestedRepos: config.project.nestedRepos }),
  });

  // Способ фиксации выбирается один раз на прогон: якоря разных способов
  // несравнимы, и смешивать их в пределах прогона нельзя.
  const anchorKind = detectAnchorKind(options.cwd, config.project.nestedRepos);
  const sourceCommits: Readonly<Record<string, string>> =
    anchorKind === 'manifest'
      ? {}
      : Object.fromEntries(
          ['.', ...(config.project.nestedRepos ?? [])].flatMap((relativePath) => {
            const dir = relativePath === '.' ? options.cwd : join(options.cwd, relativePath);
            try {
              const commit = execFileSync('git', ['-C', dir, 'rev-parse', '--verify', 'HEAD'], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
              }).trim();
              return [[relativePath, commit]];
            } catch {
              // Репозиторий без первого коммита допустим для cwd/copy. Если
              // работа запросит worktree, прежняя предстартовая проверка
              // назовёт невозможность точнее, чем запись манифеста.
              return [];
            }
          }),
        );

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

  let manifest: RunManifest = {
    run_id: journal.paths.runId,
    pipeline: pipeline.name,
    pipeline_file: pipeline.file,
    lock_hash: lockHash,
    project_root: options.projectRoot,
    workspace: pipeline.workspace,
    anchor_kind: anchorKind,
    // Список пишется всегда, включая пустой: «плагинов не было» и «версия
    // движка о них не знала» — разные утверждения, и различать их читателю
    // журнала нужно.
    plugins: (options.registry?.plugins ?? []).map((plugin) => ({ ...plugin })),
    ...(config.project.nestedRepos === undefined ? {} : { nested_repos: [...config.project.nestedRepos] }),
    ...(Object.keys(sourceCommits).length === 0 ? {} : { source_commits: sourceCommits }),
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

  // Движок фиксируется здесь: каталог прогона и журнал уже на диске (снимку
  // есть куда лечь), а первая работа ещё не создана — снимок обязан
  // существовать до первого рекурсивного вызова $STEPCAST_BIN (design.md,
  // решение 5). Отказ снятия останавливает прогон конфигурационной ошибкой:
  // молчаливый откат к незафиксированному движку — ровно то поведение,
  // против которого изменение и делается.
  const engineLocation = options.engineLocator?.() ?? locateEngine();
  const engineEditable = isEditableEngine({
    engineRoot: engineLocation.root,
    projectRoot: options.projectRoot,
  });
  const engine: EngineInfo = engineEditable
    ? {
        root: engineLocation.root,
        entry: pinEngine({ engine: engineLocation, snapshotDir: journal.paths.engine }),
        pinned: true,
      }
    : { root: engineLocation.root, entry: engineLocation.entry, pinned: false };

  // Второй манифест несёт то же, что первый, плюс движок: поле пишется у
  // всякого прогона, включая обычную установку (`pinned: false`) — «движок
  // лежал вне дерева» и «версия движка не умела писать это поле» разные
  // утверждения (run-journal, «Манифест прогона записывает движок»).
  manifest = { ...manifest, engine };
  journal.writeManifest(manifest);
  if (engine.pinned) {
    journal.event({ kind: 'engine.pinned', root: engine.root, path: journal.paths.engine });
  }

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

  // Ожидания решения человека, идущие прямо сейчас (user-decision-steps,
  // design.md решение 2) — тем же приёмом, что и `waitState` у `wake_at`.
  const awaitingDecisions = createAwaitingState();
  // Решения, записанные исходному прогону и не применённые им: возобновление
  // переносит их сюда и применяет ожиданию того же шага (дельта `run-resume`).
  // Наполняется ниже, вместе с прочим переносом из исходного прогона; ключ —
  // `работа/шаг`, потому что попытка и итерация у нового прогона свои.
  const carriedDecisions = new Map<string, CarriedDecision>();
  // Защёлка эффекта решения (design.md, решение 5): первый отказ обещания
  // `reject`/`restart` останавливает прогон, и второй такой же не переписывает
  // его — так же, как `budgetExceededLatch` держит первое превышение.
  const decisionLatch: { value: DecisionLatchValue | undefined } = { value: undefined };
  // Внутренний контроллер отмены: внешний сигнал (Ctrl-C) взводит его, и
  // отказ решения — тоже, так что оба повода останавливают прогон одним и тем
  // же `context.signal`, не заводя второго пути отмены.
  const runController = new AbortController();
  const onExternalAbort = (): void => runController.abort();
  if (options.signal !== undefined) {
    if (options.signal.aborted) runController.abort();
    else options.signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const knownStepAddresses = pipelineStepAddresses(pipeline);

  // Общий на прогон счёт мест по имени бэкенда: один агентский шаг и вызов
  // судьи того же бэкенда делят предел, а не удваивают его.
  const backendSlots = createBackendSlots((name) => config.backends[name]?.concurrency ?? 1);

  const context: RunContext = {
    ...options,
    // Умолчание реестра раскрывается один раз на прогон: каждый вызов
    // `builtinRegistry()` поднимает корневой контекст, а спрашивают его и
    // разрешение адаптера, и вычисление предикатов каждого шага (design.md
    // изменения `cordis-kernel-daemon`, Решение 13).
    registry: options.registry ?? builtinRegistry(),
    journal,
    records,
    usage,
    outputs,
    adapters,
    backendSlots,
    reportedDenials,
    sessions: createSessionRegistry(),
    pipelineContextSent: new Set<string>(),
    lockHash,
    anchorKind,
    sourceCommits,
    engine,
    runCwd: options.cwd,
    graph,
    completedWorkspaces,
    failureNote: { pending: options.resume === undefined ? undefined : previousFailureText(options.resume) },
    budgetExceededLatch: { value: undefined },
    decisionLatch,
    ...(options.resume === undefined
      ? {}
      : { observedInputs: options.resume.plan.observedInputs }),
    // Сигнал прогона — внутренний контроллер, а не сигнал вызывающего
    // напрямую: отказ решения взводит его так же, как Ctrl-C.
    signal: runController.signal,
    beginWait: (wakeAt) => {
      const release = waitState.begin(wakeAt);
      writeStatus('running', true);
      return () => {
        release();
        writeStatus('running', true);
      };
    },
    awaitDecision: async (identity, request) => {
      const since = new Date().toISOString();
      const waitId = computeWaitId({
        job: identity.job,
        step: identity.step,
        attempt: identity.attempt,
        ...(identity.iteration === undefined ? {} : { iteration: identity.iteration }),
        since,
      });
      const outcomes = Object.fromEntries(
        Object.entries(request.outcomes).map(([name, spec]) => [
          name,
          { effect: spec.effect, ...(spec.label === undefined ? {} : { label: spec.label }) },
        ]),
      );
      const deadline =
        request.deadlineMs === undefined ? undefined : new Date(Date.now() + request.deadlineMs).toISOString();
      const awaitingEntry: AwaitingDecision = {
        wait_id: waitId,
        job: identity.job,
        step: identity.step,
        outcomes,
        ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
        since,
        ...(deadline === undefined ? {} : { deadline }),
        ...(request.onExpire === undefined ? {} : { on_expire: request.onExpire }),
      };

      const endWait = awaitingDecisions.begin(awaitingEntry);
      // На диск до блокировки — тем же приёмом, что `beginWait`: ожидание
      // видно снаружи с первого такта, а не после того, как оно завершится.
      writeStatus('running', true);
      journal.event({
        kind: 'decision.awaiting',
        wait_id: waitId,
        job: identity.job,
        step: identity.step,
        outcomes,
        ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
        ...(deadline === undefined ? {} : { deadline }),
        ...(request.onExpire === undefined ? {} : { on_expire: request.onExpire }),
      });

      // Решение, перенесённое возобновлением: адресовано ожиданию прошлого
      // прогона, и потому передаётся ожиданию отдельно от каталога. Снимается
      // первым же применением — следующая итерация цикла `until` спрашивает
      // человека заново (дельта `run-decisions`).
      const key = carriedKey(identity.job, identity.step);
      const carried = carriedDecisions.get(key);

      const outcome = await waitForDecision({
        paths: journal.paths,
        waitId,
        awaiting: awaitingEntry,
        knownSteps: knownStepAddresses,
        signal: runController.signal,
        onRefused: (detail) => {
          journal.event({ kind: 'decision.refused', wait_id: waitId, job: identity.job, step: identity.step, detail });
        },
        ...(carried === undefined
          ? {}
          : {
              carried: {
                record: carried.record,
                source: shortRunId(carried.source),
                onApplied: () => carriedDecisions.delete(key),
              },
            }),
        ...(options.decisionPollIntervalMs === undefined ? {} : { pollIntervalMs: options.decisionPollIntervalMs }),
      });

      endWait();
      writeStatus('running', true);
      // Интервал ожидания не тратит бюджет прогона (design.md, решение 8):
      // записывается тем же вызовом, что и сон до сброса окна лимита, и потому
      // вычитается из `elapsedMs()`. Повод при этом называется отдельно:
      // против предела ожидания окна лимита подписки (`max_wait`) решение не
      // проверяется и его не исчерпывает — у него свой срок, объявленный на
      // шаге, а `max_wait` мерит собственные ожидания движка.
      usage.recordWait(Date.parse(since), Date.now(), 'decision');

      if (outcome.kind === 'canceled') {
        // Отмена прогона (Ctrl-C или отказ решения, объявленного другим
        // шагом) — не отказ этого решения: попытка завершится обычным путём
        // отмены, `context.signal.aborted` уже true к этому моменту.
        throw new Error('прогон отменён');
      }

      const { decision, by } = outcome;
      journal.event({
        kind: 'decision.applied',
        wait_id: waitId,
        job: identity.job,
        step: identity.step,
        outcome: decision.outcome,
        effect: decision.effect,
        by,
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
        ...(decision.restartFrom === undefined ? {} : { restart_from: decision.restartFrom }),
      });
      if (by === 'deadline') {
        journal.event({
          kind: 'decision.expired',
          wait_id: waitId,
          job: identity.job,
          step: identity.step,
          outcome: decision.outcome,
        });
      }

      const result: StepKindDecisionResult = {
        outcome: decision.outcome,
        effect: decision.effect,
        by,
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
        ...(decision.restartFrom === undefined ? {} : { restartFrom: decision.restartFrom }),
      };

      if (decision.effect === 'continue') return result;

      // Защёлка эффекта — до возврата управления исполнителю (design.md,
      // решение 5): вклад, поймавший и проглотивший отказ ниже, судьбу прогона
      // уже не меняет.
      if (decisionLatch.value === undefined) {
        decisionLatch.value = { job: identity.job, step: identity.step, record: toDecisionRecord(result) };
        runController.abort();
      }
      throw new DecisionHalt(result);
    },
    // Состояние переписывается после каждого шага: это единственный файл, по
    // изменению которого витрина узнаёт о ходе прогона, и данные, записанные
    // работой, доезжают до подписи узла только вместе с ним.
    refreshStatus: () => writeStatus('running', true),
  };

  requireAdapters(context);
  warnAboutDegradedBackends(context);
  requireStrictPermissionsSupport(context);
  requireMcpSupport(context);

  /**
   * Единственное место, где картина прогона попадает на диск: сводка
   * расхода, затем состояние. Пятого повода не бывает без обоих файлов —
   * отдельный вызов на каждом поводе однажды забыли бы (design.md,
   * Решение 1). `partial` снимается только терминальной записью: сводка
   * подводится ровно тогда, когда прогон действительно завершён.
   *
   * Обе величины читаются из одного `usage` синхронно, без `await` между
   * ними: писать расход в этом окне некому, поэтому итог прогона в сводке и
   * в `budget` состояния не расходится (design.md, Решение 8).
   */
  const writeStatus = (status: StatusValue, partial: boolean): void => {
    // Перерасход бюджета останавливает прогон так же, как отказ, и точка
    // возобновления нужна ровно так же: без неё прогон, упёршийся в потолок,
    // остался бы единственным законченным исходом без подсказки, как его
    // продолжить.
    const blocked = [...records.values()].find(
      (record) => record.status === 'failed' || record.status === 'budget_exceeded',
    );
    // Сводка пишется раньше состояния: витрина замечает изменение прогона по
    // mtime status.json, и к этому моменту лежащая рядом сводка не должна
    // быть старше него (design.md, Решение 2).
    const report = usage.report(journal.paths.runId, partial);
    journal.writeUsage(report);
    const runStatus: RunStatus = {
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
        ...(context.budgetExceededLatch.value === undefined
          ? {}
          : { exceeded: context.budgetExceededLatch.value }),
      },
      ...(blocked === undefined
        ? decisionLatch.value?.record.effect === 'restart' &&
          decisionLatch.value.record.restart_from !== undefined
          ? {
              resume: {
                command: `stepcast resume ${shortRunId(journal.paths.runId)} --from ${decisionLatch.value.record.restart_from}`,
              },
            }
          : {}
        : {
            resume: {
              command: `stepcast resume ${shortRunId(journal.paths.runId)} --from ${blocked.id}`,
              blocked_by: blocked.id,
            },
          }),
      ...(waitState.earliest() === undefined ? {} : { wake_at: waitState.earliest() as string }),
      ...(awaitingDecisions.list().length === 0 ? {} : { awaiting: [...awaitingDecisions.list()] }),
      ...(decisionLatch.value?.record.effect === 'restart' && decisionLatch.value.record.restart_from !== undefined
        ? { restart_from: decisionLatch.value.record.restart_from }
        : {}),
      updated_at: new Date().toISOString(),
    };
    journal.writeStatus(runStatus);

    // Дозапись хранилища расхода: только терминальной записью, рядом с
    // подведением сводки (design.md, Решение 3) — идущий прогон в хранилище
    // не попадает вовсе. Отказ дозаписи не должен ронять уже завершившийся
    // прогон: он сообщается тем же путём, что и прочий внутренний учёт.
    if (!partial) {
      try {
        const key = basename(journal.paths.projectDir);
        appendUsageRecord(dirname(journal.paths.projectDir), usageRecord(key, manifest, runStatus, report));
      } catch (error) {
        journal.event({
          kind: 'bookkeeping.failed',
          operation: 'дозапись хранилища расхода',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  // Выходы переиспользованных работ публикуются не здесь, а по ходу
  // исполнения: каждая работа проходит через `executeJob` в обычном порядке
  // графа, даже если все её шаги переиспользованы, и публикует выход в
  // `runJobSteps` — так же, как исполненная. Предзаполнение записи об
  // артефакте путём, по которому файл ещё не записан, было бы ложью.
  if (options.resume !== undefined) {
    restoreForResume(options.resume, journal, options.cwd, anchorKind, config.project.nestedRepos);
    carryOverRunDir(options.resume, journal);
    carryOverDecisions(options.resume, journal, carriedDecisions);
  }

  writeStatus('running', true);

  /**
   * Область прогона: ресурсы, живущие столько же, сколько сам прогон.
   * Снимается до финального состояния и до `run.finished` — состояние
   * закончившегося прогона не должно утверждать, что он спит.
   */
  const runResources = createScope({ journal });
  runResources.defer('снятие состояния ожидания прогона', () => {
    waitState.clear();
  });
  runResources.defer('снятие незакрытых ожиданий решения', () => {
    awaitingDecisions.clear();
  });
  // Слушатель внешнего сигнала на внутренний контроллер — `{ once: true }`
  // снимает его сам, но только если сигнал успел взвестись; прогон, дошедший
  // до конца без отмены, обязан снять его сам же, а не оставлять висеть на
  // сигнале вызывающего до конца процесса.
  runResources.defer('снятие слушателя внешнего сигнала отмены', () => {
    options.signal?.removeEventListener('abort', onExternalAbort);
  });

  let result: Awaited<ReturnType<typeof schedule>>;
  try {
    result = await schedule({
      pipeline,
      graph,
      // Потолок конфигурации применяет сам прогон: линт отклоняет превышение,
      // но прогон не обязан полагаться на то, что линт был.
      concurrency: Math.min(pipeline.concurrency, config.limits.concurrency),
      signal: runController.signal,
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
          ...(outcome.skip === undefined ? {} : { skip: outcome.skip }),
          ...(outcome.lastCheck === undefined ? {} : { last_check: [...outcome.lastCheck] }),
          finished_at: new Date().toISOString(),
        });
        journal.event({
          kind: 'job.finished',
          job: job.id,
          status: outcome.status,
          ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        });
        writeStatus('running', true);
      },
      });
  } finally {
    await runResources.dispose();
  }

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

  // Защёлка перейдённого потолка поднимает исход прогона поверх вычисленного
  // по работам: работа, до которой потолок остановил дело, могла успеть
  // отчитаться успехом сама, а освобождённые завершающие — тем более
  // (design.md, решение 3). Отмена остаётся важнее.
  const finalStatus: StatusValue =
    context.budgetExceededLatch.value !== undefined && result.status !== 'canceled'
      ? 'budget_exceeded'
      : result.status;

  // Манифест обновляется раньше терминальной записи состояния: запись
  // хранилища расхода, дописываемая изнутри `writeStatus`, читает `finished_at`
  // и `status` из того же объекта `manifest` (`usageRecord`) — без этого
  // порядка она увидела бы прогон ещё не завершённым.
  const exitCode = resolveExitCode(finalStatus, result.settled);
  manifest = { ...manifest, finished_at: new Date().toISOString(), status: finalStatus, exit_code: exitCode };

  writeStatus(finalStatus, false);

  journal.writeManifest(manifest);
  journal.event({ kind: 'run.finished', status: finalStatus, exit_code: exitCode });

  const costLimitUnapplied = anyCostBudgetDeclared(pipeline) && usage.runCostNeverReported();

  const restart =
    decisionLatch.value?.record.effect === 'restart' && decisionLatch.value.record.restart_from !== undefined
      ? { from: decisionLatch.value.record.restart_from }
      : undefined;

  return { journal, status: finalStatus, exitCode, costLimitUnapplied, ...(restart === undefined ? {} : { restart }) };
}

// Экспортирован для `exec/pluginStep.ts`: исполнитель вида шага собирается тем
// же путём, что и `runCommandStep`, и ему нужна та же форма контекста прогона
// и тот же исход шага (`StepOutcome` ниже). Импорт в обе стороны безопасен:
// оба места используют друг друга только внутри тел функций, вызываемых уже
// после того, как загрузчик модулей ES связал оба файла (см. комментарий у
// `registerBuiltinStepKinds` в `src/parts/builtin.ts` — тот же приём).
export interface RunContext extends RunOptions {
  /**
   * Реестр вкладов прогона — в отличие от `RunOptions.registry`, здесь он есть
   * всегда: умолчание встроенного ядра раскрыто при заведении контекста (см.
   * `startRun`), и ни одно место исполнения не поднимает его себе само.
   */
  readonly registry: Registry;
  readonly journal: RunJournal;
  readonly records: Map<string, JobRecord>;
  readonly usage: UsageAccumulator;
  readonly outputs: UpstreamOutput[];
  readonly adapters: Map<string, BackendAdapter>;
  /** Предел одновременных вызовов бэкенда, общий на прогон. */
  readonly backendSlots: BackendSlots;
  /** Одна и та же переменная вычёркивается на каждом шаге — сообщаем однажды. */
  readonly reportedDenials: Set<string>;
  /**
   * Реестр сессий прогона. Здесь, а не в исполнении работы, ровно ради
   * `session_group`: работы одной группы обязаны продолжать один диалог, а
   * реестр, живущий работу, обрывал бы его на её границе. Пространство имён
   * псевдонимов замыкается ключом (см. `sessionKey`), поэтому работа без
   * объявленной группы ведёт себя в точности как прежде.
   */
  readonly sessions: ReturnType<typeof createSessionRegistry>;
  /**
   * Сессии, в которые уже отправлен контекст пайплайна. Отслеживание живёт в
   * прогоне вместе с реестром: свод правил пайплайна агент читает один раз на
   * диалог, а не заново на каждой его работе.
   */
  readonly pipelineContextSent: Set<string>;
  /**
   * Источник знания **работы**, если практика памяти объявлена. Заводится по
   * её рабочей директории (`runJob`), а не по каталогу запуска: иначе в режиме
   * `worktree` и отбор, и предикат `knowledge_valid` смотрели бы мимо дерева,
   * которое шаг правит. На контексте прогона поля нет вовсе — значение,
   * верное только для режима `cwd`, хуже отсутствующего.
   */
  readonly knowledgeSource?: KnowledgeSource | undefined;
  readonly lockHash: string;
  /** Способ фиксации состояния: определён один раз на прогон. */
  readonly anchorKind: AnchorKind;
  /** Неизменные коммиты, от которых заводятся все worktree этого прогона. */
  readonly sourceCommits: Readonly<Record<string, string>>;
  /**
   * Движок, которым прогон исполняется, — корень, точка входа и признак
   * снимка (`run/engine.ts`). Определяется один раз на прогон, до первой
   * работы: `STEPCAST_BIN` шагов и проверок цикла берёт точку входа отсюда,
   * а не из `process.argv[1]` напрямую, чтобы пересборка `dist/` в рабочем
   * дереве не подменяла код, которым прогон уже идёт.
   */
  readonly engine: EngineInfo;
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
  /**
   * Защёлка первого превышения, остановившего исполнение. Заполняется один
   * раз — вторая и последующие остановки его не переписывают, иначе
   * состояние прогона называло бы не первую причину, а последнюю подвернувшуюся.
   * Исход прогона (`scheduler.ts`) читает её поверх статусов работ: работа,
   * до которой потолок остановил дело, могла успеть отчитаться успехом
   * (design.md, решение 3).
   */
  readonly budgetExceededLatch: { value: BudgetExceededState | undefined };
  /**
   * Защёлка эффекта решения (design.md изменения `user-decision-steps`,
   * решение 5): первый отказ обещания `reject`/`restart`, остановивший
   * прогон, — заполняется один раз, рядом с `budgetExceededLatch`.
   */
  readonly decisionLatch: { value: DecisionLatchValue | undefined };
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
   * Объявить ожидание решения и дождаться его (design.md изменения
   * `user-decision-steps`, решение 1, решение 5) — рядом с `beginWait`, тем же
   * приёмом записи `awaiting` на диск до блокировки. Разрешается результатом
   * только для эффекта `continue`; `reject` и `restart` отдаются отказом
   * `DecisionHalt`, взводя `decisionLatch` до возврата управления исполнителю.
   */
  readonly awaitDecision: (
    identity: DecisionIdentity,
    request: StepKindDecisionRequest,
  ) => Promise<StepKindDecisionResult>;
  /**
   * Переписать `status.json` по текущим записям работ. Файлом владеет движок и
   * только он: подпроцесс `stepcast data` пишет свой `data.json`, а состояние
   * прогона переписывается здесь — конкурентная запись двух процессов в один
   * файл была бы гонкой.
   */
  readonly refreshStatus: () => void;
}

/** Отсутствие поддержки сессий не отказ, а деградация с предупреждением. */
/**
 * Все бэкенды, которые понадобятся прогону, разрешаются до первой работы.
 *
 * Настроенный, но не предоставленный ни встроенно, ни плагином бэкенд иначе
 * обнаружился бы на первом агентском шаге — то есть после подготовки рабочих
 * деревьев и, возможно, после сорока минут чужой работы. Проверка стоит
 * ничего и делается там же, где остальные предстартовые.
 */
function requireAdapters(context: RunContext): void {
  const needed = new Set<string>();
  for (const job of context.expanded.pipeline.jobs) {
    for (const step of job.steps) {
      if (step.kind === 'agent') needed.add(step.agent);
      for (const predicate of step.expect) {
        if (predicate.kind === 'judge') needed.add(predicate.agent ?? context.config.defaults.agent);
      }
    }
    for (const predicate of job.until?.check ?? []) {
      if (predicate.kind === 'judge') needed.add(predicate.agent ?? context.config.defaults.agent);
    }
  }

  for (const name of needed) adapterOf(name, context);
}

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
      // Codex временно принимает, но не применяет allow/deny/enforce, чтобы
      // переносимые pipeline могли выбирать его через конфигурацию.
      if (step.agent === 'codex') continue;
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

/**
 * Отсутствие поддержки MCP не деградирует, а останавливает прогон до первого
 * шага, тем же приёмом, что и `requireStrictPermissionsSupport`: молча
 * исполнить объявление бэкендом, который его не умеет, значило бы оставить
 * пайплайн с инструментами, которых нет.
 */
function requireMcpSupport(context: RunContext): void {
  for (const job of context.expanded.pipeline.jobs) {
    for (const step of job.steps) {
      // Пустое объявление (`mcp: {}`) — снятие унаследованного: серверов у
      // шага не будет ни при какой возможности бэкенда, и требовать её от него
      // не за что.
      if (step.kind !== 'agent' || step.mcp === undefined || Object.keys(step.mcp).length === 0) continue;
      if (adapterOf(step.agent, context).capabilities.mcp) continue;
      throw new StepcastError(
        `Бэкенд ${step.agent} не объявляет возможность работать с MCP-серверами, объявленными у шага ${job.id}/${step.id}`,
        {
          file: job.source,
          hint: `Включите backends.${step.agent}.mcp в конфигурации либо снимите объявление mcp`,
        },
      );
    }
  }
}

/**
 * Экспортируется ради `exec/pluginStep.ts`: судью на шаге плагинного вида
 * зовёт тот же проход и тем же адаптером, что и на командном (см. там же
 * `describeStepTask`).
 */
export function adapterOf(name: string, context: RunContext): BackendAdapter {
  const existing = context.adapters.get(name);
  if (existing !== undefined) return existing;
  const created = (
    context.adapterFor ?? ((backend) => resolveAdapter(backend, context.config, context.registry))
  )(name);
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

  /**
   * Область работы: ресурсы, живущие ровно столько, сколько сама работа, —
   * каталог черновиков и служебные файлы её якоря. Заводится до `prepareJob`
   * и снимается единственным `finally` ниже: работа, отказавшая на подготовке
   * рабочей директории или на раскрытии подстановок, обязана убрать за собой
   * так же полно, как дошедшая до конца.
   */
  const resources = createScope({ journal, job: declared.id });

  journal.prepareJob(declared.id);
  // Регистрируется первым — снимется последним: каталог черновиков переживает
  // всё прочее содержимое области.
  resources.defer('снятие каталога черновиков', () => {
    const dir = jobScratchDir(journal.paths, declared.id);
    // Убрать каталог за собой шагу никто не запрещал, и сделанное им — не
    // отказ учёта: жаловаться в журнал на достигнутый результат незачем.
    if (!existsSync(dir)) return;
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  });
  journal.event({ kind: 'job.started', job: declared.id });
  context.records.set(declared.id, {
    ...(context.records.get(declared.id) as JobRecord),
    status: 'running',
    started_at: new Date().toISOString(),
  });
  // Начало работы сбрасывается на диск сразу, а не вместе с исходом первого
  // шага: у работы с одним долгим агентским шагом между этими моментами
  // проходят десятки минут, и всё это время состояние утверждало бы, что
  // работа ещё не начиналась.
  context.refreshStatus();

  try {
    return await runJob(declared, scope, context, resources);
  } finally {
    // Пустой каталог черновиков не несёт материала для разбора и не должен
    // копиться в раскладке прогона годами; непустой остаётся — в нём мог лечь
    // след отказа. Отказ любой обратной операции области — учётная операция,
    // не исход работы: агент, которому запрещено трогать что-либо за
    // пределами дерева, права на уборку здесь и не давалось.
    await resources.dispose();
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
  resources: ResourceScope,
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
  const adoptWorkspace = context.resume?.plan.adoptWorkspace.find((item) => item.job === job.id);
  let prepared: PreparedWorkspace;
  try {
    prepared = await prepareWorkspace({
      job,
      cwd: context.cwd,
      runDir: journal.paths.dir,
      bookkeeping: { journal, job: job.id },
      source,
      anchorKind: context.anchorKind,
      anchorsDir: journal.paths.anchors,
      ...(context.config.project.nestedRepos === undefined
        ? {}
        : { nestedRepos: context.config.project.nestedRepos }),
      sourceCommits: context.sourceCommits,
      ...(context.anchorerFor === undefined ? {} : { anchorerFor: context.anchorerFor }),
      ...(adoptWorkspace === undefined || context.resume === undefined
        ? {}
        : {
            adoptFrom: {
              path: adoptWorkspace.path,
              runId: context.resume.source.manifest.run_id,
              ...(adoptWorkspace.nested === undefined ? {} : { nested: adoptWorkspace.nested }),
            },
          }),
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
      ...(prepared.adoptedFrom === undefined ? {} : { adopted_from: prepared.adoptedFrom }),
      // Пишется здесь, до первого шага, а не по завершении работы: уборка
      // обязана быть полной и после отказа, отмены и остановки по бюджету —
      // то есть именно тогда, когда «по завершении» не наступает.
      ...(prepared.nested === undefined ? {} : { nested: prepared.nested.map((part) => ({ ...part })) }),
    },
  });
  // И на диск — сразу, а не вместе с исходом первого шага: перечень читает
  // уборка (`collectRunWorktrees` в `run/cleanup.ts`), и прогон, убитый между
  // подготовкой дерева и концом первого шага, оставил бы учётные записи
  // частей в чужих репозиториях — ровно ту утечку, ради которой заведён учёт.
  context.refreshStatus();

  if (prepared.inheritedFrom !== undefined) {
    journal.event({
      kind: 'workspace.inherited',
      job: job.id,
      source: prepared.inheritedFrom,
      via: prepared.continued === true ? 'continue' : 'seed',
    });
  }

  // Дерево работы приводится к состоянию переиспользованных шагов сразу после
  // подготовки: раньше каталога нет, позже его уже читают шаги и предикаты
  // `until`.
  restoreJobWorkspace(context, job, prepared);

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
    }, context.registry);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      status: 'failed',
      reason: `подстановку раскрыть не удалось: ${detail}`,
      cause: HaltCause.spawnFailed,
    };
  }

  const liveFiles = context.expanded.pipeline.publication?.liveFiles ?? [];
  let liveSnapshot;
  try {
    liveSnapshot = syncLiveFiles(context.runCwd, prepared.dir, liveFiles);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      status: 'failed',
      reason: `живые файлы в рабочую директорию перенести не удалось: ${detail}`,
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
  transferJobData(context, job);

  // Ниже по коду `context` — контекст работы: у него своя рабочая директория.
  //
  // Источник знания заводится здесь же, по этой самой директории, а не один
  // раз на прогон по каталогу запуска. Причина в предикате `knowledge_valid`:
  // в режиме `worktree` шаг правит копию дерева, и источник, привязанный к
  // каталогу запуска, проверял бы не то, что шаг только что написал, —
  // предикат зеленел бы на сломанной памяти дорожки и краснел бы на чужой,
  // ещё не сведённой. По той же причине и отбор идёт по дереву работы: знание
  // дорожки — это знание её копии, а не главного дерева.
  const jobContext: RunContext = {
    ...context,
    cwd: prepared.dir,
    knowledgeSource: createKnowledgeSource({
      knowledge: context.expanded.pipeline.knowledge,
      root: prepared.dir,
      specDir: context.config.project.spec.dir,
    }),
  };
  const anchorState: { anchorer: TreeAnchorer | undefined; lastAnchor: Anchor | undefined } = {
    anchorer: undefined,
    lastAnchor: undefined,
  };
  // Индексный файл живёт ровно столько, сколько работа. Регистрируется здесь,
  // а не рядом с созданием якоря: якорь заводится заново на каждой итерации
  // цикла `until` под одним и тем же именем файла, и снять его достаточно
  // однажды — тот, что остался последним.
  resources.defer('снятие служебных файлов якоря работы', () => {
    anchorState.anchorer?.dispose();
  });
  const jobStartedAt = Date.now();
  const maxIterations = job.until?.maxIterations ?? 1;
  let previousCheck: readonly PredicateResult[] | undefined;
  // Сквозная нумерация вызовов предиката script в until.check — растёт через
  // итерации цикла, тем же образом, что и у предиката script в expect шага.
  let checkScriptCallCount = 0;
  const nextCheckScriptCallIndex = (): number => {
    checkScriptCallCount += 1;
    return checkScriptCallCount;
  };

  const outcome = await (async (): Promise<JobOutcome> => {
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

      const results = await evaluateCheck(job, jobContext, nextCheckScriptCallIndex);
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
    }
  })();

  try {
    writebackLiveFiles({
      sourceRoot: context.runCwd,
      workspaceRoot: prepared.dir,
      liveFiles,
      snapshot: liveSnapshot,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    journal.event({ kind: 'job.errored', job: job.id, detail });
    return {
      status: 'failed',
      reason: `живые файлы вернуть в исходное дерево не удалось: ${detail}`,
      cause: HaltCause.spawnFailed,
    };
  }
  return outcome;
}

/**
 * Проверки цикла. Вычисляются после всех шагов итерации, в рабочей директории
 * работы. Время идёт в бюджет работы, токены — только если проверка обращается
 * к агентскому бэкенду.
 */
async function evaluateCheck(
  job: Job,
  context: RunContext,
  nextScriptCallIndex: () => number,
): Promise<PredicateResult[]> {
  const until = job.until;
  if (until === undefined) return [];

  return evaluatePredicates(
    until.check,
    {
      exitCode: 0,
      text: '',
      structured: undefined,
      cwd: context.cwd,
      // Проверка цикла запускает настоящую команду сборки или тестов, и без
      // окружения она не найдёт ни одного инструмента: `execaSync` зовётся с
      // `extendEnv: false`, поэтому пустой набор означает буквально пустой —
      // ни PATH, ни HOME.
      env: jobEnv(job, context),
      knowledge: context.knowledgeSource,
      // Проверка цикла — не попытка шага: подкаталог script-<n> ложится в
      // каталог работы, а не шага, и `exit_code`/пути в input.json несут
      // умолчания «попытки не было» — предикат цикла проверяет состояние
      // рабочего дерева, а не чей-то процесс.
      script: {
        stepDir: context.journal.prepareJob(job.id),
        attempt: 1,
        journal: context.journal,
        nextCallIndex: nextScriptCallIndex,
        timeoutMs: context.config.defaults.stepTimeoutMs,
      },
    },
    context.registry,
  );
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
      binPath: context.engine.entry,
      jobId: job.id,
      jobDir: context.journal.prepareJob(job.id),
      attempt: 1,
      workspace: context.cwd,
      artifacts: context.journal.paths.artifacts,
      scratch: jobScratchDir(context.journal.paths, job.id),
    }),
    deny: pipeline.envDeny,
    cwd: context.projectRoot,
  });
  return env;
}

/**
 * Область прогона в перечне потолков работы.
 *
 * У освобождённой работы (`budget_exempt`) потолки расхода и времени прогона
 * из проверки выпадают — в этом освобождение и состоит. Но `rate_limit_pct`
 * не потолок расхода: это доля чужого окна лимита подписки, и упор в него
 * означает не «прогон потратил своё», а «бэкенду сейчас нельзя». Снять его
 * вместе с потолком значило бы, что освобождённая работа с агентскими шагами
 * долбит бэкенд ровно тогда, когда окно уже выбрано, — поэтому у
 * освобождённой работы от области прогона остаётся один этот сторож
 * (pipeline-execution, «Работа, освобождённая от потолка прогона»).
 */
function runScopeOf(job: Job, context: RunContext): BudgetScope | undefined {
  const budget = context.expanded.pipeline.budget;
  if (job.budgetExempt !== true) return { kind: 'run', name: 'пайплайн', budget };
  if (budget?.rateLimitPct === undefined) return undefined;
  return {
    kind: 'run',
    name: 'пайплайн',
    budget: {
      rateLimitPct: budget.rateLimitPct,
      onExceed: budget.onExceed,
      ...(budget.declaredOnExceed === undefined ? {} : { declaredOnExceed: budget.declaredOnExceed }),
    },
  };
}

/** Области бюджета работы и прогона: цикл ограничен ими обеими. */
function jobScopes(job: Job, context: RunContext): BudgetScope[] {
  const scopes: BudgetScope[] = [
    { kind: 'job', name: `работа ${job.id}`, jobId: job.id, budget: job.budget },
  ];
  const run = runScopeOf(job, context);
  if (run !== undefined) scopes.push(run);
  return scopes;
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
      // Составной способ допустим и в режиме cwd, и в режиме worktree
      // (checkWorkspaceAvailability): в обоих `context.cwd` — каталог, где
      // объявленные части уже материализованы своими рабочими деревьями. Для
      // остальных способов `nested` попросту не читается.
      ...(context.config.project.nestedRepos === undefined
        ? {}
        : { nested: context.config.project.nestedRepos }),
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

  /**
   * Псевдоним сессии, замкнутый на её пространство имён.
   *
   * Без объявленной группы пространство — работа и итерация её цикла: это
   * ровно сегодняшнее поведение, при котором реестр жил в исполнении работы и
   * новая итерация `until` начинала сессии заново.
   *
   * С объявленной группой пространство — сама группа, и итерация в ключ не
   * входит: сессия группы переживает границу работы, и «начинать заново» на
   * итерации было бы нечего — предыдущие работы группы уже закончились. Работе
   * группы цикл `until` поэтому и запрещён (см. линт).
   */
  // Псевдоним принадлежит адаптеру: одинаковое `session: default` у Claude
  // и Codex означает два разных диалога, а идентификатор одной стороны другая
  // продолжить не умеет. Имя агента входит и в обычное пространство работы, и
  // в явную группу сессий.
  const sessionKey = (agent: string, alias: string): string => {
    const scope = job.sessionGroup === undefined
      ? `${job.id}#${iteration ?? 1}`
      : job.sessionGroup;
    return `${scope}/${agent}/${alias}`;
  };

  // Сессии, в которые уже отправлен контекст самой работы и выходы
  // предшественников. Отслеживание живёт в работе, а не в прогоне, в отличие
  // от контекста пайплайна: собственный контекст второй работы группы — это
  // новое знание, и умолчать о нём потому, что диалог уже начат, значило бы
  // отправить её работать по пустому месту.
  const jobContextSent = new Set<string>();
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
      const dataViolation = foldJobData(context, job);
      if (dataViolation !== undefined) return { status: 'failed', reason: dataViolation };
      if (
        (step.kind === 'agent' ||
          (step.kind === 'run' && step.outputSchemaPath !== undefined) ||
          step.kind === 'script' ||
          step.kind === 'plugin') &&
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

    // Продолжение оборванной сессии: засев реестра и отметок об отправленном
    // контексте случается до первой попытки — `executeAgentStep` берёт
    // сессию как обычно и получает `resume: true` там, где реестр сегодня
    // выдал бы новый идентификатор (design.md, решение 5).
    const continuing = planned?.decision.kind === 'continue' ? planned.decision : undefined;
    const continuationSourceId = context.resume?.source.manifest.run_id ?? 'неизвестно';
    if (continuing !== undefined && step.kind === 'agent') {
      const key = sessionKey(step.agent, step.session);
      context.sessions.seed(key, continuing.sessionId);
      context.pipelineContextSent.add(key);
      jobContextSent.add(key);
      journal.event({
        kind: 'session.continued',
        job: job.id,
        step: step.id,
        session: continuing.sessionId,
        source: continuationSourceId,
      });
      // Расход оборванной попытки складывается со счётом продолжающего шага
      // независимо от исхода продолжения: он уже потрачен, а не поставлен
      // под вопрос отказом сессии у бэкенда (design.md, решение 8).
      const carriedUsage = continuing.record.attempts.at(-1)?.usage;
      if (carriedUsage !== undefined) context.usage.carry(job.id, step.id, carriedUsage);
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

    // Освобождённая работа (`budget_exempt`) не проверяется на потолок
    // прогона: область `run` выпадает из перечня — кроме сторожа окна лимита
    // подписки, который в ней остаётся (`runScopeOf`). Области работы и шага
    // остаются как есть. Расход при этом по-прежнему копится в счётчиках
    // прогона через context.usage.record — освобождение снимает применение
    // потолка, а не учёт (design.md, решение 4).
    const budgetScopes = (): BudgetScope[] => {
      const scopes: BudgetScope[] = [
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
      ];
      const run = runScopeOf(job, context);
      if (run !== undefined) scopes.push(run);
      return scopes;
    };

    // Потолок, перейдённый до этого шага, решает ровно один вопрос — запускать
    // ли его. Шаг, который движок решил не запускать, получает budget_exceeded
    // тем же путём, что и любой неуспешный шаг ниже, но бэкенд и команда не
    // стартуют вовсе (design.md, решение 1).
    const exceeded = context.usage.check(budgetScopes());

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

    // Исход исполненного шага — его собственный, без исключений: попытку,
    // которую применение потолка оборвало на середине, `runCommandStep`/
    // `runAgentStep` отдают уже как budget_exceeded сами (design.md, решение
    // 2) — здесь статус больше не переписывается.
    const outcome: StepOutcome =
      exceeded !== undefined
        ? { status: 'budget_exceeded', reason: describeExceeded(exceeded), attempts: [], results: [], exceeded }
        : step.kind === 'run' || step.kind === 'script'
          ? await runCommandStep(
              step,
              job,
              context,
              stepDirPath,
              context.sessions,
              budgetScopes,
              changedPaths,
            )
          : step.kind === 'plugin'
            ? await runPluginStepDispatch(step, job, context, stepDirPath, budgetScopes, changedPaths, iteration)
            : await runAgentStep(
                step,
                job,
                context,
                stepDirPath,
                context.sessions,
                sessionKey,
                jobContextSent,
                budgetScopes,
                changedPaths,
              );

    for (const [index, results] of outcome.results.entries()) {
      journal.writeExpectReport(stepDirPath, { attempt: index + 1, results: [...results] });
    }

    const status: StatusValue = outcome.status;
    const reason = outcome.reason;
    const cause = causeOf(status, outcome.results, outcome.cause);

    // Защёлка прогона запоминает первое превышение, которое дело остановило.
    // Остановивших два вида, и оба ниже: шаг, который потолок не дал запустить
    // или чью попытку оборвал, — он и числится `budget_exceeded`; и перейдённый
    // потолок прогона, останавливающий всё, что после него, даже когда сам шаг
    // дошёл до конца успехом (design.md, решение 3).
    //
    // Перейдённый потолок шага или работы, никого не остановивший (его перевела
    // последняя запись расхода успевшей попытки, а следующему шагу область
    // отсчитывается заново), в защёлку не идёт: прогон доигрывается целиком, и
    // объявлять его остановленным по бюджету — та же ложь в поле статуса,
    // против которой заведено изменение, только уровнем выше. Она заодно
    // прятала бы под собой настоящий отказ, случившийся позже.
    const stopping =
      outcome.exceeded !== undefined &&
      (status === 'budget_exceeded' || outcome.exceeded.scopeKind === 'run')
        ? outcome.exceeded
        : undefined;

    if (context.budgetExceededLatch.value === undefined && stopping !== undefined) {
      context.budgetExceededLatch.value = {
        scope: stopping.scope,
        dimension: stopping.dimension,
        used: stopping.used,
        limit: stopping.limit,
        at: new Date().toISOString(),
        job: job.id,
        step: step.id,
      };
    }

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
      attempts:
        continuing === undefined
          ? [...outcome.attempts]
          : [...carriedAttempts(continuing.record, continuationSourceId), ...outcome.attempts],
      ...(outcome.observedInputs === undefined || outcome.observedInputs.length === 0
        ? {}
        : { observed_inputs: [...outcome.observedInputs] }),
      ...(outcome.backendInit === undefined ? {} : { backend_init: outcome.backendInit }),
      ...(continuing === undefined ? {} : { continued_from: continuationSourceId }),
      ...(step.kind === 'script' && step.resolved !== undefined
        ? {
            script: {
              path: step.path,
              layer: step.resolved.layer,
              absolute_path: step.resolved.absolutePath,
              runner: step.resolved.runner,
              argv: [...step.resolved.argv],
            },
          }
        : {}),
      ...(step.kind === 'script' && step.uses !== undefined
        ? {
            uses: {
              name: step.uses.name,
              ...(step.uses.layer === undefined ? {} : { layer: step.uses.layer }),
              ...(step.uses.manifestPath === undefined ? {} : { manifest_path: step.uses.manifestPath }),
            },
          }
        : {}),
      // Вид и плагин шага плагинного вида (design.md, риски): читатель без
      // этого плагина показывает запись этими же полями, не отказывая
      // чтением. Владелец не бывает «встроенным» — `kind: plugin` у
      // встроенных видов не встречается вовсе.
      ...(step.kind === 'plugin'
        ? {
            plugin_step: {
              name: step.name,
              plugin: contributionOwner(context.registry, 'steps', step.name) ?? 'неизвестный',
            },
          }
        : {}),
      ...(outcome.decision === undefined ? {} : { decision: outcome.decision }),
    };
    steps.push(stepRecord);
    journal.writeStepJson(stepDirPath, 'step.json', stepRecord);

    if (
      (step.kind === 'agent' ||
        (step.kind === 'run' && step.outputSchemaPath !== undefined) ||
        step.kind === 'script' ||
        // Структурированный выход шага плагинного вида — то, что вернул
        // исполнитель вклада (`StepKindOutcome.structured`): схема `output`
        // его проверяет, когда объявлена, но не она решает, есть ли он.
        step.kind === 'plugin') &&
      outcome.structured !== undefined
    ) {
      lastStructuredOutput = outcome.structured;
      // Шаг `script` уже записал этот файл сам — байт в байт, как и было
      // (design.md, решение 5). Переписать его здесь — заново сериализовать
      // то же значение — значило бы потерять форматирование скрипта.
      if (step.kind !== 'script') {
        journal.writeStepJson(stepDirPath, 'output.json', outcome.structured);
      }
    }
    if (job.output?.from === step.id) outputFromStep = outcome.structured;

    journal.event({
      kind: 'step.finished',
      job: job.id,
      step: step.id,
      // Ни одной попытки не было, когда потолок остановил шаг до запуска
      // (`outcome.attempts` пуст) — событие всё равно называет номер попытки,
      // и им остаётся первая: `step.started` его уже назвал этим же числом.
      attempt: outcome.attempts.length === 0 ? 1 : outcome.attempts.length,
      status,
      ...(reason === undefined ? {} : { reason }),
    });

    context.records.set(job.id, {
      ...(context.records.get(job.id) as JobRecord),
      steps: [...steps],
    });
    // Данные складываются при любом исходе шага — они рассказывают, на чём
    // работа встала, — но исход шага решает первым: шаг, упавший по `expect`,
    // таймауту или бюджету, обязан отдать наружу свою причину и свой
    // `cause`. Нарушение объявления при этом не теряется: оно дописывается к
    // причине, потому что статус у работы всё равно один.
    const dataViolation = foldJobData(context, job);

    if (status !== 'success') {
      const detail = reason === undefined ? undefined : `шаг ${step.id}: ${reason}`;
      const joined = [detail, dataViolation].filter((part) => part !== undefined).join('; ');
      return {
        status,
        ...(joined === '' ? {} : { reason: joined }),
        ...(cause === undefined ? {} : { cause }),
      };
    }

    // Шаг отработал успешно, а данные оставил недопустимые: причина отказа —
    // сама запись мимо объявления. Причины остановки прогона (`cause`) здесь
    // нет — перечень закрыт, и ни одна его строка про это не говорит; так же
    // возвращается отказ по неперенесённому выходу шага ниже.
    if (dataViolation !== undefined) return { status: 'failed', reason: dataViolation };
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

export interface StepOutcome {
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
  /**
   * Решение, применённое к ожиданию этого шага (design.md изменения
   * `user-decision-steps`, решение 5) — есть только у шага ожидающего вида,
   * дождавшегося ответа.
   */
  readonly decision?: DecisionRecord;
}

/**
 * Комбинированный сигнал шага: аборт по отмене прогона *или* по превышению
 * бюджета с `on_exceed: wait` по `rate_limit`. Разделены, чтобы после
 * исполнения отличить настоящую отмену от прерывания ради ожидания — только
 * второе ведёт в переисполнение шага, а не в статус `canceled`.
 */
function stepAbort(
  context: RunContext,
  resources: ResourceScope,
): {
  readonly controller: AbortController;
  readonly trigger: (found: Exceeded | undefined) => void;
  waitTrigger: Exceeded | undefined;
} {
  const controller = new AbortController();
  const onRunAbort = (): void => controller.abort();
  context.signal?.addEventListener('abort', onRunAbort, { once: true });
  // Слушатель снимается вместе с областью попытки, а не вручную после
  // исполнения: попытка, прерванная исключением, оставляла бы его висеть на
  // сигнале прогона до конца прогона — по слушателю на попытку.
  resources.defer('снятие слушателя отмены шага', () => {
    context.signal?.removeEventListener('abort', onRunAbort);
  });

  const state = {
    controller,
    waitTrigger: undefined as Exceeded | undefined,
    trigger(found: Exceeded | undefined) {
      if (found === undefined || controller.signal.aborted) return;
      if (found.onExceed === 'wait' && found.dimension === 'rate_limit') state.waitTrigger = found;
      controller.abort();
    },
  };
  return state;
}

/**
 * Отдаёт `budget_exceeded` попытке, которую применение потолка оборвало на
 * середине, — и только ей. Попытка, дошедшая до собственного конца, могла
 * тоже перевести потолок последней записью расхода: `abort.trigger` дошёл до
 * неё и вызвал `controller.abort()`, но слушать сигнал уже некому, и
 * `naturalStatus` при этом остаётся её настоящим исходом, не `canceled`.
 * Различие — ровно в `naturalStatus`: интерполяция чужого исхода делает его
 * `canceled` лишь тогда, когда абort действительно прервал исполнение.
 * Настоящая отмена прогона (`context.signal`) важнее и здесь не подменяется.
 */
function budgetInterrupted(
  exceeded: Exceeded | undefined,
  naturalStatus: StatusValue,
  context: RunContext,
): exceeded is Exceeded {
  return exceeded !== undefined && naturalStatus === 'canceled' && context.signal?.aborted !== true;
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

/**
 * Шаг с неразрешённым скриптом (design.md, решение 1): линт называет причину
 * заранее, а прогон, дошедший до такого шага, отказывает ему тем же текстом —
 * без попытки запуска, которую нечем было бы исполнить. Ровно одна запись
 * попытки, терминальная, тем же приёмом, что и отказ бэкенда.
 */
function unresolvedScriptOutcome(step: Extract<Step, { kind: 'script' }>): StepOutcome {
  const reason = describeScriptUnresolved(step.unresolved as ScriptUnresolved, step.uses);
  const startedAt = new Date().toISOString();
  const record: StepRecord['attempts'][number] = {
    attempt: 1,
    status: 'failed',
    reason,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    exit_code: null,
  };
  return {
    status: 'failed',
    reason,
    attempts: [record],
    results: [[{ predicate: 'spawn_failed', passed: false, hard: true, detail: reason }]],
    cause: HaltCause.spawnFailed,
  };
}

/**
 * Шаг `uses`, чьи параметры несли отложенную подстановку и потому не прошли
 * проверку схемой ни при разборе, ни при линте (design.md решение 7):
 * значение стало известно только сейчас, после позднего раскрытия. Отказ —
 * тем же приёмом, что `unresolvedScriptOutcome`: одна терминальная попытка,
 * без запуска процесса, попыток не расходует — повторный запуск не исправит
 * значение, пришедшее выходом работы выше по графу.
 */
function unresolvedUsesParamsOutcome(reason: ScriptUnresolved): StepOutcome {
  const message = describeScriptUnresolved(reason);
  const startedAt = new Date().toISOString();
  const record: StepRecord['attempts'][number] = {
    attempt: 1,
    status: 'failed',
    reason: message,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    exit_code: null,
  };
  return {
    status: 'failed',
    reason: message,
    attempts: [record],
    results: [[{ predicate: 'params_schema', passed: false, hard: true, detail: message }]],
    cause: HaltCause.spawnFailed,
  };
}

/**
 * Прочитать и проверить файл выхода шага `script` (design.md, решение 6).
 * Движок проверяет схемой сам — одинаково для любого языка, — а не
 * перекладывает это на обёртку раннера, у которой есть только Node.
 *
 * Отсутствие файла без объявленной схемы — не отказ: канал у `script` есть
 * всегда, но обещания результата без `output_schema` не было.
 */
function readScriptOutput(
  outputPath: string,
  outputSchemaPath: string | undefined,
  stepId: string,
): { readonly kind: 'value'; readonly value: unknown } | { readonly kind: 'none' } | { readonly kind: 'failure'; readonly result: PredicateResult } {
  if (!existsSync(outputPath)) {
    if (outputSchemaPath === undefined) return { kind: 'none' };
    return {
      kind: 'failure',
      result: {
        predicate: 'output_schema',
        passed: false,
        hard: true,
        detail: `шаг ${stepId} объявляет output_schema, но файл выхода не записан`,
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(outputPath, 'utf8'));
  } catch (error) {
    return {
      kind: 'failure',
      result: {
        predicate: 'output_schema',
        passed: false,
        hard: true,
        detail: `шаг ${stepId} записал файл выхода, не разбираемый как JSON: ${(error as Error).message}`,
      },
    };
  }

  if (outputSchemaPath === undefined) return { kind: 'value', value: parsed };

  const validated = validateAgainstSchemaFile(outputSchemaPath, parsed);
  if (!validated.passed) {
    return {
      kind: 'failure',
      result: {
        predicate: 'output_schema',
        passed: false,
        hard: true,
        detail: `шаг ${stepId} записал выход не по output_schema:\n${validated.detail ?? ''}`,
      },
    };
  }

  return { kind: 'value', value: parsed };
}

/**
 * Найти вклад шага плагинного вида и передать исполнение `runPluginStep`
 * (`exec/pluginStep.ts`). Вид, снятый вместе с плагином (или которого действующий
 * реестр никогда не знал), — отказ, называющий вид, перечень доступных и, пока
 * живо ядро, помнящее прежнего владельца, — плагин, вместе с которым вид снят
 * (design.md, решение 8).
 */
async function runPluginStepDispatch(
  step: Extract<Step, { kind: 'plugin' }>,
  job: Job,
  context: RunContext,
  stepDirPath: string,
  budgetScopes: () => BudgetScope[],
  changedPaths: () => readonly string[] | undefined,
  iteration?: number,
): Promise<StepOutcome> {
  const contribution = context.registry.steps.get(step.name);
  if (contribution === undefined || !hasStepExecutor(contribution)) {
    const former = formerStepKindOwner(context.registry, step.name);
    const reason =
      former === undefined
        ? `Вид шага ${step.name} неизвестен реестру. Доступны: ${stepKindNames(context.registry).join(', ')}`
        : `Вид шага ${step.name} снят вместе с плагином ${former}`;
    const now = new Date().toISOString();
    return {
      status: 'failed',
      reason,
      attempts: [{ attempt: 1, status: 'failed', reason, started_at: now, finished_at: now }],
      results: [[{ predicate: 'step_kind', passed: false, hard: true, detail: reason }]],
    };
  }
  return runPluginStep(step, job, context, stepDirPath, contribution, budgetScopes, changedPaths, iteration);
}

async function runCommandStep(
  step: Extract<Step, { kind: 'run' | 'script' }>,
  job: Job,
  context: RunContext,
  stepDirPath: string,
  _sessions: ReturnType<typeof createSessionRegistry>,
  budgetScopes: () => BudgetScope[],
  changedPaths: () => readonly string[] | undefined,
): Promise<StepOutcome> {
  if (step.kind === 'script' && step.resolved === undefined) {
    return unresolvedScriptOutcome(step);
  }

  // Параметры шага `uses`, не проверенные схемой статически — значение несло
  // отложенную подстановку, и ни разбор, ни линт не могли знать его заранее
  // (design.md, решение 7). Проверяется здесь, один раз, по окончательным
  // значениям — после позднего раскрытия, до записи `input.json`.
  if (step.kind === 'script' && step.uses?.paramsSchema !== undefined) {
    const validated = validateAgainstSchema(step.uses.paramsSchema, step.input ?? {});
    if (!validated.passed) {
      return unresolvedUsesParamsOutcome({
        reason: 'params_invalid',
        name: step.uses.name,
        manifestPath: step.uses.manifestPath ?? '',
        detail: validated.detail ?? 'значение не проходит схему',
      });
    }
  }

  const { journal, config } = context;
  // Разобранный выход командного шага. Заполняется только когда объявлен
  // output_schema — без него у командного шага структурированного выхода
  // нет, и поле остаётся неопределённым до конца функции.
  let structuredOutput: unknown;

  // Файл входа шага `script` пишется движком один раз, до первой попытки
  // (design.md, решение 3): объявленный `input` — раскрытым значением,
  // необъявленный — пустым отображением, чтобы читателю не нужна была ветка
  // «а если файла нет».
  const outputPath = join(stepDirPath, 'output.json');
  if (step.kind === 'script') {
    journal.writeStepJson(stepDirPath, 'input.json', step.input ?? {});
  }

  for (;;) {
    let exceeded: ReturnType<UsageAccumulator['check']>;
    let judgeCallCount = 0;
    const nextCallIndex = (): number => {
      judgeCallCount += 1;
      return judgeCallCount;
    };
    // Отдельная сквозная нумерация от судей: `script-<n>` и `judge-<n>` —
    // разные ряды подкаталогов одного шага (`docs/run-layout.md`).
    let scriptCallCount = 0;
    const nextScriptCallIndex = (): number => {
      scriptCallCount += 1;
      return scriptCallCount;
    };
    const onStall = (silentMs: number): void =>
      journal.event({ kind: 'step.stalled', job: job.id, step: step.id, silent_ms: silentMs });

    // Область попытки: слушатели, взятые на время исполнения шага, снимаются
    // одним `finally` при любом его исходе — успехе, отказе, отмене и
    // исключении посреди исполнения.
    const attemptResources = createScope({ journal, job: job.id, step: step.id });
    const abort = stepAbort(context, attemptResources);

    let result: Awaited<ReturnType<typeof executeRunStep>>;
    try {
      result = await executeRunStep({
        step,
        cwd: context.cwd,
        stepDir: stepDirPath,
        stallTimeoutMs: config.defaults.stallTimeoutMs,
        signal: abort.controller.signal,
        env: (plan) => stepEnv(step, job, plan.attempt, context, stepDirPath),
        // Выход прошлой попытки не должен дожить до следующей и выдаться за
        // её результат (design.md, решение 5) — файл снимается перед спавном,
        // а не после чтения: неуспешная попытка, упавшая до записи, не должна
        // унаследовать чужой файл, оставшийся на диске.
        onAttemptStart: () => {
          if (step.kind === 'script') rmSync(outputPath, { force: true });
        },
        evaluate: async (target, process_, plan) => {
          // Попытка начинается без выхода: значение, прочитанное прошлой, не
          // должно дожить до нынешней и выдаться за её результат (design.md,
          // решение 5). Снятия файла для этого мало — попытка, не записавшая
          // его вовсе, иначе унаследовала бы уже прочитанное значение.
          structuredOutput = undefined;

          // Разбор строгий: только пробелы по краям снимаются, без поиска
          // первого объекта и без склейки последней строки — вывод либо один
          // JSON-документ целиком, либо отказ попытки.
          let structured: unknown;
          if (target.kind === 'run' && target.outputSchemaPath !== undefined) {
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

          // Промах контракта не отменяет объявленных шагом предикатов, а
          // дописывается к ним последним: у скрипта, упавшего ненулевым кодом
          // и потому не записавшего файл, причиной попытки должен остаться
          // непройденный `exit_code` — настоящая причина, а не её следствие
          // (`firstFailureReason` берёт первый жёсткий промах по порядку).
          let contractFailure: PredicateResult | undefined;
          if (target.kind === 'script') {
            const contract = readScriptOutput(outputPath, target.outputSchemaPath, target.id);
            if (contract.kind === 'failure') contractFailure = contract.result;
            if (contract.kind === 'value') {
              structured = contract.value;
              structuredOutput = structured;
            }
          }

          const firstPass = await evaluatePredicates(
            target.expect,
            {
              exitCode: process_.exitCode,
              text: process_.stdout,
              structured,
              cwd: context.cwd,
              env: stepEnv(step, job, 1, context, stepDirPath),
              changedPaths: changedPaths(),
              knowledge: context.knowledgeSource,
              script: {
                stepDir: stepDirPath,
                attempt: plan.attempt,
                journal,
                nextCallIndex: nextScriptCallIndex,
                timeoutMs: target.timeoutMs,
                stallTimeoutMs: config.defaults.stallTimeoutMs,
                signal: abort.controller.signal,
              },
            },
            context.registry,
          );

          // Судьи по промаху контракта не зовутся: структурированного выхода,
          // о котором их спрашивают, у попытки нет, а отказ её уже решён —
          // платить за вызов модели незачем.
          if (contractFailure !== undefined) return [...firstPass, contractFailure];

          if (!target.expect.some((predicate) => predicate.kind === 'judge')) return firstPass;

          // Командный шаг сам расхода не несёт: расход попытки — это расход
          // судей, накапливаемый по мере их вызовов, а не заменяемый последним.
          let attemptUsage: Usage | undefined;
          const judgeResults = await runJudgePass({
            predicates: target.expect,
            firstPass,
            task: describeStepTask(target, context.registry),
            text: process_.stdout,
            structured: structured ?? process_.stdout,
            cwd: context.cwd,
            stepDir: stepDirPath,
            attempt: plan.attempt,
            timeoutMs: target.timeoutMs,
            stallTimeoutMs: config.defaults.stallTimeoutMs,
            signal: abort.controller.signal,
            onStall,
            env: stepEnv(step, job, plan.attempt, context, stepDirPath),
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
    } finally {
      await attemptResources.dispose();
    }

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
        return {
          status: 'budget_exceeded',
          reason: describeExceeded(waited.exceeded),
          attempts: result.attempts,
          results: result.results,
          exceeded: waited.exceeded,
        };
      }
      return { status: 'canceled', attempts: result.attempts, results: result.results };
    }

    // Копия в `const`: `exceeded` выше — `let`, переписываемый вложенными
    // колбэками попытки, и сужение типа по нему после вызова функции-охранника
    // не удержалось бы.
    const found = exceeded;
    const interrupted = budgetInterrupted(found, result.status, context);
    const reason = interrupted ? describeExceeded(found) : result.reason;
    return {
      status: interrupted ? 'budget_exceeded' : result.status,
      ...(reason === undefined ? {} : { reason }),
      attempts: result.attempts,
      results: result.results,
      ...(structuredOutput === undefined ? {} : { structured: structuredOutput }),
      ...(found === undefined ? {} : { exceeded: found }),
    };
  }
}

async function runAgentStep(
  step: AgentStep,
  job: Job,
  context: RunContext,
  stepDirPath: string,
  sessions: ReturnType<typeof createSessionRegistry>,
  /** Псевдоним шага в пространстве имён агента и его работы (см. `sessionKey`). */
  sessionKey: (agent: string, alias: string) => string,
  jobContextSent: Set<string>,
  budgetScopes: () => BudgetScope[],
  changedPaths: () => readonly string[] | undefined,
): Promise<StepOutcome> {
  const { journal, config } = context;
  const { pipeline } = context.expanded;
  const adapter = adapterOf(step.agent, context);

  /**
   * Запись о прерывании достаётся ровно одному сообщению — первому, которое
   * этот прогон отправляет в продолжаемый диалог. Дальше она была бы либо
   * повтором прочитанного в том же диалоге (вторая и третья попытки обычного
   * продолжения), либо прямой неправдой: попытка после неудавшегося
   * продолжения (`onFailedContinuation`) начинает разговор с чистого листа, и
   * «диалог этого шага продолжается» о ней не сказать.
   */
  let interruptedNotePending = planFor(context, job.id, step.id)?.decision.kind === 'continue';

  for (;;) {
  let exceeded: ReturnType<UsageAccumulator['check']>;
  let judgeCallCount = 0;
  const nextCallIndex = (): number => {
    judgeCallCount += 1;
    return judgeCallCount;
  };
  // Отдельная сквозная нумерация от судей: `script-<n>` и `judge-<n>` —
  // разные ряды подкаталогов одного шага (`docs/run-layout.md`).
  let scriptCallCount = 0;
  const nextScriptCallIndex = (): number => {
    scriptCallCount += 1;
    return scriptCallCount;
  };
  const onStall = (silentMs: number): void =>
    journal.event({ kind: 'step.stalled', job: job.id, step: step.id, silent_ms: silentMs });

  // Область попытки: слушатели, взятые на время исполнения шага, снимаются
  // одним `finally` при любом его исходе — успехе, отказе, отмене и
  // исключении посреди исполнения.
  const attemptResources = createScope({ journal, job: job.id, step: step.id });
  const abort = stepAbort(context, attemptResources);

  // Промпт собирается заново на каждой попытке шага, а выдержка на всех
  // попытках одна и та же: событие об её усечении пишется однажды, иначе
  // разбор по журналу насчитает усечений больше, чем их было.
  let noteTruncationReported = false;

  let result: Awaited<ReturnType<typeof executeAgentStep>>;
  try {
    result = await executeAgentStep({
      step,
      adapter,
      cwd: context.cwd,
      stepDir: stepDirPath,
      scratchDir: jobScratchDir(journal.paths, job.id),
      sessions,
      sessionAlias: sessionKey(step.agent, step.session),
      backendSlots: context.backendSlots,
      stallTimeoutMs: config.defaults.stallTimeoutMs,
      signal: abort.controller.signal,
      env: (plan) => stepEnv(step, job, plan.attempt, context, stepDirPath),
      buildPrompt: (_plan, previousFailure) => {
        // Унаследованный контекст уходит в первое сообщение сессии: повторять
        // агенту то, что он уже прочитал в этой же сессии, незачем.
        const key = sessionKey(step.agent, step.session);
        // Контекст пайплайна — один раз на диалог; контекст работы и выходы
        // предшественников — один раз на работу внутри диалога. У работы без
        // объявленной группы оба совпадают, и поведение прежнее.
        const first = !context.pipelineContextSent.has(key);
        const firstInJob = !jobContextSent.has(key);
        context.pipelineContextSent.add(key);
        jobContextSent.add(key);

        const interrupted = interruptedNotePending;
        interruptedNotePending = false;

        const stepEntries = withIterationNote(
          context,
          job.id,
          step.id,
          step.context,
          context.iterationCheck,
          interrupted,
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
          job: firstInJob ? job.context : [],
          step: stepEntries.entries,
          upstream: firstInJob ? upstreamOutputs(context.graph, job.id, context.outputs) : [],
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
          ...(context.knowledgeSource === undefined
            ? {}
            : {
                knowledge: (selector, budget) =>
                  (context.knowledgeSource as KnowledgeSource).select(
                    budget === undefined || selector.kind === 'index'
                      ? selector
                      : { ...selector, budget },
                  ),
              }),
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
          // Ключ, а не псевдоним шага: в группе один псевдоним встречается в
          // нескольких работах, и отчёт обязан называть тот диалог, в который
          // контекст на самом деле ушёл.
          session: key,
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

        const firstPass = await evaluatePredicates(
          target.expect,
          {
            exitCode: outcome.process.exitCode,
            text: outcome.text ?? '',
            structured: outcome.structured,
            cwd: context.cwd,
            env: stepEnv(step, job, 1, context, stepDirPath),
            changedPaths: changedPaths(),
            knowledge: context.knowledgeSource,
            script: {
              stepDir: stepDirPath,
              attempt: plan.attempt,
              journal,
              nextCallIndex: nextScriptCallIndex,
              timeoutMs: target.timeoutMs,
              stallTimeoutMs: config.defaults.stallTimeoutMs,
              signal: abort.controller.signal,
            },
          },
          context.registry,
        );

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
          env: stepEnv(step, job, plan.attempt, context, stepDirPath),
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
      onMcpServerUnavailable: (plan, server) => {
        journal.event({
          kind: 'mcp_server.unavailable',
          job: job.id,
          step: step.id,
          attempt: plan.attempt,
          server,
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
        // Отменённый прогон не заводит новых попыток: `AbortController` в
        // `stepAbort` реагирует на сигнал отмены один раз, и попытка,
        // начатая после первой отмены, его больше не увидит — процесс
        // отработал бы до конца непрерванным, будто отмены не было вовсе.
        // На этом же держится продолжение оборванной сессии: последняя
        // запись попытки обязана быть `canceled`, иначе отмену не отличить
        // от попытки, ответившей самой (`resolveContinuation`).
        if (context.signal?.aborted === true) return false;
        const found = exceeded ?? context.usage.check(budgetScopes());
        exceeded ??= found;
        abort.trigger(found);
        return exceeded === undefined;
      },
      // Продолжение не открылось у бэкенда: отказ стоит одну попытку, а не
      // шаг (design.md, решение 6). Следующая попытка того же шага обязана
      // начать разговор заново — с новой сессией и полным контекстом, ровно
      // как первая попытка любого другого переисполняемого шага.
      onFailedContinuation: () => {
        const key = sessionKey(step.agent, step.session);
        sessions.unseed(key);
        context.pipelineContextSent.delete(key);
        jobContextSent.delete(key);
      },
    });
  } finally {
    await attemptResources.dispose();
  }

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

  // Сессия попадает в исход шага, только если она была: у бэкенда, который
  // заводит нить сам, отменённый или упавший до первой записи шаг остаётся
  // вовсе без идентификатора, и записать за него пустую строку значило бы
  // обещать следующему прогону продолжение несуществующего диалога
  // (`docs/run-layout.md`, «Оборванный шаг продолжает свою сессию»).
  const sessionField = result.sessionId === undefined ? {} : { session: result.sessionId };

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
      { attempts: result.attempts, results: result.results, ...sessionField },
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
        ...sessionField,
      };
    }
    context.usage.sealStep(job.id, step.id);
    const waited = await waitForReset(abort.waitTrigger, context, { job: job.id, step: step.id });
    if (waited.kind === 'resumed') continue;
    if (waited.kind === 'stopped') {
      return {
        status: 'budget_exceeded',
        reason: describeExceeded(waited.exceeded),
        attempts: result.attempts,
        results: result.results,
        ...sessionField,
        exceeded: waited.exceeded,
      };
    }
    return {
      status: 'canceled',
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      attempts: result.attempts,
      results: result.results,
      ...sessionField,
    };
  }

  // Копия в `const`: `exceeded` выше — `let`, переписываемый вложенными
  // колбэками попытки, и сужение типа по нему после вызова функции-охранника
  // не удержалось бы.
  const found = exceeded;
  const interrupted = budgetInterrupted(found, result.status, context);
  const reason = interrupted ? describeExceeded(found) : result.reason;
  return {
    status: interrupted ? 'budget_exceeded' : result.status,
    ...(reason === undefined ? {} : { reason }),
    attempts: result.attempts,
    results: result.results,
    ...(result.last?.structured === undefined ? {} : { structured: result.last.structured }),
    ...sessionField,
    ...(result.last?.observedInputs === undefined
      ? {}
      : { observedInputs: result.last.observedInputs }),
    ...(result.last?.backendInit === undefined ? {} : { backendInit: result.last.backendInit }),
    ...(found === undefined ? {} : { exceeded: found }),
  };
  }
}

/** Задание шага без блока контекста — вход судьи на командном или плагинном шаге. */
export function describeStepTask(step: Step, registry: Registry): string {
  if (step.kind === 'agent') return step.prompt;
  if (step.kind === 'script') return (step.resolved?.argv ?? [step.path, ...step.args]).join(' ');
  if (step.kind === 'plugin') {
    const contribution = registry.steps.get(step.name);
    const title = contribution !== undefined && hasStepExecutor(contribution) ? contribution.title : step.name;
    return `${title}: ${JSON.stringify(step.fields)}`;
  }
  return typeof step.command === 'string' ? step.command : step.command.join(' ');
}

function failureBlock(previousFailure: string | undefined): string {
  if (previousFailure === undefined) return '';
  return `## Прошлая попытка не прошла проверку\n\n${previousFailure}\n\nПочини причину, а не симптом.`;
}

export function stepEnv(
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
      binPath: context.engine.entry,
      jobId: job.id,
      jobDir: context.journal.prepareJob(job.id),
      stepId: step.id,
      stepDir: stepDirPath,
      attempt,
      workspace: context.cwd,
      artifacts: context.journal.paths.artifacts,
      scratch: jobScratchDir(context.journal.paths, job.id),
      ...(step.kind === 'script'
        ? {
            contractInputPath: join(stepDirPath, 'input.json'),
            contractOutputPath: join(stepDirPath, 'output.json'),
          }
        : {}),
    }),
    deny: pipeline.envDeny,
    cwd: context.projectRoot,
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
 * Запись оборванной попытки — только последняя, та самая, что дала шагу
 * статус `canceled`: более ранние попытки того же шага уже расходовали
 * бюджет исходного прогона и к продолжению отношения не имеют.
 */
function carriedAttempts(record: StepRecord, sourceRunId: string): readonly StepRecord['attempts'][number][] {
  const last = record.attempts.at(-1);
  return last === undefined ? [] : [{ ...last, carried_from: sourceRunId }];
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
 *
 * В запись попадают только ключи, объявленные определением работы, — тем
 * определением, которым движок её исполняет, а не файлом `resolved.json` на
 * диске: иначе шаг, которому доступна файловая система работы, расширял бы
 * себе объявление правкой этого файла. Необъявленный ключ — это `data.json`,
 * написанный в обход команды (`stepcast data` сама такого не допустит), и
 * возвращённая причина роняет работу без повторных попыток: файл остался на
 * месте, повтор упёрся бы в то же самое. Объявленные соседи необъявленного
 * ключа в запись всё равно попадают — они и правда опубликованы.
 */
function foldJobData(context: RunContext, job: Job): string | undefined {
  const record = context.records.get(job.id);
  if (record === undefined) return undefined;

  const raw = readJobData(jobDir(context.journal.paths, job.id));
  const declared = new Set(job.data);
  const data: Record<string, string> = {};
  let rejected: string | undefined;
  for (const [key, value] of Object.entries(raw)) {
    if (declared.has(key)) data[key] = value;
    else rejected ??= key;
  }

  context.records.set(job.id, {
    ...record,
    ...(Object.keys(data).length === 0 ? {} : { data }),
  });
  context.refreshStatus();

  if (rejected === undefined) return undefined;
  return (
    `работа ${job.id} не объявляла ключ данных «${rejected}»: ` +
    (job.data.length === 0 ? 'объявленный состав пуст' : `объявлены ${job.data.join(', ')}`)
  );
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
 *
 * Перенесённое подчиняется объявлению нового определения работы, а не
 * старого: определение могло поменяться между прогонами, и объявление нового
 * прогона — единственное, которым он сам исполняется.
 */
function transferJobData(context: RunContext, job: Job): void {
  const source = context.resume?.source;
  if (source === undefined) return;
  if (!context.resume?.plan.steps.some((step) => step.job === job.id && step.decision.kind === 'reuse')) {
    return;
  }

  const target = jobDir(context.journal.paths, job.id);
  if (existsSync(jobDataPath(target))) return;

  const carried = readJobData(jobDir(source.paths, job.id));
  const declared = new Set(job.data);
  const allowed = Object.fromEntries(Object.entries(carried).filter(([key]) => declared.has(key)));
  if (Object.keys(allowed).length === 0) return;

  // Обход объявления здесь законен и уже отработан: `allowed` отобран по
  // `job.data` строкой выше, то есть тем же объявлением, которым сверяется
  // всякая запись.
  bookkeep({ journal: context.journal, job: job.id }, 'перенос данных работы', () => {
    writeJobDataUnchecked(target, allowed);
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
    [
      paths.manifest,
      paths.lock,
      paths.status,
      paths.events,
      paths.usage,
      paths.artifacts,
      paths.jobs,
      paths.workspace,
      paths.anchors,
      // Снимок движка принадлежит прогону, который его снял: этот прогон снял
      // собственный до первой работы (`run/engine.ts`), и чужой, скопированный
      // поверх, вернул бы исполнение к коду другого прогона — при том что
      // манифест называет путь своего снимка (run-engine-snapshot).
      paths.engine,
      // Записи решений адресованы ожиданиям исходного прогона и этому прогону
      // не годятся: неприменённое решение переносится отдельно и осознанно —
      // `carryOverDecisions` ниже.
      paths.decisions,
    ].map((path) => basename(path)),
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
 * Перенести решения, записанные исходному прогону и не применённые им (дельта
 * `run-resume`): человек ответил прогону, чей процесс уже не жил, и команда
 * сказала ему, что решение применится при возобновлении. Переисполняемый шаг
 * получит его первым же тактом своего ожидания, вместо второго вопроса тому же
 * человеку.
 *
 * Событие переноса пишется по каждому решению: оно и след для читателя
 * журнала, и источник, из которого перенос читается ещё раз, если и этот
 * прогон не успеет применить решение.
 */
function carryOverDecisions(
  resume: ResumeContext,
  journal: RunJournal,
  into: Map<string, CarriedDecision>,
): void {
  let pending: readonly CarriedDecision[];
  try {
    pending = collectPendingDecisions(resume.source.paths, resume.source.manifest.run_id);
  } catch (error) {
    // Не отказ, как и у переноса каталога: без переноса прогон спросит
    // человека заново — хуже, но не неверно.
    journal.event({
      kind: 'bookkeeping.failed',
      operation: 'перенос неприменённых решений',
      detail: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  for (const entry of pending) {
    into.set(carriedKey(entry.job, entry.step), entry);
    journal.event({
      kind: 'decision.carried',
      wait_id: entry.waitId,
      job: entry.job,
      step: entry.step,
      source: entry.source,
      outcome: entry.record.outcome,
      ...(entry.record.reason === undefined ? {} : { reason: entry.record.reason }),
      ...(entry.record.restart_from === undefined ? {} : { restart_from: entry.record.restart_from }),
    });
  }
}

/**
 * Привести каталог запуска к состоянию, на котором остановилось
 * переиспользование.
 *
 * Только каталог запуска и только пути работ, которые в нём и работали:
 * результат работы изолированного режима лежит в её собственном дереве и
 * туда же возвращается — своей записью плана (`restoreWorkspace`,
 * `restoreJobWorkspace`). Наложить его на главное дерево проекта значило бы
 * испортить репозиторий пользователя возобновлением, которое ничего такого не
 * обещает.
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
  nestedRepos: readonly string[] | undefined,
): void {
  const restore = resume.plan.restore;
  if (restore === undefined) return;
  restoreTree({
    journal,
    dir: cwd,
    scope: 'resume',
    anchorKind,
    ...(nestedRepos === undefined ? {} : { nestedRepos }),
    anchor: restore.anchor,
    paths: restore.paths,
  });
}

/**
 * Привести рабочий каталог работы изолированного режима к состоянию, на
 * котором остановилось переиспользование её шагов.
 *
 * Возобновление заводит новое дерево (`worktree` — от HEAD проекта, `copy` —
 * копией каталога запуска), а переиспользованный шаг в нём не исполняется и
 * ничего не пишет: без этого восстановления переисполняемый шаг и предикаты
 * `until` работы увидели бы дерево без единой правки предшественников —
 * проверка гоняла бы код, которого там нет.
 *
 * Перенятый каталог (продолжение оборванной сессии) не трогается: он и есть
 * то состояние, которое диалог оставил (design.md, решение 4).
 */
function restoreJobWorkspace(context: RunContext, job: Job, prepared: PreparedWorkspace): void {
  if (prepared.mode === 'cwd' || prepared.adoptedFrom !== undefined) return;
  const restore = context.resume?.plan.restoreWorkspace.find((item) => item.job === job.id);
  if (restore === undefined) return;

  restoreTree({
    journal: context.journal,
    dir: prepared.dir,
    // Своя область на работу: индексный файл якоря у параллельных дорожек
    // общим быть не может.
    scope: `resume:${job.id}`,
    anchorKind: context.anchorKind,
    repoDir: context.cwd,
    ...(context.config.project.nestedRepos === undefined
      ? {}
      : { nestedRepos: context.config.project.nestedRepos }),
    anchor: restore.anchor,
    paths: restore.paths,
  });
}

/** Общая механика обоих восстановлений: якорь, пути, каталог — и мягкий отказ. */
function restoreTree(options: {
  readonly journal: RunJournal;
  readonly dir: string;
  readonly scope: string;
  readonly anchorKind: AnchorKind;
  readonly repoDir?: string;
  readonly nestedRepos?: readonly string[];
  readonly anchor: Anchor;
  readonly paths: readonly string[];
}): void {
  const { journal, dir, anchor, paths } = options;
  const anchorer = createAnchorer({
    dir,
    stateDir: journal.paths.anchors,
    kind: options.anchorKind,
    scope: options.scope,
    ...(options.repoDir === undefined ? {} : { repoDir: options.repoDir }),
    ...(options.nestedRepos === undefined ? {} : { nested: options.nestedRepos }),
  });

  try {
    anchorer.restorePaths(anchor, paths);
    journal.event({ kind: 'tree.restored', anchor: anchor.id, path: dir });
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
  stepId: string,
  own: readonly ContextEntry[],
  previousCheck: readonly PredicateResult[] | undefined,
  /** Это сообщение — первое, которое прогон отправляет в продолжаемый диалог. */
  interrupted: boolean,
  onTruncated: (truncation: IterationNoteTruncation) => void,
): { entries: readonly ContextEntry[]; hasNote: boolean } {
  const entries = takeFailureNote(context, jobId, stepId, own, interrupted);
  if (previousCheck === undefined) return { entries, hasNote: false };

  const failed = previousCheck.filter((item) => !item.passed && item.hard);
  if (failed.length === 0) return { entries, hasNote: false };

  const { text, truncation } = buildIterationNote(failed, context.config.context.noteMaxTokens);
  if (truncation !== undefined) onTruncated(truncation);

  return { entries: [{ kind: 'text', text }, ...entries], hasNote: true };
}

/**
 * Текст выдержки о прошлом отказе, если прошлый прогон её заслуживает.
 *
 * Работа, чей шаг продолжает оборванную сессию, исключается: её «отказ» —
 * отмена, а не непройденная проверка, и ей достанется запись о прерывании,
 * а не эта выдержка (`takeFailureNote`).
 */
function previousFailureText(resume: ResumeContext): string | undefined {
  const continuingJobs = new Set(
    resume.plan.steps.filter((item) => item.decision.kind === 'continue').map((item) => item.job),
  );
  return buildPreviousFailure(resume.source.paths, resume.source.status, continuingJobs)?.text;
}

/**
 * Подложить выдержку о прошлом отказе первому агентскому шагу работы, с
 * которой возобновление начато, либо запись о прерывании — продолжаемому
 * шагу. Запись входит в состав контекста наравне с остальными и потому
 * учитывается в пределе размера.
 *
 * Шаг, продолжающий сессию, выдержки об отказе не получает вовсе: его не
 * забраковали, а `plan.failureNoteJob` его работу своим адресатом и не
 * выбирает (`resumePlan.ts`). Запись о прерывании при этом кладётся не всякой
 * его попытке, а только той, что действительно продолжает оборванный диалог:
 * решает это вызывающий (`runAgentStep`), потому что засев сессии может быть
 * снят посреди шага отказом продолжения.
 */
function takeFailureNote(
  context: RunContext,
  jobId: string,
  stepId: string,
  own: readonly ContextEntry[],
  interrupted: boolean,
): readonly ContextEntry[] {
  if (interrupted) return [{ kind: 'text', text: buildInterruptedNote() }, ...own];

  const note = context.failureNote.pending;
  if (note === undefined) return own;
  if (context.resume?.plan.failureNoteJob !== jobId) return own;

  context.failureNote.pending = undefined;
  return [{ kind: 'text', text: note }, ...own];
}

export { isStepcastError };
