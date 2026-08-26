import { join } from 'node:path';

import { extractRefusal } from '../backend/types.js';
import type { Predicate, RunStep } from '../pipeline/model.js';
import type { AttemptRecord, PredicateResult, StatusValue } from '../journal/schema.js';
import { planAttempt, runAttempts, type AttemptPlan } from './attempts.js';
import { runProcess, type ProcessResult } from './process.js';

/**
 * Исполнение шага командной строки.
 *
 * Полная проверка результата приходит отдельной группой задач; здесь
 * вычисляется только `exit_code`, а остальные предикаты подключаются через
 * `evaluate`. Разделение оставляет слои независимыми: цикл попыток не знает,
 * чем именно проверяется результат.
 */

export interface StepAttemptContext {
  readonly plan: AttemptPlan;
  readonly env: Readonly<Record<string, string>>;
  readonly stepDir: string;
}

export interface RunStepOptions {
  readonly step: RunStep;
  readonly cwd: string;
  readonly stepDir: string;
  /** Окружение на попытку: STEPCAST_ATTEMPT меняется от попытки к попытке. */
  readonly env: (plan: AttemptPlan) => Readonly<Record<string, string>>;
  readonly stallTimeoutMs?: number;
  readonly graceMs?: number;
  readonly signal?: AbortSignal;
  readonly onStall?: (silentMs: number) => void;
  readonly onAttemptStart?: (plan: AttemptPlan) => void;
  readonly onExpectFailed?: (plan: AttemptPlan, result: PredicateResult) => void;
  /**
   * Оценка результата попытки. Умолчание проверяет только код возврата.
   * Может возвращать промис: судья внутри неё — асинхронный агентский вызов.
   */
  readonly evaluate?: (
    step: RunStep,
    result: ProcessResult,
    plan: AttemptPlan,
  ) => readonly PredicateResult[] | Promise<readonly PredicateResult[]>;
  readonly canContinue?: (attempt: number) => boolean;
}

export interface RunStepResult {
  readonly status: StatusValue;
  readonly reason?: string;
  readonly attempts: readonly AttemptRecord[];
  readonly results: readonly (readonly PredicateResult[])[];
  readonly last: ProcessResult | undefined;
}

export async function executeRunStep(options: RunStepOptions): Promise<RunStepResult> {
  const { step } = options;
  const evaluate = options.evaluate ?? evaluateExitCode;
  const records: AttemptRecord[] = [];
  const allResults: Array<readonly PredicateResult[]> = [];
  let last: ProcessResult | undefined;

  const loop = await runAttempts<AttemptRecord>({
    attempts: step.attempts,
    ...(options.canContinue === undefined ? {} : { canContinue: options.canContinue }),
    run: async (plan) => {
      options.onAttemptStart?.(plan);
      const startedAt = new Date().toISOString();

      const suffix = plan.attempt === 1 ? '' : `.${plan.attempt}`;
      const result = await runProcess({
        command: step.command,
        cwd: options.cwd,
        env: options.env(plan),
        timeoutMs: step.timeoutMs,
        ...(options.stallTimeoutMs === undefined ? {} : { stallTimeoutMs: options.stallTimeoutMs }),
        ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.onStall === undefined ? {} : { onStall: options.onStall }),
        stdoutPath: join(options.stepDir, `stdout${suffix}.log`),
        stderrPath: join(options.stepDir, `stderr${suffix}.log`),
      });

      last = result;

      const results =
        result.outcome === 'exited'
          ? await evaluate(step, result, plan)
          : [
              {
                predicate: result.outcome,
                passed: false,
                hard: true,
                detail: describeOutcome(result.outcome, step.timeoutMs, result.forceKilled),
              } satisfies PredicateResult,
            ];

      allResults.push(results);
      for (const item of results) {
        if (!item.passed && item.hard) options.onExpectFailed?.(plan, item);
      }

      const passed = results.every((item) => item.passed || !item.hard);
      const status: StatusValue =
        result.outcome === 'canceled' ? 'canceled' : passed ? 'success' : 'failed';
      const reason = passed ? undefined : firstFailureReason(results);

      const record: AttemptRecord = {
        attempt: plan.attempt,
        status,
        ...(reason === undefined ? {} : { reason }),
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        exit_code: result.exitCode,
      };
      records.push(record);

      // Командный шаг сам бэкенд не зовёт: отказ добирается сюда только через
      // судью, вызванного из `evaluate`, — тем же именем предиката, что и у
      // отказа агентского шага.
      const terminal = extractRefusal(results) !== undefined;

      return { passed: passed && result.outcome === 'exited', value: record, terminal };
    },
  });

  const cancelled = records.at(-1)?.status === 'canceled';
  const status: StatusValue = cancelled ? 'canceled' : loop.passed ? 'success' : 'failed';

  return {
    status,
    ...(status === 'success' ? {} : { reason: records.at(-1)?.reason ?? 'попытки исчерпаны' }),
    attempts: records,
    results: allResults,
    last,
  };
}

/** Исход процесса, не дошедшего до собственного кода возврата. */
function describeOutcome(
  outcome: Exclude<ProcessResult['outcome'], 'exited'>,
  timeoutMs: number,
  forceKilled: boolean,
): string {
  switch (outcome) {
    case 'timeout':
      return `Шаг не завершился за ${timeoutMs} мс${forceKilled ? ' и был добит' : ''}`;
    case 'canceled':
      return 'Прогон отменён';
    case 'spawn_failed':
      return 'Процесс шага не удалось запустить: проверьте команду и её доступность';
  }
}

function firstFailureReason(results: readonly PredicateResult[]): string | undefined {
  const failed = results.find((item) => !item.passed && item.hard);
  if (failed === undefined) return undefined;
  return failed.detail ?? failed.predicate;
}

/**
 * Умолчание: шаг без объявленных предикатов считается пройденным при нулевом
 * коде возврата. Остальные предикаты подключит группа проверки результата.
 */
export function evaluateExitCode(step: RunStep, result: ProcessResult): PredicateResult[] {
  const declared = step.expect.filter(
    (predicate): predicate is Extract<Predicate, { kind: 'exit_code' }> =>
      predicate.kind === 'exit_code',
  );

  const expected = declared[0]?.value ?? 0;
  const passed = result.exitCode === expected;

  return [
    {
      predicate: 'exit_code',
      passed,
      hard: true,
      expected,
      actual: result.exitCode,
      ...(passed ? {} : { detail: `код возврата ${result.exitCode ?? 'нет'} вместо ${expected}` }),
    },
  ];
}

export { planAttempt };
