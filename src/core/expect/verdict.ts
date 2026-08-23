import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, parse as parsePath } from 'node:path';
import { fileURLToPath } from 'node:url';

// Сборка для draft 2020-12: см. evaluate.ts — тот же выбор экспорта ajv.
import { Ajv2020 } from 'ajv/dist/2020.js';

import { StepcastError } from '../errors.js';

/**
 * Схема вердикта судьи.
 *
 * Поставляется со stepcast, а не автором пайплайна: настраивать в ней нечего,
 * а её путь должен резолвиться и из исходников (тесты), и из `dist/` (прогон),
 * поэтому — от расположения этого модуля, а не от текущей директории.
 */

export interface JudgeVerdict {
  readonly pass: boolean;
  readonly reason: string;
}

export function judgeVerdictSchemaPath(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  return join(findPackageRoot(here), 'schema', 'judge-verdict.schema.json');
}

/** Корень пакета: ближайший каталог с `package.json` вверх по дереву. */
function findPackageRoot(from: string): string {
  let current = from;
  for (;;) {
    if (existsSync(join(current, 'package.json'))) return current;
    const parent = dirname(current);
    if (parent === current || parent === parsePath(current).root) {
      throw new StepcastError('Не удалось найти корень пакета stepcast для схемы вердикта судьи');
    }
    current = parent;
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(
  JSON.parse(readFileSync(judgeVerdictSchemaPath(), 'utf8')) as object,
);

/**
 * Разобрать структурированный ответ судьи.
 *
 * Принимается только структура по схеме — свободный текст не толкуется.
 * Отсутствие структурированного вывода и несоответствие схеме неразличимы для
 * вызывающего кода: оба дают «вердикта нет».
 */
export function parseVerdict(structured: unknown): JudgeVerdict | undefined {
  if (structured === undefined) return undefined;
  if (validate(structured) !== true) return undefined;
  return structured as JudgeVerdict;
}
