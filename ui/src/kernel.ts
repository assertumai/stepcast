import { Context, type Fiber } from 'cordis';
import { createContext } from 'react';

import { failedFibers, settle, topLevelFibers, unresolvedFibers } from '../../src/core/plugins/fibers';
// Расширение у `./slots.ts` — явно, не по привычке: рядом лежит
// `ui/src/slots.tsx` (рендерер), и резолверы расходятся, что означает голое
// `./slots` — esbuild (vite, сборка тестов) по умолчанию пробует `.tsx`
// раньше `.ts`, `tsc` в режиме `bundler` — наоборот. Явное расширение снимает
// разногласие само, вместо того чтобы полагаться на совпадение порядков
// (`allowImportingTsExtensions` в `ui/tsconfig.json` существует для этого).
import {
  SLOTS_SERVICE_NAME,
  SlotsService,
  isSlotServiceName,
  slot,
  slotNameFromServiceName,
  slotServiceName,
  translateSlotNameConflict,
  type RejectedContribution,
} from './slots.ts';
import { LIVE_SERVICE_NAME, LiveService, type EventSourceFactory } from './services/live';
import { SCREENS_SERVICE_NAME, ScreensService } from './services/screens';
import { PLUGINS_SERVICE_NAME, PluginsService, type PluginModuleLoader } from './services/plugins';
import type { StyleSink } from './services/styles';

/**
 * Ядро витрины — корневой контекст cordis страницы (design.md
 * `cordis-kernel-browser`, Решения 7, 9, 13).
 *
 * `createBrowserKernel()` синхронно поднимает контекст, сервис `slots` и
 * слот `root`: страница ещё не отрисована, а место для первого вкладчика уже
 * есть. Контекст — собственность вызывающего (`main.tsx`), не дерева
 * компонентов: он заводится на уровне модуля, до `createRoot(...).render`, и
 * переживает любую перерисовку по устройству, а не по соглашению.
 *
 * Отказы не бросаются наружу вызовом — они собираются `settle()`, тем же
 * приёмом, что и в демоне (`src/core/plugins/kernel.ts`), через общий модуль
 * `src/core/plugins/fibers.ts`.
 */

/** Слот, которому некуда встать, кроме как на сам корень (design.md, Решение 7). */
export const ROOT = slot<Record<string, never>, 'single'>('root', 'single');

/**
 * Контекст ядра в дереве React — обычным `createContext`, а не своим
 * провайдером (design.md, Решение 11). Читает его только `<Slot>`
 * (`ui/src/slots.tsx`): компонент, внесённый в слот, к контексту не
 * обращается вовсе, всё нужное приходит через props слота.
 */
export const KernelContext = createContext<Context | undefined>(undefined);

function topLevelOwnerOf(fiber: Fiber, ctx: Context): Fiber {
  let current = fiber;
  while (current.parent !== ctx) current = current.parent.fiber;
  return current;
}

const RESERVED_SERVICE_RE = /^service "([^"]+)" has been registered at <([^>]*)>/;

/**
 * Имена сервисов, заведённых самим ядром, — заняты наравне с префиксом `slot:`
 * (design.md, Решение 2): и реестр слотов, и сервис живых данных — такие же
 * сервисы контекста, как и слоты, и плагин, попытавшийся завести сервис с
 * таким именем напрямую, получает конфликт cordis так же, как при повторном
 * объявлении слота.
 */
const KERNEL_SERVICE_NAMES: Readonly<Record<string, string>> = {
  [SLOTS_SERVICE_NAME]: 'реестр слотов',
  [LIVE_SERVICE_NAME]: 'живые данные витрины',
  [SCREENS_SERVICE_NAME]: 'состав экранов витрины',
  [PLUGINS_SERVICE_NAME]: 'состав браузерных строк',
};

function translateKernelNameConflict(
  error: unknown,
  claimant: string,
): { readonly slot: string | undefined; readonly message: string } | undefined {
  const slotConflict = translateSlotNameConflict(error, claimant);
  if (slotConflict !== undefined) return { slot: slotConflict.conflict.slotName, message: slotConflict.message };

  if (!(error instanceof Error)) return undefined;
  const match = RESERVED_SERVICE_RE.exec(error.message);
  const name = match?.[1];
  const belongs = name === undefined ? undefined : KERNEL_SERVICE_NAMES[name];
  if (name === undefined || belongs === undefined) return undefined;
  return {
    // Имя сервиса ядра — не слот, и приписывать отказу слот `root` значило бы
    // назвать в диагностике то, к чему отказ отношения не имеет.
    slot: undefined,
    message: `Имя сервиса ${name} занято: оно принадлежит ядру (${belongs})`,
  };
}

