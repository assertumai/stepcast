import type { BudgetDimension, Event } from '../core/journal/schema.js';
import { describeBudgetAmounts, type UsageSnapshot } from '../core/budget/accumulator.js';
import { inline } from '../core/text.js';
import { formatDuration, formatMoney, formatTokens } from '../core/units.js';

/**
 * Рендеринг строк ленты хода прогона.
 *
 * Событие плюс снимок расхода даёт ноль или одну строку. Перечень печатаемых
 * видов закрыт в обе стороны (`switch` без `default`, кроме отказа в
 * молчание): вид, которого лента не знает, не печатается — иначе первое же
 * новое событие движка потекло бы в терминал сырым JSON.
 *
 * Строка не несёт ни цвета, ни возврата каретки, ни какой-либо другой
 * управляющей последовательности: перенаправление в файл должно давать
 * обычный текст.
 */

const DASH = '—';

/** Хвост строки с деталью события: пусто, если детали нет или она пуста после очистки. */
function detailSuffix(detail: string | undefined): string {
  if (detail === undefined) return '';
  const text = inline(detail);
  return text === '' ? '' : ` — ${text}`;
}

/**
 * Величины бюджетного события в единицах его измерения. Журналы, записанные
 * до появления `dimension`, печатаются прежней дробью: измерения в них нет.
 */
function budgetAmounts(dimension: BudgetDimension | undefined, used: number, limit: number): string {
  return dimension === undefined ? `${used}/${limit}` : describeBudgetAmounts(dimension, used, limit);
}

/** Время от старта прогона, собственным форматом `ч:мм:сс` — не `formatDuration()`. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `+${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** Адрес события бюджета: шаг, если известен и работа, иначе работа, иначе прогон. */
function budgetAddress(event: {
  readonly job?: string | undefined;
  readonly step?: string | undefined;
}): string {
  if (event.job !== undefined && event.step !== undefined) return `${event.job}/${event.step}`;
  if (event.job !== undefined) return event.job;
  return 'прогон';
}

/**
 * Накопленный расход прогона рядом со строкой исхода шага. Прочерк вместо
 * нуля на месте несообщённой цены — тем же правилом, что и `stepcast usage`
 * (`src/cli/commands/usage.ts`). Частично сообщённая цена несёт пометку числа
 * попыток без неё.
 */
function budgetSuffix(usage: UsageSnapshot): string {
  const tokens = formatTokens(usage.tokens);
  const cost = usage.costMicroUsd === undefined ? DASH : formatMoney(usage.costMicroUsd);
  const unreportedNote =
    usage.costMicroUsd !== undefined && usage.costUnreportedAttempts > 0
      ? ` (${usage.costUnreportedAttempts} без цены)`
      : '';
  const duration = formatDuration(usage.elapsedMs);
  return `${tokens} токенов, ${cost}${unreportedNote}, ${duration}`;
}

/**
 * Строка ленты для одного события — или `undefined`, если вид не печатается.
 *
 * `elapsedMs` — время от `run.started` до этого события, посчитанное
 * вызывающим по меткам времени самих событий: `usage.elapsedMs` для этого не
 * годится, он вычитает сон и после `budget.waiting` пошёл бы назад.
 */
export function renderProgressLine(
  event: Event,
  usage: UsageSnapshot,
  elapsedMs: number,
): string | undefined {
  const prefix = formatElapsed(elapsedMs);
  const line = (address: string, text: string): string => `${prefix}  ${address}: ${text}`;

  switch (event.kind) {
    case 'run.started':
      return line('прогон', `начат — ${inline(event.pipeline)}`);
    case 'run.finished':
      return line('прогон', `${event.status} (код ${event.exit_code})`);
    case 'job.started':
      return line(event.job, 'работа начата');
    case 'job.finished':
      return line(event.job, `работа ${event.status}${detailSuffix(event.reason)}`);
    case 'job.errored':
      return line(event.job, `работа прервана ошибкой${detailSuffix(event.detail)}`);
    case 'step.started':
      return line(`${event.job}/${event.step}`, `шаг начат (попытка ${event.attempt})`);
    case 'step.finished':
      return line(
        `${event.job}/${event.step}`,
        `шаг ${event.status} (попытка ${event.attempt})${detailSuffix(event.reason)} — ${budgetSuffix(usage)}`,
      );
    case 'step.stalled':
      return line(`${event.job}/${event.step}`, `тишина ${Math.round(event.silent_ms / 1000)}с`);
    case 'iteration.started':
      return line(event.job, `итерация ${event.iteration} начата`);
    case 'iteration.finished':
      return line(
        event.job,
        `итерация ${event.iteration} ${event.passed ? 'пройдена' : 'не пройдена'}${detailSuffix(event.reason)}`,
      );
    case 'expect.failed':
      return line(
        `${event.job}/${event.step}`,
        `предикат ${inline(event.predicate)} не прошёл (попытка ${event.attempt})${detailSuffix(event.detail)}`,
      );
    case 'budget.warning':
      return line(
        budgetAddress(event),
        `бюджет: предупреждение — ${inline(event.scope)}: ${budgetAmounts(event.dimension, event.used, event.limit)}`,
      );
    case 'budget.exceeded':
      return line(
        budgetAddress(event),
        `бюджет исчерпан — ${inline(event.scope)}: ${budgetAmounts(event.dimension, event.used, event.limit)}`,
      );
    case 'budget.waiting':
      return line(
        budgetAddress(event),
        `бюджет: сон до сброса окна (${formatDuration(event.wait_ms)})`,
      );
    case 'budget.resumed':
      return line(budgetAddress(event), `бюджет: пробуждение (${formatDuration(event.actual_ms)})`);
    case 'backend.refused':
      return line(
        `${event.job}/${event.step}`,
        `бэкенд отказал (${event.class})${detailSuffix(event.message)}`,
      );
    case 'permission.denied':
      return line(
        `${event.job}/${event.step}`,
        `отказ в разрешении: ${inline(event.tool)}${detailSuffix(event.detail)}`,
      );
    default:
      return undefined;
  }
}
