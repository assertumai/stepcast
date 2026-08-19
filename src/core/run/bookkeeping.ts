import type { RunJournal } from '../journal/writer.js';

/**
 * Внутренний учёт движка.
 *
 * Снятие якоря состояния дерева, вычисление диффов, запись производных файлов
 * журнала, чтение данных прошлого прогона — всё это пользователь не заказывал.
 * Он заказывал реализацию фичи. Поэтому неудача любой такой операции пишется в
 * журнал и на этом заканчивается: статус шага, работы и прогона она не
 * трогает, исполнение продолжается.
 *
 * Последствие ограничено утратой зависящей возможности и наступает позже, в
 * другом месте: шаг без снятого якоря не переиспользуется при возобновлении,
 * предикат `changed_only` помечается невычисленным, `diff.patch` не пишется.
 *
 * Возврат `undefined` означает «не получилось» и обязывает вызывающего иметь
 * ветку без результата. Тип это гарантирует.
 */
export interface BookkeepingScope {
  readonly journal: RunJournal;
  readonly job?: string;
  readonly step?: string;
}

function report(scope: BookkeepingScope, operation: string, error: unknown): void {
  scope.journal.event({
    kind: 'bookkeeping.failed',
    operation,
    ...(scope.job === undefined ? {} : { job: scope.job }),
    ...(scope.step === undefined ? {} : { step: scope.step }),
    detail: error instanceof Error ? error.message : String(error),
  });
}

/** Синхронная операция учёта. Исключение превращается в запись журнала. */
export function bookkeep<T>(
  scope: BookkeepingScope,
  operation: string,
  run: () => T,
): T | undefined {
  try {
    return run();
  } catch (error) {
    report(scope, operation, error);
    return undefined;
  }
}

/** Асинхронная операция учёта. */
export async function bookkeepAsync<T>(
  scope: BookkeepingScope,
  operation: string,
  run: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    report(scope, operation, error);
    return undefined;
  }
}
