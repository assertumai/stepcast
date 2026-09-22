import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';
import type { JSX } from 'react';

import { createBrowserKernel, KernelContext, type BrowserKernel } from '../src/kernel';
import { KernelFrame, Slot } from '../src/slots.tsx';
import shellPlugin, { SCREEN } from '../src/plugins/shell.tsx';
import screensPlugin from '../src/plugins/screens.tsx';
import routesPlugin from '../src/plugins/routes.tsx';
import { bindRouterKernel } from '../src/router';
import { fakeEventSources } from './support/live';
import { ROUTE_TARGET } from '@stepcast/slots';

/**
 * Плагин `screens` (`ui/src/plugins/screens.tsx`): читает состав у демона и
 * применяет встроенные половины по таблице `ui/src/screens/index.ts`
 * (design.md, Решение 12, 13). Адрес и место в меню больше не поле
 * объявления экрана — они приходят маршрутом (`ui-routes`), поэтому здесь
 * подставной демон отвечает и на `/api/screens`, и на `/api/routes`.
 */

interface FakeScreen {
  readonly id: string;
  readonly title: string;
  readonly params: readonly string[];
  /** Происхождение строки в ответе демона. Не названо — строка поставки витрины, как у встроенного состава. */
  readonly builtin?: boolean;
}

interface FakeRoute {
  readonly id: string;
  readonly path: string;
  readonly target: { readonly kind: 'screen'; readonly id: string };
  readonly nav?: { readonly order: number; readonly title?: string };
}

