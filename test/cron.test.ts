import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isKnownTimeZone,
  isSatisfiable,
  nextOccurrence,
  parseCron,
  type CronMask,
} from '../src/core/trigger/cron.js';

function mask(expression: string): CronMask {
  const parsed = parseCron(expression);
  assert.equal(parsed.ok, true, `выражение должно разбираться: ${expression}`);
  return (parsed as { ok: true; mask: CronMask }).mask;
}

/** Все моменты срабатывания в полуинтервале `(from, until]`, в ISO-виде. */
function occurrences(expression: string, zone: string, from: number, until: number): string[] {
  const m = mask(expression);
  const out: string[] = [];
  let cursor = from;
  for (let i = 0; i < 500; i += 1) {
    const found = nextOccurrence(m, zone, cursor);
    if (!found.ok) break;
    const at = (found as { ok: true; at: number }).at;
    if (at > until) break;
    out.push(new Date(at).toISOString());
    cursor = at;
  }
  return out;
}

describe('trigger/cron: разбор выражения', () => {
  it('принимает все поддержанные формы полей', () => {
    const parsed = parseCron('*/15 1-5 1,15 * *');
    assert.equal(parsed.ok, true);
  });

  it('принимает диапазон с шагом', () => {
    const parsed = parseCron('0 0-10/2 * * *');
    assert.equal(parsed.ok, true);
  });

  it('отклоняет макрос @daily, называя макросы неподдержанной формой', () => {
    const parsed = parseCron('@daily');
    assert.equal(parsed.ok, false);
    assert.match((parsed as { ok: false; reason: string }).reason, /[Мм]акрос/);
  });

  it('отклоняет имя дня недели, называя имена неподдержанной формой', () => {
    const parsed = parseCron('0 3 * * mon');
    assert.equal(parsed.ok, false);
    assert.match((parsed as { ok: false; reason: string }).reason, /[Ии]мена/);
  });

  it('отклоняет четыре поля, называя ожидаемое число полей', () => {
    const parsed = parseCron('0 3 * *');
    assert.equal(parsed.ok, false);
    assert.match((parsed as { ok: false; reason: string }).reason, /5/);
  });

  it('отклоняет шесть полей', () => {
    const parsed = parseCron('0 0 3 * * *');
    assert.equal(parsed.ok, false);
    assert.match((parsed as { ok: false; reason: string }).reason, /5/);
  });

  it('отклоняет значение вне диапазона поля часа', () => {
    const parsed = parseCron('0 24 * * *');
    assert.equal(parsed.ok, false);
    assert.match((parsed as { ok: false; reason: string }).reason, /час/);
    assert.match((parsed as { ok: false; reason: string }).reason, /0-23/);
  });

  it('отклоняет расширение Quartz "?"', () => {
    const parsed = parseCron('0 3 ? * *');
    assert.equal(parsed.ok, false);
    assert.match((parsed as { ok: false; reason: string }).reason, /Quartz/);
  });
});

