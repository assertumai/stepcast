import { readFileSync } from 'node:fs';

// Сборка для draft 2020-12: см. evaluate.ts — тот же выбор экспорта ajv.
import { Ajv2020 } from 'ajv/dist/2020.js';

import { packagedSchemaPath } from '../package-schema.js';

/**
 * Схема вердикта судьи.
 *
 * Поставляется со stepcast, а не автором пайплайна: настраивать в ней нечего,
 * а её путь должен резолвиться и из исходников (тесты), и из `dist/` (прогон),
 * поэтому — от расположения движка, а не от текущей директории
 * (`packagedSchemaPath` в `../package-schema.js`).
 */

export interface JudgeVerdict {
  readonly pass: boolean;
  readonly reason: string;
}

export function judgeVerdictSchemaPath(): string {
  return packagedSchemaPath('judge-verdict');
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
