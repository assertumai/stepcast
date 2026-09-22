import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { createBrowserKernel, type BrowserKernel } from '../src/kernel';
import { KernelFrame } from '../src/slots.tsx';
import shellPlugin from '../src/plugins/shell.tsx';
import screensPlugin from '../src/plugins/screens.tsx';
import routesPlugin from '../src/plugins/routes.tsx';
import { bindRouterKernel } from '../src/router';
import { TargetLink } from '../src/routeLink';
import { fakeEventSources, type FakeSource } from './support/live';
import { SCREEN } from '@stepcast/slots';

/**
 * Каркас поверх таблицы маршрутов (`ui-routes`, design.md Решения 12, 13):
 * навигация и перечень адресов собираются из действующей таблицы, а не из
 * объявлений экранов, — здесь проверяется то, что специфично для маршрутов и
 * не покрыто `ui/test/screens.test.tsx` (состав и половины экранов).
 */

interface FakeScreen {
  readonly id: string;
  readonly title: string;
  readonly params: readonly string[];
}

interface FakeRoute {
  readonly id: string;
  readonly path: string;
  readonly target: { readonly kind: string; readonly id: string };
  readonly params?: Readonly<Record<string, string>>;
  readonly nav?: { readonly order: number; readonly title?: string; readonly activeFor?: readonly string[] };
}

function installFetch(screens: readonly FakeScreen[], routes: readonly FakeRoute[]): () => void {
  const previous = (globalThis as { fetch?: unknown }).fetch;
  (globalThis as { fetch?: unknown }).fetch = async (input: unknown) => {
    const url = String(input);
    if (url === '/api/screens') {
      const body = JSON.stringify({ screens: screens.map((screen) => ({ builtin: true, ...screen })) });
      return { ok: true, status: 200, json: async () => JSON.parse(body) as unknown };
    }
    if (url === '/api/routes') {
      const body = JSON.stringify({ routes });
      return { ok: true, status: 200, json: async () => JSON.parse(body) as unknown };
    }
    throw new Error(`неожиданный fetch в тесте: ${url}`);
  };
  return () => {
    (globalThis as { fetch?: unknown }).fetch = previous;
  };
}

