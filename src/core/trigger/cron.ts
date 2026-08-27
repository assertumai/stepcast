/**
 * Разбор cron-выражения и вычисление ближайшего момента срабатывания.
 *
 * Подмножество грамматики crontab: `*`, число, диапазон `a-b`, список через
 * запятую и шаг (звёздочка со слэшем и числом, `a-b/n`). Имена месяцев и дней, макросы `@...` и
 * расширения Quartz (`?`, `L`, `#`, поле секунд) сознательно не поддержаны —
 * толковать их по догадке значило бы молча принять то, чего пользователь не
 * писал (см. design.md, раздел «Грамматика cron»).
 *
 * Не называть этот модуль или его функции `scheduler` — так уже называется
 * планировщик графа работ в `src/core/run/scheduler.ts`.
 */

export interface CronMask {
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly dayOfMonth: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  readonly dayOfWeek: ReadonlySet<number>;
  /** День месяца задан не как `*` — участвует в объединении по «или». */
  readonly dayOfMonthRestricted: boolean;
  /** День недели задан не как `*` — участвует в объединении по «или». */
  readonly dayOfWeekRestricted: boolean;
}

export type ParseResult = { readonly ok: true; readonly mask: CronMask } | { readonly ok: false; readonly reason: string };

export type OccurrenceResult =
  | { readonly ok: true; readonly at: number }
  | { readonly ok: false; readonly reason: string };

interface FieldSpec {
  readonly name: string;
  readonly min: number;
  readonly max: number;
}

const FIELD_SPECS: readonly FieldSpec[] = [
  { name: 'минута', min: 0, max: 59 },
  { name: 'час', min: 0, max: 23 },
  { name: 'день месяца', min: 1, max: 31 },
  { name: 'месяц', min: 1, max: 12 },
  { name: 'день недели', min: 0, max: 6 },
];

type FieldResult = { readonly ok: true; readonly values: Set<number> } | { readonly ok: false; readonly reason: string };

/** Разобрать одно поле: список через запятую из `*`, числа, диапазона и шага. */
function parseField(raw: string, spec: FieldSpec): FieldResult {
  const values = new Set<number>();

  for (const part of raw.split(',')) {
    if (part === '') {
      return { ok: false, reason: `Поле ${spec.name} содержит пустой элемент списка` };
    }

    const stepMatch = /^([^/]+)\/(\d+)$/.exec(part);
    const base = stepMatch === null ? part : (stepMatch[1] as string);
    const step = stepMatch === null ? 1 : Number(stepMatch[2]);

    if (stepMatch !== null) {
      if (step <= 0) {
        return { ok: false, reason: `Шаг поля ${spec.name} должен быть положительным: ${part}` };
      }
      if (base !== '*' && !/^\d+-\d+$/.test(base)) {
        return {
          ok: false,
          reason: `Шаг поля ${spec.name} поддержан только для * и диапазона a-b: ${part}`,
        };
      }
    }

    let start: number;
    let end: number;
    if (base === '*') {
      start = spec.min;
      end = spec.max;
    } else if (/^\d+-\d+$/.test(base)) {
      const [a, b] = base.split('-').map(Number) as [number, number];
      if (a > b) {
        return { ok: false, reason: `Диапазон поля ${spec.name} задан в обратном порядке: ${base}` };
      }
      start = a;
      end = b;
    } else if (/^\d+$/.test(base)) {
      start = Number(base);
      end = start;
    } else {
      return { ok: false, reason: `Неразбираемое значение поля ${spec.name}: ${part}` };
    }

    if (start < spec.min || end > spec.max) {
      return {
        ok: false,
        reason: `Поле ${spec.name} допускает диапазон ${spec.min}-${spec.max}, получено ${part}`,
      };
    }

    for (let value = start; value <= end; value += step) values.add(value);
  }

  return { ok: true, values };
}

