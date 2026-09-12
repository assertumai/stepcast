import { createHash } from 'node:crypto';

import { StepcastError } from '../errors.js';
import type { AwaitingDecision, DecisionEffect, DecisionRecord } from '../journal/schema.js';
import type { Pipeline } from '../pipeline/model.js';
import type { StepKindDecisionResult } from '../plugins/contract.js';

/**
 * Чистая часть решения человека (`user-decision-steps`, design.md решение 5):
 * идентификатор ожидания, проверка предложенного исхода по объявленному
 * ожиданию и тексты отказов. Общая для движка (`decisionWait.ts`), команды
 * (`cli/commands/decide.ts`) и демона (`ui/screens/decisions`) — три места
 * согласны в том, что решение допустимо, потому что здесь ровно одна функция,
 * а не три её копии.
 *
 * Модуль не зависит ни от раннера, ни от демона, ни от CLI: только от формы
 * записей журнала.
 */

/** Составляющие идентификатора ожидания. */
export interface WaitIdentity {
  readonly job: string;
  readonly step: string;
  /** Номер попытки — тот же цикл `runAttempts`, что и у прочих шагов. */
  readonly attempt: number;
  /** Итерация цикла `until`, если работа его объявляет. */
  readonly iteration?: number;
  /** Момент начала этого ожидания, ISO 8601. */
  readonly since: string;
}

/**
 * Идентификатор ожидания: решение принадлежит **ожиданию**, не шагу
 * (design.md, решение 5) — шаг внутри `until` спрашивает человека на каждой
 * итерации, и решение прошлой не смеет закрыть следующую; та же попытка,
 * начатая заново при возобновлении прогона, начинает ожидание с новым `since`
 * и потому получает новый идентификатор.
 */
export function computeWaitId(identity: WaitIdentity): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        job: identity.job,
        step: identity.step,
        attempt: identity.attempt,
        iteration: identity.iteration ?? null,
        since: identity.since,
      }),
    )
    .digest('hex')
    .slice(0, 16);
}

/** Решение, предложенное человеком, — до проверки по объявленному ожиданию. */
export interface ProposedDecision {
  readonly outcome: string;
  readonly reason?: string;
  readonly restartFrom?: string;
}

/** Решение, прошедшее проверку: исход и его эффект из закрытого набора. */
export interface ValidatedDecision {
  readonly outcome: string;
  readonly effect: DecisionEffect;
  readonly reason?: string;
  readonly restartFrom?: string;
}

/**
 * Выбрать ожидание, к которому относится решение: по имени шага, если оно
 * названо, иначе — единственное, если оно ровно одно.
 *
 * Голое имя шага (`gate` вместо `build/gate`) допустимо, пока оно
 * однозначно: шаг с тем же именем в двух параллельных работах — законный
 * пайплайн, и молча решить за первую из них значило бы принять решение не за
 * тот шаг. Неоднозначность отвергается тем же перечнем, что и ожидания без
 * названного шага.
 */
export function selectAwaiting(
  awaiting: readonly AwaitingDecision[],
  step?: string,
): AwaitingDecision {
  if (awaiting.length === 0) {
    throw new StepcastError('Прогон не ждёт решения', {
      hint: 'stepcast status покажет, идёт ли прогон и чего он ждёт',
    });
  }

  if (step !== undefined) {
    // Полный адрес `работа/шаг` сильнее голого имени: он назван однозначно, и
    // одноимённый шаг соседней работы его не оспаривает.
    const exact = awaiting.find((item) => `${item.job}/${item.step}` === step);
    if (exact !== undefined) return exact;

    const byName = awaiting.filter((item) => item.step === step);
    if (byName.length === 0) {
      throw new StepcastError(`Прогон не ждёт решения на шаге ${step}`, {
        hint: `Ожидающие шаги: ${listSteps(awaiting)}`,
      });
    }
    if (byName.length > 1) {
      throw new StepcastError(`Шаг ${step} ждёт решения в нескольких работах — назовите работа/шаг`, {
        hint: `Ожидающие шаги: ${listSteps(byName)}`,
      });
    }
    return byName[0] as AwaitingDecision;
  }

  if (awaiting.length > 1) {
    throw new StepcastError('Прогон ждёт решения на нескольких шагах — укажите --step', {
      hint: `Ожидающие шаги: ${listSteps(awaiting)}`,
    });
  }

  return awaiting[0] as AwaitingDecision;
}

