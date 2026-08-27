import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BackendAdapter, BackendRefusal } from '../backend/types.js';
import type { BackendSlots } from '../backend/slots.js';
import {
  BACKEND_REFUSAL_PREDICATE,
  describeRefusal,
  emptyUsage,
  extractRefusal,
  mergeUsage,
  messagePrefix,
  sumUsage,
} from '../backend/types.js';
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
  /**
   * Место бэкенда: вызов ждёт его перед запуском процесса и освобождает по
   * завершении. Отсутствие — прогон без предела одновременности бэкенда,
   * как в тестах, что вызывают исполнение шага напрямую.
   */
  readonly backendSlots?: BackendSlots;
  /** Текст, который отправляется вместе с промптом: контекст и разбор отказа. */
  readonly buildPrompt: (plan: AttemptPlan, previousFailure: string | undefined) => string;
  readonly env: (plan: AttemptPlan) => Readonly<Record<string, string>>;
  readonly stallTimeoutMs?: number;
  readonly graceMs?: number;
  readonly signal?: AbortSignal;
  readonly onStall?: (silentMs: number) => void;
  readonly onAttemptStart?: (plan: AttemptPlan) => void;
  /**
   * Нарастающий итог попытки и её номер. Номер обязателен: без него расход
   * ложится под чужую попытку, а замена по ключу стирает предыдущую.
   */
  readonly onUsage?: (usage: Usage, attempt: number) => void;
  readonly onUnparsed?: (line: string) => void;
  readonly onExpectFailed?: (plan: AttemptPlan, result: PredicateResult) => void;
  /** Может возвращать промис: судья внутри неё — асинхронный агентский вызов. */
  readonly evaluate?: (
    step: AgentStep,
    outcome: AgentAttemptOutcome,
    plan: AttemptPlan,
  ) => readonly PredicateResult[] | Promise<readonly PredicateResult[]>;
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
  /** Классификация неустранимого отказа бэкенда, если попытка на него упёрлась. */
  readonly refusal?: BackendRefusal;
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
      // Окно попытки открывается запуском процесса, а не постановкой в
      // очередь за местом бэкенда: иначе при насыщенном пределе started_at…
      // finished_at показывал бы чужое ожидание как время этого шага, расходясь
      // с `usage.wallclock_ms`, который считает сам процесс. Значение задаётся
      // и здесь: попытка, до процесса не дошедшая, обязана остаться с началом.
      let startedAt = new Date().toISOString();

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
      const seenUsageMessageIds = new Set<string>();
      let text: string | undefined;
      let structured: unknown;
      let backendInit: Record<string, unknown> | undefined;
      let failedByBackend = false;
      let refusal: BackendRefusal | undefined;
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
            recordUsageDelta(event.usage, event.messageId);
            break;
          case 'usage':
            recordUsageDelta(event.usage, event.messageId);
            break;
          case 'result':
            if (event.text !== undefined) text = event.text;
            if (event.structured !== undefined) structured = event.structured;
            if (event.usage !== undefined) {
              usage = mergeUsage(usage, event.usage);
              options.onUsage?.(usage, plan.attempt);
            }
            if (event.failed === true) failedByBackend = true;
            if (event.refusal !== undefined) refusal = event.refusal;
            break;
          case 'unparsed':
            options.onUnparsed?.(event.line);
            break;
          case 'ignored':
            break;
        }
      };

      const recordUsageDelta = (delta: Partial<Usage> | undefined, messageId: string | undefined): void => {
        if (delta === undefined || (messageId !== undefined && seenUsageMessageIds.has(messageId))) return;
        if (messageId !== undefined) seenUsageMessageIds.add(messageId);
        // Пик — величина этого одного сообщения, а не накопленного расхода:
        // считается до слияния с пустой базой, иначе sumUsage увидел бы его
        // как обычное поле дельты и просуммировал бы вместо взятия максимума.
        const peak = messagePrefix(delta);
        const messageUsage = mergeUsage(emptyUsage(adapter.name, resolvedModel, 0), delta);
        usage = sumUsage(usage, peak === undefined ? messageUsage : { ...messageUsage, peak_prefix_tokens: peak });
        options.onUsage?.(usage, plan.attempt);
      };

      // Место бэкенда занято вокруг самого процесса: таймаут и детектор
      // тишины отсчитываются от старта процесса, а не от постановки в
      // очередь, — иначе ожидание места засчиталось бы попытке как простой.
      const runBackendProcess = (): Promise<ProcessResult> => {
        startedAt = new Date().toISOString();
        return runProcess({
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
      };
      const process_ = options.backendSlots === undefined
        ? await runBackendProcess()
        : await options.backendSlots.run(adapter.name, runBackendProcess);

      if (carry.trim() !== '') handleLine(carry);
      usage = { ...usage, wallclock_ms: process_.wallclockMs };
      // Длительность известна только после завершения процесса, а по ходу
      // потока её в событиях нет. Без этой записи учёт работы и шага остаётся
      // с нулевым временем, которое выглядит измерением, а не пробелом.
      options.onUsage?.(usage, plan.attempt);

      const outcome: AgentAttemptOutcome = {
        process: process_,
        text,
        structured,
        usage,
        observedInputs: [...observedInputs].sort(),
        backendInit,
        failedByBackend,
        ...(refusal === undefined ? {} : { refusal }),
      };

      const results =
        process_.outcome === 'exited'
          ? await evaluate(step, outcome, plan)
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

      // Отказ судьи внутри `evaluate` классифицируется тем же путём, что и
      // отказ самого шага, и кладёт себя в результаты предикатов тем же
      // именем: место одно, и учитывать его дальше можно не различая источник.
      const effectiveRefusal = outcome.refusal ?? extractRefusal(results);
      last = effectiveRefusal === undefined ? outcome : { ...outcome, refusal: effectiveRefusal };

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

      return { passed, value: record, terminal: effectiveRefusal !== undefined };
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
  } satisfies AgentStepResult;
}

function writePrompt(stepDir: string, suffix: string, prompt: string): void {
  // Промпт хранится целиком: без него нельзя понять, почему шаг повёл себя
  // так, а не иначе. Это часть запроса, сформированная stepcast, — бэкенд
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
  // Неустранимый отказ проверяется раньше кода возврата и общей отметки об
  // ошибке: у обоих настоящих конвертов отказа код возврата ненулевой, и без
  // этой проверки первым по порядку в объяснении оказался бы он, а не то, что
  // действительно произошло.
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