/** Отказ, попавший на полосу диагностик, — что показать и что записать в `console.error` (design.md, Решение 6). */
export interface Diagnostic {
  readonly kind: 'unresolved' | 'rejected' | 'failed';
  readonly plugin: string;
  /**
   * Слот, из-за которого отказ. `undefined` — только у отказа плагина, не
   * имеющего отношения к слотам вовсе (любая ошибка в его `apply`): выдумывать
   * ему слот значило бы назвать в полосе диагностик неправду. У отказов
   * состава — а требование `ui-kernel` про «называть плагин и слот» именно о
   * них — слот назван всегда.
   */
  readonly slot: string | undefined;
  readonly message: string;
}

/** Текст отвергнутого вклада для полосы диагностик — по причине отказа (`ui/src/slots.ts`). */
function rejectionMessage(rejected: RejectedContribution): string {
  if (rejected.reason === 'kind-mismatch') {
    return (
      `Слот ${rejected.slotName}: вклад плагина ${rejected.owner} отвергнут — ` +
      `слот объявлен видом ${rejected.kind}, а вклад внесён как ${rejected.contributedKind}`
    );
  }
  const keyed = rejected.key === undefined ? '' : ` с ключом ${rejected.key}`;
  return (
    `Слот ${rejected.slotName}${keyed}: вклад плагина ${rejected.owners[1]} отвергнут — ` +
    `место уже занял ${rejected.owners[0]}`
  );
}

async function collectDiagnostics(ctx: Context): Promise<readonly Diagnostic[]> {
  let fibers = await settle(ctx);
  const diagnostics: Diagnostic[] = [];
  const disposed = new Set<Fiber>();

  // Повторное объявление слота — исключение из «собирается, не бросается»:
  // cordis валит область вкладом при `provide`. Плагин, отказавший так,
  // снимается целиком — тем же правилом, что в демоне (design.md, Решение 6).
  for (const failed of failedFibers(fibers)) {
    const error = await failed.await().catch((reason: unknown) => reason as unknown);
    const translated = translateKernelNameConflict(error, failed.name);
    diagnostics.push({
      kind: 'failed',
      plugin: failed.name,
      slot: translated?.slot,
      message: translated?.message ?? (error instanceof Error ? error.message : String(error)),
    });
    const owner = topLevelOwnerOf(failed, ctx);
    if (!disposed.has(owner)) {
      disposed.add(owner);
      await owner.dispose();
    }
  }

  // Диспоз владельца мог освободить имена и разрешить ожидавшие их области
  // (или, наоборот, обнажить новые зависшие) — пересчитать на успокоившемся
  // после этого дереве.
  if (disposed.size > 0) fibers = await settle(ctx);

  for (const unresolved of unresolvedFibers(fibers)) {
    const names = unresolved.missing.map((name) => (isSlotServiceName(name) ? slotNameFromServiceName(name) : name));
    diagnostics.push({
      kind: 'unresolved',
      plugin: unresolved.plugin,
      slot: names.join(', '),
      message: `Плагин ${unresolved.plugin} ждёт слот ${names.join(', ')}, которого не объявил ни один из загруженных плагинов`,
    });
  }

  for (const rejected of ctx.slots.getRejected()) {
    diagnostics.push({
      kind: 'rejected',
      plugin: rejected.reason === 'kind-mismatch' ? rejected.owner : rejected.owners[1],
      slot: rejected.slotName,
      message: rejectionMessage(rejected),
    });
  }

  // Строки, чья новая редакция не загрузилась (`stale`) или не применилась
  // (`failed`), — тем же видом диагностики, что и отказы сборки (design.md
  // `hot-swap-preserves-data`, Решение 6): не молча, полосой поверх витрины.
  for (const row of ctx.plugins.diagnostics()) {
    diagnostics.push({ kind: 'failed', plugin: row.plugin, slot: undefined, message: row.message });
  }

  return diagnostics;
}

