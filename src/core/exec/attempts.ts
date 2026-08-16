import type { Attempts } from '../pipeline/model.js';

/**
 * Повторные попытки.
 *
 * Проверки того, что попытка отличается от предыдущей, здесь нет намеренно:
 * ограничителей ровно два — `attempts.max` и бюджет. Зато каждая попытка
 * записывается отдельно, поэтому шаг, стабильно проходящий с третьего раза,
 * виден в отчёте как диагноз промпта или спеки.
 */

export interface AttemptPlan {
  readonly attempt: number;
  /** Подмешать ли в контекст вывод непройденных предикатов прошлой попытки. */
  readonly includeFailure: boolean;
  /** Модель для этой попытки, если ступень эскалации её меняет. */
  readonly model?: string;
}

/**
 * Ступень эскалации для попытки. Первая попытка идёт как объявлено, для
 * второй берётся первая ступень и так далее. Когда список короче `max`,
 * последняя ступень повторяется — иначе поздние попытки внезапно теряли бы
 * накопленные послабления.
 */
export function planAttempt(attempt: number, attempts: Attempts): AttemptPlan {
  if (attempt <= 1 || attempts.escalation.length === 0) {
    return { attempt, includeFailure: false };
  }

  const index = Math.min(attempt - 2, attempts.escalation.length - 1);
  const step = attempts.escalation[index];

  return {
    attempt,
    includeFailure: step?.includeFailure ?? false,
    ...(step?.model === undefined ? {} : { model: step.model }),
  };
}

export interface AttemptOutcome<T> {
  readonly passed: boolean;
  readonly value: T;
}

export interface AttemptLoopOptions<T> {
  readonly attempts: Attempts;
  /** Исполнить одну попытку. Возвращает результат и признак прохождения. */
  readonly run: (plan: AttemptPlan) => Promise<AttemptOutcome<T>>;
  /** Осталось ли право на ещё одну попытку: бюджет проверяется снаружи. */
  readonly canContinue?: (attempt: number) => boolean;
}

export interface AttemptLoopResult<T> {
  readonly passed: boolean;
  /** Все попытки по порядку: журнал хранит каждую отдельно. */
  readonly outcomes: readonly T[];
  readonly attemptsUsed: number;
  readonly stoppedEarly: boolean;
}

export async function runAttempts<T>(options: AttemptLoopOptions<T>): Promise<AttemptLoopResult<T>> {
  const outcomes: T[] = [];
  let attempt = 0;

  for (;;) {
    attempt += 1;
    const outcome = await options.run(planAttempt(attempt, options.attempts));
    outcomes.push(outcome.value);

    if (outcome.passed) {
      return { passed: true, outcomes, attemptsUsed: attempt, stoppedEarly: false };
    }
    if (attempt >= options.attempts.max) {
      return { passed: false, outcomes, attemptsUsed: attempt, stoppedEarly: false };
    }
    if (options.canContinue !== undefined && !options.canContinue(attempt)) {
      return { passed: false, outcomes, attemptsUsed: attempt, stoppedEarly: true };
    }
  }
}
