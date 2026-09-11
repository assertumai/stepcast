import { useRoute } from '../router';

/**
 * Пресеты периода экрана расхода (design.md изменения `ui-dashboard`, Решение
 * 5; `ui-routes`, design.md Решение 6): закрытый перечень значений — теперь
 * поле маршрута (`values.period` в `src/builtin/routes.yml`), а не объявления
 * экрана, — маршрут владеет адресом, и перечень значений параметра адреса
 * принадлежит ему же. Разбор адреса общего модуля (`src/ui/routes.ts`)
 * по-прежнему не знает имён пресетов — он лишь сверяется с объявленным
 * перечнем.
 *
 * Подписи и длительность остаются делом этого экрана: маршрут называет
 * только ключи значений, а не то, как их подписать.
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

/**
 * Пресеты, объявленные маршрутом, которым сейчас открыт экран расхода — тем
 * самым, что разобрал адрес и достался экрану параметром `period`, а не
 * первым по таблице маршрутом на эту цель: второй маршрут пользователя на
 * экран расхода со своим `values.period` дал бы иначе переключатель от чужого
 * адреса (design.md, Решение 6).
 *
 * Маршрут не объявляет `values.period` — пустой перечень: переключатель тогда
 * не показывает ни одной кнопки, но сам экран открывается по-прежнему.
 */
export function useUsagePeriods(): readonly UsagePeriod[] {
  const { route } = useRoute();
  const keys = route?.route.values?.period ?? [];
  return keys.map((key) => ({ key, ...(PRESETS[key] ?? { label: key }) }));
}

/**
 * Параметр `period` адреса в число дней. Голый `/usage` — те же 30 дней.
 * Значение вне перечня сюда не доходит: такой адрес этому маршруту не
 * принадлежит вовсе (`values` маршрута) — умолчание здесь остаётся на случай
 * прямого вызова компонента.
 */
export function daysForPeriod(period: string | undefined, periods: readonly UsagePeriod[]): number | undefined {
  if (period === undefined) return DEFAULT_USAGE_DAYS;
  const found = periods.find((candidate) => candidate.key === period);
  return found === undefined ? DEFAULT_USAGE_DAYS : found.days;
}
