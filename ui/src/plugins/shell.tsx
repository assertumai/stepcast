import { Component, useContext, useEffect, useSyncExternalStore, type JSX, type ReactNode } from 'react';
import type { Context } from 'cordis';

import { hrefForRoute } from '../../../src/parts/ui/routes.ts';
import { KernelContext, ROOT } from '../kernel';
import { HOME_ROUTES_FILE, RoutesListing } from '../pages/Routes';
import { useRoute, useRoutes, useScreens } from '../router';
import { Slot } from '../slots.tsx';
import { WidgetHost } from '../widgetHost';
import { GenericNavItem } from './navItem';
import {
  NAV,
  ROUTES_LISTING_KEY,
  ROUTE_TARGET,
  SCREEN,
  SCREEN_FRAME,
  type ChainLinkProps,
  type RouteTargetSlotProps,
} from '@stepcast/slots';

/**
 * Каркас витрины — встроенный плагин (design.md `cordis-kernel-browser`,
 * Решение 8; `ui-routes`, design.md Решения 5, 12, 13). Вносит компонент
 * каркаса в `root` с тремя дочерними слотами — `nav` (пункты меню по
 * действующей таблице маршрутов), `route.target` (цель разобранного
 * маршрута по её виду), `screen.frame` (обрамление; сюда же вносит границу
 * ошибок).
 *
 * Каркас не знает ни одного имени экрана и ни одного вида цели сверх двух
 * встроенных (`screen`, `widget`): оба заводит сам, третий (дашборд —
 * `dashboards-as-files`) добавится вкладом в тот же слот `route.target`, не
 * трогая этот файл.
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

/** Причина, по которой цель маршрута не показана, — общий вид для обоих встроенных видов цели (design.md, Решение 5). */
function MissingTarget({ reason }: { readonly reason: string }): JSX.Element {
  return <div className="screen-error">{reason}</div>;
}

/**
 * Причина отказа сборки — полосой над содержимым (`ui-daemon`, «Отказ сборки
 * состава не гасит витрину»): причина приходит вместе с составом либо
 * таблицей и показывается пользователю. Отдельно от полосы диагностик ядра
 * витрины (`ui/src/slots.tsx`): та про отказы плагинов страницы, эта — про
 * отказ сборки на демоне.
 */
function BuildErrorBar({ label, reason }: { readonly label: string; readonly reason: string }): JSX.Element {
  return (
    <div className="screens-build-error" role="alert">
      {label} не пересобран: {reason}
    </div>
  );
}

/**
 * Вид цели `screen` — ключ слота экранов, тем же приёмом, что и прежде.
 * Присутствие `id` проверяется реактивно по сервису `screens`: отключённая
 * или незнакомая строка перестаёт быть экраном сразу по следующему событию
 * потока, без хот-свопа слотов (`ui-daemon`, «Состав экранов изменён без
 * перезагрузки»).
 */
function ScreenTargetView({ target, pathParams, targetParams, ...live }: RouteTargetSlotProps): JSX.Element {
  const { table, buildError } = useScreens();

  if (!table.has(target.id)) {
    return (
      <MissingTarget
        reason={
          buildError === undefined
            ? `Экран «${target.id}» не найден в действующем составе`
            : `Экран «${target.id}» не найден в действующем составе (сборка состава: ${buildError})`
        }
      />
    );
  }

  // Параметры пути доезжают до экрана по своим именам, а объявленные
  // маршрутом параметры цели — поверх них (`ui-routes`, Решение 6): их
  // подстановки уже применены разбором адреса (`parseRoute`), а литерал,
  // названный маршрутом явно, сильнее одноимённого сегмента пути — иначе
  // объявить его было бы невозможно.
  const params = { ...pathParams, ...targetParams };

  return (
    <Slot
      of={SCREEN}
      k={target.id}
      props={{ ...live, params }}
      default={<MissingTarget reason={`Экран «${target.id}» объявлен составом, но браузерная половина недоступна`} />}
    />
  );
}

/**
 * Вид цели `widget` — хост виджета, тем же компонентом, каким виджет
 * показан на экране виджетов (`ui-routes`, Решение 5). Параметры цели
 * маршруту на виджет пока недоступны — контракт `props` виджета откладывает
 * `dashboards-as-files` (`docs/widgets.md`, Non-Goals).
 */
function WidgetTargetView({ target, targetParams, widgets }: RouteTargetSlotProps): JSX.Element {
  const paramNames = Object.keys(targetParams);
  if (paramNames.length > 0) {
    return (
      <MissingTarget
        reason={`Маршрут объявляет параметры цели виджета (${paramNames.join(', ')}) — контракта props у виджета пока нет`}
      />
    );
  }

  const parts = target.id.split('/');
  if (parts.length !== 2) {
    return <MissingTarget reason={`Цель виджета «${target.id}» ожидает форму <проект>/<id>`} />;
  }
  const [projectKey, id] = parts as [string, string];
  const found = widgets?.projects
    .find((project) => project.projectKey === projectKey)
    ?.widgets.find((widget) => widget.id === id);
  if (found === undefined) {
    return <MissingTarget reason={`Виджет «${id}» проекта «${projectKey}» не найден в действующем составе`} />;
  }
  return <WidgetHost projectKey={projectKey} id={id} version={found.version} />;
}

