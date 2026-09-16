/**
 * Места бэкенда: сколько его вызовов может идти одновременно.
 *
 * Счёт живёт рядом с адаптерами, а не в планировщике: планировщик знает
 * работы, а предел считает вызовы, и один агентский шаг может смениться
 * вызовом судьи того же бэкенда. Место занимает вызов — не работа и не шаг, —
 * и вызов, удерживающий место, другого места не ждёт: иначе предел давал бы
 * взаимную блокировку.
 */
export interface BackendSlots {
  /**
   * Дождаться места бэкенда, исполнить вызов и освободить место при любом его
   * исходе — успехе, отказе, таймауте и отмене одинаково.
   */
  run<T>(backend: string, call: () => Promise<T>): Promise<T>;
  /** Число идущих сейчас вызовов бэкенда — для проверок и разбора. */
  active(backend: string): number;
}

interface Counter {
  active: number;
  /** Ожидающие места, в порядке обращения: очередь без приоритетов. */
  readonly waiting: (() => void)[];
}

export function createBackendSlots(limitFor: (backend: string) => number): BackendSlots {
  const counters = new Map<string, Counter>();

  const counterOf = (backend: string): Counter => {
    const existing = counters.get(backend);
    if (existing !== undefined) return existing;
    const created: Counter = { active: 0, waiting: [] };
    counters.set(backend, created);
    return created;
  };

  return {
    async run(backend, call) {
      // Предел меньше единицы означал бы вызов, которому места не будет
      // никогда: прогресс важнее буквального прочтения настройки.
      const limit = Math.max(1, Math.floor(limitFor(backend)));
      const counter = counterOf(backend);

      if (counter.active >= limit) {
        await new Promise<void>((resolve) => counter.waiting.push(resolve));
      }
      counter.active += 1;

      try {
        return await call();
      } finally {
        counter.active -= 1;
        // Место передаётся первому в очереди, а не объявляется свободным:
        // иначе между освобождением и пробуждением его успел бы занять вызов,
        // пришедший позже.
        counter.waiting.shift()?.();
      }
    },
    active(backend) {
      return counters.get(backend)?.active ?? 0;
    },
  };
}
