/**
 * Построчный диф двух текстов — чистый модуль без `node:*`, общий демону и
 * браузеру (`ui-proposals`, design.md Решение 8): экран очереди строит диф из
 * текущего содержимого цели и предложенного текста прямо в браузере, `git
 * diff` не годится — предложенного текста в git нет, а кабинет вправе быть
 * вне репозитория.
 *
 * Алгоритм — наивный LCS: файл кабинета весит сотни строк, и квадратичная
 * цена на них незаметна; внешняя зависимость ради дифа не заводится.
 */

export type DiffLineKind = 'same' | 'added' | 'removed';

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
}

/** Строки текста — пустая строка целиком даёт пустой перечень, а не одну пустую строку (создание файла с нуля). */
function linesOf(text: string): readonly string[] {
  return text === '' ? [] : text.split('\n');
}

/**
 * Построчный диф `before` → `after`: перечень строк с видом. Совпадающие
 * строки идут `same`, снятые из `before` — `removed`, добавленные в `after` —
 * `added`. Наибольшая общая подпоследовательность считается динамическим
 * программированием снизу вверх, восстановление — проходом сверху вниз.
 */
export function diffLines(before: string, after: string): readonly DiffLine[] {
  const a = linesOf(before);
  const b = linesOf(after);
  const n = a.length;
  const m = b.length;

  // `lcs[i][j]` — длина LCS хвостов `a[i..]` и `b[j..]`.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      result.push({ kind: 'same', text: a[i] as string });
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      result.push({ kind: 'removed', text: a[i] as string });
      i += 1;
    } else {
      result.push({ kind: 'added', text: b[j] as string });
      j += 1;
    }
  }
  while (i < n) {
    result.push({ kind: 'removed', text: a[i] as string });
    i += 1;
  }
  while (j < m) {
    result.push({ kind: 'added', text: b[j] as string });
    j += 1;
  }

  return result;
}
