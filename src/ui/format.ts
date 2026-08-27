/**
 * Форматирование величин для витрины.
 *
 * Модуль общий с демоном не потому, что демон им пользуется, а потому, что
 * правила здесь — чистые функции без React и без `window`, и только так их
 * достаёт обычный тест: браузерного окружения в проекте нет, и всё, что
 * осталось внутри компонентов, проверяется человеком глазами. Тот же довод,
 * по которому здесь же живут `routes.ts` и `grouping.ts`.
 *
 * Прочерк вместо нуля на месте несообщённого значения — то же правило, что и
 * в `stepcast usage` (`src/cli/commands/usage.ts`): несообщённая бэкендом
 * цена, показанная как `$0.00`, врёт о расходе, а прочерк — честно говорит
 * «неизвестно».
 */

const DASH = '—';

export function fmtTokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return DASH;
  if (value >= 1e6) return `${Number.isInteger(value / 1e6) ? value / 1e6 : (value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${Number.isInteger(value / 1e3) ? value / 1e3 : (value / 1e3).toFixed(1)}k`;
  return String(value);
}

/**
 * Длительность двумя старшими единицами.
 *
 * Округление идёт один раз — до секунд, целиком, — а разряды считаются уже из
 * округлённого. Округляя каждый разряд по отдельности, легко получить «52м
 * 60с»: 3 179 600 мс это 52 минуты и 59.6 секунды, и честные по отдельности
 * разряды складываются в число, которого на часах не бывает.
 */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return DASH;

  const total = Math.round(ms / 1000);
  if (total >= 3600) {
    const hours = Math.floor(total / 3600);
    const minutes = Math.round((total % 3600) / 60);
    // Минуты округлены вверх до целого часа: разряд переносится, а не показывается.
    if (minutes === 60) return `${hours + 1}ч`;
    return minutes === 0 ? `${hours}ч` : `${hours}ч ${minutes}м`;
  }
  if (total >= 60) {
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return seconds === 0 ? `${minutes}м` : `${minutes}м ${seconds}с`;
  }
  return `${total}с`;
}

export function fmtMoney(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return DASH;
  return `$${usd.toFixed(Math.abs(usd) >= 1 ? 2 : 4)}`;
}

export function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${bytes} Б`;
}

export function fmtTime(iso: string | undefined): string {
  if (iso === undefined) return DASH;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? DASH : date.toLocaleString('ru');
}
