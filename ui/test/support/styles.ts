import type { StyleSink } from '../../src/services/styles';

/**
 * Подставной приёмник стилей — общий для браузерных тестов замены
 * (`hot-swap-preserves-data`): накапливает, что было поставлено и что снято, в
 * порядке вызова, без обращения к `document` — тесты идут в Node без DOM
 * (`scripts/build-ui-tests.mjs`).
 */
export interface StyleCall {
  readonly id: string;
  readonly css: string;
}

export function fakeStyleSink(): {
  readonly sink: StyleSink;
  readonly applied: readonly StyleCall[];
  readonly removed: readonly StyleCall[];
  /** Стили, действующие прямо сейчас — поставленные и ещё не снятые, по `id`. */
  readonly active: () => readonly StyleCall[];
} {
  const applied: StyleCall[] = [];
  const removed: StyleCall[] = [];
  const live = new Map<string, StyleCall>();
  let seq = 0;

  const sink: StyleSink = (id, css) => {
    const call: StyleCall = { id, css };
    const key = `${id}#${seq++}`;
    applied.push(call);
    live.set(key, call);
    return () => {
      removed.push(call);
      live.delete(key);
    };
  };

  return { sink, applied, removed, active: () => [...live.values()] };
}