/** Метасимволы расширений Quartz: `?` (не задано), `L` (последний), `#` (n-й день недели месяца). */
const QUARTZ_CHARS = /[?L#]/;
const HAS_LETTER = /[a-zA-Z]/;

/**
 * Разобрать cron-выражение в маску. Не бросает исключение — вызывающий код
 * (`stepcast lint`) собирает диагностики по многим записям сразу и не должен
 * останавливаться на первой.
 */
export function parseCron(expression: string): ParseResult {
  const trimmed = expression.trim();

  if (trimmed.startsWith('@')) {
    return {
      ok: false,
      reason: `Макросы вида ${trimmed} не поддержаны — распишите пять полей явно`,
    };
  }

  const fields = trimmed.split(/\s+/).filter((field) => field.length > 0);
  if (fields.length !== 5) {
    return {
      ok: false,
      reason: `Ожидается 5 полей (минута час день_месяца месяц день_недели), получено ${fields.length}`,
    };
  }

  const parsed: Set<number>[] = [];
  for (const [index, spec] of FIELD_SPECS.entries()) {
    const raw = fields[index] as string;

    if (QUARTZ_CHARS.test(raw)) {
      return {
        ok: false,
        reason: `Расширения Quartz (?, L, #) не поддержаны: поле ${spec.name} содержит ${raw}`,
      };
    }
    if (HAS_LETTER.test(raw)) {
      return {
        ok: false,
        reason: `Имена месяцев и дней недели не поддержаны: поле ${spec.name} содержит ${raw}`,
      };
    }

    const field = parseField(raw, spec);
    if (!field.ok) return field;
    parsed.push(field.values);
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parsed as [
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
  ];

  return {
    ok: true,
    mask: {
      minute,
      hour,
      dayOfMonth,
      month,
      dayOfWeek,
      dayOfMonthRestricted: fields[2] !== '*',
      dayOfWeekRestricted: fields[4] !== '*',
    },
  };
}

/** Известно ли имя часового пояса базе ICU движка. */
export function isKnownTimeZone(name: string): boolean {
  try {
    const format = new Intl.DateTimeFormat('en-US', { timeZone: name });
    return format.resolvedOptions().timeZone !== undefined;
  } catch {
    return false;
  }
}

interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

function formatZonedParts(
  zone: string,
  utcMs: number,
  options: Intl.DateTimeFormatOptions,
): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-US', { ...options, timeZone: zone }).formatToParts(
    new Date(utcMs),
  );
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

const LOCAL_PARTS_OPTIONS: Intl.DateTimeFormatOptions = {
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
};

function zonedParts(zone: string, utcMs: number): LocalParts {
  const map = formatZonedParts(zone, utcMs, LOCAL_PARTS_OPTIONS);
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
  };
}

/** Смещение пояса от UTC в момент `utcMs`, в миллисекундах — положительное к востоку. */
function timeZoneOffsetMs(zone: string, utcMs: number): number {
  const map = formatZonedParts(zone, utcMs, { ...LOCAL_PARTS_OPTIONS, second: '2-digit' });
  const asIfUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second),
  );
  return asIfUtc - utcMs;
}

/** Прибавить одну минуту к наивным (без пояса) календарным полям. */
function addMinute(parts: LocalParts): LocalParts {
  const next = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute + 1, 0),
  );
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
    hour: next.getUTCHours(),
    minute: next.getUTCMinutes(),
  };
}

function matchesMask(mask: CronMask, parts: LocalParts): boolean {
  if (!mask.minute.has(parts.minute)) return false;
  if (!mask.hour.has(parts.hour)) return false;
  if (!mask.month.has(parts.month)) return false;

  // День недели считается по наивному календарю — тем же способом, что
  // задаёт наивную арифметику `addMinute`: `Date.UTC` здесь снова не про
  // настоящее UTC-время, а про календарь, и день недели от него не зависит
  // от часового пояса.
  const dayOfWeek = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  const domMatch = mask.dayOfMonth.has(parts.day);
  const dowMatch = mask.dayOfWeek.has(dayOfWeek);

  // День месяца и день недели, заданные оба, объединяются по «или» — как в
  // crontab. Если ограничено только одно (или ни одного), действует обычное
  // «и»: неограниченное поле матчится маской из полного диапазона, и оно не
  // портит результат обычного «и» само по себе.
  if (mask.dayOfMonthRestricted && mask.dayOfWeekRestricted) return domMatch || dowMatch;
  return domMatch && dowMatch;
}

/** Горизонт поиска: заведомо больше числа минут в четырёх годах, включая високосные. */
const HORIZON_MINUTES = 4 * 366 * 24 * 60;

/** Наибольшее число дней в месяце, считая февраль високосного года. */
const MAX_DAYS_IN_MONTH: readonly number[] = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Может ли маска сработать хоть когда-нибудь — проверка по календарю, без
 * перебора и без обращения к текущему времени.
 *
 * Невыполнимой маску делает только сочетание дня месяца с месяцем: 30 февраля
 * не наступает никогда, тогда как любой день недели наступает в любом месяце,
 * а любые минута и час — в любом дне (кроме часа, пропущенного переходом на
 * летнее время в один день года; это не делает расписание невыполнимым).
 * Такая проверка нужна `stepcast lint`: перебор от «сейчас» сделал бы вердикт
 * линта зависящим от дня запуска у расписаний, чьё срабатывание лежит близко
 * к краю горизонта.
 */