export interface BrowserKernelOptions {
  /**
   * Фабрика источника событий сервиса `live`. По умолчанию — настоящий
   * `EventSource` браузера; тесты подставляют свой (требование `ui-kernel`,
   * «Источник событий MUST быть подменяем, чтобы сервис проверялся без
   * браузера»), и без подмены ядро в Node не поднять вовсе — `EventSource`
   * там нет.
   */
  readonly createEventSource?: EventSourceFactory;
  /**
   * Загрузчик модуля браузерной половины плагина. По умолчанию —
   * `import(pluginModuleHref(id, version))`; тесты подставляют свой (design.md
   * `hot-swap-preserves-data`, Решение 8) — замена проверяется без сети.
   */
  readonly loadPluginModule?: PluginModuleLoader;
  /**
   * Приёмник стилей браузерной половины. По умолчанию — `<style
   * data-plugin="<id>">` в `document.head`; тесты подставляют свой —
   * принадлежность стиля области строки проверяется без браузера (design.md,
   * Решение 7, 8).
   */
  readonly styleSink?: StyleSink;
}

export interface BrowserKernel {
  readonly ctx: Context;
  /** Дождаться успокоения контекста и собрать диагностики сборки (design.md, Решение 6). */
  settle(): Promise<readonly Diagnostic[]>;
  /**
   * Подписка на «диагностики могли измениться»: состав браузерных строк
   * приходит потоком уже после монтирования страницы, и отказ замены обязан
   * попасть на полосу диагностик (`KernelRoot`, `ui/src/slots.tsx`), а не
   * только в `console.error` — собранные один раз эффектом монтирования
   * диагностики о нём не узнали бы вовсе (design.md
   * `hot-swap-preserves-data`, Решение 6). Возвращает функцию отписки.
   */
  subscribe(listener: () => void): () => void;
  /** Снять все области плагинов — то, чем `hot-swap-preserves-data` заменит один плагин, а тесты чистят дерево целиком. */
  dispose(): Promise<void>;
}

export function createBrowserKernel(options: BrowserKernelOptions = {}): BrowserKernel {
  const ctx = new Context();
  new SlotsService(ctx);
  // Сервис живых данных — тоже собственность ядра, а не плагина: каркас
  // читает `ctx.live` первой же отрисовкой, и заводить его отдельным плагином
  // значило бы поставить наличие данных в зависимость от порядка загрузки
  // (требование `ui-kernel`, «Данные витрины и подписка на события живут в
  // сервисе»). Одна подписка на вкладку — следствие того, что конструктор
  // зовётся ровно здесь.
  new LiveService(ctx, options.createEventSource);
  // Состав экранов — тем же приёмом, что и `live`: маршрутизатор
  // (`ui/src/router.tsx`) и плагин `screens` читают его с первой отрисовки, а
  // не с той, на которую попадёт какой-то конкретный плагин.
  new ScreensService(ctx);
  // Состав браузерных строк и их замена — тоже собственность ядра, а не
  // плагина (design.md `hot-swap-preserves-data`, Решение 1): плагин обязан
  // пережить замену любой строки, включая свою собственную, а заменяющий
  // самого себя не может снять и незавершённую замену.
  new PluginsService(ctx, {
    ...(options.loadPluginModule === undefined ? {} : { loadModule: options.loadPluginModule }),
    ...(options.styleSink === undefined ? {} : { styleSink: options.styleSink }),
  });
  ctx.provide(slotServiceName(ROOT.name), ROOT);

  // Ядро сверяет состав строк на каждое изменение поля `plugins` снимка
  // `live` (design.md, Решение 11) — сравнением по ссылке: демон присылает ту
  // же ссылку, пока состав не изменился (`ui/src/services/live.ts`). Подписка
  // не оформлена `ctx.effect`, как у `LiveService`, — снимать её незачем: она
  // обязана жить, пока живо само ядро, ровно как и слот `root` выше.
  let lastPlugins = ctx.live.get().plugins;
  ctx.live.subscribe(() => {
    const next = ctx.live.get().plugins;
    if (next === lastPlugins) return;
    lastPlugins = next;
    void ctx.plugins.reconcile(next);
  });

  return {
    ctx,
    settle: () => collectDiagnostics(ctx),
    subscribe: (listener) => ctx.plugins.subscribe(listener),
    async dispose() {
      await settle(ctx);
      await Promise.all(topLevelFibers(ctx).map((fiber) => fiber.dispose()));
    },
  };
}
