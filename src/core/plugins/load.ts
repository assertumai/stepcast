import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ResolvedConfig } from '../config/resolve.js';
import { StepcastError } from '../errors.js';
import { builtinRegistry } from './builtin.js';
import { StepcastPluginSchema, type CommandContribution, type StepcastPlugin } from './contract.js';
import { addPlugin, type Registry } from './registry.js';

/**
 * Загрузка плагинов.
 *
 * Плагины загружаются один раз на вызов команды — после разрешения
 * конфигурации (она их и называет) и до разбора аргументов: команда плагина
 * обязана попасть в перечень раньше, чем разбор объявит её неизвестной.
 *
 * Отказ загрузки прекращает команду целиком, а не пропускает плагин молча:
 * пайплайн, объявивший предикат плагина, без него разбирается неверно, а
 * `stepcast config` без него печатает конфигурацию, которой не будет.
 */

/** Строка объявления вместе с файлом, в котором она объявлена. */
export interface PluginDeclaration {
  readonly spec: string;
  /** Файл конфигурации либо `undefined`, если источник — не файл. */
  readonly declaredIn?: string;
}

/**
 * Объявления плагинов с их источниками. Берутся из вклада слоёв, а не из
 * `Config.plugins`: относительный путь разрешается от файла, в котором
 * объявлен, и знать этот файл обязан именно загрузчик.
 */
export function pluginDeclarations(resolved: ResolvedConfig): PluginDeclaration[] {
  const contributions = resolved.denyContributions.get('plugins') ?? [];
  const seen = new Set<string>();
  const declarations: PluginDeclaration[] = [];

  for (const contribution of contributions) {
    for (const spec of contribution.patterns) {
      // Дубликат между слоями — не ошибка: глобальный и проектный конфиг
      // вправе назвать один и тот же адаптер. Загрузка при этом одна.
      if (seen.has(spec)) continue;
      seen.add(spec);
      declarations.push({
        spec,
        ...(contribution.source.kind === 'file' ? { declaredIn: contribution.source.path } : {}),
      });
    }
  }
  return declarations;
}

export interface LoadOptions {
  /** Корень проекта: от него разрешается спецификатор пакета. */
  readonly projectRoot: string;
  /** Каталог движка: запасное место разрешения для глобальной установки. */
  readonly engineRoot?: string;
  /** Подмена импорта: тесты подставляют модуль, не выкладывая его на диск. */
  readonly importModule?: (url: string) => Promise<unknown>;
  /** Встроенные команды: их вносит точка входа, ядро о них не знает. */
  readonly builtinCommands?: readonly CommandContribution[];
}

/** Путь модуля: относительный — от файла объявления, иначе — пакет. */
export function resolveModulePath(declaration: PluginDeclaration, options: LoadOptions): string {
  const { spec } = declaration;

  if (isAbsolute(spec)) return spec;

  if (spec.startsWith('./') || spec.startsWith('../')) {
    const base = declaration.declaredIn === undefined ? options.projectRoot : dirname(declaration.declaredIn);
    return resolvePath(base, spec);
  }

  // Пакет — зависимость проекта: разрешается от его корня. Каталог движка —
  // запасной путь для глобальной установки, где плагин лежит рядом с самим
  // stepcast, а не в репозитории.
  const roots = [options.projectRoot, ...(options.engineRoot === undefined ? [] : [options.engineRoot])];
  const failures: string[] = [];
  for (const root of roots) {
    try {
      return createRequire(join(root, 'package.json')).resolve(spec);
    } catch (error) {
      failures.push(`${root}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    }
  }

  throw new StepcastError(`Модуль плагина ${spec} не найден`, {
    ...(declaration.declaredIn === undefined ? {} : { file: declaration.declaredIn }),
    at: 'plugins',
    hint: `Искали от: ${roots.join(', ')}. Установите пакет в проект либо назовите путь, начав его с ./`,
  });
}

/** Прочитать и проверить объект, экспортированный модулем по умолчанию. */
function toPlugin(module: unknown, declaration: PluginDeclaration, path: string): StepcastPlugin {
  const exported = (module as { default?: unknown } | undefined)?.default;
  if (exported === undefined) {
    throw new StepcastError(`Модуль плагина ${declaration.spec} не экспортирует объект по умолчанию`, {
      ...(declaration.declaredIn === undefined ? {} : { file: declaration.declaredIn }),
      at: 'plugins',
      hint: `Модуль ${path} обязан объявить export default с полями name и вкладами (docs/plugins.md)`,
    });
  }

  const parsed = StepcastPluginSchema.safeParse(exported);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined || issue.path.length === 0 ? 'корень объекта' : issue.path.join('.');
    throw new StepcastError(
      `Плагин ${declaration.spec} не соответствует контракту: ${where} — ${issue?.message ?? 'неверная форма'}`,
      {
        ...(declaration.declaredIn === undefined ? {} : { file: declaration.declaredIn }),
        at: 'plugins',
        hint: `Модуль: ${path}. Контракт описан в docs/plugins.md`,
      },
    );
  }
  return exported as StepcastPlugin;
}

/**
 * Собрать реестр: встроенные вклады плюс вклады объявленных плагинов, в
 * порядке объявления.
 */
export async function loadPlugins(resolved: ResolvedConfig, options: LoadOptions): Promise<Registry> {
  const registry = builtinRegistry(options.builtinCommands ?? []);
  const declarations = pluginDeclarations(resolved);
  if (declarations.length === 0) return registry;

  const load = options.importModule ?? ((url: string) => import(url));

  for (const declaration of declarations) {
    const path = resolveModulePath(declaration, options);
    let module: unknown;
    try {
      module = await load(pathToFileURL(path).href);
    } catch (error) {
      throw new StepcastError(
        `Модуль плагина ${declaration.spec} не загружается: ${error instanceof Error ? error.message : String(error)}`,
        {
          ...(declaration.declaredIn === undefined ? {} : { file: declaration.declaredIn }),
          at: 'plugins',
          hint: `Модуль: ${path}`,
          cause: error,
        },
      );
    }

    addPlugin(registry, toPlugin(module, declaration, path), path);
  }

  return registry;
}
