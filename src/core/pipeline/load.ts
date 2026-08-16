import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';

import { ScarpError } from '../errors.js';
import { WIRING_KEYS } from './schema.js';

/** Прочитать и разобрать YAML-документ, отдав понятную диагностику. */
export function readYamlDocument(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new ScarpError(`Файл не найден: ${path}`, { file: path, cause: error });
    }
    throw new ScarpError(`Не удалось прочитать файл: ${(error as Error).message}`, {
      file: path,
      cause: error,
    });
  }

  try {
    return parseYaml(text);
  } catch (error) {
    throw new ScarpError(`Документ не разбирается как YAML: ${(error as Error).message}`, {
      file: path,
      cause: error,
    });
  }
}

/** Проверить документ схемой, привязав ошибку к файлу и месту внутри него. */
export function validateDocument<T extends z.ZodType>(
  schema: T,
  document: unknown,
  file: string,
): z.infer<T> {
  const parsed = schema.safeParse(document);
  if (parsed.success) return parsed.data;

  const first = parsed.error.issues[0];
  const at = first === undefined ? '' : first.path.join('.');
  throw new ScarpError(`Документ не соответствует схеме: ${first?.message ?? 'неизвестная ошибка'}`, {
    file,
    ...(at === '' ? {} : { at }),
    hint: 'Сверьтесь с docs/pipeline-format.md',
  });
}

/**
 * Обвязка описывает место работы в конкретном пайплайне, поэтому внутри файла
 * работы её быть не может: иначе работа перестаёт быть переиспользуемой.
 * Схема строгая и такие ключи и так не пропустит, но диагностика по существу
 * полезнее, чем «неизвестный ключ».
 */
export function rejectWiringKeys(document: unknown, file: string): void {
  if (typeof document !== 'object' || document === null) return;
  for (const key of WIRING_KEYS) {
    if (key in (document as Record<string, unknown>)) {
      throw new ScarpError(`Ключ ${key} недопустим внутри файла работы`, {
        file,
        at: key,
        hint: 'Зависимости и условия описываются на месте подключения работы в пайплайне',
      });
    }
  }
}
