import type { Context, Fiber } from 'cordis';

import type { BackendContribution, PipelineContext, PredicateKind, StepKind } from '../../core/plugins/pipeline-contract.js';
import type { ContributionService, Kernel } from '../../core/plugins/kernel.js';
import { rowScope, type BuiltinRow } from '../../core/plugins/load.js';

/**
 * Служебные сервисы движка пайплайнов — `backends`, `predicates`, `steps` —
 * и помощник строки-потребителя, общий для всех строк этого каталога
 * (design.md `pipeline-owns-services`, Решение 1). Раскладка та же, что у
 * витрины: сами сервисы и объявление контекста cordis живут рядом с
 * помощником, а не в ядре (`src/ui/screens/registry.ts`, `src/ui/shell/row.ts`).
 *
 * `declare module 'cordis'` для этих трёх сервисов переехало сюда из ядра:
 * ядро (`src/core/plugins/kernel.ts`) их типов не знает вовсе — они заводятся
 * строкой `pipeline` (`./row.ts`), не сборкой ядра.
 */

/**
 * Области строк этого каталога — строки `pipeline` и её потребителей
 * (`backend-claude`, `predicates`, пять строк видов шага). Модульное
 * множество, не поле сервиса и не параметр `register`: признак встроенности
 * обязан быть неподделываемым — тем же приёмом и по той же причине, что
 * `builtinFibers` витрины (`src/ui/screens/registry.ts`). Область помечается
 * изнутри применения строки, до первой регистрации (`partRow` ниже).
 *
 * В синхронной сборке умолчания (`src/parts/builtin.ts`, `createBuiltinKernel`)
 * тела строк зовутся прямо на корневом контексте — фибер, попавший сюда в
 * этом случае, окажется корневым, и это не портит признак: `register`
 * (`ContributionService`, `kernel.ts`) проверяет принадлежность этому
 * множеству, а корневой фибер, единожды помеченный, остаётся во множестве на
 * весь срок жизни этого ядра (design.md, Решение 4).
 */
const builtinFibers = new WeakSet<Fiber>();

/** Признак «эта область — область строки этого каталога», подаётся конструктору `ContributionService`. */
export function isBuiltinFiber(fiber: Fiber): boolean {
  return builtinFibers.has(fiber);
}

declare module 'cordis' {
  interface Context {
    backends: ContributionService<BackendContribution>;
    predicates: ContributionService<PredicateKind>;
    steps: ContributionService<StepKind>;
  }
}

/**
 * Стык доменного объявления контекста с настоящим (`plugin-surface-split`,
 * design.md, Решение 4): расхождение `PipelineContext`
 * (`core/plugins/pipeline-contract.ts`) с составом сервисов, которые заводит
 * эта строка, — ошибка компиляции здесь, у нас, а не у автора плагина. Имя
 * иное, чем у ядерного стыка `pluginContext()` (`core/plugins/kernel.ts`), и
 * иное, чем у публикуемого сужения `pipelineContext()`
 * (`src/parts/pipeline/surface.ts`) — тот проверяет состав в рантайме, этот
 * только в типах, и два одноимённых экспорта одного каталога читались бы как
 * один.
 */
export function pipelinePluginContext(ctx: Context): PipelineContext {
  return ctx;
}

/** Строка-поставщик или строка-потребитель этого каталога — `BuiltinRow` плюс то, что нужно синхронному умолчанию (design.md, Решение 4). */
export interface PartRow extends BuiltinRow {
  /** Сервисы, которых ждёт тело строки, — те же имена, что несёт `ctx.plugin({ inject })` в форме дерева. */
  readonly inject: readonly string[];
  /**
   * Тело строки без области — вызывается синхронным умолчанием
   * (`createBuiltinKernel`) прямо на корневом контексте, в порядке перечня
   * `BUILTIN_ROWS`. То же тело, что заводит форма дерева (`apply`): различается
   * только область, на которой оно исполняется.
   */
  register(ctx: Context): void;
}

/**
 * Строка-поставщик или строка-потребитель служебных сервисов пайплайна:
 * `rowScope` (`src/core/plugins/load.ts`) плюс пометка области, до первой
 * регистрации (design.md, Решение 2, Решение 3). Форма дерева (`apply`)
 * заводит собственную область строки с объявленным `inject`; синхронное
 * умолчание (`register`) зовёт то же тело прямо на переданном контексте —
 * `createBuiltinKernel` подаёт ей корневой контекст, предварительно сверив
 * `inject` (design.md, Решение 4).
 */
export function partRow(id: string, inject: readonly string[], register: (ctx: Context) => void): PartRow {
  const marked = (ctx: Context): void => {
    builtinFibers.add(ctx.fiber);
    register(ctx);
  };
  return {
    id,
    inject,
    register: marked,
    apply: (kernel: Kernel) => rowScope(kernel, id, inject, marked),
  };
}
