import { Component, useContext, useEffect, useSyncExternalStore, type JSX, type ReactNode } from 'react';
import type { Context } from 'cordis';

import { KernelContext, ROOT } from '../kernel';
import { useDefaultScreenId, useRoute, useScreens } from '../router';
import { Slot } from '../slots.tsx';
import { NAV, SCREEN, SCREEN_FRAME, type ChainLinkProps } from '@stepcast/slots';

/**
 * Каркас витрины — встроенный плагин (design.md `cordis-kernel-browser`,
 * Решение 8). Вносит компонент каркаса в `root` одним вызовом с тремя
 * дочерними слотами — `nav` (список пунктов меню по маршруту), `screen`
 * (экран по ключу маршрута), `screen.frame` (обрамление экрана; сюда же
 * вносит границу ошибок).
 *
 * Каркас не знает ни одного имени экрана (`ui-kernel`, «Прежнего
 * переключателя не осталось»; `ui-screens`, «Навигация и разбор адреса
 * собираются из зарегистрированных экранов»): навигация — целиком слот
 * `nav`, экран — целиком слот `screen` по ключу `route.screenId`, а
 * содержимое обоих собирают сами экраны (`ui/src/plugins/screens.tsx`,
 * `ui/src/screens/*.tsx`).
 *
 * Подписка на сервис `live` — здесь и только здесь (design.md, Решение 10):
 * каркас раздаёт данные вкладчикам через props слотов, сами вкладчики к
 * контексту не обращаются вовсе.
 */

// Дескрипторы — из поверхности `@stepcast/slots` (design.md изменения
// `shared-module-table`, Решение 5), не копии. Ре-экспорт сохраняет прежний
// путь импорта тем, кто уже на него полагается (`ui/test/shell.test.tsx`).
export { NAV, SCREEN, SCREEN_FRAME };

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

/**
 * Ни ключа маршрута, ни экрана по умолчанию в слоте нет — состав ещё не
 * пришёл или пуст (`ui-kernel`, «Ключа нет в слоте экранов»: ключ, которого в
 * слоте нет, ведёт на экран по умолчанию, и только когда нет и его, показать
 * нечего).
 */
function NoScreen(): JSX.Element {
  return <div className="screen-error">Экран не найден в действующем составе.</div>;
}

/**
 * Причина отказа сборки состава — полосой над экраном (`ui-daemon`, «Отказ
 * сборки состава не гасит витрину»: причина приходит вместе с составом и
 * показывается пользователю). Отдельно от полосы диагностик ядра витрины
 * (`ui/src/slots.tsx`): та про отказы плагинов страницы, эта — про отказ
 * сборки на демоне.
 */
function BuildErrorBar({ reason }: { readonly reason: string }): JSX.Element {
  return (
    <div className="screens-build-error" role="alert">
      Состав экранов не пересобран: {reason}
    </div>
  );
}

function Shell(): JSX.Element {
  const ctx = useKernelContext();
  const live = useSyncExternalStore(
    (listener) => ctx.live.subscribe(listener),
    () => ctx.live.get(),
    () => ctx.live.get(),
  );
  const { route, navigate } = useRoute();
  const { buildError } = useScreens();
  const defaultScreenId = useDefaultScreenId();
  // Прогон, за которым следит поток событий, — по разобранным параметрам
  // адреса, а не по имени экрана: каркас не знает ни одного (`ui-screens`,
  // «каркас витрины MUST NOT содержать перечня экранов»). Пара «проект и
  // прогон» и есть адрес прогона, кто бы её ни объявил.
  const { projectKey, runId } = route.params;
  const followed = projectKey === undefined || runId === undefined ? undefined : `${projectKey}/${runId}`;

  // Единственное место подписки: смена адреса пересоздаёт её через `follow`,
  // а не размонтирование компонента (design.md, Решение 10).
  useEffect(() => {
    ctx.live.follow(followed);
  }, [ctx, followed]);

  const screenProps = {
    overview: live.overview,
    navigate,
    params: route.params,
    backlog: live.backlog,
    widgets: live.widgets,
    snapshot: live.snapshot,
  };

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

        <Slot of={NAV} props={{ route, navigate }} />

        <div className={live.state === 'live' ? 'live on' : 'live off'}>{LIVE_LABEL[live.state]}</div>
      </nav>

      <main className="content">
        {buildError === undefined ? null : <BuildErrorBar reason={buildError} />}
        <Slot
          of={SCREEN_FRAME}
          props={{}}
          default={
            <Slot
              of={SCREEN}
              props={screenProps}
              k={route.screenId ?? defaultScreenId ?? ''}
              // Ключа нет в слоте — экран по умолчанию действующего состава
              // (`ui-kernel`, «Ключа нет в слоте экранов»), а не пустое место:
              // тот же экран, на который ведёт неразобранный адрес.
              default={
                <Slot
                  of={SCREEN}
                  props={screenProps}
                  k={defaultScreenId ?? ''}
                  default={<NoScreen />}
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
