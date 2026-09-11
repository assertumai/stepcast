import { readFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { z } from 'zod';

import { StepcastError } from '../errors.js';
import { describeSchemaFailure } from '../schema-failure.js';

/**
 * Манифест плагина пользователя (`user-plugins`, design.md, Решение 6).
 *
 * Имени в манифесте нет: `id` строки — имя каталога (Решение 4), а не
 * значение, которое могло бы с ним разойтись. Обе половины необязательны по
 * отдельности, но манифест без единой не описывает плагин вовсе — это отказ,
 * а не пустой плагин.
 */

export const PLUGIN_MANIFEST_FILE = 'plugin.json';

export const PluginManifestSchema = z
  .object({
    version: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    /** Модуль, который движок импортирует сам — без компиляции (Решение 7). */
    server: z.string().min(1).optional(),
    /** Исходник, который демон собирает esbuild и отдаёт странице (Решение 8). */
    browser: z.string().min(1).optional(),
  })
  .strict()
  .refine((value) => value.server !== undefined || value.browser !== undefined, {
    message: 'манифест не объявляет ни серверной, ни браузерной половины',
  })
  // Проверка `refine` в печатаемую схему сама не попадает — `z.toJSONSchema`
  // видит только форму, а не тело предиката. Ограничение выразимо в JSON
  // Schema, и здесь оно дописывается к печати руками: иначе редактор принимал
  // бы `{}`, который `readPluginManifest` отвергает, — а спецификация требует
  // схемы, совпадающей с моделью (`user-plugins`, «Схема опубликована»).
  .meta({ anyOf: [{ required: ['server'] }, { required: ['browser'] }] });

export type PluginManifestDocument = z.infer<typeof PluginManifestSchema>;

export interface PluginManifest {
  readonly dir: string;
  readonly manifestPath: string;
  readonly version: string | undefined;
  readonly description: string | undefined;
  /** Абсолютный реальный путь серверной половины — уже проверенный внутри каталога плагина. */
  readonly server: string | undefined;
  /** Абсолютный реальный путь браузерной половины — уже проверенный внутри каталога плагина. */
  readonly browser: string | undefined;
}

/**
 * Разрешить путь половины манифеста внутри каталога плагина, отклонив выход
 * за его пределы по реальному пути — тем же приёмом, каким виджет закрывает
 * символическую ссылку наружу (`src/ui/widgets.ts`, `resolveWidgetFile`).
 * Это не песочница, а граница адресного пространства: демон отдаёт по
 * `/plugins/<id>.js` то, что назвал манифест, и ничего сверх (Решение 6).
 */
function resolvePluginHalf(
  pluginDir: string,
  relative: string,
  field: 'server' | 'browser',
  manifestPath: string,
): string {
  const target = join(pluginDir, relative);

  let realDir: string;
  let realTarget: string;
  try {
    realDir = realpathSync(pluginDir);
    realTarget = realpathSync(target);
  } catch (error) {
    throw new StepcastError(`Половина ${field} манифеста плагина не читается: ${relative}`, {
      file: manifestPath,
      at: field,
      hint: `Файл ${target} недоступен: ${(error as Error).message}`,
    });
  }

  if (realTarget !== realDir && !realTarget.startsWith(realDir + sep)) {
    throw new StepcastError(`Половина ${field} манифеста плагина выходит за пределы каталога плагина`, {
      file: manifestPath,
      at: field,
      hint: `Путь ${relative} обязан указывать внутрь каталога плагина ${pluginDir}`,
    });
  }

  return realTarget;
}

/**
 * Прочитать и проверить манифест каталога плагина. Отказ называет файл и
 * место внутри документа (`StepcastError.file`/`at`) — тем же составом
 * полей, каким называет их отказ разбора манифеста шага
 * (`src/core/pipeline/steps.ts`). Вызывающий (`applyTreeRow`,
 * `src/core/plugins/load.ts`) решает, прекращает ли этот отказ загрузку
 * целиком или становится состоянием одной строки (Решение 10).
 */
export function readPluginManifest(pluginDir: string): PluginManifest {
  const manifestPath = join(pluginDir, PLUGIN_MANIFEST_FILE);

  let text: string;
  try {
    text = readFileSync(manifestPath, 'utf8');
  } catch (error) {
    throw new StepcastError(`Манифест плагина не читается: ${(error as Error).message}`, {
      file: manifestPath,
      hint: `Каталог плагина обязан содержать ${PLUGIN_MANIFEST_FILE} (docs/plugins.md)`,
      cause: error,
    });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new StepcastError(`Манифест плагина не разбирается как JSON: ${(error as Error).message}`, {
      file: manifestPath,
      cause: error,
    });
  }

  const parsed = PluginManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const failure = describeSchemaFailure(parsed.error);
    throw new StepcastError(`Манифест плагина не соответствует формату: ${failure.message}`, {
      file: manifestPath,
      ...(failure.at === undefined ? {} : { at: failure.at }),
      hint: 'Формат описан в docs/plugins.md; схема — schema/plugin-manifest.schema.json',
    });
  }

  const doc = parsed.data;
  return {
    dir: pluginDir,
    manifestPath,
    version: doc.version,
    description: doc.description,
    server: doc.server === undefined ? undefined : resolvePluginHalf(pluginDir, doc.server, 'server', manifestPath),
    browser: doc.browser === undefined ? undefined : resolvePluginHalf(pluginDir, doc.browser, 'browser', manifestPath),
  };
}
