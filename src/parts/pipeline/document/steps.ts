import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve as resolvePath, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { Ajv2020 } from 'ajv/dist/2020.js';

import type { Config } from '../config/resolve.js';
import { validateAgainstSchema } from '../expect/evaluate.js';
import { describeSchemaFailure } from '../../../kernel/schema-failure.js';
import { packagedSchemaPath } from '../domain/package-schema.js';
import {
  DEFERRED_NAMESPACES,
  fingerprintContent,
  isFile,
  resolveWrapper,
  selectRunner,
  type ScriptRoots,
} from './expand.js';
import { placeholderNamespaces } from './interpolate.js';
import { StepManifestSchema } from './schema.js';
import type { ResolvedScript, ScriptUnresolved, StepLayer, UsesOrigin } from './model.js';

/**
 * Разрешение имени переиспользуемого шага и чтение его манифеста
 * (design.md, каталог с манифестом). Ни одна из функций здесь не бросает
 * исключение на промахе — движок или конфигурация автора манифеста могут
 * быть в любом состоянии, и `stepcast lint` обязан назвать все промахи
 * документа за один проход (design.md, решение 8): каждый промах приходит
 * значением `ScriptUnresolved`, а не через throw.
 */

const STEP_LAYERS: ReadonlyArray<readonly [StepLayer, (roots: ScriptRoots) => string]> = [
  ['project', (roots) => join(roots.project, '.stepcast', 'steps')],
  ['home', (roots) => join(roots.home, '.stepcast', 'steps')],
  ['builtin', (roots) => roots.builtin],
];

/**
 * Найти каталог шага по имени, слоями (design.md, решение 3). Каталог без
 * `step.yml` не считается каталогом шага — слой просматривается дальше, как и
 * при отсутствующем каталоге: `isFile` на несуществующем пути тоже даёт
 * `false`, и разница между «каталога нет» и «каталог есть, манифеста нет» не
 * нужна на этом шаге.
 */
function findStepDir(
  name: string,
  roots: ScriptRoots,
): { readonly layer: StepLayer; readonly dir: string } | { readonly searched: readonly string[] } {
  const searched: string[] = [];
  for (const [layer, dirFor] of STEP_LAYERS) {
    const dir = join(dirFor(roots), name);
    searched.push(dir);
    if (isFile(join(dir, 'step.yml'))) return { layer, dir };
  }
  return { searched };
}

interface ReadManifest {
  readonly layer: StepLayer;
  readonly stepDir: string;
  readonly manifestPath: string;
  readonly manifestFingerprint: string;
  readonly declaredFile: string;
  readonly declaredRunner: string | undefined;
  readonly declaredOutputSchema: string | undefined;
  /** Схема параметров, объявленная манифестом, — необязательна: шаг может не принимать `with` вовсе. */
  readonly paramsSchema: Readonly<Record<string, unknown>> | undefined;
}

const ajv = new Ajv2020({ allErrors: true, strict: false });

/** Схема параметров манифеста обязана быть объектной JSON Schema (design.md, решение 4). */
function paramsSchemaDefect(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'params обязана быть объектом — JSON Schema, описывающей with';
  }
  const schema = value as Record<string, unknown>;
  if (schema.type !== 'object' || typeof schema.properties !== 'object' || schema.properties === null) {
    return 'params обязана быть объектной схемой — type: object с properties';
  }
  try {
    ajv.compile(schema);
  } catch (error) {
    return `params не компилируется как JSON Schema: ${(error as Error).message}`;
  }
  return undefined;
}

