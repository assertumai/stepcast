import { Component, useContext, useEffect, useSyncExternalStore, type JSX, type ReactNode } from 'react';
import type { Context } from 'cordis';

import { MENU } from '../../../src/ui/routes';
import type { BacklogOverview, Overview, RunSnapshot, WidgetsOverview } from '../api';
import { KernelContext, ROOT } from '../kernel';
import { useRoute, type Route } from '../router';
import { Slot } from '../slots.tsx';
import { slot, type ChainLinkProps } from '../slots.ts';
import { Agents } from '../pages/Agents';
import { Backlog } from '../pages/Backlog';
import { Cleanup } from '../pages/Cleanup';
import { Pipelines } from '../pages/Pipelines';
import { RunDetail } from '../pages/RunDetail';
import { Settings } from '../pages/Settings';
import { Steps } from '../pages/Steps';
import { Usage } from '../pages/Usage';
import { Widgets } from '../pages/Widgets';

/**
 * Каркас витрины — встроенный плагин (design.md `cordis-kernel-browser`,
 * Решение 8), образец для всех будущих: вносит компонент каркаса в `root`
 * одним вызовом с тремя дочерними слотами — `nav` (список пунктов меню по
 * маршруту), `screen` (экран по ключу маршрута), `screen.frame` (обрамление
 * экрана; сюда же вносит границу ошибок).
 *
 * Подписка на сервис `live` — здесь и только здесь (design.md, Решение 10):
 * каркас раздаёт данные вкладчикам через props слотов, сами вкладчики к
 * контексту не обращаются вовсе.
 */

export const NAV = slot<{ readonly route: Route; readonly navigate: (href: string) => void }, 'list'>('nav', 'list');
export const SCREEN = slot<
  { readonly overview: Overview | undefined; readonly navigate: (href: string) => void },
  'keyed'
>('screen', 'keyed');
export const SCREEN_FRAME = slot<Record<string, never>, 'chain'>('screen.frame', 'chain');

interface LegacyProps {
  readonly route: Route;
  readonly navigate: (href: string) => void;
  readonly overview: Overview | undefined;
  readonly backlog: BacklogOverview | undefined;
  readonly widgets: WidgetsOverview | undefined;
  readonly snapshot: RunSnapshot | undefined;
}

/**
 * Прежний переключатель — временное содержимое по умолчанию слота `screen`
 * (design.md, Решение 9): ключ, которого слот не знает, попадает сюда.
 * Восемь экранов, ещё не переведённых в плагины; `builtin-pages-as-plugins`
 * снимает эту функцию целиком, переводя их. `runs` здесь нет — он вносится
 * в `screen` ключом `runs` плагином `ui/src/plugins/runs.tsx`.
 */
function LegacySwitch({ route, navigate, overview, backlog, widgets, snapshot }: LegacyProps): JSX.Element | null {
  if (route.page === 'pipelines') return <Pipelines overview={overview} navigate={navigate} />;
  if (route.page === 'steps') return <Steps />;
  if (route.page === 'widgets') return <Widgets overview={overview} widgets={widgets} />;
  if (route.page === 'backlog') return <Backlog backlog={backlog} />;
  if (route.page === 'usage') {
    return <Usage overview={overview} {...(route.days === undefined ? {} : { days: route.days })} navigate={navigate} />;
  }
  if (route.page === 'cleanup') return <Cleanup overview={overview} />;
  if (route.page === 'agents') return <Agents />;
  if (route.page === 'settings') return <Settings />;
  if (route.page === 'run') {
    return (
      <RunDetail
        key={`${route.projectKey}/${route.runId}`}
        projectKey={route.projectKey}
        runId={route.runId}
        snapshot={snapshot}
        navigate={navigate}
      />
    );
  }
  return null;
}

interface BoundaryState {
  readonly error: Error | undefined;
}

/** Граница ошибок — единственный сегодняшний вкладчик `chain` (design.md, открытый вопрос про второго пользователя). */
class ScreenErrorBoundary extends Component<ChainLinkProps<Record<string, never>>, BoundaryState> {
  override state: BoundaryState = { error: undefined };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  override render(): ReactNode {
    if (this.state.error !== undefined) {
      return <div className="screen-error">Экран упал: {this.state.error.message}</div>;
    }
    return this.props.next;
  }
}

function useKernelContext(): Context {
  const ctx = useContext(KernelContext);
  if (ctx === undefined) throw new Error('Shell вызван вне дерева ядра витрины');
  return ctx;
}

const LIVE_LABEL = {
  connecting: 'подключение к демону…',
  live: 'живое обновление',
  offline: 'нет связи с демоном',
} as const;

function Shell(): JSX.Element {
  const ctx = useKernelContext();
  const live = useSyncExternalStore(
    (listener) => ctx.live.subscribe(listener),
    () => ctx.live.get(),
    () => ctx.live.get(),
  );
  const { route, navigate } = useRoute();
  const followedAddress = route.page === 'run' ? `${route.projectKey}/${route.runId}` : undefined;

  // Единственное место подписки: смена адреса пересоздаёт её через `follow`,
  // а не размонтирование компонента (design.md, Решение 10).
  useEffect(() => {
    ctx.live.follow(followedAddress);
  }, [ctx, followedAddress]);

  return (
    <div className="shell">
      <nav className="sidebar">
        <a
          className="brand"
          href="/"
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey) return;
            event.preventDefault();
            navigate('/');
          }}
        >
          stepcast
        </a>

        {/* `runs` — первый пункт исходного меню (`src/ui/routes.ts`): слот
            рисуется первым, чтобы порядок не изменился от перевода одного
            пункта на вклад. */}
        <Slot of={NAV} props={{ route, navigate }} />

        {MENU.filter((item) => item.page !== 'runs').map((item) => (
          <a
            key={item.page}
            className={item.pages.includes(route.page) ? 'nav-item active' : 'nav-item'}
            href={item.href}
            aria-current={item.pages.includes(route.page) ? 'page' : undefined}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey) return;
              event.preventDefault();
              navigate(item.href);
            }}
          >
            {item.title}
          </a>
        ))}

        <div className={live.state === 'live' ? 'live on' : 'live off'}>{LIVE_LABEL[live.state]}</div>
      </nav>

      <main className="content">
        <Slot
          of={SCREEN_FRAME}
          props={{}}
          default={
            <Slot
              of={SCREEN}
              props={{ overview: live.overview, navigate }}
              k={route.page}
              default={
                <LegacySwitch
                  route={route}
                  navigate={navigate}
                  overview={live.overview}
                  backlog={live.backlog}
                  widgets={live.widgets}
                  snapshot={live.snapshot}
                />
              }
            />
          }
        />
      </main>
    </div>
  );
}

export default function shell(ctx: Context): void {
  ctx.slots.contribute(ROOT, { component: Shell, slots: [NAV, SCREEN, SCREEN_FRAME] });
  ctx.slots.contribute<Record<string, never>, 'chain'>(SCREEN_FRAME, { component: ScreenErrorBoundary });
}
