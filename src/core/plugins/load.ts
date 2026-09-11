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

/**
 * Применить одну строку дерева: встроенная — фабрика из таблицы `builtin.ts`
 * по форме `use: stepcast:<имя>`, обычная — прежние `resolveModulePath`,
 * импорт и `applyPlugin` (задача 3.1, 3.2). Строка встроенного слоя,
 * замененная патчем, сюда не доходит вовсе: в дереве её больше нет — на её
 * месте новая строка со своим `use`.
 *
 * Возвращает область плагина, если она была заведена (обычная строка), — её
 * `loadPlugins` использует для отказа о незакрытом внедрении. Встроенная
 * строка область не заводит: она регистрирует вклад прямо на корневом
 * контексте ядра (`builtin.ts`).
 */
async function applyTreeRow(
  kernel: Kernel,
  row: TreeRow,
  options: LoadOptions,
  load: (url: string) => Promise<unknown>,
): Promise<Fiber | undefined> {
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

/**
 * Собрать реестр: встроенные вклады действующих строк плюс вклады
 * действующих строк-плагинов, в порядке дерева, после того как контекст
 * успокоился.
 */
export async function loadPlugins(resolved: ResolvedConfig, options: LoadOptions): Promise<Registry> {
  const kernel = createKernelShell(options.builtinCommands ?? []);
  const load = options.importModule ?? ((url: string) => import(url));
  // Чьей строкой заведена область. Нужно отказу о незакрытом внедрении: он
  // рождается после цикла, когда текущей строки уже нет, а файл конфигурации
  // назвать обязан наравне с прочими отказами загрузки.
  const declaredBy = new Map<Fiber, TreeRow>();

  for (const row of resolved.pluginTree) {
    if (!row.enabled) continue;
    const fiber = await applyTreeRow(kernel, row, options, load);
    if (fiber !== undefined) declaredBy.set(fiber, row);
  }

  const failure = unresolvedInjectFailure(await kernel.settle(), declaredBy);
  if (failure !== undefined) throw failure.error;

  return registryFromKernel(kernel);
}

/** Итог применения одной строки — для команды осмотра дерева (`stepcast plugins`, design.md, Решение 8). */
export interface RowOutcome {
  readonly row: TreeRow;
  readonly status: 'active' | 'disabled' | 'failed' | 'not-attempted';
  readonly error?: StepcastError;
}

/**
 * Пройти дерево, как это делает `loadPlugins`, но не бросая исключение на
 * первом отказе: команда осмотра (`stepcast plugins`) обязана напечатать
 * дерево целиком и тогда, когда одна из строк не загрузилась (design.md,
 * Решение 8). Строка, на которой случился отказ, несёт его причину; строки
 * ниже неё помечаются «не загружалась» — их и не пытались применить.
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
  let failed = false;

  for (const row of resolved.pluginTree) {
    if (failed) {
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
      failed = true;
      outcomes.push({
        row,
        status: 'failed',
        error: isStepcastError(error) ? error : new StepcastError(error instanceof Error ? error.message : String(error)),
      });
    }
  }

  // Отказ о незакрытом внедрении ищется, только если ни одна строка не
  // отказала: после отказа дерево применено не целиком, и ожидающая область
  // ждёт сервис строки, до которой попросту не дошли, — причиной названа уже
  // она.
  if (!failed) {
    const failure = unresolvedInjectFailure(await kernel.settle(), declaredBy);
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
