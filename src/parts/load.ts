import type { ResolvedConfig } from '../core/config/resolve.js';
import type { CommandContribution } from '../core/plugins/contract.js';
import { applyPluginTree, walkPluginTree, type LoadOptions, type LoadResult, type RowOutcome } from '../core/plugins/load.js';
import type { Introspection } from '../core/plugins/introspect.js';
import type { Kernel } from '../core/plugins/kernel.js';
import { BUILTIN_ROWS, createKernelShell } from './builtin.js';

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
 */

/**
 * Опции состава дефолта: опции обхода плюс то, чем распоряжается сборка ядра,
 * а не обход. `builtinCommands` объявлено здесь, а не в `LoadOptions` ядерной
 * пары: читает его только `createKernelShell` ниже, и поле, оставленное в
 * общих опциях, молча не вносило бы команд при прямом вызове
 * `applyPluginTree`/`walkPluginTree`.
 */
export interface DefaultLoadOptions extends LoadOptions {
  /** Встроенные команды: их вносит точка входа, ядро о них не знает. */
  readonly builtinCommands?: readonly CommandContribution[];
}

/** Ядро состава дефолта и опции обхода к нему — общая часть обеих обёрток ниже. */
function defaultComposition(options: DefaultLoadOptions): { readonly kernel: Kernel; readonly options: LoadOptions } {
  const { builtinCommands, ...rest } = options;
  return {
    kernel: createKernelShell(builtinCommands ?? []),
    options: { ...rest, builtinRows: [...BUILTIN_ROWS, ...(options.builtinRows ?? [])] },
  };
}

/** Загрузить дерево плагинов на встроенном ядре движка — прежнее поведение `loadPlugins`. */
export function loadPlugins(resolved: ResolvedConfig, options: DefaultLoadOptions): Promise<LoadResult> {
  const composition = defaultComposition(options);
  return applyPluginTree(composition.kernel, resolved, composition.options);
}

/** Пройти дерево плагинов на встроенном ядре движка — прежнее поведение `inspectPluginTree`. */
export function inspectPluginTree(
  resolved: ResolvedConfig,
  options: DefaultLoadOptions,
): Promise<{ readonly outcomes: readonly RowOutcome[]; readonly introspection: Introspection }> {
  const composition = defaultComposition(options);
  return walkPluginTree(composition.kernel, resolved, composition.options);
}
