/**
 * Закрытый перечень причин, по которым прогон вправе остановиться досрочно.
 *
 * Список закрыт намеренно. Каждая причина либо объявлена пользователем в
 * пайплайне (`expect`, `attempts`, `until`, бюджет), либо им же вызвана
 * (отмена), либо означает, что шаг физически не запустился. Ничего другого
 * останавливать прогон не имеет права — в частности, внутренний учёт движка:
 * снятие якоря состояния дерева, вычисление диффов, чтение прошлых прогонов.
 * Их неудача проходит через `bookkeeping` и статусов не касается.
 *
 * Инструмент, не доходящий до цели по непонятной пользователю внутренней
 * причине, не используют — поэтому расширение этого списка требует такого же
 * обоснования, как изменение кодов возврата.
 */
export const HaltCause = {
  /** Непройденный предикат `expect` при исчерпанных попытках. */
  expectFailed: 'expect_failed',
  /** Шаг не завершился за отведённое время. */
  timeout: 'timeout',
  /** Процесс шага не удалось запустить. */
  spawnFailed: 'spawn_failed',
  /** Предел итераций цикла исчерпан, а его проверки не прошли. */
  untilNotMet: 'until_not_met',
  /** Превышен объявленный потолок расхода. */
  budgetExceeded: 'budget_exceeded',
  /** Прогон отменён пользователем или сигналом. */
  canceled: 'canceled',
} as const;

export type HaltCauseValue = (typeof HaltCause)[keyof typeof HaltCause];

/** Перечень целиком: тест сверяет с ним фактический набор причин. */
export const HALT_CAUSES: readonly HaltCauseValue[] = Object.values(HaltCause);

export function isHaltCause(value: unknown): value is HaltCauseValue {
  return typeof value === 'string' && (HALT_CAUSES as readonly string[]).includes(value);
}

/** Человекочитаемое имя причины для состояния прогона и вывода команд. */
export function describeHaltCause(cause: HaltCauseValue): string {
  switch (cause) {
    case HaltCause.expectFailed:
      return 'проверка результата не пройдена';
    case HaltCause.timeout:
      return 'шаг не уложился в отведённое время';
    case HaltCause.spawnFailed:
      return 'процесс шага не удалось запустить';
    case HaltCause.untilNotMet:
      return 'предел итераций цикла исчерпан';
    case HaltCause.budgetExceeded:
      return 'превышен объявленный бюджет';
    case HaltCause.canceled:
      return 'прогон отменён';
  }
}
