/**
 * Слияние имён классов: `undefined`/`false`/пустая строка отфильтрованы, а
 * не превращены в `"undefined"` в разметке (design.md изменения
 * `shared-module-table`, Решение 6). Библиотека — обычный CSS на токенах, а
 * не Tailwind, поэтому конфликтов утилитных классов, которые решает
 * `tailwind-merge`, здесь не бывает: простой join — весь нужный инструмент.
 */
export function cn(...classes: readonly (string | false | undefined | null)[]): string {
  return classes.filter((value): value is string => typeof value === 'string' && value.length > 0).join(' ');
}
