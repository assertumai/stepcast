import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { findPackageRoot } from '../package-schema.js';

import type { ResolvedConfig } from '../config/resolve.js';
import { isStepcastError, StepcastError } from '../errors.js';
import { BUILTIN_ROW_IDS, createKernelShell, findBuiltinRow, type BuiltinRow } from './builtin.js';
import {
  isContextPlugin,
  StepcastPluginSchema,
  type CommandContribution,
  type ContextPlugin,
  type ContextPluginObject,
  type StepcastPlugin,
} from './contract.js';
import { translateReservedNameConflict, unresolvedFibers, type Fiber, type Kernel } from './kernel.js';
import { readPluginManifest, type PluginManifest } from './manifest.js';
import { registryFromKernel, type Registry } from './registry.js';
import { BUILTIN_USE_PREFIX, isBuiltinUse, type TreeRow } from './tree.js';

/**
 * Загрузка плагинов.
 *
 * Плагины загружаются один раз на вызов команды — после разрешения
 * конфигурации (она собирает дерево плагинов) и до разбора аргументов:
 * команда плагина обязана попасть в перечень раньше, чем разбор объявит её
 * неизвестной.
 *
 * Вход загрузчика — дерево плагинов (`ResolvedConfig.pluginTree`,
 * `plugin-tree`), а не список объявлений: строки идут по порядку дерева,
 * отключённые пропускаются, встроенные разрешаются таблицей `builtin.ts`, а
 * не диском.
 *
 * Отказ загрузки прекращает команду целиком, а не пропускает строку молча:
 * пайплайн, объявивший предикат плагина, без него разбирается неверно, а
 * `stepcast config` без него печатает конфигурацию, которой не будет.
 * Исключение — команда осмотра дерева (`stepcast plugins`, `plugin-tree`):
 * она переживает отказ загрузки одной из строк (`inspectPluginTree` ниже).
 *
 * Плагин применяется областью контекста (`kernel.ctx.plugin`), а не полем
 * реестра: снятие области снимает вклад без единой строки учёта здесь
 * (design.md, Решение 2). Реестр объявляется собранным только после того, как
 * контекст успокоился (`kernel.settle()`), — форма ожидания, проверенная на
 * типах установленной версии cordis (design.md, Решение 9).
 */

/** Файл, объявивший строку, — только для строк файлового слоя. */
function declaredIn(row: TreeRow): string | undefined {
  return row.source.kind === 'file' ? row.source.path : undefined;
}

/**
 * `{ file }`, если строка пришла из файла, иначе пустой объект — спред в
 * опции `StepcastError`. Отдельная функция, а не повторный вызов
 * `declaredIn(row)` в самом спреде: `exactOptionalPropertyTypes` не умеет
 * сузить второй вызов той же функции по проверке первого.
 */
function fileOption(row: TreeRow): { readonly file: string } | Record<string, never> {
  const file = declaredIn(row);
  return file === undefined ? {} : { file };
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
  /**
   * Строки поставки вызывающего — фабрики встроенного слоя сверх строк движка
   * (`plugin-tree`, design.md Решение 2): витрина передаёт `src/ui/screens/rows.ts`.
   * `applyTreeRow` ищет их наравне с `findBuiltinRow`; вызов, не назвавший
   * поле, ищет фабрику только среди строк движка, как и до появления строк
   * поставки.
   */
  readonly builtinRows?: readonly BuiltinRow[];
  /**
   * Строка, найденная обходом каталога плагинов (`user-plugins`), применилась
   * без отказа: вызывающий (витрина) заводит здесь свой вклад в области этой
   * строки — регистрацию браузерной половины в сервисе состава плагинов
   * (design.md, Решение 1, задача 2.6). `fiber` — область строки, если она
   * была заведена (плагин объявил серверную половину); её нет для плагина,
   * несущего только браузерную половину. Молчание поля — как в дереве команд
   * CLI — не заводит вклада вовсе: сервиса состава там нет.
   */
  readonly onDirectoryRow?: (info: {
    readonly row: TreeRow;
    readonly manifest: PluginManifest;
    readonly fiber: Fiber | undefined;
  }) => void;
}

