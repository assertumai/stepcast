import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BackendAdapter } from '../backend/types.js';
import { emptyUsage, mergeUsage } from '../backend/types.js';
import type { AgentStep } from '../pipeline/model.js';
import type { AttemptRecord, PredicateResult, StatusValue, Usage } from '../journal/schema.js';
import { runAttempts, type AttemptPlan } from './attempts.js';
import { runProcess, type ProcessResult } from './process.js';

/**
 * Исполнение агентского шага.
 *
 * Промпт уходит на stdin, поток разбирается по мере поступления, расход
 * снимается на лету. Идентификаторы сессий раздаёт движок: только так он
 * может заранее решить, к какой сессии относится шаг.
 */

export interface SessionRegistry {
  /** Выдать идентификатор сессии по псевдониму, отметив, начата ли она. */
  acquire(alias: string): { readonly id: string; readonly resume: boolean };
}

export function createSessionRegistry(): SessionRegistry {
  const started = new Map<string, string>();
  return {
    acquire(alias) {
      const existing = started.get(alias);
      if (existing !== undefined) return { id: existing, resume: true };
      const id = randomUUID();
      started.set(alias, id);
      return { id, resume: false };
    },
  };
}

export interface AgentStepOptions {
  readonly step: AgentStep;
  readonly adapter: BackendAdapter;
  readonly cwd: string;
  readonly stepDir: string;
  readonly sessions: SessionRegistry;
  /** Текст, который отправляется вместе с промптом: контекст и разбор отказа. */
  readonly buildPrompt: (plan: AttemptPlan, previousFailure: string | undefined) => string;
  readonly env: (plan: AttemptPlan) => Readonly<Record<string, string>>;
  readonly stallTimeoutMs?: number;
  readonly graceMs?: number;
  readonly signal?: AbortSignal;
  readonly onStall?: (silentMs: number) => void;
  readonly onAttemptStart?: (plan: AttemptPlan) => void;
  readonly onUsage?: (usage: Usage) => void;
  readonly onUnparsed?: (line: string) => void;
  readonly onExpectFailed?: (plan: AttemptPlan, result: PredicateResult) => void;
  readonly evaluate?: (
    step: AgentStep,
    outcome: AgentAttemptOutcome,
  ) => readonly PredicateResult[];
  readonly canContinue?: (attempt: number) => boolean;
}

export interface AgentAttemptOutcome {
  readonly process: ProcessResult;
  readonly text: string | undefined;
  readonly structured: unknown;
  readonly usage: Usage;
  readonly observedInputs: readonly string[];
  readonly backendInit: Record<string, unknown> | undefined;
  readonly failedByBackend: boolean;
}

export interface AgentStepResult {
  readonly status: StatusValue;
  readonly reason?: string;
  readonly attempts: readonly AttemptRecord[];
  readonly results: readonly (readonly PredicateResult[])[];
  readonly sessionId: string;
  readonly last: AgentAttemptOutcome | undefined;
}

/** Инструменты чтения: по ним уточняется инвалидация на следующем прогоне. */
const READING_TOOLS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead']);