describe('trigger/cron: вычисление моментов', () => {
  it('находит ближайший ежедневный момент', () => {
    const result = nextOccurrence(mask('0 3 * * *'), 'UTC', Date.UTC(2026, 0, 1, 0, 0));
    assert.equal(result.ok, true);
    assert.equal(new Date((result as { ok: true; at: number }).at).toISOString(), '2026-01-01T03:00:00.000Z');
  });

  it('находит ближайший ежечасный момент', () => {
    const result = nextOccurrence(mask('0 * * * *'), 'UTC', Date.UTC(2026, 0, 1, 3, 30));
    assert.equal(result.ok, true);
    assert.equal(new Date((result as { ok: true; at: number }).at).toISOString(), '2026-01-01T04:00:00.000Z');
  });

  it('находит ближайший шаговый момент', () => {
    const result = nextOccurrence(mask('*/15 * * * *'), 'UTC', Date.UTC(2026, 0, 1, 3, 16));
    assert.equal(result.ok, true);
    assert.equal(new Date((result as { ok: true; at: number }).at).toISOString(), '2026-01-01T03:30:00.000Z');
  });

  it('объединяет 13-е число и пятницу по «или»', () => {
    const m = mask('0 3 13 * 5');
    const after = Date.UTC(2026, 0, 1);
    const horizon = Date.UTC(2026, 5, 1);

    const dates: string[] = [];
    let cursor = after;
    for (let i = 0; i < 200; i += 1) {
      const found = nextOccurrence(m, 'UTC', cursor);
      if (!found.ok || found.at > horizon) break;
      dates.push(new Date(found.at).toISOString().slice(0, 10));
      cursor = found.at;
    }

    assert.ok(dates.some((date) => date.endsWith('-13')), 'должно быть 13-е число');
    const fridays = dates.filter((date) => new Date(`${date}T00:00:00Z`).getUTCDay() === 5);
    assert.ok(fridays.length > 0, 'должна быть хотя бы одна пятница');
  });

  it('находит 29 февраля в горизонте', () => {
    const result = nextOccurrence(mask('0 0 29 2 *'), 'UTC', Date.UTC(2025, 0, 1));
    assert.equal(result.ok, true);
    assert.equal(new Date((result as { ok: true; at: number }).at).getUTCFullYear() % 4, 0);
  });

  it('30 февраля не даёт срабатываний', () => {
    const result = nextOccurrence(mask('0 0 30 2 *'), 'UTC', Date.UTC(2026, 0, 1));
    assert.equal(result.ok, false);
  });
});

