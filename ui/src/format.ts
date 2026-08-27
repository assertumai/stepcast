/**
 * Форматирование величин для витрины.
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

export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return DASH;
  if (ms >= 3_600_000) {
    const hours = Math.floor(ms / 3_600_000);
    const minutes = Math.round((ms % 3_600_000) / 60_000);
    return minutes === 0 ? `${hours}ч` : `${hours}ч ${minutes}м`;
  }
  if (ms >= 60_000) {
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1000);
    return seconds === 0 ? `${minutes}м` : `${minutes}м ${seconds}с`;
  }
  return `${Math.round(ms / 1000)}с`;
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
