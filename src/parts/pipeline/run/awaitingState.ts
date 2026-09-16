import type { AwaitingDecision } from './journal/schema.js';

/**
 * Ожидания решения, идущие в прогоне прямо сейчас — тот же приём, что
 * `waitState.ts` у `wake_at`: перечень, а не одно поле, потому что работы
 * идут параллельно и два ожидания решения одновременно — законное состояние.
 */
export interface AwaitingState {
  /** Начать ожидание; возвращает снятие именно этой записи. */
  begin(entry: AwaitingDecision): () => void;
  /** Все незавершённые ожидания — то, что уходит в `RunStatus.awaiting`. */
  list(): readonly AwaitingDecision[];
  /** Снять все незавершённые ожидания — при выходе из области прогона. */
  clear(): void;
}

export function createAwaitingState(): AwaitingState {
  const pending = new Map<string, AwaitingDecision>();

  return {
    begin(entry) {
      pending.set(entry.wait_id, entry);
      return () => {
        pending.delete(entry.wait_id);
      };
    },
    list() {
      return [...pending.values()];
    },
    clear() {
      pending.clear();
    },
  };
}
