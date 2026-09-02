/**
 * Ожидания сброса окна лимита, идущие в прогоне прямо сейчас.
 *
 * Ожидающих работ может быть несколько, а момент пробуждения в состоянии
 * прогона один: пользователю нужно знать, когда прогон перестанет спать, — то
 * есть ближайший из них. Одно поле на прогон при параллельном исполнении
 * снимало бы чужой момент вместе со своим.
 */
export interface WaitState {
  /** Начать ожидание до момента `wakeAt`; возвращает снятие именно этого. */
  begin(wakeAt: string): () => void;
  /** Ближайший момент пробуждения или `undefined`, если прогон не спит. */
  earliest(): string | undefined;
  /**
   * Снять все незавершённые ожидания. Зовётся при выходе из области прогона:
   * закончившийся прогон не спит, и состояние, утверждающее обратное, врёт
   * витрине и `stepcast status` до самой уборки.
   */
  clear(): void;
}

export function createWaitState(): WaitState {
  // Ключ — не сам момент: два ожидания могут прийтись на один и тот же, и
  // снятие одного унесло бы второе.
  const pending = new Map<number, string>();
  let counter = 0;

  return {
    begin(wakeAt) {
      counter += 1;
      const token = counter;
      pending.set(token, wakeAt);
      return () => {
        pending.delete(token);
      };
    },
    clear() {
      pending.clear();
    },
    earliest() {
      // Моменты записаны в ISO 8601 с зоной UTC: лексикографический порядок
      // совпадает с хронологическим, разбирать их обратно не нужно.
      let earliest: string | undefined;
      for (const wakeAt of pending.values()) {
        if (earliest === undefined || wakeAt < earliest) earliest = wakeAt;
      }
      return earliest;
    },
  };
}
