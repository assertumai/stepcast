import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, parse as parsePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StepcastError } from './errors.js';

/** Тот же слаг, что у идентификатора работы и у пункта очереди. */
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const SCHEMA_SUFFIX = '.schema.json';

/** Расположение этого модуля: и в исходниках, и в `dist/` — на одной глубине от корня пакета. */
const HERE = fileURLToPath(new URL('.', import.meta.url));

/** Корень пакета stepcast: ближайший каталог с `package.json` вверх по дереву. */
export function findPackageRoot(from: string): string {
  let current = from;
  for (;;) {
    if (existsSync(join(current, 'package.json'))) return current;
    const parent = dirname(current);
    if (parent === current || parent === parsePath(current).root) {
      throw new StepcastError('Не удалось найти корень пакета stepcast');
    }
    current = parent;
  }
}

/** Место, где ссылка на схему пакета объявлена в документе — для текста отказа. */
export interface SchemaReference {
  readonly file: string;
  readonly declaredAt: string;
}

/**
 * Путь к схеме `<имя>.schema.json`, поставляемой пакетом stepcast —
 * `<корень пакета>/schema/<имя>.schema.json`, от расположения этого модуля, а
 * не от места объявления и не от каталога запуска. Тот же приём, что уже
 * несёт схему вердикта судьи (`judgeVerdictSchemaPath`), — работает
 * одинаково из исходников (тесты), из `dist/`, из `node_modules` целевого
 * репозитория и из глобальной установки.
 *
 * Имя проверяется слагом в kebab-case до обращения к файловой системе: `/`,
 * `.` и `..` в имени отказывают раньше, чем дошло бы до чтения каталога —
 * сослаться этой формой на файл вне `schema/` нельзя.
 */
export function packagedSchemaPath(name: string, reference?: SchemaReference): string {
  const at = reference === undefined ? {} : { file: reference.file, at: reference.declaredAt };

  if (!KEBAB_CASE.test(name)) {
    throw new StepcastError(`Имя схемы stepcast:${name} не является слагом в kebab-case`, {
      ...at,
      hint: 'Слаг — латиница в нижнем регистре, цифры и дефис; путь, точка и .. в имени недопустимы',
    });
  }

  const schemaDir = join(findPackageRoot(HERE), 'schema');
  const path = join(schemaDir, `${name}${SCHEMA_SUFFIX}`);
  if (existsSync(path)) return path;

  const known = packagedSchemaNames(schemaDir);
  throw new StepcastError(`Схема stepcast:${name} не поставляется пакетом stepcast`, {
    ...at,
    hint:
      known.length > 0
        ? `Пакет поставляет: ${known.join(', ')}`
        : `Каталог ${schemaDir} пуст или недоступен — установка пакета stepcast неполна`,
  });
}

/**
 * Имена схем, поставляемых пакетом, — для перечня в отказе.
 *
 * Нечитаемый каталог `schema/` (неполная установка, нестандартная раскладка)
 * перечень не даёт, но и ошибкой чтения наверх всплыть не должен: всплывшее —
 * дефект по контракту `errors.ts` и печатается со стеком, а здесь речь всё та
 * же — об ошибке конфигурации с кодом `2`.
 */
function packagedSchemaNames(schemaDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(schemaDir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith(SCHEMA_SUFFIX))
    .map((entry) => entry.slice(0, -SCHEMA_SUFFIX.length))
    .sort();
}