function UnknownTargetKind({ kind }: { readonly kind: string }): JSX.Element {
  return <MissingTarget reason={`Вид цели «${kind}» не знаком действующему составу витрины`} />;
}

function Shell(): JSX.Element {
  const ctx = useKernelContext();
  const live = useSyncExternalStore(
    (listener) => ctx.live.subscribe(listener),
    () => ctx.live.get(),
    () => ctx.live.get(),
  );
  const { route, navigate } = useRoute();
  const routesSnapshot = useRoutes();
  const { table: screensTable, buildError: screensBuildError } = useScreens();

  // Прогон, за которым следит поток событий, — по разобранным параметрам
  // адреса, а не по имени экрана: каркас не знает ни одного (`ui-screens`,
  // «каркас витрины MUST NOT содержать перечня экранов»). Пара «проект и
  // прогон» и есть адрес прогона, кто бы её ни объявил.
  const { projectKey, runId } = route?.pathParams ?? {};
  const followed = projectKey === undefined || runId === undefined ? undefined : `${projectKey}/${runId}`;

  // Единственное место подписки: смена адреса пересоздаёт её через `follow`,
  // а не размонтирование компонента (design.md, Решение 10).
  useEffect(() => {
    ctx.live.follow(followed);
  }, [ctx, followed]);

  const liveProps = {
    overview: live.overview,
    navigate,
    backlog: live.backlog,
    widgets: live.widgets,
    snapshot: live.snapshot,
    proposals: live.proposals,
  };

  const navRoutes = [...routesSnapshot.table]
    .filter((candidate) => candidate.nav !== undefined)
    .sort((a, b) => (a.nav?.order ?? Number.POSITIVE_INFINITY) - (b.nav?.order ?? Number.POSITIVE_INFINITY));

  const activeRouteId = route?.route.id;

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

        {navRoutes.map((navRoute) => {
          const title =
            navRoute.nav?.title ??
            (navRoute.target.kind === 'screen' ? screensTable.get(navRoute.target.id)?.title : undefined) ??
            navRoute.target.id;
          const active =
            activeRouteId !== undefined &&
            (activeRouteId === navRoute.id || navRoute.nav?.activeFor?.includes(activeRouteId) === true);
          // Ссылка пункта — адрес своего маршрута, а не поиск по цели: цель
          // вправе иметь несколько маршрутов, и пункт обязан вести на тот, чей
          // `nav` его и породил (`ui-routes`, Решение 13).
          const href = hrefForRoute(navRoute);
          return (
            <Slot
              key={navRoute.id}
              of={NAV}
              k={navRoute.id}
              props={{ route: navRoute, title, href, active, navigate }}
              default={<GenericNavItem route={navRoute} title={title} href={href} active={active} navigate={navigate} />}
            />
          );
        })}

        <div className={live.state === 'live' ? 'live on' : 'live off'}>{LIVE_LABEL[live.state]}</div>
      </nav>

      <main className="content">
        {screensBuildError === undefined ? null : <BuildErrorBar label="Состав экранов" reason={screensBuildError} />}
        {routesSnapshot.buildError === undefined ? null : (
          <BuildErrorBar label="Таблица маршрутов" reason={routesSnapshot.buildError} />
        )}
        <Slot
          of={SCREEN_FRAME}
          props={{}}
          default={
            route === undefined ? (
              <Slot
                of={SCREEN}
                k={ROUTES_LISTING_KEY}
                props={{ ...liveProps, params: {} }}
                default={
                  <RoutesListing
                    pathname={window.location.pathname}
                    table={routesSnapshot.table}
                    buildError={routesSnapshot.buildError}
                    layerFile={HOME_ROUTES_FILE}
                  />
                }
              />
            ) : (
              <Slot
                of={ROUTE_TARGET}
                k={route.route.target.kind}
                props={{
                  ...liveProps,
                  target: route.route.target,
                  pathParams: route.pathParams,
                  targetParams: route.targetParams,
                }}
                default={<UnknownTargetKind kind={route.route.target.kind} />}
              />
            )
          }
        />
      </main>
    </div>
  );
}

export default function shell(ctx: Context): void {
  ctx.slots.contribute(ROOT, { component: Shell, slots: [NAV, SCREEN, SCREEN_FRAME, ROUTE_TARGET] });
  ctx.slots.contribute<Record<string, never>, 'chain'>(SCREEN_FRAME, { component: ScreenErrorBoundary });
  ctx.slots.contribute(ROUTE_TARGET, { component: ScreenTargetView, key: 'screen' });
  ctx.slots.contribute(ROUTE_TARGET, { component: WidgetTargetView, key: 'widget' });
}