/** Прочитать и проверить манифест каталога, уже найденного слоем. */
function readManifest(
  name: string,
  layer: StepLayer,
  stepDir: string,
): { readonly ok: true; readonly manifest: ReadManifest } | { readonly ok: false; readonly reason: ScriptUnresolved } {
  const manifestPath = join(stepDir, 'step.yml');

  let text: string;
  try {
    text = readFileSync(manifestPath, 'utf8');
  } catch (error) {
    return {
      ok: false,
      reason: {
        reason: 'manifest_invalid',
        name,
        manifestPath,
        detail: `не удалось прочитать файл: ${(error as Error).message}`,
      },
    };
  }

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    return {
      ok: false,
      reason: {
        reason: 'manifest_invalid',
        name,
        manifestPath,
        detail: `документ не разбирается как YAML: ${(error as Error).message}`,
      },
    };
  }

  const parsed = StepManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const failure = describeSchemaFailure(parsed.error);
    return {
      ok: false,
      reason: {
        reason: 'manifest_invalid',
        name,
        manifestPath,
        detail: failure.at === undefined ? failure.message : `${failure.at}: ${failure.message}`,
      },
    };
  }

  const doc = parsed.data;
  if (doc.name !== name) {
    return {
      ok: false,
      reason: { reason: 'name_mismatch', name, manifestName: doc.name, manifestPath },
    };
  }

  if (doc.params !== undefined) {
    const defect = paramsSchemaDefect(doc.params);
    if (defect !== undefined) {
      return { ok: false, reason: { reason: 'manifest_invalid', name, manifestPath, detail: defect } };
    }
  }

  return {
    ok: true,
    manifest: {
      layer,
      stepDir,
      manifestPath,
      manifestFingerprint: fingerprintContent(text),
      declaredFile: doc.file,
      declaredRunner: doc.runner,
      declaredOutputSchema: doc.output_schema,
      paramsSchema: doc.params as Readonly<Record<string, unknown>> | undefined,
    },
  };
}

/**
 * Разрешить путь внутри манифеста относительно каталога шага, отклонив всё,
 * что уводит за его пределы (design.md, решение 9). Каталог — единица
 * переноса: слои внутри манифеста не применяются вовсе, только этот один
 * каталог.
 */
function resolveWithinStepDir(
  value: string,
  stepDir: string,
): { readonly ok: true; readonly absolute: string } | { readonly ok: false; readonly detail: string } {
  const absolute = isAbsolute(value) ? value : resolvePath(stepDir, value);
  const base = stepDir.endsWith(sep) ? stepDir : stepDir + sep;
  if (absolute !== stepDir && !absolute.startsWith(base)) {
    return { ok: false, detail: `путь ${value} выходит за пределы каталога шага ${stepDir}` };
  }
  return { ok: true, absolute };
}

const STEPCAST_SCHEMA_PREFIX = 'stepcast:';

/**
 * Разрешить `output_schema` манифеста: форма `stepcast:<имя>` адресует схему
 * пакета и границы каталога не касается (design.md, решение 9, то же
 * исключение, что у `output_schema` шага `script`); прочее значение —
 * относительно каталога шага, с той же проверкой границы, что и у `file`.
 */
function resolveManifestOutputSchema(
  value: string,
  manifest: ReadManifest,
): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly detail: string } {
  if (value.startsWith(STEPCAST_SCHEMA_PREFIX)) {
    try {
      return {
        ok: true,
        path: packagedSchemaPath(value.slice(STEPCAST_SCHEMA_PREFIX.length), {
          file: manifest.manifestPath,
          declaredAt: 'output_schema',
        }),
      };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  }
  const resolved = resolveWithinStepDir(value, manifest.stepDir);
  if (!resolved.ok) return resolved;
  return { ok: true, path: resolved.absolute };
}

/** Собрать скрипт шага из манифеста: путь, раннер, argv, отпечаток (design.md, решение 9). */
function resolveManifestScript(
  name: string,
  manifest: ReadManifest,
  config: Config,
  scriptRoots: ScriptRoots,
): { readonly resolved: ResolvedScript } | { readonly unresolved: ScriptUnresolved } {
  const fileCheck = resolveWithinStepDir(manifest.declaredFile, manifest.stepDir);
  if (!fileCheck.ok) {
    return {
      unresolved: { reason: 'manifest_invalid', name, manifestPath: manifest.manifestPath, detail: fileCheck.detail },
    };
  }
  if (!isFile(fileCheck.absolute)) {
    return {
      unresolved: {
        reason: 'step_file_missing',
        name,
        manifestPath: manifest.manifestPath,
        expectedPath: fileCheck.absolute,
      },
    };
  }

  const content = readFileSync(fileCheck.absolute, 'utf8');
  const runner = selectRunner(manifest.declaredRunner, fileCheck.absolute, content, config);
  if ('reason' in runner) return { unresolved: runner };

  // Обёртка ищется в тех же корнях, что и у шага `script`: она не часть
  // каталога шага, а свойство раннера, объявленного конфигурацией проекта.
  const wrapperPath = resolveWrapper(config.runners[runner.name]!, scriptRoots);

  return {
    resolved: {
      absolutePath: fileCheck.absolute,
      layer: manifest.layer,
      runner: runner.name,
      argv: [...runner.command, ...(wrapperPath === undefined ? [] : [wrapperPath]), fileCheck.absolute],
      fingerprint: fingerprintContent(content),
    },
  };
}

/** Значение содержит подстановку из отложенного пространства где-то в дереве. */
function hasDeferredValue(value: unknown): boolean {
  if (typeof value === 'string') {
    return placeholderNamespaces(value).some((namespace) => DEFERRED_NAMESPACES.has(namespace));
  }
  if (Array.isArray(value)) return value.some(hasDeferredValue);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(hasDeferredValue);
  }
  return false;
}