function listSteps(awaiting: readonly AwaitingDecision[]): string {
  return awaiting.map((item) => `${item.job}/${item.step}`).join(', ');
}

/**
 * Проверить предложенное решение по объявленному ожиданию: исход — из
 * перечня, `reject` требует причины, `restart` — названного шага. `knownSteps`
 * называет допустимые адреса `job` и `job/step` — тот же состав, что
 * принимает `--from` команды `resume` (design.md, решение 4); при значении
 * `undefined` существование шага не проверяется — только то, что он назван.
 *
 * Опущенный `knownSteps` — лёгкая проверка демона (design.md, решение 5):
 * `POST /api/run/decision` не разворачивает пайплайн ради одной проверки, а
 * настоящая проверка по составу шагов идёт в `stepcast decide`, которую
 * маршрут порождает следом. Команда и ждущий процесс всегда передают состав,
 * потому что перезапуск с несуществующего шага обязан отказать им, а не
 * начать возобновление вслепую.
 */
export function validateDecision(
  awaiting: AwaitingDecision,
  proposed: ProposedDecision,
  knownSteps?: ReadonlySet<string>,
): ValidatedDecision {
  const spec = awaiting.outcomes[proposed.outcome];
  if (spec === undefined) {
    throw new StepcastError(`Исход ${proposed.outcome} не входит в перечень ожидания`, {
      hint: `Допустимы: ${Object.keys(awaiting.outcomes).join(', ')}`,
    });
  }

  if (spec.effect === 'reject' && (proposed.reason === undefined || proposed.reason.trim() === '')) {
    throw new StepcastError('Отклонение требует причины', { hint: 'Укажите --reason «почему»' });
  }

  if (spec.effect === 'restart') {
    if (proposed.restartFrom === undefined) {
      throw new StepcastError('Перезапуск требует шага, с которого продолжить', {
        hint: 'Укажите --from job[/step]',
      });
    }
    if (knownSteps !== undefined && !knownSteps.has(proposed.restartFrom)) {
      throw new StepcastError(`Шаг ${proposed.restartFrom} в прогоне не найден`, {
        hint: `Доступны: ${[...knownSteps].sort().join(', ')}`,
      });
    }
  }

  return {
    outcome: proposed.outcome,
    effect: spec.effect,
    ...(proposed.reason === undefined ? {} : { reason: proposed.reason }),
    ...(proposed.restartFrom === undefined ? {} : { restartFrom: proposed.restartFrom }),
  };
}

/**
 * Адреса, допустимые как точка перезапуска: имя работы либо `работа/шаг` —
 * та же форма, что принимает `--from` команды `resume`. Проверяется здесь, на
 * приёме решения (командой либо движком), а не посреди возобновления.
 */
export function pipelineStepAddresses(pipeline: Pipeline): ReadonlySet<string> {
  const addresses = new Set<string>();
  for (const job of pipeline.jobs) {
    addresses.add(job.id);
    for (const step of job.steps) addresses.add(`${job.id}/${step.id}`);
  }
  return addresses;
}

/** Результат `request()` в форму записи журнала (snake_case полей файла). */
export function toDecisionRecord(result: StepKindDecisionResult): DecisionRecord {
  return {
    outcome: result.outcome,
    effect: result.effect,
    by: result.by,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    ...(result.restartFrom === undefined ? {} : { restart_from: result.restartFrom }),
  };
}
