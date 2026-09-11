import { Service, type Context, type Fiber } from 'cordis';

import { WIDGET_ERROR_EXPORT, WIDGET_STYLE_EXPORT } from '../../../src/ui/widgetRuntime.ts';
import { pluginModuleHref } from '../../../src/ui/routes.ts';
import type { PluginRowView, WidgetCompileFailure } from '../api';
import type { StyleSink } from './styles.ts';
import { defaultStyleSink } from './styles.ts';

/**
 * Сервис состава браузерных строк — единица замены плагина владеет ядро, а
 * не плагин (design.md `hot-swap-preserves-data`, Решение 1): строки по
 * идентификатору, у каждой версия, область (`ctx.plugin`-фибер) и состояние
 * `active` / `stale` / `failed` (Решение 6).
 *
 * Заводится `createBrowserKernel()` (`ui/src/kernel.ts`) рядом со `slots`,
 * `live` и `screens`; сверку состава зовёт ядро на каждое изменение поля
 * `plugins` снимка `live` (Решение 11).
 */
export const PLUGINS_SERVICE_NAME = 'plugins';

export type PluginRowState =
  | { readonly status: 'active'; readonly version: string }
  | {
      readonly status: 'stale';
      /** Версия, которая работает на странице — прежняя редакция, чья замена не загрузилась. */
      readonly workingVersion: string;
      readonly failedVersion: string;
      readonly reason: string;
    }
  | { readonly status: 'failed'; readonly version: string; readonly reason: string };

/** Загрузить модуль браузерной половины по идентификатору и версии строки — шов, как и `createEventSource`. */
export type PluginModuleLoader = (id: string, version: string) => Promise<unknown>;

const defaultLoader: PluginModuleLoader = (id, version) => import(/* @vite-ignore */ pluginModuleHref(id, version));

/** Диагностика строки для полосы кернела (`ui/src/kernel.ts`, `collectDiagnostics`) — только у `stale`/`failed`. */
export interface PluginRowDiagnostic {
  readonly plugin: string;
  readonly message: string;
}

interface Row {
  /** Область текущей ПРИМЕНЁННОЙ редакции — `undefined`, если применённой нет (`failed`). */
  fiber: Fiber | undefined;
  /** Версия текущей применённой редакции — `undefined` вместе с `fiber`. */
  appliedVersion: string | undefined;
  state: PluginRowState;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Разобранная ошибка сборки — в одну строку причины: место и текст, как их напечатал бы компилятор. */
function failureReason(failure: WidgetCompileFailure): string {
  return `${failure.file}:${failure.line}:${failure.column}: ${failure.text}`;
}

interface PluginModuleShape {
  readonly default?: unknown;
  readonly [WIDGET_ERROR_EXPORT]?: WidgetCompileFailure;
  readonly [WIDGET_STYLE_EXPORT]?: string;
}

export interface PluginsServiceOptions {
  readonly loadModule?: PluginModuleLoader;
  readonly styleSink?: StyleSink;
}

export class PluginsService extends Service {
  /** Применённые строки: запись появляется, когда редакция применилась либо отказала. */
  private readonly rows = new Map<string, Row>();
  /**
   * Желаемый состав — то, что прислал демон, а не то, что уже применено
   * (`rows`). Обходить при снятии нужно именно его: строка, чей импорт ещё
   * идёт, в `rows` не попала, и состав без неё, пришедший следующим событием,
   * не поставил бы ей снятия вовсе — она применилась бы после и осталась на
   * странице навсегда.
   */
  private readonly desired = new Set<string>();
  /** Очередь на строку (design.md, Решение «замены одной строки последовательны»): второе обращение к той же строке ждёт первое. */
  private readonly queues = new Map<string, Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private readonly loadModule: PluginModuleLoader;
  private readonly styleSink: StyleSink;
  private readonly rootCtx: Context;

  constructor(ctx: Context, options: PluginsServiceOptions = {}) {
    super(ctx, PLUGINS_SERVICE_NAME);
    this.rootCtx = ctx;
    this.loadModule = options.loadModule ?? defaultLoader;
    this.styleSink = options.styleSink ?? defaultStyleSink;
  }

  /**
   * Подписка на изменение состояний строк. Нужна полосе диагностик
   * (`KernelRoot`, `ui/src/slots.tsx`): состав приходит потоком уже после того,
   * как страница смонтирована, и без уведомления отказ замены остался бы
   * только в `console.error` — полоса собирается один раз эффектом монтирования.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Диагностики отказавших/устаревших строк — собираются `ui/src/kernel.ts` в общую полосу вместе с отказами сборки. */
  diagnostics(): readonly PluginRowDiagnostic[] {
    const out: PluginRowDiagnostic[] = [];
    for (const [id, row] of this.rows) {
      if (row.state.status === 'stale') {
        out.push({
          plugin: id,
          message:
            `Новая редакция ${row.state.failedVersion} не загрузилась — работает прежняя ${row.state.workingVersion}: ${row.state.reason}`,
        });
      } else if (row.state.status === 'failed') {
        out.push({ plugin: id, message: `Редакция ${row.state.version} не применилась: ${row.state.reason}` });
      }
    }
    return out;
  }

