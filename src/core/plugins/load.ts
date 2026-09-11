import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { findPackageRoot } from '../package-schema.js';

import type { ResolvedConfig } from '../config/resolve.js';
import { isStepcastError, StepcastError } from '../errors.js';
import { createBuiltinKernel } from './builtin.js';
import {
  isContextPlugin,
  StepcastPluginSchema,
  type CommandContribution,
  type ContextPlugin,
  type ContextPluginObject,
  type StepcastPlugin,
} from './contract.js';
import { translateReservedNameConflict, unresolvedFibers, type Fiber, type Kernel } from './kernel.js';
import { registryFromKernel, type Registry } from './registry.js';

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
 *
 * Плагин применяется областью контекста (`kernel.ctx.plugin`), а не полем
 * реестра: снятие области снимает вклад без единой строки учёта здесь
 * (design.md, Решение 2). Реестр объявляется собранным только после того, как
 * контекст успокоился (`kernel.settle()`), — форма ожидания, проверенная на
 * типах установленной версии cordis (design.md, Решение 9).
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
  const roots = [options.projectRoot, options.engineRoot ?? findPackageRoot(fileURLToPath(new URL('.', import.meta.url)))];
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

export type Recognized =
  | { readonly form: 'declarative'; readonly plugin: StepcastPlugin }
  | { readonly form: 'context'; readonly plugin: ContextPlugin };

/**
 * Прочитать и опознать форму объекта, экспортированного модулем по
 * умолчанию. Функция или объект с `apply` — плагин контекста, проверяется
 * только тем, что тело исполнимо; всё прочее — прежняя проверка
 * `StepcastPluginSchema` до исполнения кода плагина. Значение, не подошедшее
 * ни под одну форму, называет обе в отказе.
 */
