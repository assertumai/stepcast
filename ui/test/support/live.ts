import type { EventSourceFactory, EventSourceLike } from '../../src/services/live';

/**
 * Подставной источник событий — общий для всех браузерных тестов
 * (требование `ui-kernel`, «Источник событий MUST быть подменяем, чтобы
 * сервис проверялся без браузера»).
 *
 * Нужен не только тестам самого сервиса: ядро витрины заводит `live` наравне
 * с реестром слотов, а `EventSource` в Node нет вовсе — без подмены не
 * поднимается ни одно ядро. Модуль не `*.test.tsx`, поэтому сборщик тестов
 * (`scripts/build-ui-tests.mjs`) не берёт его точкой входа, а вкладывает в
 * каждый тест, который его импортирует.
 */

export class FakeSource implements EventSourceLike {
  closed = false;
  private readonly listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: unknown): void {
    const event = { data: JSON.stringify(data) } as MessageEvent<string>;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

/** Фабрика источников и перечень всего, что она успела открыть, — в порядке открытия. */
export function fakeEventSources(): { readonly factory: EventSourceFactory; readonly sources: readonly FakeSource[] } {
  const sources: FakeSource[] = [];
  const factory: EventSourceFactory = (url) => {
    const source = new FakeSource(url);
    sources.push(source);
    return source;
  };
  return { factory, sources };
}
