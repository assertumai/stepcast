import type { ResolvedConfig } from '../core/config/resolve.js';
import { StepcastError } from '../core/errors.js';
import { applyPluginTree, walkPluginTree, type LoadOptions, type LoadResult, type RowOutcome } from '../core/plugins/load.js';
import type { Introspection } from '../core/plugins/introspect.js';
import type { Kernel } from '../core/plugins/kernel.js';
import { DECLARATIVE_CONTRIBUTION_FIELDS } from '../core/plugins/pipeline-contract.js';
import { createKernelShell } from './builtin.js';
import { BUILTIN_ROWS } from './rows.js';

/**
 * Состав дефолта (`docs/microkernel-target.md`, «Финальная структура кода»):
 * какое ядро поднять и какими строками поставки его дополнить — решение вне
 * ядра плагинов (`kernel-domain-free-imports`, Решение 3). `loadPlugins` и
 * `inspectPluginTree` сохраняют имена и сигнатуры, которыми их звали до
 * переезда: вызывающие (CLI, витрина, тесты) правят только путь импорта.
 *
 * Порядок слагаемых в `builtinRows` обязателен: подсказка отказа о
 * несуществующей встроенной строке перечисляет строки в этом же порядке —
 * строки движка, затем строки вызывающего (`load.ts`, `unknownBuiltinRow`).
 *
 * Наборы входов различаются только строками вызывающего: команды CLI
 * (`src/cli/main.ts`) зовут `loadPlugins`/`inspectPluginTree` без
 * `builtinRows` и состава у себя не называют — им достаётся перечень дефолта
 * `src/parts/rows.ts` и ничего сверх него; `stepcast up` (`src/ui/kernel.ts`)
 * подаёт поверх него `UI_ROWS` параметром. Поэтому строки витрины не попадают
 * в дерево команд CLI, а добавление и изъятие строки дефолта — правка
 * `src/parts/rows.ts`, и только её: ни этот модуль, ни обход
 * (`src/core/plugins/load.ts`), ни разрешение конфигурации
 * (`src/core/config/resolve.ts`) состава не знают.
 */

/**
 * Опции состава дефолта — опции обхода без `declarativeFields`
 * (`cli-commands-as-rows`, Решение 11): её подаёт сам состав дефолта, ниже, —
 * вызывающему (CLI, витрина, тесты) называть действующую таблицу незачем,
 * она всегда одна и та же (`DECLARATIVE_CONTRIBUTION_FIELDS`). Сборка ядра
 * (`createKernelShell`) больше не принимает ничего, что вызывающий мог бы
 * подать этим типом отдельно от строк (Решение 2) — команды приходят
 * строками `builtinRows`, тем же полем, что и прочие строки вызывающего.
 */
export type DefaultLoadOptions = Omit<LoadOptions, 'declarativeFields'>;

/**
 * Отказ: строка вызывающего повторяет `id` строки движка (`plugin-tree`,
 * design.md, Решение 5). Молча такая пара даёт две одноимённые строки в семени
 * дерева и отказ о занятом имени вклада, где обе стороны зовутся «встроенный
 * вклад», — причина не названа вовсе. Замена встроенной строки делается
 * патчем состава (`plugins.patch.yml`), а не второй записью в перечне
 * вызывающего, — тот путь идёт мимо `builtinRows` обеих сторон и этим отказом
 * не задевается.
 */
function duplicateBuiltinRow(id: string): StepcastError {
  return new StepcastError(`Строка ${id} названа и перечнем движка, и перечнем вызывающего`, {
    at: 'plugins',
    hint: 'Замена встроенной строки делается патчем (plugins.patch.yml), а не второй записью в перечне — см. docs/plugins.md',
  });
}

/** Ядро состава дефолта и опции обхода к нему — общая часть обеих обёрток ниже. */
function defaultComposition(options: DefaultLoadOptions): { readonly kernel: Kernel; readonly options: LoadOptions } {
  const callerRows = options.builtinRows ?? [];
  const engineIds = new Set(BUILTIN_ROWS.map((row) => row.id));
  for (const row of callerRows) if (engineIds.has(row.id)) throw duplicateBuiltinRow(row.id);
  return {
    kernel: createKernelShell(),
    options: { ...options, builtinRows: [...BUILTIN_ROWS, ...callerRows], declarativeFields: DECLARATIVE_CONTRIBUTION_FIELDS },
  };
}

/**
 * Загрузить дерево плагинов на встроенном ядре движка — прежнее поведение
 * `loadPlugins`. `async`, а не прямой возврат `applyPluginTree(...)`: отказ
 * `defaultComposition` (пересечение перечней) обязан прийти отклонённым
 * промисом, как и всякий другой отказ загрузки, а не синхронным исключением
 * из функции, объявленной `Promise<LoadResult>`.
 */
export async function loadPlugins(resolved: ResolvedConfig, options: DefaultLoadOptions): Promise<LoadResult> {
  const composition = defaultComposition(options);
  return applyPluginTree(composition.kernel, resolved, composition.options);
}

/** Пройти дерево плагинов на встроенном ядре движка — прежнее поведение `inspectPluginTree`, тем же приёмом `async`. */
export async function inspectPluginTree(
  resolved: ResolvedConfig,
  options: DefaultLoadOptions,
): Promise<{ readonly outcomes: readonly RowOutcome[]; readonly introspection: Introspection }> {
  const composition = defaultComposition(options);
  return walkPluginTree(composition.kernel, resolved, composition.options);
}