  /**
   * Сверить состав с присланным демоном: применить новую строку, снять
   * исчезнувшую, заменить разошедшуюся версию (design.md, Решение 1, 2, 4).
   * Каждая строка обрабатывается своей очередью — сверки не ждут друг друга,
   * но два обращения к одной строке подряд не снимают и не применяют её
   * вперехлёст.
   */
  async reconcile(composition: readonly PluginRowView[]): Promise<void> {
    const seen = new Set<string>();
    const tasks: Promise<void>[] = [];

    for (const view of composition) {
      seen.add(view.id);
      // Желаемый состав пополняется СИНХРОННО, до первого `await`: следующая
      // сверка обязана увидеть эту строку, даже если её импорт ещё идёт.
      this.desired.add(view.id);
      tasks.push(this.enqueue(view.id, view));
    }
    for (const id of [...this.desired]) {
      if (seen.has(id)) continue;
      this.desired.delete(id);
      tasks.push(this.enqueue(id, undefined));
    }

    await Promise.all(tasks);
  }

  private enqueue(id: string, view: PluginRowView | undefined): Promise<void> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.then(() => this.swapRow(id, view)).catch(() => undefined);
    this.queues.set(id, next);
    return next;
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  /**
   * Новая редакция не годится — прежняя остаётся работать (`stale`), а если
   * работающей не было, строка садится в `failed`. Одна дорога у трёх причин:
   * импорт бросил, демон отдал модуль ошибки сборки, модуль не экспортирует
   * применения — все три выясняются ДО снятия прежней области, и ни одна не
   * вправе оставить страницу молча пустой (спека `ui-hot-swap`, «Отказ новой
   * редакции назван, прежняя молча не возвращается»).
   */
  private rejectEdition(id: string, version: string, existing: Row | undefined, reason: string): void {
    const failure: PluginRowState =
      existing?.appliedVersion !== undefined
        ? { status: 'stale', workingVersion: existing.appliedVersion, failedVersion: version, reason }
        : { status: 'failed', version, reason };
    console.error(`[stepcast] строка ${id}: ${reason}`);
    this.rows.set(id, {
      fiber: existing?.fiber,
      appliedVersion: existing?.appliedVersion,
      state: failure,
    });
    this.notify();
  }

  private async swapRow(id: string, view: PluginRowView | undefined): Promise<void> {
    const existing = this.rows.get(id);

    if (view === undefined) {
      if (existing === undefined) return;
      await this.rootCtx.slots.batch(async () => {
        await existing.fiber?.dispose();
      });
      this.rows.delete(id);
      this.notify();
      return;
    }

    // Уже применена ровно эта версия — сверка ничего не делает (design.md,
    // Решение 10: замена не трогает то, чем уже владеет).
    if (existing?.appliedVersion === view.version) return;

    // Шаг 1: импорт — вне окна замены. Его отказ не трогает прежнюю редакцию
    // (design.md, Решение 2): страница обязана остаться ровно такой, какой
    // была, а строка — назвать причину и обе версии.
    let module: PluginModuleShape;
    try {
      module = (await this.loadModule(id, view.version)) as PluginModuleShape;
    } catch (error) {
      this.rejectEdition(id, view.version, existing, reasonOf(error));
      return;
    }

    // Ошибка сборки приходит не отказом запроса, а исполняемым модулем и тем
    // же 200 (`errorModuleText`, `src/ui/widgets.ts`): `import()` браузера
    // превращает любой не-2xx ответ в `TypeError` без тела, и без чтения этого
    // экспорта сломанная половина применилась бы как пустая — молча, тем же
    // приёмом, каким её читает хост виджета (`ui/src/widgetHost.tsx`).
    const failure = module[WIDGET_ERROR_EXPORT];
    if (failure !== undefined) {
      this.rejectEdition(id, view.version, existing, failureReason(failure));
      return;
    }

    const apply = module.default;
    if (typeof apply !== 'function') {
      this.rejectEdition(
        id,
        view.version,
        existing,
        'модуль браузерной половины не экспортирует применение по умолчанию',
      );
      return;
    }
    const applyRow = apply as (ctx: Context) => void;
    const css = module[WIDGET_STYLE_EXPORT];

    // Шаги 2 и 3: снятие прежней области и применение новой — целиком внутри
    // окна замены (design.md, Решение 3), чтобы рендерер увидел одно
    // изменение состава, а не промежуточный кадр без строки.
    await this.rootCtx.slots.batch(async () => {
      await existing?.fiber?.dispose();

      const fiber = this.rootCtx.plugin({
        name: id,
        apply: (ctx) => {
          // Стиль — эффект области самой строки, а не вызов рядом с ней: так
          // он снимается тем же, чем снимается область, включая снятие ядра
          // целиком (`BrowserKernel.dispose`), а не только заменой этой
          // строки (спека `ui-hot-swap`, «применяться эффектом области её
          // строки»). Вешается до применения половины — стиль обязан быть на
          // месте раньше первой отрисовки её вклада.
          if (css !== undefined) ctx.effect(() => this.styleSink(id, css), `plugins.style(${id})`);
          applyRow(ctx);
        },
      });
      try {
        await fiber;
      } catch (error) {
        await fiber.dispose().catch(() => undefined);
        const reason = reasonOf(error);
        console.error(`[stepcast] строка ${id}: ${reason}`);
        this.rows.set(id, {
          fiber: undefined,
          appliedVersion: undefined,
          state: { status: 'failed', version: view.version, reason },
        });
        return;
      }

      this.rows.set(id, {
        fiber,
        appliedVersion: view.version,
        state: { status: 'active', version: view.version },
      });
    });
    this.notify();
  }
}

declare module 'cordis' {
  interface Context {
    plugins: PluginsService;
  }
}
