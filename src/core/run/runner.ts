import { createHash } from 'node:crypto';

import { resolveAdapter } from '../backend/registry.js';
import type { BackendAdapter } from '../backend/types.js';
import { UsageAccumulator, describeExceeded, type BudgetScope } from '../budget/accumulator.js';
import type { Config } from '../config/resolve.js';
import { assembleContext, type UpstreamOutput } from '../context/assemble.js';
import { ExitCode, ScarpError, isScarpError, type ExitCodeValue } from '../errors.js';
import { createSessionRegistry, executeAgentStep } from '../exec/agentStep.js';
import { buildStepEnv, injectedVariables } from '../exec/env.js';
import { executeRunStep } from '../exec/runStep.js';
import { evaluatePredicates } from '../expect/evaluate.js';
import { buildGraph } from '../graph.js';
import { shortRunId } from '../journal/paths.js';
import { RunJournal } from '../journal/writer.js';
import { serializeLock } from '../pipeline/lock.js';
import type { AgentStep, ExpandedPipeline, Job, Step } from '../pipeline/model.js';
import type {
  JobRecord,
  PredicateResult,
  RunManifest,
  RunStatus,
  StatusValue,
  StepRecord,
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

  if (pipeline.workspace.mode !== 'cwd') {
    throw new ScarpError(`Режим рабочей директории ${pipeline.workspace.mode} ещё не реализован`, {
      file: pipeline.file,
      at: 'workspace.mode',
      hint: 'В текущем срезе доступен только cwd; worktree и copy добавятся отдельным изменением',
    });
  }

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

  const context: RunContext = {
    ...options,
    journal,
    records,
    usage,
    outputs,
    adapters,
    reportedDenials,
    lockHash,
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
              command: `scarp resume ${shortRunId(journal.paths.runId)} --from ${blocked.id}`,
              blocked_by: blocked.id,
            },
          }),
      updated_at: new Date().toISOString(),
    } satisfies RunStatus);
  };

  writeStatus('running');

  const result = await schedule({
    pipeline,
    graph,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    scopeExtras: { run: { id: journal.paths.runId, dir: journal.paths.dir }, env: {} },
    execute: async (job) => executeJob(job, context),
    onSettled: async (job, outcome) => {
      const record = records.get(job.id) as JobRecord;
      records.set(job.id, {
        ...record,
        status: outcome.status,
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
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

async function executeJob(job: Job, context: RunContext): Promise<JobOutcome> {
  const { journal } = context;

  journal.prepareJob(job.id);
  journal.event({ kind: 'job.started', job: job.id });
  context.records.set(job.id, {
    ...(context.records.get(job.id) as JobRecord),
    status: 'running',
    started_at: new Date().toISOString(),
  });

  const sessions = createSessionRegistry();
  const steps: StepRecord[] = [];
  let lastAgentStructured: unknown;
  let outputFromStep: unknown;

  for (const step of job.steps) {
    const stepDirPath = journal.prepareStep(job.id, step.index, step.id);
    journal.event({ kind: 'step.started', job: job.id, step: step.id, attempt: 1 });

    const budgetScopes = (): BudgetScope[] => [
      {
        kind: 'step',
        name: `${job.id}/${step.id}`,
        jobId: job.id,
        stepId: step.id,
        budget: step.budget,
      },
      { kind: 'job', name: `работа ${job.id}`, jobId: job.id, budget: job.budget },
      { kind: 'run', name: 'пайплайн', budget: context.expanded.pipeline.budget },
    ];

    let exceeded = context.usage.check(budgetScopes());

    const outcome =
      step.kind === 'run'
        ? await runCommandStep(step, job, context, stepDirPath, sessions, budgetScopes)
        : await runAgentStep(step, job, context, stepDirPath, sessions, budgetScopes);

    exceeded = outcome.exceeded ?? exceeded;

    for (const [index, results] of outcome.results.entries()) {
      journal.writeExpectReport(stepDirPath, { attempt: index + 1, results: [...results] });
    }

    const status: StatusValue = exceeded !== undefined ? 'budget_exceeded' : outcome.status;
    const reason = exceeded !== undefined ? describeExceeded(exceeded) : outcome.reason;

    const stepRecord: StepRecord = {
      id: step.id,
      index: step.index,
      kind: step.kind,
      key: stepKey(context, job, step),
      status,
      ...(reason === undefined ? {} : { reason }),
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
      return { status, ...(reason === undefined ? {} : { reason: `шаг ${step.id}: ${reason}` }) };
    }
  }

  const published = job.output === undefined ? undefined : (outputFromStep ?? lastAgentStructured);
  if (job.output !== undefined && published !== undefined) {
    const path = journal.writeArtifact(job.id, published);
    context.outputs.push({ job: job.id, path, value: published });
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

async function runCommandStep(
  step: Extract<Step, { kind: 'run' }>,
  job: Job,
  context: RunContext,
  stepDirPath: string,
  _sessions: ReturnType<typeof createSessionRegistry>,
  budgetScopes: () => BudgetScope[],
): Promise<StepOutcome> {
  const { journal, config } = context;

  const result = await executeRunStep({
    step,
    cwd: context.cwd,
    stepDir: stepDirPath,
    stallTimeoutMs: config.defaults.stallTimeoutMs,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    env: (plan) => stepEnv(step, job, plan.attempt, context, stepDirPath),
    evaluate: (target, process_) =>
      evaluatePredicates(target.expect, {
        exitCode: process_.exitCode,
        text: process_.stdout,
        structured: undefined,
        cwd: context.cwd,
        env: stepEnv(step, job, 1, context, stepDirPath),
      }),
    onStall: (silentMs) =>
      journal.event({ kind: 'step.stalled', job: job.id, step: step.id, silent_ms: silentMs }),
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

  return {
    status: result.status,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    attempts: result.attempts,
    results: result.results,
    ...(context.usage.check(budgetScopes()) === undefined
      ? {}
      : { exceeded: context.usage.check(budgetScopes()) }),
  };
}

async function runAgentStep(
  step: AgentStep,
  job: Job,
  context: RunContext,
  stepDirPath: string,
  sessions: ReturnType<typeof createSessionRegistry>,
  budgetScopes: () => BudgetScope[],
): Promise<StepOutcome> {
  const { journal, config } = context;
  const { pipeline } = context.expanded;
  const adapter = adapterOf(step.agent, context);

  // Унаследованный контекст уходит в первое сообщение сессии: повторять
  // агенту то, что он уже прочитал в этой же сессии, незачем.
  const sessionStarted = new Set<string>();
  let exceeded: ReturnType<UsageAccumulator['check']>;

  const result = await executeAgentStep({
    step,
    adapter,
    cwd: context.cwd,
    stepDir: stepDirPath,
    sessions,
    stallTimeoutMs: config.defaults.stallTimeoutMs,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    env: (plan) => stepEnv(step, job, plan.attempt, context, stepDirPath),
    buildPrompt: (_plan, previousFailure) => {
      const first = !sessionStarted.has(step.session);
      sessionStarted.add(step.session);

      const assembled = assembleContext({
        workspace: context.cwd,
        pipeline: first ? pipeline.context : [],
        job: first ? job.context : [],
        step: step.context,
        upstream: first ? context.outputs : [],
        contextUpstream: job.contextUpstream,
        inherit: step.contextInherit,
        exclude: step.contextExclude,
        deny: config.context.deny,
        inlineThreshold: config.context.inlineThreshold,
        maxTokens: step.contextMaxTokens ?? config.context.maxTokens,
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
    evaluate: (target, outcome) =>
      evaluatePredicates(target.expect, {
        exitCode: outcome.process.exitCode,
        text: outcome.text ?? '',
        structured: outcome.structured,
        cwd: context.cwd,
        env: stepEnv(step, job, 1, context, stepDirPath),
      }),
    onUsage: (current) => {
      context.usage.record(job.id, step.id, 1, current);
      exceeded ??= context.usage.check(budgetScopes(), current);
    },
    onUnparsed: (line) =>
      journal.event({ kind: 'backend.unparsed', job: job.id, step: step.id, line }),
    onStall: (silentMs) =>
      journal.event({ kind: 'step.stalled', job: job.id, step: step.id, silent_ms: silentMs }),
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
      exceeded ??= context.usage.check(budgetScopes());
      return exceeded === undefined;
    },
  });

  if (exceeded !== undefined) {
    journal.event({
      kind: 'budget.exceeded',
      scope: exceeded.scope,
      used: exceeded.used,
      limit: exceeded.limit,
    });
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
function stepKey(context: RunContext, job: Job, step: Step): string {
  return createHash('sha256')
    .update(JSON.stringify({ lock: context.lockHash, job: job.id, step }))
    .digest('hex')
    .slice(0, 16);
}

export { isScarpError };
