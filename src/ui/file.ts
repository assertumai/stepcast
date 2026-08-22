import { openSync, readFileSync, readSync, closeSync, statSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath, sep } from 'node:path';

import { StepcastError } from '../core/errors.js';

/** Потолок отдачи: `stdout.log` агентского шага бывает крупным. */
export const MAX_FILE_BYTES = 1024 * 1024;

export interface JournalFileContent {
  readonly path: string;
  readonly bytes: number;
  readonly content: string;
  readonly truncated: boolean;
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

/** Прочитать файл журнала, не отдавая наружу больше потолка. */
export function readJournalFile(runDir: string, requested: string): JournalFileContent {
  const target = resolveJournalPath(runDir, requested);
  const bytes = statSync(target).size;

  if (bytes <= MAX_FILE_BYTES) {
    return { path: requested, bytes, content: readFileSync(target, 'utf8'), truncated: false };
  }

  const buffer = Buffer.alloc(MAX_FILE_BYTES);
  const handle = openSync(target, 'r');
  try {
    readSync(handle, buffer, 0, MAX_FILE_BYTES, 0);
  } finally {
    closeSync(handle);
  }

  return { path: requested, bytes, content: buffer.toString('utf8'), truncated: true };
}

/** JSON журнала для витрины: нечитаемый файл даёт undefined, а не исключение. */
export function readJournalJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}