describe('trigger/cron: часовые пояса', () => {
  it('один и тот же момент в двух поясах даёт разные мгновения', () => {
    const m = mask('0 9 * * *');
    const after = Date.UTC(2026, 0, 1);
    const moscow = nextOccurrence(m, 'Europe/Moscow', after);
    const tokyo = nextOccurrence(m, 'Asia/Tokyo', after);
    assert.equal(moscow.ok, true);
    assert.equal(tokyo.ok, true);
    assert.notEqual((moscow as { ok: true; at: number }).at, (tokyo as { ok: true; at: number }).at);
  });

  it('пояс не объявлен вычисляется по машине', () => {
    // Проверяется само наличие результата: конкретный пояс машины неизвестен тесту.
    const result = nextOccurrence(mask('0 3 * * *'), Intl.DateTimeFormat().resolvedOptions().timeZone, Date.UTC(2026, 0, 1));
    assert.equal(result.ok, true);
  });

  it('неизвестный часовой пояс отклоняется', () => {
    const result = nextOccurrence(mask('0 3 * * *'), 'Mars/Olympus', Date.UTC(2026, 0, 1));
    assert.equal(result.ok, false);
  });

  it('isKnownTimeZone узнаёт валидные и не узнаёт неизвестные пояса', () => {
    assert.equal(isKnownTimeZone('Europe/Moscow'), true);
    assert.equal(isKnownTimeZone('Mars/Olympus'), false);
  });

  it('несуществующий локальный час в день перехода на летнее время срабатывания не даёт', () => {
    // America/New_York, весенний переход 2024: 10 марта 2024, 02:00 → 03:00.
    // Расписание на 2:30 в этот день не существует и не должно сработать в
    // пределах суток; следующее срабатывание — на следующий день.
    const m = mask('30 2 * * *');
    const before = Date.UTC(2024, 2, 9, 12, 0); // 9 марта, полдень UTC
    const result = nextOccurrence(m, 'America/New_York', before);
    assert.equal(result.ok, true);
    const at = (result as { ok: true; at: number }).at;
    const iso = new Date(at).toISOString();
    // Ожидается 11 марта (10-е пропущено), не 10-е.
    assert.equal(iso.startsWith('2024-03-11'), true);
  });

  it('существующий час в день перехода вперёд срабатывает', () => {
    // America/New_York, весенний переход 2026: 8 марта, 02:00 → 03:00.
    // 03:00 в этот день существует и приходится на 07:00Z (EDT, -4).
    const found = occurrences(
      '0 3 * * *',
      'America/New_York',
      Date.UTC(2026, 2, 8, 0, 0),
      Date.UTC(2026, 2, 8, 23, 59),
    );
    assert.deepEqual(found, ['2026-03-08T07:00:00.000Z']);
  });

  it('ежечасное расписание переживает переход вперёд без потери часов', () => {
    // В сутках перехода вперёд 23 локальных часа: 02:30 не существует, всё
    // остальное существует ровно один раз.
    const day = occurrences(
      '30 * * * *',
      'America/New_York',
      Date.UTC(2026, 2, 8, 5, 0), // локально 00:00 EST 8 марта
      Date.UTC(2026, 2, 9, 4, 0), // локально 00:00 EDT 9 марта
    );
    assert.equal(day.length, 23, `ожидалось 23 срабатывания, получено ${day.length}: ${day.join(', ')}`);
    assert.equal(day[0], '2026-03-08T05:30:00.000Z'); // 00:30 EST
    assert.equal(day[1], '2026-03-08T06:30:00.000Z'); // 01:30 EST
    assert.equal(day[2], '2026-03-08T07:30:00.000Z'); // 03:30 EDT, час перехода
  });

  it('повторённый час при переходе назад даёт ровно одно срабатывание — раннее', () => {
    // Europe/Berlin, осенний переход 2026: 25 октября, 03:00 CEST → 02:00 CET.
    // Локальное 02:30 существует дважды: 00:30Z (CEST) и 01:30Z (CET).
    // Ожидается одно срабатывание, и именно раннее.
    const found = occurrences(
      '30 2 * * *',
      'Europe/Berlin',
      Date.UTC(2026, 9, 24, 12, 0),
      Date.UTC(2026, 9, 25, 12, 0),
    );
    assert.deepEqual(found, ['2026-10-25T00:30:00.000Z']);
  });

  it('ежечасное расписание переживает переход назад, повторяя час один раз', () => {
    // В сутках перехода назад 25 локальных часов, но повторённый час даёт
    // одно срабатывание: 24 всего.
    const day = occurrences(
      '30 * * * *',
      'Europe/Berlin',
      Date.UTC(2026, 9, 24, 22, 0), // локально 00:00 CEST 25 октября
      Date.UTC(2026, 9, 25, 23, 0), // локально 00:00 CET 26 октября
    );
    assert.equal(day.length, 24, `ожидалось 24 срабатывания, получено ${day.length}: ${day.join(', ')}`);
    assert.equal(day[1], '2026-10-24T23:30:00.000Z'); // 01:30 CEST
    assert.equal(day[2], '2026-10-25T00:30:00.000Z'); // 02:30 CEST — раннее прохождение
    assert.equal(day[3], '2026-10-25T02:30:00.000Z'); // 03:30 CET, повторённый час не удвоен
  });

  it('отсчёт изнутри повторённого часа не даёт момента в прошлом', () => {
    // Отсчёт от 01:15Z 25 октября — это второе прохождение 02:15 в Берлине,
    // раннее прохождение 02:30 (00:30Z) уже позади.
    const after = Date.UTC(2026, 9, 25, 1, 15);
    const result = nextOccurrence(mask('30 2 * * *'), 'Europe/Berlin', after);
    assert.equal(result.ok, true);
    const at = (result as { ok: true; at: number }).at;
    assert.ok(at > after, `момент должен быть в будущем, получено ${new Date(at).toISOString()}`);
    assert.equal(new Date(at).toISOString(), '2026-10-25T01:30:00.000Z');
  });
});

describe('trigger/cron: выполнимость маски', () => {
  it('признаёт обычные расписания выполнимыми', () => {
    assert.equal(isSatisfiable(mask('0 3 * * *')), true);
    assert.equal(isSatisfiable(mask('*/15 1-5 1,15 * *')), true);
    assert.equal(isSatisfiable(mask('0 0 29 2 *')), true);
  });

  it('признаёт 30 февраля невыполнимым', () => {
    assert.equal(isSatisfiable(mask('0 0 30 2 *')), false);
  });

  it('день недели вместе с днём месяца делает маску выполнимой по «или»', () => {
    assert.equal(isSatisfiable(mask('0 0 30 2 5')), true);
  });

  it('вердикт не зависит от текущего времени', () => {
    // Тот же ответ, что у перебора, но без обращения к «сейчас».
    assert.equal(isSatisfiable(mask('0 0 31 4 *')), false);
    assert.equal(isSatisfiable(mask('0 0 31 1 *')), true);
  });
});
