import { createHash } from 'node:crypto';

import type { Config } from '../config/resolve.js';
import { ExitCode, ScarpError, type ExitCodeValue } from '../errors.js';
import { buildStepEnv, injectedVariables } from '../exec/env.js';
import { executeRunStep } from '../exec/runStep.js';
import { buildGraph } from '../graph.js';
import { RunJournal } from '../journal/writer.js';
import { serializeLock } from '../pipeline/lock.js';
import type { ExpandedPipeline, Job, Step } from '../pipeline/model.js';
import type {
  JobRecord,
  RunManifest,
  RunStatus,
  StatusValue,
  StepRecord,
} from '../journal/schema.js';
import { shortRunId } from '../journal/paths.js';
import { schedule, type JobOutcome } from './scheduler.js';

export interface RunOptions {
  readonly expanded: ExpandedPipeline;
  readonly config: Config;
  readonly projectRoot: string;
  /** Каталог, в котором исполняются шаги. Для режима cwd — он же. */
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
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

  const records = new Map<string, JobRecord>(
    pipeline.jobs.map((job) => [job.id, { id: job.id, status: 'pending', steps: [] }]),
  );
  const graph = buildGraph(pipeline).graph;
  const reportedDenials = new Set<string>();
  const startedAt = Date.now();

  const writeStatus = (status: StatusValue): void => {
    const blocked = [...records.values()].find((record) => record.status === 'failed');
    const state: RunStatus = {
      run_id: journal.paths.runId,
      pipeline: pipeline.name,
      lock_hash: lockHash,
      status,
      workspace: pipeline.workspace,
      inputs: pipeline.inputs,
      jobs: [...records.values()],
      budget: {
        tokens_used: 0,
        ...(pipeline.budget?.tokens === undefined ? {} : { tokens_limit: pipeline.budget.tokens }),
        wallclock_ms: Date.now() - startedAt,
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
    };
    journal.writeStatus(state);
  };

  writeStatus('running');

  const result = await schedule({
    pipeline,
    graph,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    scopeExtras: { run: { id: journal.paths.runId, dir: journal.paths.dir }, env: {} },
    execute: async (job) =>
      executeJob(job, { ...options, journal, records, reportedDenials }),
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

interface JobContext extends RunOptions {
  readonly journal: RunJournal;
  readonly records: Map<string, JobRecord>;
  /**
   * Уже сообщённые исключения по запретам. Одна и та же переменная
   * вычёркивается на каждой попытке каждого шага, и без этого журнал
   * заполняется повторами одного факта.
   */
  readonly reportedDenials: Set<string>;
}

async function executeJob(job: Job, context: JobContext): Promise<JobOutcome> {
  const { journal, config } = context;
  const { pipeline } = context.expanded;

  journal.prepareJob(job.id);
  journal.event({ kind: 'job.started', job: job.id });

  const record = context.records.get(job.id) as JobRecord;
  context.records.set(job.id, { ...record, status: 'running', started_at: new Date().toISOString() });

  const steps: StepRecord[] = [];

  for (const step of job.steps) {
    if (step.kind === 'agent') {
      throw new ScarpError('Агентские шаги ещё не реализованы', {
        file: job.source,
        at: `jobs.${job.id}.steps.${step.index - 1}`,
        hint: 'В текущем срезе исполняются только шаги run; адаптер бэкенда добавится отдельной группой задач',
      });
    }

    const stepDirPath = journal.prepareStep(job.id, step.index, step.id);
    journal.event({ kind: 'step.started', job: job.id, step: step.id, attempt: 1 });

    const outcome = await executeRunStep({
      step,
      cwd: context.cwd,
      stepDir: stepDirPath,
      stallTimeoutMs: config.defaults.stallTimeoutMs,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      env: (plan) =>
        buildEnv(step, plan.attempt, {
          ...context,
          jobId: job.id,
          jobEnv: job.env,
          stepDirPath,
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

    for (const [index, results] of outcome.results.entries()) {
      journal.writeExpectReport(stepDirPath, { attempt: index + 1, results: [...results] });
    }

    const stepRecord: StepRecord = {
      id: step.id,
      index: step.index,
      kind: 'run',
      key: stepKey(pipeline.file, job.id, step),
      status: outcome.status,
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      attempts: [...outcome.attempts],
    };
    steps.push(stepRecord);
    journal.writeStepJson(stepDirPath, 'step.json', stepRecord);

    journal.event({
      kind: 'step.finished',
      job: job.id,
      step: step.id,
      attempt: outcome.attempts.length,
      status: outcome.status,
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    });

    context.records.set(job.id, { ...(context.records.get(job.id) as JobRecord), steps: [...steps] });

    if (outcome.status !== 'success') {
      return {
        status: outcome.status,
        ...(outcome.reason === undefined ? {} : { reason: `шаг ${step.id}: ${outcome.reason}` }),
      };
    }
  }

  return { status: 'success' };
}

interface EnvContext extends JobContext {
  readonly jobId: string;
  readonly jobEnv: Readonly<Record<string, string>>;
  readonly stepDirPath: string;
}

function buildEnv(step: Step, attempt: number, context: EnvContext): Record<string, string> {
  const { pipeline } = context.expanded;
  const { env, denied } = buildStepEnv({
    base: context.baseEnv ?? process.env,
    envFiles: pipeline.envFiles,
    pipeline: pipeline.env,
    job: context.jobEnv,
    step: step.env,
    injected: injectedVariables({
      runId: context.journal.paths.runId,
      runDir: context.journal.paths.dir,
      jobId: context.jobId,
      jobDir: context.journal.prepareJob(context.jobId),
      stepId: step.id,
      stepDir: context.stepDirPath,
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
      scope: `jobs.${context.jobId}.steps.${step.id}`,
    });
  }

  return env;
}

/** Ключ шага: записывается сейчас, используется возобновлением позже. */
function stepKey(pipelineFile: string, jobId: string, step: Step): string {
  return createHash('sha256')
    .update(JSON.stringify({ pipelineFile, jobId, step }))
    .digest('hex')
    .slice(0, 16);
}