export async function executeAgentStep(options: AgentStepOptions): Promise<AgentStepResult> {
  const { step, adapter } = options;
  const evaluate = options.evaluate ?? evaluateDefault;
  const records: AttemptRecord[] = [];
  const allResults: Array<readonly PredicateResult[]> = [];

  let last: AgentAttemptOutcome | undefined;
  let previousFailure: string | undefined;
  let sessionId = '';

  await runAttempts<AttemptRecord>({
    attempts: step.attempts,
    ...(options.canContinue === undefined ? {} : { canContinue: options.canContinue }),
    run: async (plan) => {
      options.onAttemptStart?.(plan);
      const startedAt = new Date().toISOString();

      const session = options.sessions.acquire(step.session);
      sessionId = session.id;

      const resolvedModel = plan.model ?? step.model;
      const prompt = options.buildPrompt(plan, plan.includeFailure ? previousFailure : undefined);
      const launch = adapter.launch({
        prompt,
        cwd: options.cwd,
        ...(resolvedModel === undefined ? {} : { model: resolvedModel }),
        ...(adapter.capabilities.sessions ? { sessionId: session.id } : {}),
        resumeSession: adapter.capabilities.sessions && session.resume,
        ...(step.outputSchemaPath === undefined
          ? {}
          : { outputSchemaPath: step.outputSchemaPath }),
        ...(step.permissions === undefined ? {} : { permissions: step.permissions }),
      });

      const suffix = plan.attempt === 1 ? '' : `.${plan.attempt}`;
      writePrompt(options.stepDir, suffix, prompt);

      let usage = emptyUsage(adapter.name, resolvedModel, 0);
      let text: string | undefined;
      let structured: unknown;
      let backendInit: Record<string, unknown> | undefined;
      let failedByBackend = false;
      const observedInputs = new Set<string>();
      let carry = '';

      const consume = (chunk: string): void => {
        carry += chunk;
        const lines = carry.split('\n');
        carry = lines.pop() ?? '';
        for (const line of lines) handleLine(line);
      };

      const handleLine = (line: string): void => {
        const event = adapter.parseLine(line);
        switch (event.kind) {
          case 'init':
            backendInit = event.data;
            break;
          case 'tool_use':
            if (READING_TOOLS.has(event.name)) {
              const path = readPathFromInput(event.input);
              if (path !== undefined) observedInputs.add(path);
            }
            break;
          case 'usage':
            usage = mergeUsage(usage, event.usage);
            options.onUsage?.(usage);
            break;
          case 'result':
            if (event.text !== undefined) text = event.text;
            if (event.structured !== undefined) structured = event.structured;
            usage = mergeUsage(usage, event.usage);
            if (event.failed === true) failedByBackend = true;
            options.onUsage?.(usage);
            break;
          case 'unparsed':
            options.onUnparsed?.(event.line);
            break;
          case 'ignored':
            break;
        }
      };

      const process_ = await runProcess({
        command: launch.command,
        cwd: options.cwd,
        env: { ...options.env(plan), ...(launch.env ?? {}) },
        stdin: launch.stdin,
        timeoutMs: step.timeoutMs,
        ...(options.stallTimeoutMs === undefined ? {} : { stallTimeoutMs: options.stallTimeoutMs }),
        ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.onStall === undefined ? {} : { onStall: options.onStall }),
        stdoutPath: join(options.stepDir, `stdout${suffix}.log`),
        stderrPath: join(options.stepDir, `stderr${suffix}.log`),
        onStdout: consume,
      });

      if (carry.trim() !== '') handleLine(carry);
      usage = { ...usage, wallclock_ms: process_.wallclockMs };

      const outcome: AgentAttemptOutcome = {
        process: process_,
        text,
        structured,
        usage,
        observedInputs: [...observedInputs].sort(),
        backendInit,
        failedByBackend,
      };
      last = outcome;

      const results =
        process_.outcome === 'exited'
          ? evaluate(step, outcome)
          : [
              {
                predicate: process_.outcome === 'timeout' ? 'timeout' : 'canceled',
                passed: false,
                hard: true,
                detail:
                  process_.outcome === 'timeout'
                    ? `Шаг не завершился за ${step.timeoutMs} мс`
                    : 'Прогон отменён',
              } satisfies PredicateResult,
            ];

      allResults.push(results);
      for (const item of results) {
        if (!item.passed && item.hard) options.onExpectFailed?.(plan, item);
      }

      const passed =
        process_.outcome === 'exited' && results.every((item) => item.passed || !item.hard);
      previousFailure = passed ? undefined : describeFailure(results, process_);

      const status: StatusValue =
        process_.outcome === 'canceled' ? 'canceled' : passed ? 'success' : 'failed';

      const record: AttemptRecord = {
        attempt: plan.attempt,
        status,
        ...(passed ? {} : { reason: previousFailure ?? 'проверка не пройдена' }),
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        exit_code: process_.exitCode,
        usage,
      };
      records.push(record);

      return { passed, value: record };
    },
  });

  const cancelled = records.at(-1)?.status === 'canceled';
  const succeeded = records.at(-1)?.status === 'success';
  const status: StatusValue = cancelled ? 'canceled' : succeeded ? 'success' : 'failed';

  return {
    status,
    ...(status === 'success' ? {} : { reason: records.at(-1)?.reason ?? 'попытки исчерпаны' }),
    attempts: records,
    results: allResults,
    sessionId,
    last,
  };
}

function writePrompt(stepDir: string, suffix: string, prompt: string): void {
  // Промпт хранится целиком: без него нельзя понять, почему шаг повёл себя
  // так, а не иначе. Это часть запроса, сформированная scarp, — бэкенд
  // добавит к ней свой системный промпт и проектный контекст.
  writeFileSync(join(stepDir, `prompt${suffix}.txt`), prompt, { mode: 0o600 });
}

function readPathFromInput(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ['file_path', 'path', 'notebook_path', 'pattern']) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function describeFailure(
  results: readonly PredicateResult[],
  process_: ProcessResult,
): string | undefined {
  const failed = results.find((item) => !item.passed && item.hard);
  if (failed !== undefined) return failed.detail ?? failed.predicate;
  return process_.exitCode === 0 ? undefined : `код возврата ${process_.exitCode ?? 'нет'}`;
}

/** Умолчание: успех определяется кодом возврата и отсутствием отказа бэкенда. */
function evaluateDefault(_step: AgentStep, outcome: AgentAttemptOutcome): PredicateResult[] {
  const passed = outcome.process.exitCode === 0 && !outcome.failedByBackend;
  return [
    {
      predicate: 'backend',
      passed,
      hard: true,
      ...(passed
        ? {}
        : {
            detail: outcome.failedByBackend
              ? 'бэкенд сообщил об ошибке'
              : `код возврата ${outcome.process.exitCode ?? 'нет'}`,
          }),
    },
  ];
}