function installFetch(screens: readonly FakeScreen[], routes: readonly FakeRoute[], buildError?: string): () => void {
  const previous = (globalThis as { fetch?: unknown }).fetch;
  (globalThis as { fetch?: unknown }).fetch = async (input: unknown) => {
    const url = String(input);
    if (url === '/api/screens') {
      const body = JSON.stringify({
        screens: screens.map((screen) => ({ builtin: true, ...screen })),
        ...(buildError === undefined ? {} : { buildError }),
      });
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

async function bootShellAndScreens(kernel: BrowserKernel): Promise<void> {
  await kernel.ctx.plugin({ name: 'shell', apply: shellPlugin });
  await kernel.ctx.plugin({ name: 'routes', apply: routesPlugin });
  await kernel.ctx.plugin({ name: 'screens', apply: screensPlugin });
  // `screens`/`routes` пишут состав асинхронно, отдельным `.then()` внутри
  // своего `apply` — сама область плагина успокаивается раньше, чем придёт
  // ответ `fetch`. Подставной `fetch` в этих тестах разрешается синхронно
  // (`Promise.resolve`), но микрозадаче всё равно нужно несколько тиков.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('screens: состав применяется по ответу демона', () => {
  it('навигация собрана из маршрутов в порядке nav.order, а не в порядке ответа демона', async () => {
    const restoreFetch = installFetch(
      [
        { id: 'screen-backlog', title: 'Шаги', params: [] },
        { id: 'screen-pipelines', title: 'Пайплайны', params: [] },
        { id: 'screen-runs', title: 'Прогоны', params: [] },
      ],
      [
        { id: 'route-steps', path: '/backlog', target: { kind: 'screen', id: 'screen-backlog' }, nav: { order: 2 } },
        { id: 'route-pipelines', path: '/pipelines', target: { kind: 'screen', id: 'screen-pipelines' }, nav: { order: 1 } },
        { id: 'route-runs', path: '/', target: { kind: 'screen', id: 'screen-runs' }, nav: { order: 0 } },
      ],
    );
    const restoreWindow = installWindow('/');
    try {
      const kernel = freshKernel();
      await bootShellAndScreens(kernel);
      const diagnostics = await kernel.settle();
      assert.deepEqual(diagnostics, []);

      const markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
      const positions = ['Прогоны', 'Пайплайны', 'Шаги'].map((title) => markup.indexOf(title));
      assert.ok(positions.every((position) => position >= 0), markup);
      assert.ok(positions[0]! < positions[1]! && positions[1]! < positions[2]!, markup);
    } finally {
      restoreWindow();
      restoreFetch();
    }
  });

  it('экран открыт по ключу маршрута', async () => {
    const restoreFetch = installFetch(
      [
        { id: 'screen-runs', title: 'Прогоны', params: [] },
        { id: 'screen-backlog', title: 'Бэклог', params: [] },
      ],
      [
        { id: 'route-runs', path: '/', target: { kind: 'screen', id: 'screen-runs' }, nav: { order: 0 } },
        { id: 'route-backlog', path: '/backlog', target: { kind: 'screen', id: 'screen-backlog' }, nav: { order: 1 } },
      ],
    );
    const restoreWindow = installWindow('/backlog');
    try {
      const kernel = freshKernel();
      await bootShellAndScreens(kernel);
      const diagnostics = await kernel.settle();

      const markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
      // Экран очереди без данных показывает свою «Загрузка», как и до перевода.
      assert.match(markup, /looks for a <code>backlog\.md<\/code>|sc-empty-title">Loading|Loading…/);
    } finally {
      restoreWindow();
      restoreFetch();
    }
  });

  it('адрес, не разобранный ни одним маршрутом, показывает перечень маршрутов, а не экран по умолчанию', async () => {
    const restoreFetch = installFetch(
      [{ id: 'screen-runs', title: 'Прогоны', params: [] }],
      [{ id: 'route-runs', path: '/', target: { kind: 'screen', id: 'screen-runs' }, nav: { order: 0 } }],
    );
    const restoreWindow = installWindow('/settings');
    try {
      const kernel = freshKernel();
      await bootShellAndScreens(kernel);
      const diagnostics = await kernel.settle();

      const markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
      assert.doesNotMatch(markup, /Настройки/);
      // Путь /settings не разобран ни одним действующим маршрутом (`ui-routes», «Адрес без маршрута показывает перечень объявленных маршрутов»).
      assert.match(markup, /No route matches this address/);
    } finally {
      restoreWindow();
      restoreFetch();
    }
  });

  it('маршрут на экран без доступной браузерной половины показан с причиной', async () => {
    const restoreFetch = installFetch(
      [
        { id: 'screen-runs', title: 'Прогоны', params: [] },
        { id: 'screen-mystery', title: 'Загадка', params: [] },
      ],
      [
        { id: 'route-runs', path: '/', target: { kind: 'screen', id: 'screen-runs' }, nav: { order: 0 } },
        { id: 'route-mystery', path: '/mystery', target: { kind: 'screen', id: 'screen-mystery' }, nav: { order: 1 } },
      ],
    );
    const restoreWindow = installWindow('/mystery');
    try {
      const kernel = freshKernel();
      await bootShellAndScreens(kernel);
      const diagnostics = await kernel.settle();

      const markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
      assert.match(markup, /Загадка/);
      assert.match(markup, /screen-mystery/);
      assert.match(markup, /browser half is unavailable/);
    } finally {
      restoreWindow();
      restoreFetch();
    }
  });

  it('экран, чью строку заменил чужой модуль, показан причиной, а не встроенной половиной', async () => {
    // Признак `builtin: false` — единственное, чем страница отличает
    // заменённую строку от встроенной: `id` у замены тот же самый
    // (`ui-screens`, «встроенная половина MUST NOT применяться вовсе»).
    const restoreFetch = installFetch(
      [
        { id: 'screen-runs', title: 'Прогоны', params: [] },
        { id: 'screen-backlog', title: 'Бэклог (свой)', params: [], builtin: false },
      ],
      [
        { id: 'route-runs', path: '/', target: { kind: 'screen', id: 'screen-runs' }, nav: { order: 0 } },
        { id: 'route-backlog', path: '/backlog', target: { kind: 'screen', id: 'screen-backlog' }, nav: { order: 1 } },
      ],
    );
    const restoreWindow = installWindow('/backlog');
    try {
      const kernel = freshKernel();
      await bootShellAndScreens(kernel);
      const diagnostics = await kernel.settle();

      const markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
      assert.match(markup, /browser half is unavailable/);
      assert.match(markup, /screen-backlog/);
      // Пункт меню заменённого экрана на месте и несёт его заголовок.
      assert.match(markup, /Бэклог \(свой\)/);
      // Встроенная половина бэклога не применена: её «Загрузка» не показана.
      assert.doesNotMatch(markup, /looks for a <code>backlog\.md<\/code>/);
    } finally {
      restoreWindow();
      restoreFetch();
    }
  });

  it('причина отказа сборки состава названа на странице', async () => {
    const restoreFetch = installFetch(
      [{ id: 'screen-runs', title: 'Прогоны', params: [] }],
      [{ id: 'route-runs', path: '/', target: { kind: 'screen', id: 'screen-runs' }, nav: { order: 0 } }],
      'Модуль плагина ./my-screen.mjs не загружается',
    );
    const restoreWindow = installWindow('/');
    try {
      const kernel = freshKernel();
      await bootShellAndScreens(kernel);
      const diagnostics = await kernel.settle();

      const markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
      assert.match(markup, /Screen composition was not rebuilt/);
      assert.match(markup, /my-screen\.mjs не загружается/);
      // Прежний состав при этом работает: экран прогонов на месте.
      assert.match(markup, /sc-empty-title">Loading…/);
    } finally {
      restoreWindow();
      restoreFetch();
    }
  });

  it('состав без отказа сборки полосы не показывает', async () => {
    const restoreFetch = installFetch(
      [{ id: 'screen-runs', title: 'Прогоны', params: [] }],
      [{ id: 'route-runs', path: '/', target: { kind: 'screen', id: 'screen-runs' }, nav: { order: 0 } }],
    );
    const restoreWindow = installWindow('/');
    try {
      const kernel = freshKernel();
      await bootShellAndScreens(kernel);
      const diagnostics = await kernel.settle();

      const markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
      assert.doesNotMatch(markup, /Screen composition was not rebuilt/);
    } finally {
      restoreWindow();
      restoreFetch();
    }
  });

  it('вклад с тем же id вместо встроенного даёт по тому же адресу другой экран', async () => {
    const restoreFetch = installFetch(
      [{ id: 'screen-runs', title: 'Прогоны', params: [] }],
      [{ id: 'route-runs', path: '/', target: { kind: 'screen', id: 'screen-runs' }, nav: { order: 0 } }],
    );
    const restoreWindow = installWindow('/');
    try {
      const kernel = freshKernel();
      await kernel.ctx.plugin({ name: 'shell', apply: shellPlugin });

      function Impostor(): JSX.Element {
        return <span id="impostor">не Runs</span>;
      }
      // Занимает ключ `screen-runs` раньше плагина `screens`: слот `keyed`
      // отдаёт место первому вкладчику (`ui/src/slots.ts`) — тем же правилом,
      // каким патч дерева заменяет встроенную строку на демоне.
      await kernel.ctx.plugin({
        name: 'impostor',
        apply: (ctx) => ctx.slots.contribute(SCREEN, { component: Impostor, key: 'screen-runs' }),
      });
      await kernel.ctx.plugin({ name: 'routes', apply: routesPlugin });
      await kernel.ctx.plugin({ name: 'screens', apply: screensPlugin });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      const diagnostics = await kernel.settle();

      const markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
      assert.match(markup, /id="impostor"/);
      assert.doesNotMatch(markup, /sc-empty-title">Loading…/);
    } finally {
      restoreWindow();
      restoreFetch();
    }
  });
});

describe('screens: вид цели route.target напрямую, вне маршрутизации', () => {
  it('цель, известная составу, но без бандловой половины, показана причиной с id и объяснением', async () => {
    const restoreFetch = installFetch([{ id: 'screen-riddle', title: 'Ребус', params: [] }], []);
    try {
      const kernel = createBrowserKernel({ createEventSource: fakeEventSources().factory });
      bindRouterKernel(kernel.ctx);
      await kernel.ctx.plugin({ name: 'shell', apply: shellPlugin });
      await kernel.ctx.plugin({ name: 'routes', apply: routesPlugin });
      await kernel.ctx.plugin({ name: 'screens', apply: screensPlugin });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await kernel.settle();

      const markup = renderToStaticMarkup(
        <KernelContext.Provider value={kernel.ctx}>
          <Slot
            of={ROUTE_TARGET}
            props={{
              target: { kind: 'screen', id: 'screen-riddle' },
              pathParams: {},
              targetParams: {},
              overview: undefined,
              navigate: () => {},
              backlog: undefined,
              widgets: undefined,
              snapshot: undefined,
              proposals: undefined,
            }}
            k="screen"
            default={null}
          />
        </KernelContext.Provider>,
      );
      assert.match(markup, /screen-riddle/);
      assert.match(markup, /browser half is unavailable/);
    } finally {
      restoreFetch();
    }
  });

  it('цель, которой нет в действующем составе, показана отдельной причиной', async () => {
    const restoreFetch = installFetch([], []);
    try {
      const kernel = createBrowserKernel({ createEventSource: fakeEventSources().factory });
      bindRouterKernel(kernel.ctx);
      await kernel.ctx.plugin({ name: 'shell', apply: shellPlugin });
      await kernel.ctx.plugin({ name: 'routes', apply: routesPlugin });
      await kernel.ctx.plugin({ name: 'screens', apply: screensPlugin });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await kernel.settle();

      const markup = renderToStaticMarkup(
        <KernelContext.Provider value={kernel.ctx}>
          <Slot
            of={ROUTE_TARGET}
            props={{
              target: { kind: 'screen', id: 'screen-nowhere' },
              pathParams: {},
              targetParams: {},
              overview: undefined,
              navigate: () => {},
              backlog: undefined,
              widgets: undefined,
              snapshot: undefined,
              proposals: undefined,
            }}
            k="screen"
            default={null}
          />
        </KernelContext.Provider>,
      );
      assert.match(markup, /screen-nowhere/);
      assert.match(markup, /is not in the active composition/);
    } finally {
      restoreFetch();
    }
  });
});
