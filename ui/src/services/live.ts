import { Service, type Context } from 'cordis';

import type { RouteDefinition } from '../../../src/ui/routes.ts';
import type { ScreenDeclaration } from '../../../src/ui/screens/declaration.ts';
import type { BacklogOverview, Overview, PluginRowView, RunSnapshot, WidgetsOverview } from '../api';

/**
 * Живое состояние страницы — сервис контекста на месте прежнего хука
 * `useLive` (design.md `cordis-kernel-browser`, Решение 10).
 *
 * Демон ведёт один общий наблюдатель на всех подключённых клиентов
 * (`src/ui/watcher.ts`); один `EventSource` на вкладку открывается эффектом
 * СВОЕЙ области — не размонтированием компонента, — и закрывается снятием
 * этой области. `follow(адрес)` пересоздаёт подписку тем же поведением, что
 * был у эффекта хука: прежний снимок прогона не переживает смену адреса, а
 * связь на время пересоздания считается «подключение», не «нет связи».
 *
 * Компонент, получивший эти данные через слот, к сервису не обращается —
 * подписан на него только каркас (`ui/src/plugins/shell.tsx`).
 */

/** Имя сервиса — занято ядром наравне с реестром слотов (`ui/src/kernel.ts`). */
export const LIVE_SERVICE_NAME = 'live';

export type LiveState = 'connecting' | 'live' | 'offline';

/** Событие `routes` потока — та же форма, что и ответ `GET /api/routes` (`ui-daemon`). */
export interface RoutesEvent {
  readonly routes: readonly RouteDefinition[];
  readonly buildError?: string;
}

/** Событие `screens` потока — та же форма, что и ответ `GET /api/screens` (`ui-daemon`). */
export interface ScreensEvent {
  readonly screens: readonly (ScreenDeclaration & { readonly builtin: boolean })[];
  readonly buildError?: string;
}

export interface LiveSnapshot {
  readonly overview: Overview | undefined;
  readonly backlog: BacklogOverview | undefined;
  readonly widgets: WidgetsOverview | undefined;
  readonly snapshot: RunSnapshot | undefined;
  readonly state: LiveState;
  /**
   * Состав браузерных строк, событие `plugins` потока (design.md изменения
   * `hot-swap-preserves-data`, Решение 11): ядро сверяет его со своими
   * применёнными строками (`ui/src/services/plugins.ts`) и запускает замены.
   * Та же ссылка, пока демон не прислал отличающийся состав — сравнение по
   * ссылке и решает, звать ли сверку заново.
   */
  readonly plugins: readonly PluginRowView[];
  /**
   * Таблица маршрутов и состав экранов — событиями `routes`/`screens`
   * потока (`ui-daemon`, «Поток событий несёт действующие маршруты и состав
   * экранов»). `undefined` — обмена ещё не было; плагины `routes`/`screens`
   * (`ui/src/plugins/`) читают их отсюда и пишут в свои сервисы тем же
   * приёмом, каким ядро сверяет `plugins` ниже.
   */
  readonly routes: RoutesEvent | undefined;
  readonly screens: ScreensEvent | undefined;
}

/** Поверхность `EventSource`, которой пользуется сервис — минимум, достаточный для проверки без браузера. */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

const defaultFactory: EventSourceFactory = (url) => new EventSource(url);

const EMPTY_PLUGINS: readonly PluginRowView[] = Object.freeze([]);

const INITIAL_SNAPSHOT: LiveSnapshot = {
  overview: undefined,
  backlog: undefined,
  widgets: undefined,
  snapshot: undefined,
  state: 'connecting',
  plugins: EMPTY_PLUGINS,
  routes: undefined,
  screens: undefined,
};

export class LiveService extends Service {
  private data: LiveSnapshot = INITIAL_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private readonly createSource: EventSourceFactory;
  /**
   * Контекст сборки, а не `this.ctx`: доступ к сервису через `ctx.live`
   * отдаёт его через трекер, привязанный к ОБРАЩАЮЩЕМУСЯ контексту (тем же
   * приёмом, каким `SlotsService.contribute` в `ui/src/slots.ts` узнаёт
   * вызвавшего) — `this.ctx` внутри `follow()`, позванного снаружи, был бы
   * контекстом вызвавшего, а не сервиса. Подписке нужен ровно противоположный
   * эффект: она обязана жить, пока жив сам сервис, а не пока жива область
   * плагина, который случайно попросил её пересоздать (`hot-swap-preserves-data`).
   */
  private readonly rootCtx: Context;
  private address: string | undefined;
  private closeCurrent: (() => void) | undefined;

  constructor(ctx: Context, createSource: EventSourceFactory = defaultFactory) {
    super(ctx, LIVE_SERVICE_NAME);
    this.rootCtx = ctx;
    this.createSource = createSource;
    this.openSubscription();
  }

  /** Снимок — та же ссылка, пока ничего не изменилось: сервис читают через `useSyncExternalStore`. */
  get(): LiveSnapshot {
    return this.data;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Адрес прогона, за которым следить, — `undefined`, если наблюдение общее. Смена адреса пересоздаёт подписку, повтор того же — нет. */
  follow(address: string | undefined): void {
    if (address === this.address) return;
    this.address = address;
    this.openSubscription();
  }

  private openSubscription(): void {
    this.closeCurrent?.();
    // Прежний снимок принадлежит прежнему адресу — показывать его, пока не
    // пришёл новый, значило бы приписать чужие данные новой подписке.
    // Обзор, очередь и виджеты не привязаны к адресу — переживают смену.
    this.patch({ snapshot: undefined, state: 'connecting' });

    const address = this.address;
    this.closeCurrent = this.rootCtx.effect(() => {
      const query = address === undefined ? '' : `?run=${encodeURIComponent(address)}`;
      const source = this.createSource(`/api/events${query}`);

      source.addEventListener('overview', (event) => {
        this.patch({ state: 'live', overview: JSON.parse(event.data) as Overview });
      });
      source.addEventListener('backlog', (event) => {
        this.patch({ state: 'live', backlog: JSON.parse(event.data) as BacklogOverview });
      });
      source.addEventListener('widgets', (event) => {
        this.patch({ state: 'live', widgets: JSON.parse(event.data) as WidgetsOverview });
      });
      source.addEventListener('run', (event) => {
        this.patch({ state: 'live', snapshot: JSON.parse(event.data) as RunSnapshot });
      });
      source.addEventListener('plugins', (event) => {
        const parsed = JSON.parse(event.data) as { readonly plugins: readonly PluginRowView[] };
        this.patch({ state: 'live', plugins: parsed.plugins });
      });
      source.addEventListener('routes', (event) => {
        this.patch({ state: 'live', routes: JSON.parse(event.data) as RoutesEvent });
      });
      source.addEventListener('screens', (event) => {
        this.patch({ state: 'live', screens: JSON.parse(event.data) as ScreensEvent });
      });
      source.addEventListener('error', () => this.patch({ state: 'offline' }));

      return () => source.close();
    }, 'live.subscribe');
  }

  private patch(update: Partial<LiveSnapshot>): void {
    this.data = { ...this.data, ...update };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

declare module 'cordis' {
  interface Context {
    live: LiveService;
  }
}