/**
 * Путь модуля строки: относительный — от файла объявления, иначе — пакет.
 * Форма `stepcast:<имя>` сюда не доходит: её разрешает таблица встроенных
 * строк (`applyTreeRow`), а не диск.
 */
export function resolveModulePath(row: TreeRow, options: LoadOptions): string {
  const spec = row.use;

  if (isAbsolute(spec)) return spec;

  if (spec.startsWith('./') || spec.startsWith('../')) {
    const file = declaredIn(row);
    const base = file === undefined ? options.projectRoot : dirname(file);
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
    ...fileOption(row),
    at: 'plugins',
    hint: `Искали от: ${roots.join(', ')}. Установите пакет в проект либо назовите путь, начав его с ./`,
  });
}

/**
 * Отказ строки, известный до всякой загрузки (`TreeRow.failure`), — или
 * `undefined`, если такого отказа за строкой не числится. Общий для применения
 * строки (`applyTreeRow`) и для тех, кто показывает состояние строк, не
 * загружая их (`stepcast plugins` с готовым реестром): текст отказа обязан быть
 * один и тот же.
 */
export function rowFailureError(row: TreeRow): StepcastError | undefined {
  if (row.failure === undefined) return undefined;
  return new StepcastError(row.failure.message, {
    ...(row.source.kind === 'directory' ? { file: row.source.dir } : fileOption(row)),
    at: 'plugins',
    ...(row.failure.hint === undefined ? {} : { hint: row.failure.hint }),
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
function toPlugin(module: unknown, row: TreeRow, path: string): Recognized {
  const exported = (module as { default?: unknown } | undefined)?.default;
  if (exported === undefined) {
    throw new StepcastError(`Модуль плагина ${row.use} не экспортирует объект по умолчанию`, {
      ...fileOption(row),
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
    throw new StepcastError(`Модуль плагина ${row.use} не опознан ни одной формой плагина`, {
      ...fileOption(row),
      at: 'plugins',
      hint: `Модуль ${path} обязан экспортировать по умолчанию либо декларативный объект вкладов, либо функцию над контекстом (объект с apply) — см. docs/plugins.md`,
    });
  }

  const parsed = StepcastPluginSchema.safeParse(exported);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined || issue.path.length === 0 ? 'корень объекта' : issue.path.join('.');
    throw new StepcastError(
      `Плагин ${row.use} не соответствует контракту: ${where} — ${issue?.message ?? 'неверная форма'}`,
      {
        ...fileOption(row),
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
    inject: ['backends', 'predicates', 'commands', 'steps'] as string[],
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
      for (const contribution of plugin.steps ?? []) {
        ctx.steps.register(contribution.name, contribution);
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
 * Имя, объявленное распознанным плагином, если оно есть, — без отказа на
 * безымянном плагине контекста: тот случай остаётся за `pluginName` внутри
 * `applyPlugin`. Нужна только каталожной строке (Решение 4): сверить имя с
 * именем каталога до регистрации единственного вклада не удастся, если
 * отсутствие имени уже брошено исключением.
 */
function tentativePluginName(recognized: Recognized): string | undefined {
  if (recognized.form === 'declarative') return recognized.plugin.name;
  const name = recognized.plugin.name;
  return name === undefined || name === '' || name === 'default' ? undefined : name;
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

/** Отказ: строка называет несуществующую встроенную строку формой `stepcast:<имя>`. */
function unknownBuiltinRow(row: TreeRow, name: string, callerRows: readonly BuiltinRow[]): StepcastError {
  const names = [...BUILTIN_ROW_IDS, ...callerRows.map((candidate) => candidate.id)];
  return new StepcastError(`Строка ${row.id} называет несуществующую встроенную строку stepcast:${name}`, {
    ...fileOption(row),
    at: 'plugins',
    hint: `Пакет поставляет: ${names.map((id) => `stepcast:${id}`).join(', ')}`,
  });
}

/** Дописать отказ ядра (конфликт имён) расположением строки — тем же составом полей, что у прочих отказов загрузки. */
function withRowLocation(error: unknown, row: TreeRow): never {
  if (!isStepcastError(error) || error.file !== undefined) throw error;
  throw new StepcastError(error.message, {
    exitCode: error.exitCode,
    ...fileOption(row),
    at: error.at ?? 'plugins',
    ...(error.hint === undefined ? {} : { hint: error.hint }),
    cause: error,
  });
}

/** Отказ: имя, объявленное серверной половиной каталожного плагина, разошлось с именем каталога (design.md, Решение 4). */
function pluginNameMismatch(row: TreeRow, declaredName: string, manifestPath: string): StepcastError {
  return new StepcastError(
    `Серверная половина плагина ${row.id} называет себя ${declaredName} — имя плагина обязано совпадать с именем каталога`,
    {
      file: manifestPath,
      at: 'server',
      hint: `Переименуйте каталог плагина в ${declaredName} либо назовите плагин ${row.id} внутри серверной половины`,
    },
  );
}

/**
 * Путь резолвится в каталог: каталожный плагин пользователя (`user-plugins`,
 * design.md, Решение 2). Манифест читает и проверяет `readPluginManifest`; её
 * отказы (нет манифеста, манифест не разбирается, половина вне каталога) уже
 * несут `file`/`at` и всплывают как есть. Плагин без серверной половины
 * применяется без импорта — отсутствие сервера не отказ (`plugin.json`
 * объявил только браузерную половину).
 */
async function applyDirectoryTreeRow(
  kernel: Kernel,
  row: TreeRow,
  dir: string,
  options: LoadOptions,
  load: (url: string) => Promise<unknown>,
): Promise<Fiber | undefined> {
  const manifest = readPluginManifest(dir);

  if (manifest.server === undefined) {
    options.onDirectoryRow?.({ row, manifest, fiber: undefined });
    return undefined;
  }

  let module: unknown;
  try {
    module = await load(pathToFileURL(manifest.server).href);
  } catch (error) {
    throw new StepcastError(
      `Серверная половина плагина ${row.id} не загружается: ${error instanceof Error ? error.message : String(error)}`,
      { file: manifest.manifestPath, at: 'server', hint: `Модуль: ${manifest.server}`, cause: error },
    );
  }

  const recognized = toPlugin(module, row, manifest.server);
  const declaredName = tentativePluginName(recognized);
  if (declaredName !== undefined && declaredName !== row.id) {
    throw pluginNameMismatch(row, declaredName, manifest.manifestPath);
  }

  const fiber = await applyPlugin(kernel, recognized, manifest.server);
  try {
    options.onDirectoryRow?.({ row, manifest, fiber });
  } catch (error) {
    // Вклад вызывающего — часть применения этой строки, и его отказ обязан
    // снять её область целиком: иначе строка числилась бы отказавшей, а её
    // регистрации оставались бы в реестре за ней (design.md, Решение 10:
    // «отказ не оставляет ни одного вклада»).
    await fiber.dispose().catch(() => undefined);
    kernel.forgetPlugin(fiber);
    throw error;
  }
  return fiber;
}

/**
 * Применить одну строку дерева: встроенная — фабрика из таблицы `builtin.ts`
 * по форме `use: stepcast:<имя>`, каталог с манифестом — каталожный плагин
 * пользователя (`applyDirectoryTreeRow`, `user-plugins`, Решение 2), обычная —
 * прежние `resolveModulePath`, импорт и `applyPlugin` (задача 3.1, 3.2).
 * Опознание каталога — по диску, а не по источнику строки: строка, написанная
 * руками в патче с `use`, указывающим на каталог с манифестом, даёт тот же
 * плагин, что и найденная обходом (`plugin-tree`, Решение источника строки).
 * Строка встроенного слоя, заменённая патчем, сюда не доходит вовсе: в дереве
 * её больше нет — на её месте новая строка со своим `use`.
 *
 * Возвращает область плагина, если она была заведена, — её `loadPlugins`
 * использует для отказа о незакрытом внедрении. Встроенная строка и
 * каталожный плагин без серверной половины область не заводят.
 */
async function applyTreeRow(
  kernel: Kernel,
  row: TreeRow,
  options: LoadOptions,
  load: (url: string) => Promise<unknown>,
): Promise<Fiber | undefined> {
  // Строка отказала ещё при сборке дерева (каталог назван идентификатором
  // встроенной строки, `user-plugins`, Решение 5). Отказ отдаётся отсюда, а не
  // особой веткой у каждого вызывающего: дальше с ним поступают по общему
  // правилу — у строки, найденной обходом, он становится её состоянием
  // (Решение 10).
  const known = rowFailureError(row);
  if (known !== undefined) throw known;

  if (isBuiltinUse(row.use)) {
    const name = row.use.slice(BUILTIN_USE_PREFIX.length);
    const builtinRow = findBuiltinRow(name) ?? options.builtinRows?.find((candidate) => candidate.id === name);
    if (builtinRow === undefined) throw unknownBuiltinRow(row, name, options.builtinRows ?? []);
    try {
      await builtinRow.apply(kernel);
    } catch (error) {
      // Конфликт имени вклада, случившийся на встроенной фабрике (две строки
      // дерева назвали одну и ту же), обязан прийти тем же составом полей,
      // что и отказы обычных строк: файлом строки и `at: 'plugins'`
      // (`plugin-contributions`).
      withRowLocation(translateReservedNameConflict(error), row);
    }
    return undefined;
  }

  const path = resolveModulePath(row, options);

  let isDirectory = false;
  try {
    isDirectory = statSync(path).isDirectory();
  } catch {
    isDirectory = false;
  }

  if (isDirectory) {
    try {
      return await applyDirectoryTreeRow(kernel, row, path, options, load);
    } catch (error) {
      withRowLocation(error, row);
    }
  }

  let module: unknown;
  try {
    module = await load(pathToFileURL(path).href);
  } catch (error) {
    throw new StepcastError(
      `Модуль плагина ${row.use} не загружается: ${error instanceof Error ? error.message : String(error)}`,
      {
        ...fileOption(row),
        at: 'plugins',
        hint: `Модуль: ${path}`,
        cause: error,
      },
    );
  }

  const recognized = toPlugin(module, row, path);
  try {
    return await applyPlugin(kernel, recognized, path);
  } catch (error) {
    withRowLocation(error, row);
  }
}

/** Строка, которой заведена область, — ищется ближайший предок, который значится (см. `applyTreeRow`). */
function rowOf(fiber: Fiber, declaredBy: ReadonlyMap<Fiber, TreeRow>): TreeRow | undefined {
  const seen = new Set<Fiber>();
  let current = fiber;
  while (!seen.has(current)) {
    const row = declaredBy.get(current);
    if (row !== undefined) return row;
    seen.add(current);
    current = current.parent.fiber;
  }
  return undefined;
}

/**
 * Отказ о незакрытом внедрении: плагин остался ждать сервис, которого никто
 * не зарегистрировал. Рождается после цикла по строкам — когда текущей строки
 * уже нет, — поэтому строку-виновницу приходится искать по области
 * (`rowOf`). Общий для загрузки и для осмотра дерева: команда `stepcast
 * plugins` обязана назвать ту же виновницу и ту же причину, что и отказ
 * загрузки (`plugin-tree`).
 */
function unresolvedInjectFailure(
  fibers: readonly Fiber[],
  declaredBy: ReadonlyMap<Fiber, TreeRow>,
): { readonly row: TreeRow | undefined; readonly error: StepcastError } | undefined {
  const first = unresolvedFibers(fibers)[0];
  if (first === undefined) return undefined;
  const row = rowOf(first.fiber, declaredBy);
  const file = row === undefined ? undefined : declaredIn(row);
  return {
    row,
    error: new StepcastError(
      `Плагин ${first.plugin} ждёт сервис ${first.missing.join(', ')}, которого не регистрирует ни один из объявленных плагинов`,
      {
        ...(file === undefined ? {} : { file }),
        at: 'plugins',
        hint: 'Объявите плагин, регистрирующий этот сервис, либо снимите зависимость от него',
      },
    ),
  };
}

/** Заменить итог строки на отказ, оставив её на своём месте в перечне. */
function markRowFailed(outcomes: RowOutcome[], row: TreeRow, error: StepcastError): void {
  const index = outcomes.findIndex((outcome) => outcome.row === row);
  if (index !== -1) outcomes[index] = { row, status: 'failed', error };
}

/**
 * Дождаться, пока контекст успокоится, и разобраться с незакрытым внедрением
 * (`unresolvedInjectFailure`).
 *
 * Отказ после применения — такой же отказ строки, как и отказ при нём: строка,
 * найденная обходом каталогов, получает его своим состоянием, её область
 * снимается целиком (иначе за «отказавшей» строкой остались бы вклады,
 * design.md Решение 10), и поиск повторяется — снятая область могла быть
 * единственной, кого ждала соседняя. Строка, названная явно, возвращается
 * вызывающему: загрузка прекращается ею, как и прежде, а осмотр дерева
 * помечает её отказавшей.
 */
async function settleRows(
  kernel: Kernel,
  declaredBy: Map<Fiber, TreeRow>,
  outcomes: RowOutcome[],
): Promise<{ readonly row: TreeRow | undefined; readonly error: StepcastError } | undefined> {
  // Каждый заход снимает ровно одну область и выбрасывает её из `declaredBy` —
  // счётчик здесь только затем, чтобы неожиданное состояние не стало вечным
  // циклом в долгоживущем демоне.
  for (let guard = declaredBy.size; guard >= 0; guard -= 1) {
    const failure = unresolvedInjectFailure(await kernel.settle(), declaredBy);
    if (failure === undefined) return undefined;
    const { row } = failure;
    if (row === undefined || row.source.kind !== 'directory') return failure;

    const fiber = [...declaredBy].find(([, candidate]) => candidate === row)?.[0];
    if (fiber === undefined) return failure;
    declaredBy.delete(fiber);
    await fiber.dispose().catch(() => undefined);
    // Область, так и оставшаяся `PENDING`, снятием эффектов не разматывает:
    // запись в перечне загруженных пережила бы отказ строки (см.
    // `Kernel.forgetPlugin`). Вкладов за ней нет — её тело не исполнялось.
    kernel.forgetPlugin(fiber);
    markRowFailed(outcomes, row, failure.error);
  }
  return undefined;
}

/** Итог применения одной строки — общий для загрузки и осмотра дерева (design.md, Решение 8, 10). */
export interface RowOutcome {
  readonly row: TreeRow;
  readonly status: 'active' | 'disabled' | 'failed' | 'not-attempted';
  readonly error?: StepcastError;
}

export interface LoadResult {
  readonly registry: Registry;
  /**
   * Итог каждой строки дерева, в его порядке (design.md, Решение 10):
   * `resolveWithPlugins`, точка входа CLI и `currentDaemonKernel` доносят их
   * до `stepcast plugins`/`config` и до состава плагинов витрины, не
   * пересобирая дерево заново.
   */
  readonly outcomes: readonly RowOutcome[];
}

/**
 * Собрать реестр: встроенные вклады действующих строк плюс вклады
 * действующих строк-плагинов, в порядке дерева, после того как контекст
 * успокоился.
 *
 * Отказ строки, найденной обходом каталога плагинов, — её состояние
 * (`RowOutcome.status: 'failed'`), а не конец загрузки: соседние строки
 * применяются, и реестр собирается из того, что удалось (design.md,
 * Решение 10). Так же мягок и отказ, случившийся уже после применения, —
 * незакрытое внедрение (`settleRows`): область такой строки снимается, и
 * реестр собирается без её вкладов. Строка, названная явно — ключом `plugins`
 * или патчем, — при отказе по-прежнему прекращает загрузку целиком, как и до
 * появления каталогов плагинов.
 */
export async function loadPlugins(resolved: ResolvedConfig, options: LoadOptions): Promise<LoadResult> {
  const kernel = createKernelShell(options.builtinCommands ?? []);
  const load = options.importModule ?? ((url: string) => import(url));
  // Чьей строкой заведена область. Нужно отказу о незакрытом внедрении: он
  // рождается после цикла, когда текущей строки уже нет, а файл конфигурации
  // назвать обязан наравне с прочими отказами загрузки.
  const declaredBy = new Map<Fiber, TreeRow>();
  const outcomes: RowOutcome[] = [];

  for (const row of resolved.pluginTree) {
    if (!row.enabled) {
      outcomes.push({ row, status: 'disabled' });
      continue;
    }
    try {
      const fiber = await applyTreeRow(kernel, row, options, load);
      if (fiber !== undefined) declaredBy.set(fiber, row);
      outcomes.push({ row, status: 'active' });
    } catch (error) {
      if (row.source.kind !== 'directory') throw error;
      outcomes.push({
        row,
        status: 'failed',
        error: isStepcastError(error) ? error : new StepcastError(error instanceof Error ? error.message : String(error)),
      });
    }
  }

  const failure = await settleRows(kernel, declaredBy, outcomes);
  if (failure !== undefined) throw failure.error;

  return { registry: registryFromKernel(kernel), outcomes };
}

/**
 * Пройти дерево, как это делает `loadPlugins`, но не бросая исключение на
 * первом отказе: команда осмотра (`stepcast plugins`) обязана напечатать
 * дерево целиком и тогда, когда одна из строк не загрузилась (design.md,
 * Решение 8). Отказ строки, найденной обходом каталога плагинов, — её
 * состояние: соседние строки, включая идущие следом, применяются как обычно
 * (design.md, Решение 10). Отказ строки, названной явно — ключом `plugins`
 * или патчем, — по-прежнему останавливает применение: строки ниже неё
 * помечаются «не загружалась», их и не пытались применить, а команда
 * завершится кодом ошибки конфигурации.
 *
 * Успокоение контекста здесь такое же, как в `loadPlugins`: отказ о
 * незакрытом внедрении рождается только после него, и без него команда
 * осмотра напечатала бы все строки действующими там, где загрузка отказала, —
 * молча потеряв и виновницу, и причину.
 */
export async function inspectPluginTree(
  resolved: ResolvedConfig,
  options: LoadOptions,
): Promise<readonly RowOutcome[]> {
  const kernel = createKernelShell(options.builtinCommands ?? []);
  const load = options.importModule ?? ((url: string) => import(url));
  const outcomes: RowOutcome[] = [];
  const declaredBy = new Map<Fiber, TreeRow>();
  // `true`, только когда отказала строка, названная явно: отказ каталожной
  // строки не останавливает применение прочих (design.md, Решение 10).
  let stopped = false;

  for (const row of resolved.pluginTree) {
    if (stopped) {
      outcomes.push({ row, status: 'not-attempted' });
      continue;
    }
    if (!row.enabled) {
      outcomes.push({ row, status: 'disabled' });
      continue;
    }
    try {
      const fiber = await applyTreeRow(kernel, row, options, load);
      if (fiber !== undefined) declaredBy.set(fiber, row);
      outcomes.push({ row, status: 'active' });
    } catch (error) {
      outcomes.push({
        row,
        status: 'failed',
        error: isStepcastError(error) ? error : new StepcastError(error instanceof Error ? error.message : String(error)),
      });
      if (row.source.kind !== 'directory') stopped = true;
    }
  }

  // Отказ о незакрытом внедрении ищется, только если применение не
  // остановилось строгим отказом: тогда дерево применено не целиком, и
  // ожидающая область ждёт сервис строки, до которой попросту не дошли, —
  // причиной названа уже она.
  if (!stopped) {
    const failure = await settleRows(kernel, declaredBy, outcomes);
    if (failure !== undefined) {
      const index = outcomes.findIndex((outcome) => outcome.row === failure.row);
      // Виновница помечается отказавшей на своём месте; строки ниже неё
      // применились и вкладов не теряли, поэтому «не загружалась» им не
      // ставится. Область, не приписанная ни одной строке, — отказ дерева
      // целиком: он достаётся первой действующей строке, чтобы причина всё
      // же была напечатана.
      const at = index === -1 ? outcomes.findIndex((outcome) => outcome.status === 'active') : index;
      const target = outcomes[at];
      if (target !== undefined) outcomes[at] = { row: target.row, status: 'failed', error: failure.error };
    }
  }

  await kernel.dispose().catch(() => undefined);
  return outcomes;
}
