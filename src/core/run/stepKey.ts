import { createHash } from 'node:crypto';

import type { Step } from '../pipeline/model.js';

/**
 * Ключ шага отвечает на один вопрос: остаётся ли прошлый успех шага
 * действительным.
 *
 * Функция чистая и живёт отдельно намеренно. Ключ считают двое: исполнитель —
 * когда пишет запись шага, и планировщик возобновления — когда решает, можно
 * ли шаг переиспользовать. Если бы у них были разные реализации, они рано или
 * поздно разошлись бы, и переиспользование стало бы то ложно-отрицательным
 * (лишняя работа), то ложно-положительным (устаревший результат). Второе
 * гораздо хуже, и заметить его почти невозможно.
 */
export interface StepKeyInput {
  readonly lockHash: string;
  readonly jobId: string;
  readonly step: Step;
  /** Отпечаток входов: якорь дерева, наблюдённые или объявленные пути. */
  readonly inputsFingerprint: string | undefined;
  /** Команда бэкенда: смена CLI меняет результат при том же промпте. */
  readonly backendCommand: string | undefined;
  /** Выходы работ выше по графу на момент исполнения этого шага. */
  readonly upstream: readonly { readonly job: string; readonly value: unknown }[];
}

/**
 * Составляющая `upstream` для ключа: выходы работ выше по графу.
 *
 * Порядок задаётся здесь, а не тем, как выходы накопились. Исполнитель
 * складывает их в порядке завершения работ, планировщик возобновления — в
 * порядке разбора прогона; разошедшийся порядок даёт разный JSON, то есть
 * разный ключ при неизменном определении и одном и том же составе выходов.
 * Сортировка по идентификатору работы снимает вопрос конструктивно: обе
 * стороны подают одну и ту же последовательность независимо от того, как они
 * до неё дошли.
 */
export function upstreamForKey(
  outputs: readonly { readonly job: string; readonly value: unknown }[],
): readonly { readonly job: string; readonly value: unknown }[] {
  return [...outputs]
    .map((output) => ({ job: output.job, value: output.value }))
    .sort((left, right) => (left.job === right.job ? 0 : left.job < right.job ? -1 : 1));
}

export function computeStepKey(input: StepKeyInput): string {
  const { step } = input;

  return createHash('sha256')
    .update(
      JSON.stringify({
        lock: input.lockHash,
        job: input.jobId,
        step,
        inputs: input.inputsFingerprint ?? null,
        backend:
          step.kind === 'agent'
            ? {
                name: step.agent,
                command: input.backendCommand ?? null,
                model: step.model ?? null,
              }
            : null,
        upstream: input.upstream.map((output) => ({ job: output.job, value: output.value })),
      }),
    )
    .digest('hex')
    .slice(0, 16);
}
