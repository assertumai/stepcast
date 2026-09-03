import { openSync, readFileSync, readSync, closeSync, statSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath, sep } from 'node:path';

import { StepcastError } from '../core/errors.js';

/** Потолок отдачи: `stdout.log` агентского шага бывает крупным. */
export const MAX_FILE_BYTES = 1024 * 1024;

/** Какой конец крупного файла отдавать: начало или конец. */
export type FileSide = 'head' | 'tail';

export interface JournalFileContent {
  readonly path: string;
  readonly bytes: number;
  readonly content: string;
  readonly truncated: boolean;
  /** Какой конец файла показан. У неусечённого файла — всегда `head`. */
  readonly side: FileSide;
}

/**
 * Отбросить обрубок многобайтовой последовательности на краю окна.
 *
 * Окно вырезается по байтам, а файл читается как UTF-8, и в этом репозитории
 * почти весь текст русский: край окна почти наверняка приходится на середину
 * двухбайтового символа. Без обрезки такой обрубок превращается в `�` — при
 * чтении хвоста ещё и в самом заметном месте, в первой строке.
 *
 * Экспортирована ради `src/ui/stepOutput.ts`: чтение дописанного от смещения
 * режет буфер по тем же двум краям — от начала при большом файле, от конца на
 * границе того, что уже дописано, — и второй копии этого правила в
 * репозитории быть не должно.
 */
export function trimPartialUtf8(buffer: Buffer, side: FileSide): Buffer {
  if (side === 'tail') {
    // Продолжающие байты (10xxxxxx) в начале окна — хвост символа, начало
    // которого осталось за окном.
    let start = 0;
    while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1;
    return buffer.subarray(start);
  }

  // Ведущий байт задаёт длину последовательности; если она не уместилась в
  // окно, символ обрывается на конце — и его начало тоже надо срезать.
  for (let back = 1; back <= 3 && back <= buffer.length; back += 1) {
    const lead = buffer[buffer.length - back]!;
    if ((lead & 0xc0) === 0x80) continue;
    const expected = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
    return expected > back ? buffer.subarray(0, buffer.length - back) : buffer;
  }

  return buffer;
}

/**
 * Путь внутри каталога прогона.
 *
 * Проверка нужна даже при том, что путь витрина выдаёт себе сама: обработчик,
 * доверяющий пути «потому что мы его сами выдали», перестаёт быть верным ровно
 * в тот день, когда снимок начнут строить из чего-то ещё.
 */
export function resolveJournalPath(runDir: string, requested: string): string {
  if (isAbsolute(requested)) {
    throw new StepcastError('Путь к файлу журнала должен быть относительным', {
      hint: 'Абсолютные пути не принимаются',
    });
  }

  const root = resolvePath(runDir);
  const target = resolvePath(root, requested);

  // Сравнение с разделителем на конце: иначе каталог-сосед с общим префиксом
  // (`<run>-other`) прошёл бы проверку как вложенный.
  if (target !== root && !target.startsWith(root + sep)) {
    throw new StepcastError('Путь ведёт за пределы каталога прогона', {
      hint: 'Витрина отдаёт только файлы внутри прогона',
    });
  }

  return target;
}

/**
 * Прочитать файл журнала, не отдавая наружу больше потолка.
 *
 * Какой конец крупного файла показать — решает вызывающий, и это не придирка:
 * у `stdout.log` причина отказа (упор в лимит сессии, таймаут, последняя
 * реплика перед обрывом) всегда в хвосте, а у JSON-артефакта осмысленное
 * начало. Отдавать всегда голову значит прятать ровно то, ради чего лог и
 * открывают, поэтому умолчание — хвост, а начало запрашивается явно.
 */
export function readJournalFile(
  runDir: string,
  requested: string,
  side: FileSide = 'tail',
): JournalFileContent {
  const target = resolveJournalPath(runDir, requested);
  const bytes = statSync(target).size;

  if (bytes <= MAX_FILE_BYTES) {
    return {
      path: requested,
      bytes,
      content: readFileSync(target, 'utf8'),
      truncated: false,
      side: 'head',
    };
  }

  const buffer = Buffer.alloc(MAX_FILE_BYTES);
  const offset = side === 'tail' ? bytes - MAX_FILE_BYTES : 0;
  const handle = openSync(target, 'r');
  try {
    readSync(handle, buffer, 0, MAX_FILE_BYTES, offset);
  } finally {
    closeSync(handle);
  }

  return {
    path: requested,
    bytes,
    content: trimPartialUtf8(buffer, side).toString('utf8'),
    truncated: true,
    side,
  };
}

/** JSON журнала для витрины: нечитаемый файл даёт undefined, а не исключение. */
export function readJournalJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}
