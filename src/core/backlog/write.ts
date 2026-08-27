import { StepcastError } from '../errors.js';
import { parse } from './parse.js';

/**
 * Проставить поля пункту и вернуть новый текст файла. Файлов модуль не
 * трогает — запись остаётся заботой вызывающего (см. `atomicWrite`).
 *
 * Существующее поле переписывается на месте, новое дописывается за последним
 * полем пункта. Разбор повторяется на каждом поле: вставка строки сдвигает
 * все последующие позиции, а файл очереди заведомо мал.
 */
export function withFields(
  text: string,
  slug: string,
  values: Readonly<Record<string, string>>,
): string {
  let result = text;

  for (const [name, value] of Object.entries(values)) {
    assertSingleLine(name, value);
    const lines = result.split('\n');
    const entry = parse(result).find((candidate) => candidate.slug === slug);
    if (entry === undefined) {
      throw new StepcastError(`пункт «${slug}» в очереди не найден`, { at: slug });
    }

    const existing = entry.fields.get(name);
    if (existing === undefined) lines.splice(entry.lastFieldLine + 1, 0, `${name}: ${value}`);
    else lines[existing.line] = `${name}: ${value}`;

    result = lines.join('\n');
  }

  return result;
}

/**
 * Значение поля обязано занимать ровно одну строку.
 *
 * Разбор читает пункт построчно: перевод строки в значении превратил бы его
 * хвост в строку, которую не разобрать ни как поле, ни как заголовок, — и
 * следующее же чтение очереди отказало бы целиком, а не на одном пункте.
 * Сведение чужого многострочного текста к одной строке — забота вызывающего
 * (см. `runFinish`): что именно значит «свести», знает он, а не ядро.
 */
function assertSingleLine(name: string, value: string): void {
  if (!/[\n\r]/.test(value)) return;
  throw new StepcastError(
    `значение поля «${name}» обязано занимать одну строку: перевод строки сделал бы очередь неразбираемой`,
    { at: name },
  );
}