function installWindow(pathname: string): () => void {
  const globals = globalThis as Record<string, unknown>;
  const previous = globals['window'];
  globals['window'] = {
    location: { pathname, origin: 'http://localhost' },
    history: { pushState: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return () => {
    globals['window'] = previous;
  };
}

function freshKernel(): BrowserKernel {
  const kernel = createBrowserKernel({ createEventSource: fakeEventSources().factory });
  bindRouterKernel(kernel.ctx);
  return kernel;
}

/** Ядро вместе с источником событий: живое применение правки проверяется его кадрами. */
function kernelWithSource(): { kernel: BrowserKernel; source: FakeSource } {
  const { factory, sources } = fakeEventSources();
  const kernel = createBrowserKernel({ createEventSource: factory });
  bindRouterKernel(kernel.ctx);
  const source = sources[0];
  if (source === undefined) throw new Error('ядро витрины обязано открыть подписку сразу');
  return { kernel, source };
}

async function boot(kernel: BrowserKernel): Promise<void> {
  await kernel.ctx.plugin({ name: 'shell', apply: shellPlugin });
  await kernel.ctx.plugin({ name: 'routes', apply: routesPlugin });
  await kernel.ctx.plugin({ name: 'screens', apply: screensPlugin });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const RUNS_ROUTE: FakeRoute = {
  id: 'route-runs',
  path: '/',
  target: { kind: 'screen', id: 'screen-runs' },
  nav: { order: 0, activeFor: ['route-run'] },
};
const RUN_ROUTE: FakeRoute = { id: 'route-run', path: '/runs/:id', target: { kind: 'screen', id: 'screen-run' } };
const RUNS_SCREEN: FakeScreen = { id: 'screen-runs', title: 'Прогоны', params: [] };
const RUN_SCREEN: FakeScreen = { id: 'screen-run', title: 'Прогон', params: ['id'] };

describe('ui-routes: навигация и подсветка из действующей таблицы', () => {
  it('название пункта берётся из nav.title слоя, а не из заголовка цели', async () => {
    const restoreFetch = installFetch(
      [RUNS_SCREEN],
      [{ ...RUNS_ROUTE, nav: { order: 0, title: 'Мои прогоны' } }],
    );
    const restoreWindow = installWindow('/');
    try {
      const kernel = freshKernel();
      await boot(kernel);
      const diagnostics = await kernel.settle();
      assert.deepEqual(diagnostics, []);

      const markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
      assert.match(markup, /Мои прогоны/);
      assert.doesNotMatch(markup, />Прогоны</);
    } finally {
      restoreWindow();
      restoreFetch();
    }
  });

  it('пункт подсвечен на дочернем маршруте, названном в nav.active_for, хотя своего пункта у него нет', async () => {
    const restoreFetch = installFetch([RUNS_SCREEN, RUN_SCREEN], [RUNS_ROUTE, RUN_ROUTE]);
    const restoreWindow = installWindow('/runs/42');
    try {
      const kernel = freshKernel();
      await boot(kernel);
      const diagnostics = await kernel.settle();
      assert.deepEqual(diagnostics, []);

      const markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
      // Открыт /runs/42 (маршрут `route-run`, без своего пункта меню), а
      // подсвечен пункт `route-runs` — тем же правилом, каким его называет
      // собственный `nav.active_for` (`ui-routes`, design.md Решение 13).
      assert.match(markup, /nav-item active/);
      assert.match(markup, /Прогоны/);
    } finally {
      restoreWindow();
      restoreFetch();
    }
  });

  it('маршрут без места в навигации не даёт пункта меню, но адрес открывается', async () => {
    const restoreFetch = installFetch([RUNS_SCREEN, RUN_SCREEN], [RUNS_ROUTE, RUN_ROUTE]);
    const restoreWindow = installWindow('/runs/42');
    try {
      const kernel = freshKernel();
      await boot(kernel);
      const diagnostics = await kernel.settle();

      const markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
      // Ровно один пункт навигации — у screen-run своего нет.
      assert.equal((markup.match(/class="nav-item/g) ?? []).length, 1);
    } finally {
      restoreWindow();
      restoreFetch();
    }
  });

  it('цель неизвестного вида показана названной причиной, а не пустым местом', async () => {
    const restoreFetch = installFetch(
      [],
      [{ id: 'route-dash', path: '/dash', target: { kind: 'dashboard', id: 'proj/board' }, nav: { order: 0 } }],
    );
    const restoreWindow = installWindow('/dash');
    try {
      const kernel = freshKernel();
      await boot(kernel);
      const diagnostics = await kernel.settle();

      const markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
      assert.match(markup, /dashboard/);
      assert.match(markup, /is unknown to the active composition/);
    } finally {
      restoreWindow();
      restoreFetch();
    }
  });

  it('пустая таблица маршрутов называет это состояние, а не остаётся пустой страницей', async () => {
    const restoreFetch = installFetch([], []);
    const restoreWindow = installWindow('/');
    try {
      const kernel = freshKernel();
      await boot(kernel);
      const diagnostics = await kernel.settle();

      const markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
      assert.match(markup, /No active routes/);
      assert.match(markup, /routes\.yml/);
    } finally {
      restoreWindow();
      restoreFetch();
    }
  });

  it('пункт меню ведёт на путь своего маршрута, а не на первый по таблице адрес той же цели', async () => {
    // Ровно то, ради чего маршруты и заводятся: своя строка пользователя на
    // встроенную цель. Поиск ссылки по цели увёл бы пункт «Релиз» на `/`.
    const mine: FakeRoute = {
      id: 'release',
      path: '/release',
      target: { kind: 'screen', id: 'screen-runs' },
      nav: { order: 10, title: 'Релиз' },
    };
    const restoreFetch = installFetch([RUNS_SCREEN], [RUNS_ROUTE, mine]);
    const restoreWindow = installWindow('/');
    try {
      const kernel = freshKernel();
      await boot(kernel);
      const diagnostics = await kernel.settle();

      const markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
      assert.match(markup, /href="\/release"[^>]*>Релиз</);
    } finally {
      restoreWindow();
      restoreFetch();
    }
  });

  it('параметры цели маршрута доезжают до экрана вместе с параметрами пути', async () => {
    const probe: FakeScreen = { id: 'screen-probe', title: 'Проба', params: ['id'] };
    const route: FakeRoute = {
      id: 'probe',
      path: '/probe/:id',
      target: { kind: 'screen', id: 'screen-probe' },
      params: { id: '${params.id}', preset: 'release' },
    };
    const restoreFetch = installFetch([probe], [route]);
    const restoreWindow = installWindow('/probe/42');
    try {
      const kernel = kernelWithSource().kernel;
      await kernel.ctx.plugin({ name: 'shell', apply: shellPlugin });
      await kernel.ctx.plugin({ name: 'routes', apply: routesPlugin });
      await kernel.ctx.plugin({ name: 'screens', apply: screensPlugin });
      // Своя половина «экрана-пробы»: она печатает то, что до неё доехало.
      await kernel.ctx.plugin({
        name: 'probe',
        apply: (ctx) => {
          ctx.slots.contribute(SCREEN, {
            key: 'screen-probe',
            component: ({ params }: { readonly params: Readonly<Record<string, string>> }) => (
              <pre>{JSON.stringify(params)}</pre>
            ),
          });
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      const diagnostics = await kernel.settle();

      const markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
      // Подстановка применена разбором адреса, литерал доехал как есть
      // (`ui-routes`, «Параметры цели с подстановкой»).
      assert.match(markup, /&quot;id&quot;:&quot;42&quot;/);
      assert.match(markup, /&quot;preset&quot;:&quot;release&quot;/);
    } finally {
      restoreWindow();
      restoreFetch();
    }
  });

  it('маршрут на виджет открывает его хостом на месте экрана', async () => {
    const route: FakeRoute = { id: 'board', path: '/board', target: { kind: 'widget', id: 'proj/clock' } };
    const restoreFetch = installFetch([], [route]);
    const restoreWindow = installWindow('/board');
    try {
      const { kernel, source } = kernelWithSource();
      await boot(kernel);
      source.emit('widgets', {
        projects: [{ projectKey: 'proj', projectPath: '/p', widgets: [{ id: 'clock', version: '1' }] }],
      });
      const diagnostics = await kernel.settle();

      const markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
      // Тот же хост, каким виджет показан на экране виджетов: до загрузки
      // модуля он рисует свою карточку, и это отличает его от причины отказа.
      assert.match(markup, /widget-card/);
      assert.doesNotMatch(markup, /is not in the active composition/);
    } finally {
      restoreWindow();
      restoreFetch();
    }
  });

  it('цель, которой нет в действующем составе, показана названной причиной', async () => {
    const restoreFetch = installFetch([], [RUNS_ROUTE]);
    const restoreWindow = installWindow('/');
    try {
      const kernel = freshKernel();
      await boot(kernel);
      const diagnostics = await kernel.settle();

      const markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
      assert.match(markup, /screen-runs/);
      assert.match(markup, /is not in the active composition/);
    } finally {
      restoreWindow();
      restoreFetch();
    }
  });

  it('маршрут, добавленный при открытой витрине, появляется в меню без перезагрузки', async () => {
    const restoreFetch = installFetch([RUNS_SCREEN], [RUNS_ROUTE]);
    const restoreWindow = installWindow('/');
    try {
      const { kernel, source } = kernelWithSource();
      await boot(kernel);
      const diagnostics = await kernel.settle();
      assert.doesNotMatch(
        renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />),
        /Релиз/,
      );

      source.emit('routes', {
        routes: [
          RUNS_ROUTE,
          { id: 'release', path: '/release', target: { kind: 'screen', id: 'screen-runs' }, nav: { order: 10, title: 'Релиз' } },
        ],
      });

      const markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
      assert.match(markup, /href="\/release"[^>]*>Релиз</);
    } finally {
      restoreWindow();
      restoreFetch();
    }
  });

  it('маршрут открытой страницы, отключённый правкой файла, сменяется перечнем маршрутов без перезагрузки', async () => {
    const restoreFetch = installFetch([RUNS_SCREEN, RUN_SCREEN], [RUNS_ROUTE, RUN_ROUTE]);
    const restoreWindow = installWindow('/runs/42');
    try {
      const { kernel, source } = kernelWithSource();
      await boot(kernel);
      const diagnostics = await kernel.settle();
      assert.doesNotMatch(
        renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />),
        /No route matches this address/,
      );

      // Пользователь выключил маршрут страницы прогона: демон прислал таблицу
      // без него, и открытый адрес перестал быть объявленным.
      source.emit('routes', { routes: [RUNS_ROUTE] });

      const markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
      assert.match(markup, /No route matches this address/);
      assert.match(markup, /\/runs\/42/);
    } finally {
      restoreWindow();
      restoreFetch();
    }
  });

  it('строка экрана «Маршруты» показывает причину, по которой перечень открыт', async () => {
    // Поставочная конфигурация: строка `screen-routes` включена, и перечень
    // на неразобранном адресе — её вклад. Причина обязана быть названа и в
    // нём, а не только в текстовом перечне каркаса.
    const restoreFetch = installFetch(
      [{ id: 'screen-routes', title: 'Маршруты', params: [] }],
      [{ id: 'screen-routes', path: '/routes', target: { kind: 'screen', id: 'screen-routes' }, nav: { order: 0 } }],
    );
    const restoreWindow = installWindow('/');
    try {
      const kernel = freshKernel();
      await boot(kernel);
      const diagnostics = await kernel.settle();

      const markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
      assert.match(markup, /No route matches this address/);
      assert.match(markup, /No start page/);
    } finally {
      restoreWindow();
      restoreFetch();
    }
  });

  it('отказ сборки таблицы маршрутов назван полосой над содержимым', async () => {
    const previous = (globalThis as { fetch?: unknown }).fetch;
    (globalThis as { fetch?: unknown }).fetch = async (input: unknown) => {
      const url = String(input);
      if (url === '/api/screens') {
        return { ok: true, status: 200, json: async () => ({ screens: [] }) };
      }
      if (url === '/api/routes') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ routes: [], buildError: 'Путь /admin занят маршрутами a и b' }),
        };
      }
      throw new Error(`неожиданный fetch: ${url}`);
    };
    const restoreWindow = installWindow('/');
    try {
      const kernel = freshKernel();
      await boot(kernel);
      const diagnostics = await kernel.settle();

      const markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
      assert.match(markup, /Route table was not rebuilt/);
      assert.match(markup, /занят маршрутами a и b/);
    } finally {
      restoreWindow();
      (globalThis as { fetch?: unknown }).fetch = previous;
    }
  });
});

describe('ui-routes: ссылка на цель без маршрута', () => {
  it('цель с маршрутом — обычная ссылка, цель без маршрута — не-ссылка с названной причиной', () => {
    const kernel = freshKernel();
    kernel.ctx.routes.set([RUNS_ROUTE], undefined);

    const withRoute = renderToStaticMarkup(
      <TargetLink target={{ kind: 'screen', id: 'screen-runs' }} navigate={() => {}}>
        прогоны
      </TargetLink>,
    );
    assert.match(withRoute, /<a href="\/"/);

    // Маршрут страницы прогона отключён: ни ссылки, ни подмены чужим адресом
    // — место остаётся и называет причину (`ui-routes`, «Ссылка на цель без
    // маршрута»).
    const withoutRoute = renderToStaticMarkup(
      <TargetLink target={{ kind: 'screen', id: 'screen-run' }} params={{ id: '42' }} navigate={() => {}}>
        прогон 42
      </TargetLink>,
    );
    assert.doesNotMatch(withoutRoute, /<a /);
    assert.match(withoutRoute, /прогон 42/);
    assert.match(withoutRoute, /no active route leads to target screen:screen-run/);
  });
});
