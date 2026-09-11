/**
 * Приёмник стилей браузерной половины плагина (design.md `hot-swap-preserves-data`,
 * Решение 7, 8) — куда девать CSS, который принесла редакция строки, и как его
 * снять вместе с её областью.
 *
 * Подменяем параметром ядра (`BrowserKernelOptions.styleSink`, `ui/src/kernel.ts`)
 * тем же приёмом, что и `createEventSource`: браузерные тесты идут в Node без
 * DOM (`scripts/build-ui-tests.mjs`), и без шва принадлежность стиля области
 * строки не проверить вовсе. Модуль не обращается к `document` на уровне
 * модуля — только внутри самой функции умолчания, — чтобы импортироваться в
 * Node без падения.
 */

/** Поставить стиль строки на страницу, вернуть функцию его снятия. */
export type StyleSink = (id: string, css: string) => () => void;

/** Умолчание: один `<style data-plugin="<id>">` на строку в `document.head`, снятие — `remove()`. */
export const defaultStyleSink: StyleSink = (id, css) => {
  const element = document.createElement('style');
  element.dataset.plugin = id;
  element.textContent = css;
  document.head.appendChild(element);
  return () => element.remove();
};