/**
 * Свести переданные параметры со схемой манифеста (design.md, решения 5 и
 * 6): состав проверяется всегда и до Ajv, недостающее со значением по
 * умолчанию получает его здесь же, до записи файла фиксации.
 */
function composeParams(
  name: string,
  manifest: ReadManifest,
  provided: Readonly<Record<string, unknown>>,
): { readonly ok: true; readonly params: Record<string, unknown> } | { readonly ok: false; readonly reason: ScriptUnresolved } {
  const schema = manifest.paramsSchema;
  const properties = (schema?.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
  const required = (schema?.required as readonly string[] | undefined) ?? [];
  const declaredNames = Object.keys(properties);

  if (schema === undefined) {
    const providedNames = Object.keys(provided);
    if (providedNames.length > 0) {
      return {
        ok: false,
        reason: {
          reason: 'params_invalid',
          name,
          manifestPath: manifest.manifestPath,
          detail: `шаг не объявляет params — переданы: ${providedNames.join(', ')}`,
        },
      };
    }
    return { ok: true, params: {} };
  }

  for (const key of Object.keys(provided)) {
    if (!declaredNames.includes(key)) {
      return {
        ok: false,
        reason: {
          reason: 'params_invalid',
          name,
          manifestPath: manifest.manifestPath,
          detail: `параметр ${key} не объявлен. Объявлены: ${declaredNames.length === 0 ? '—' : declaredNames.join(', ')}`,
        },
      };
    }
  }

  const params: Record<string, unknown> = {};
  for (const key of declaredNames) {
    if (key in provided) {
      params[key] = provided[key];
      continue;
    }
    const propSchema = properties[key];
    if (propSchema !== undefined && 'default' in propSchema) {
      params[key] = propSchema.default;
      continue;
    }
    if (required.includes(key)) {
      return {
        ok: false,
        reason: {
          reason: 'params_invalid',
          name,
          manifestPath: manifest.manifestPath,
          detail: `не передан обязательный параметр ${key}`,
        },
      };
    }
  }

  return { ok: true, params };
}

/** Копия схемы параметров без перечисленных имён — ни в `properties`, ни в `required`. */
function withoutParams(
  schema: Readonly<Record<string, unknown>>,
  names: readonly string[],
): Record<string, unknown> {
  const properties = schema.properties as Record<string, unknown> | undefined;
  const required = schema.required as readonly string[] | undefined;
  return {
    ...schema,
    ...(properties === undefined
      ? {}
      : {
          properties: Object.fromEntries(
            Object.entries(properties).filter(([key]) => !names.includes(key)),
          ),
        }),
    ...(required === undefined ? {} : { required: required.filter((key) => !names.includes(key)) }),
  };
}

/**
 * Проверить сведённые параметры схемой манифеста там, где значения известны
 * статически (design.md, решение 7): пропускается **значение** с отложенной
 * подстановкой (`${jobs.*}`, `${run.*}`, `${env.*}`), а не весь набор —
 * соседний параметр, известный уже сейчас, проверяется как обычно. Та же
 * проверка повторится в прогоне, движком, перед записью `input.json`, уже по
 * окончательным значениям — и там она пройдёт по набору целиком.
 *
 * Отложенные параметры снимаются вместе со своим описанием в `properties` и
 * своим упоминанием в `required`: иначе схема отчиталась бы о них как о
 * недостающих. Ключевые слова уровня объекта, связывающие снятый параметр с
 * оставшимися (`dependentRequired`, `oneOf`), при этом теряют часть своего
 * предмета — их проверяет движок, когда набор станет полным.
 */
export function validateUsesParamsStatic(
  name: string,
  manifestPath: string,
  paramsSchema: Readonly<Record<string, unknown>> | undefined,
  params: Readonly<Record<string, unknown>>,
): { readonly ok: true } | { readonly ok: false; readonly reason: ScriptUnresolved } {
  if (paramsSchema === undefined) return { ok: true };

  const deferredKeys = Object.keys(params).filter((key) => hasDeferredValue(params[key]));
  const schema = deferredKeys.length === 0 ? paramsSchema : withoutParams(paramsSchema, deferredKeys);
  const value =
    deferredKeys.length === 0
      ? params
      : Object.fromEntries(Object.entries(params).filter(([key]) => !deferredKeys.includes(key)));

  const result = validateAgainstSchema(schema, value);
  if (result.passed) return { ok: true };
  return {
    ok: false,
    reason: { reason: 'params_invalid', name, manifestPath, detail: result.detail ?? 'значение не проходит схему' },
  };
}

interface UsesStepBuildCommon {
  readonly uses: UsesOrigin;
  readonly outputSchemaPath?: string;
  /** Схема параметров манифеста — движок использует её ещё раз после позднего раскрытия (`runner.ts`). */
  readonly paramsSchema?: Readonly<Record<string, unknown>>;
}

/** Ровно одно из `resolved`/`unresolved` — тем же правилом, что и у `ScriptStep` (design.md, решение 8). */
export type UsesStepBuild =
  | (UsesStepBuildCommon & { readonly resolved: ResolvedScript })
  | (UsesStepBuildCommon & { readonly unresolved: ScriptUnresolved });

/**
 * Разрешить шаг `uses` целиком: имя → манифест → файл и раннер → параметры.
 * Ровно одно из `resolved`/`unresolved` результата когда-либо заполнено — тем
 * же правилом, что и у `ScriptStep` (design.md, решение 8): порядок проверок
 * решает, какой из промахов называется первым, когда их несколько сразу, — от
 * самого общего (шага не существует) к самому частному (значение параметра не
 * по схеме).
 */
export function resolveUsesStep(
  name: string,
  provided: Readonly<Record<string, unknown>>,
  stepRoots: ScriptRoots,
  scriptRoots: ScriptRoots,
  config: Config,
): UsesStepBuild {
  const located = findStepDir(name, stepRoots);
  if ('searched' in located) {
    return { uses: { name }, unresolved: { reason: 'step_not_found', name, searched: located.searched } };
  }

  const read = readManifest(name, located.layer, located.dir);
  if (!read.ok) {
    return { uses: { name }, unresolved: read.reason };
  }
  const manifest = read.manifest;
  const origin = (params?: Record<string, unknown>): UsesOrigin => ({
    name,
    layer: manifest.layer,
    manifestPath: manifest.manifestPath,
    manifestFingerprint: manifest.manifestFingerprint,
    ...(params === undefined ? {} : { params }),
  });

  const outputSchema =
    manifest.declaredOutputSchema === undefined
      ? undefined
      : resolveManifestOutputSchema(manifest.declaredOutputSchema, manifest);
  if (outputSchema !== undefined && !outputSchema.ok) {
    return {
      uses: origin(),
      unresolved: { reason: 'manifest_invalid', name, manifestPath: manifest.manifestPath, detail: outputSchema.detail },
      ...(manifest.paramsSchema === undefined ? {} : { paramsSchema: manifest.paramsSchema }),
    };
  }
  const outputSchemaPath = outputSchema === undefined ? undefined : outputSchema.path;

  const scriptOutcome = resolveManifestScript(name, manifest, config, scriptRoots);
  if ('unresolved' in scriptOutcome) {
    return {
      uses: origin(),
      unresolved: scriptOutcome.unresolved,
      ...(manifest.paramsSchema === undefined ? {} : { paramsSchema: manifest.paramsSchema }),
      ...(outputSchemaPath === undefined ? {} : { outputSchemaPath }),
    };
  }

  const composed = composeParams(name, manifest, provided);
  if (!composed.ok) {
    return {
      uses: origin(),
      unresolved: composed.reason,
      ...(manifest.paramsSchema === undefined ? {} : { paramsSchema: manifest.paramsSchema }),
      ...(outputSchemaPath === undefined ? {} : { outputSchemaPath }),
    };
  }

  const staticCheck = validateUsesParamsStatic(name, manifest.manifestPath, manifest.paramsSchema, composed.params);
  if (!staticCheck.ok) {
    return {
      uses: origin(composed.params),
      unresolved: staticCheck.reason,
      ...(manifest.paramsSchema === undefined ? {} : { paramsSchema: manifest.paramsSchema }),
      ...(outputSchemaPath === undefined ? {} : { outputSchemaPath }),
    };
  }

  return {
    uses: origin(composed.params),
    resolved: scriptOutcome.resolved,
    ...(manifest.paramsSchema === undefined ? {} : { paramsSchema: manifest.paramsSchema }),
    ...(outputSchemaPath === undefined ? {} : { outputSchemaPath }),
  };
}