export function isSatisfiable(mask: CronMask): boolean {
  if (mask.minute.size === 0 || mask.hour.size === 0 || mask.month.size === 0) return false;
  if (mask.dayOfMonth.size === 0 || mask.dayOfWeek.size === 0) return false;

  // День недели, заданный вместе с днём месяца, объединяется по «или» и сам по
  // себе выполним — тогда сочетание месяца с днём месяца ничего не запрещает.
  if (mask.dayOfWeekRestricted) return true;
  if (!mask.dayOfMonthRestricted) return true;

  for (const month of mask.month) {
    const maxDay = MAX_DAYS_IN_MONTH[month - 1] as number;
    for (const day of mask.dayOfMonth) {
      if (day <= maxDay) return true;
    }
  }
  return false;
}

/**
 * Мгновение UTC, которому в поясе `zone` отвечает наивная минута `parts`, или
 * `undefined`, если такой минуты в этом поясе нет.
 *
 * Смещение пояса зависит от мгновения, а не от наивных полей, поэтому одним
 * пересчётом не обойтись: смещение, взятое в самой наивной минуте,
 * истолкованной как UTC, — это смещение совсем другого мгновения, и в сутки
 * перехода оно уводит кандидата на час. Поэтому кандидаты строятся по каждому
 * смещению, действующему в окрестности искомой минуты: смещения снимаются за
 * сутки до, в самой минуте и через сутки после (переходы дальше друг от друга,
 * чем на сутки), плюс уточнение — смещение в уже полученном кандидате. Каждый
 * кандидат проверяется обратным пересчётом: несуществующая минута проверки не
 * проходит ни в одном кандидате, у существующей проходит хотя бы один, а у
 * повторённой при переходе назад — два. Берётся ранний из тех, что позже
 * `afterUtcMs`: так на повторённый час приходится ровно одно срабатывание, и
 * оно не оказывается в прошлом, если отсчёт начат внутри самого повторённого
 * часа.
 */
function resolveLocalMinute(zone: string, parts: LocalParts, afterUtcMs: number): number | undefined {
  const naive = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
  const day = 24 * 60 * 60 * 1000;

  const offsets = new Set<number>();
  for (const probe of [naive - day, naive, naive + day]) offsets.add(timeZoneOffsetMs(zone, probe));
  for (const offset of [...offsets]) offsets.add(timeZoneOffsetMs(zone, naive - offset));

  let best: number | undefined;
  for (const offset of offsets) {
    const candidate = naive - offset;
    if (candidate <= afterUtcMs) continue;
    const roundTrip = zonedParts(zone, candidate);
    if (
      roundTrip.year === parts.year &&
      roundTrip.month === parts.month &&
      roundTrip.day === parts.day &&
      roundTrip.hour === parts.hour &&
      roundTrip.minute === parts.minute &&
      (best === undefined || candidate < best)
    ) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Ближайший момент срабатывания после `afterUtcMs`, в часовом поясе `timezone`.
 *
 * Перебор идёт по наивным локальным минутам, а не по UTC: перебор по UTC на
 * переходе летнего времени либо не находит существующий локальный момент,
 * либо находит его дважды. Наивная минута проверяется на совпадение с маской,
 * а затем — обратным пересчётом в тот же пояс — на существование: несуществующий
 * локальный час (пропуск при переходе вперёд) не проходит эту проверку и
 * пропускается, а повторённый (переход назад) даёт ровно один момент — ранний,
 * — потому что каждая наивная минута перебирается ровно один раз.
 */
export function nextOccurrence(mask: CronMask, timezone: string, afterUtcMs: number): OccurrenceResult {
  if (!isKnownTimeZone(timezone)) {
    return { ok: false, reason: `Неизвестный часовой пояс: ${timezone}` };
  }

  let parts = zonedParts(timezone, afterUtcMs);
  parts = addMinute(parts);

  for (let i = 0; i < HORIZON_MINUTES; i += 1) {
    if (matchesMask(mask, parts)) {
      const at = resolveLocalMinute(timezone, parts, afterUtcMs);
      if (at !== undefined) return { ok: true, at };
      // Наивная минута не существует в этом поясе (пропуск при переходе на
      // летнее время вперёд) — переходим к следующей.
    }

    parts = addMinute(parts);
  }

  return { ok: false, reason: `В горизонте поиска (4 года) нет ни одного момента срабатывания` };
}
