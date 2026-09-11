import { declaration } from '../../../src/ui/screens/usage/declaration.ts';

/**
 * Пресеты периода экрана расхода (design.md изменения `ui-dashboard`, Решение
 * 5): своё дело экрана, а не общего маршрутизатора — `src/ui/routes.ts` не
 * обязан знать имена пресетов, чтобы разобрать параметр `period` в общем виде
 * (`ui-screens`, «Навигация и разбор адреса собираются из зарегистрированных
 * экранов»).
 *
 * Состав и порядок пресетов берутся из объявления экрана — того же перечня,
 * которым демон и страница разбирают адрес (`paramValues.period`): иначе
 * переключатель однажды предложил бы период, который разбор адреса уже не
 * признаёт своим. Подписи и длительность живут здесь: объявление — про `id`,
 * параметры и адрес, а не про вид переключателя.
 */
export interface UsagePeriod {
  readonly key: string;
  readonly days?: number;
  readonly label: string;
}

/** Голый `/usage` без периода в пути — этот же период. */
export const DEFAULT_USAGE_DAYS = 30;

/** Подпись и длительность пресета. Пресет без `days` — «всё время». */
const PRESETS: Readonly<Record<string, { readonly days?: number; readonly label: string }>> = {
  '7d': { days: 7, label: '7 дней' },
  '30d': { days: DEFAULT_USAGE_DAYS, label: '30 дней' },
  '90d': { days: 90, label: '90 дней' },
  all: { label: 'всё время' },
};

export const USAGE_PERIODS: readonly UsagePeriod[] = (declaration.paramValues?.['period'] ?? []).map((key) => ({
  key,
  ...(PRESETS[key] ?? { label: key }),
}));

/**
 * Параметр `period` адреса в число дней. Голый `/usage` — те же 30 дней.
 * Значение вне перечня сюда не доходит: такой адрес этому экрану не
 * принадлежит вовсе (`paramValues` объявления) — умолчание здесь остаётся на
 * случай прямого вызова компонента.
 */
export function daysForPeriod(period: string | undefined): number | undefined {
  if (period === undefined) return DEFAULT_USAGE_DAYS;
  const found = USAGE_PERIODS.find((candidate) => candidate.key === period);
  return found === undefined ? DEFAULT_USAGE_DAYS : found.days;
}
