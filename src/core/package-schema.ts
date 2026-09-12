import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, parse as parsePath, resolve } from 'node:path';
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

const PIPELINE_SUFFIX = '.yml';

/** Префикс ссылки на пайплайн поставки — `stepcast run stepcast:migrate-widgets` (`pipeline-definition`). */
export const STEPCAST_PIPELINE_PREFIX = 'stepcast:';

/** Каталог встроенных пайплайнов пакета — четвёртый встроенный слой, рядом со `scripts/`, `steps/` и `routes.yml` (`pipeline-definition`, design.md изменения `agent-edits-widgets`, Решение 11). */
function packagedPipelinesDir(): string {
  return join(findPackageRoot(HERE), 'src', 'builtin', 'pipelines');
}

/** Имена пайплайнов, поставляемых пакетом, — для перечня в отказе. */
export function packagedPipelineNames(): readonly string[] {
  let entries: string[];
  try {
    entries = readdirSync(packagedPipelinesDir());
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith(PIPELINE_SUFFIX))
    .map((entry) => entry.slice(0, -PIPELINE_SUFFIX.length))
    .sort();
}

/**
 * Путь к файлу пайплайна поставки `stepcast:<имя>` — от расположения этого
 * модуля, той же схемой, что `packagedSchemaPath` (`pipeline-definition`,
 * «Ссылка на поставку называет и пайплайн, а не только схему»): работает
 * одинаково из исходников, из `dist/`, из `node_modules` целевого репозитория
 * и из глобальной установки, потому что не зависит от каталога запуска.
 * Имя — слаг в kebab-case, проверенный до обращения к диску: `/`, `.` и `..`
 * отказывают тем же текстом, что и у схемы, раньше, чем дошло бы до чтения
 * каталога.
 */
export function packagedPipelinePath(name: string, reference?: SchemaReference): string {
  const at = reference === undefined ? {} : { file: reference.file, at: reference.declaredAt };

  if (!KEBAB_CASE.test(name)) {
    throw new StepcastError(`Имя пайплайна поставки stepcast:${name} не является слагом в kebab-case`, {
      ...at,
      hint: 'Слаг — латиница в нижнем регистре, цифры и дефис; путь, точка и .. в имени недопустимы',
    });
  }

  const dir = packagedPipelinesDir();
  const path = join(dir, `${name}${PIPELINE_SUFFIX}`);
  if (existsSync(path)) return path;

  const known = packagedPipelineNames();
  throw new StepcastError(`Пайплайн stepcast:${name} не поставляется пакетом stepcast`, {
    ...at,
    hint:
      known.length > 0
        ? `Пакет поставляет: ${known.join(', ')}`
        : `Каталог ${dir} пуст или недоступен — установка пакета stepcast неполна`,
  });
}

/** Разобранная цель `stepcast run`/`stepcast lint`: файл каталога запуска либо пайплайн поставки. */
export interface ResolvedPipelineTarget {
  readonly pipelinePath: string;
  /** Цель названа ссылкой `stepcast:<имя>` — слои `script`/`step` ищутся от каталога запуска, а не от каталога поставки. */
  readonly isSupplyPipeline: boolean;
}

/**
 * Цель позиционного аргумента: `stepcast:<имя>` — пайплайн поставки (путь от
 * расположения движка), всё остальное — **путь** от каталога запуска
 * (`pipeline-definition`, «Путь остаётся путём»). Правило одно на обе команды
 * (`stepcast run`, `stepcast lint`): написанное дважды, оно разъехалось бы —
 * и `run` с `lint` расходились бы в том, какой файл они вообще смотрят.
 *
 * Голое имя, совпавшее с именем поставки (`migrate-widgets.yml` в каталоге
 * запуска), остаётся файлом проекта: позиционный аргумент `stepcast run`
 * сегодня путь, и поставка его смысла не отнимает.
 */
export function resolvePipelineTarget(cwd: string, target: string): ResolvedPipelineTarget {
  if (!target.startsWith(STEPCAST_PIPELINE_PREFIX)) {
    return { pipelinePath: resolve(cwd, target), isSupplyPipeline: false };
  }
  return {
    pipelinePath: packagedPipelinePath(target.slice(STEPCAST_PIPELINE_PREFIX.length)),
    isSupplyPipeline: true,
  };
}

/**
 * Обёртки раннера, поставляемые пакетом (design.md, решение 7): имя →
 * скомпилированный файл от корня пакета. Пакет поставляет одну — для Node
 * (design.md, Non-Goals) — но перечень заведён множественным, а не константой,
 * чтобы вторая обёртка не потребовала переписывать разбор имени.
 */
const PACKAGED_WRAPPERS: Readonly<Record<string, string>> = {
  step: join('dist', 'src', 'step', 'wrapper.js'),
};

/** Имена обёрток, поставляемых пакетом, — для перечня в отказе и в отчёте. */
export function packagedWrapperNames(): readonly string[] {
  return Object.keys(PACKAGED_WRAPPERS).sort();
}

/**
 * Путь к обёртке `stepcast:<имя>`, поставляемой пакетом, — от расположения
 * этого модуля, той же схемой, что и `packagedSchemaPath`. Незнакомое имя —
 * отказ с перечнем поставляемых (`stepcast-configuration`, решение о
 * форме `wrapper`).
 */
export function packagedWrapperPath(name: string, reference?: SchemaReference): string {
  const at = reference === undefined ? {} : { file: reference.file, at: reference.declaredAt };
  const relative = PACKAGED_WRAPPERS[name];
  if (relative === undefined) {
    throw new StepcastError(`Обёртка stepcast:${name} не поставляется пакетом stepcast`, {
      ...at,
      hint: `Пакет поставляет: ${packagedWrapperNames().join(', ')}`,
    });
  }
  const path = join(findPackageRoot(HERE), relative);
  if (!existsSync(path)) {
    throw new StepcastError(`Обёртка stepcast:${name} не найдена по пути ${path}`, {
      ...at,
      hint: 'Установка пакета stepcast неполна — соберите его (npm run build) либо переустановите',
    });
  }
  return path;
}