function toPlugin(module: unknown, declaration: PluginDeclaration, path: string): Recognized {
  const exported = (module as { default?: unknown } | undefined)?.default;
  if (exported === undefined) {
    throw new StepcastError(`Модуль плагина ${declaration.spec} не экспортирует объект по умолчанию`, {
      ...(declaration.declaredIn === undefined ? {} : { file: declaration.declaredIn }),
      at: 'plugins',
      hint: `Модуль ${path} обязан объявить export default с полями name и вкладами (docs/plugins.md)`,
    });
  }

  if (isContextPlugin(exported)) {
    return { form: 'context', plugin: exported };
  }

  // Форма контекста не опознана. Значение, не являющееся даже объектом
  // (строка, число), не может быть и декларативным вкладом — отказ называет
  // обе допустимые формы, а не печатает вводящий в заблуждение zod-разбор
  // объекта, которого нет. Объект, похожий на декларативный, но неверной
  // формы, идёт прежним путём — его отказ называет конкретное поле.
  if (typeof exported !== 'object' || exported === null) {
    throw new StepcastError(`Модуль плагина ${declaration.spec} не опознан ни одной формой плагина`, {
      ...(declaration.declaredIn === undefined ? {} : { file: declaration.declaredIn }),
      at: 'plugins',
      hint: `Модуль ${path} обязан экспортировать по умолчанию либо декларативный объект вкладов, либо функцию над контекстом (объект с apply) — см. docs/plugins.md`,
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
  return { form: 'declarative', plugin: exported as StepcastPlugin };
}

/**
 * Адаптер в одну сторону (design.md, Решение 7): декларативный объект
 * превращается в плагин контекста самим движком, а не наоборот. Каждая
 * регистрация — тем же вызовом, каким её сделал бы плагин контекста, и в той
 * же области — области этого плагина.
 */
export function toContextPlugin(plugin: StepcastPlugin): ContextPluginObject {
  return {
    name: plugin.name,
    ...(plugin.version === undefined ? {} : { version: plugin.version }),
    inject: ['backends', 'predicates', 'commands'] as string[],
    apply(ctx) {
      for (const [name, contribution] of Object.entries(plugin.backends ?? {})) {
        ctx.backends.register(name, contribution);
      }
      for (const contribution of plugin.predicates ?? []) {
        ctx.predicates.register(contribution.name, contribution);
      }
      for (const contribution of plugin.commands ?? []) {
        ctx.commands.register(contribution.name, contribution);
      }
    },
  };
}

/**
 * Имя плагина контекста: поле `name` объекта либо имя функции. Безымянный
 * `export default function (ctx) {…}` именем не считается: по спецификации ES
 * `Function.name` у него — строка `default`, то есть имя было бы не у плагина,
 * а у формы экспорта. Оно попало бы и в перечень `registry.plugins`, и в
 * манифест прогона (по нему состав плагинов сверяется при возобновлении), и в
 * текст отказа о конфликте — два безымянных плагина стали бы неразличимы.
 */
function pluginName(plugin: ContextPlugin): string {
  const name = plugin.name;
  if (name === undefined || name === '' || name === 'default') {
    throw new StepcastError('Плагин контекста обязан иметь имя: назовите функцию или добавьте поле name', {
      at: 'plugins',
      hint: 'export default function myPlugin(ctx) { … } — имя функции и есть имя плагина (docs/plugins.md)',
    });
  }
  return name;
}

/**
 * Применить один плагин (любой формы) к ядру и, если применение прошло без
 * отказа, записать его в перечень загруженных. Используется и загрузкой из
 * файла (`loadPlugins`), и напрямую — синтетическим плагином без файла на
 * диске (тесты ядра). Возвращает область плагина: её `dispose()` снимает всё,
 * что плагин зарегистрировал, разом (тест «снятие области»).
 */
export async function applyPlugin(kernel: Kernel, recognized: Recognized, source: string): Promise<Fiber> {
  const plugin = recognized.form === 'declarative' ? toContextPlugin(recognized.plugin) : recognized.plugin;
  const name = pluginName(plugin);
  const version = recognized.form === 'declarative' ? recognized.plugin.version : plugin.version;
  const wrapped: ContextPluginObject =
    typeof plugin === 'function'
      ? { name, ...(plugin.version === undefined ? {} : { version: plugin.version }), apply: plugin, ...(plugin.inject === undefined ? {} : { inject: plugin.inject }) }
      : { ...plugin, name };

  const fiber = kernel.ctx.plugin(wrapped);
  try {
    await fiber;
  } catch (error) {
    // Область снимается здесь, а не оставляется на усмотрение cordis: отказ
    // посреди применения не имеет права оставить ни первого вклада, ни занятого
    // им имени, ни записи в перечне плагинов (design.md, Решение 10). Снятие
    // идемпотентно — область, уже снятую самой библиотекой, оно не портит, —
    // и его отказ не заслоняет исходный: наружу идёт тот, из-за которого всё.
    await fiber.dispose().catch(() => undefined);
    throw translateReservedNameConflict(error);
  }
  kernel.recordPlugin(fiber.ctx, { name, ...(version === undefined ? {} : { version }), source });
  return fiber;
}

/** Применить плагин декларативной формы — сокращение для частого случая (тесты, `loadPlugins`). */
export function applyDeclarativePlugin(kernel: Kernel, plugin: StepcastPlugin, source: string): Promise<Fiber> {
  return applyPlugin(kernel, { form: 'declarative', plugin }, source);
}

/** Применить плагин контекста — сокращение, симметричное `applyDeclarativePlugin`. */
export function applyContextPlugin(kernel: Kernel, plugin: ContextPlugin, source: string): Promise<Fiber> {
  return applyPlugin(kernel, { form: 'context', plugin }, source);
}

/**
 * Объявление, которым заведена область. Вложенная область (`ctx.inject` внутри
 * тела плагина) в перечне не значится — ищется ближайший предок, который
 * значится: плагин отвечает за то, что завело его тело.
 */
function declarationOf(
  fiber: Fiber,
  declaredBy: ReadonlyMap<Fiber, PluginDeclaration>,
): PluginDeclaration | undefined {
  // Корневая область — сама себе предок: перечень пройденных и есть условие
  // остановки, отдельного признака корня для этого не нужно.
  const seen = new Set<Fiber>();
  let current = fiber;
  while (!seen.has(current)) {
    const declaration = declaredBy.get(current);
    if (declaration !== undefined) return declaration;
    seen.add(current);
    current = current.parent.fiber;
  }
  return undefined;
}

/**
 * Собрать реестр: встроенные вклады плюс вклады объявленных плагинов, в
 * порядке объявления, после того как контекст успокоился.
 */
export async function loadPlugins(resolved: ResolvedConfig, options: LoadOptions): Promise<Registry> {
  const kernel = createBuiltinKernel(options.builtinCommands ?? []);
  const declarations = pluginDeclarations(resolved);
  const load = options.importModule ?? ((url: string) => import(url));
  // Чьим объявлением заведена область. Нужно отказу о незакрытом внедрении:
  // он рождается после цикла, когда текущего объявления уже нет, а файл
  // конфигурации назвать обязан наравне с прочими отказами загрузки.
  const declaredBy = new Map<Fiber, PluginDeclaration>();

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

    const recognized = toPlugin(module, declaration, path);
    try {
      declaredBy.set(await applyPlugin(kernel, recognized, path), declaration);
    } catch (error) {
      // Конфликт имён вкладов знает вид вклада, имя и обоих претендентов, но
      // не знает, откуда плагин взялся: ядро про конфигурацию не знает вовсе.
      // Место объявления дописывается здесь — прочие отказы загрузки несут
      // `file` и `at: 'plugins'`, и отказ ядра обязан приходить тем же
      // составом полей: и печать CLI, и карточка витрины показывают
      // расположение отдельно от текста.
      if (!isStepcastError(error) || error.file !== undefined) throw error;
      throw new StepcastError(error.message, {
        exitCode: error.exitCode,
        ...(declaration.declaredIn === undefined ? {} : { file: declaration.declaredIn }),
        at: error.at ?? 'plugins',
        ...(error.hint === undefined ? {} : { hint: error.hint }),
        cause: error,
      });
    }
  }

  const fibers = await kernel.settle();
  const unresolved = unresolvedFibers(fibers);
  const first = unresolved[0];
  if (first !== undefined) {
    const declaredIn = declarationOf(first.fiber, declaredBy)?.declaredIn;
    throw new StepcastError(
      `Плагин ${first.plugin} ждёт сервис ${first.missing.join(', ')}, которого не регистрирует ни один из объявленных плагинов`,
      {
        ...(declaredIn === undefined ? {} : { file: declaredIn }),
        at: 'plugins',
        hint: 'Объявите плагин, регистрирующий этот сервис, либо снимите зависимость от него',
      },
    );
  }

  return registryFromKernel(kernel);
}
