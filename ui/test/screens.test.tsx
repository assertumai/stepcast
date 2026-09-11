import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';
import type { JSX } from 'react';

import { createBrowserKernel, KernelContext, type BrowserKernel } from '../src/kernel';
import { KernelFrame, Slot } from '../src/slots.tsx';
import shellPlugin, { SCREEN } from '../src/plugins/shell.tsx';
import screensPlugin from '../src/plugins/screens.tsx';
import { bindRouterKernel } from '../src/router';
import { fakeEventSources } from './support/live';

/**
 * Плагин `screens` (`ui/src/plugins/screens.tsx`): читает состав у демона и
 * применяет встроенные половины по таблице `ui/src/screens/index.ts`
 * (design.md, Решение 12, 13; тесты 1.10, 1.11 изменения
 * `builtin-pages-as-plugins`).
 */

interface FakeScreen {
  readonly id: string;
  readonly title: string;
  readonly nav?: { readonly order: number };
  readonly params: readonly string[];
  readonly path: string;
  /** Происхождение строки в ответе демона. Не названо — строка поставки витрины, как у встроенного состава. */
  readonly builtin?: boolean;
}

function installFetch(screens: readonly FakeScreen[], buildError?: string): () => void {
  const previous = (globalThis as { fetch?: unknown }).fetch;
  (globalThis as { fetch?: unknown }).fetch = async (input: unknown) => {
    const url = String(input);
    assert.equal(url, '/api/screens');
    const body = JSON.stringify({
      screens: screens.map((screen) => ({ builtin: true, ...screen })),
      ...(buildError === undefined ? {} : { buildError }),
    });
    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(body) as unknown,
    };
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
  await kernel.ctx.plugin({ name: 'screens', apply: screensPlugin });
  // `screens` пишет состав асинхронно, отдельным `.then()` внутри своего
  // `apply` — сама область плагина успокаивается раньше, чем придёт ответ
  // `fetch`. Подставной `fetch` в этих тестах разрешается синхронно
  // (`Promise.resolve`), но микрозадаче всё равно нужен тик.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('screens: состав применяется по ответу демона', () => {
  it('навигация собрана из вкладов экранов в объявленном порядке, а не в порядке ответа демона', async () => {
    const restoreFetch = installFetch([
      { id: 'screen-steps', title: 'Шаги', nav: { order: 2 }, params: [], path: '/steps' },
      { id: 'screen-pipelines', title: 'Пайплайны', nav: { order: 1 }, params: [], path: '/pipelines' },
      { id: 'screen-runs', title: 'Прогоны', nav: { order: 0 }, params: [], path: '/' },
    ]);
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
    const restoreFetch = installFetch([
      { id: 'screen-runs', title: 'Прогоны', nav: { order: 0 }, params: [], path: '/' },
      { id: 'screen-backlog', title: 'Бэклог', nav: { order: 1 }, params: [], path: '/backlog' },
    ]);
    const restoreWindow = installWindow('/backlog');
    try {
      const kernel = freshKernel();
      await bootShellAndScreens(kernel);
      const diagnostics = await kernel.settle();

      const markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
      // Экран очереди без данных показывает свою «Загрузка», как и до перевода.
      assert.match(markup, /Демон ищет файл|class="empty">Загрузка/);
    } finally {
      restoreWindow();
      restoreFetch();
    }
  });

  it('экрана, которого демон не назвал, нет ни в навигации, ни в слоте экранов', async () => {
    const restoreFetch = installFetch([{ id: 'screen-runs', title: 'Прогоны', nav: { order: 0 }, params: [], path: '/' }]);
    const restoreWindow = installWindow('/settings');
    try {
      const kernel = freshKernel();
      await bootShellAndScreens(kernel);
      const diagnostics = await kernel.settle();

      const markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
      assert.doesNotMatch(markup, /Настройки/);
      // Путь /settings не разобран ни одним действующим экраном — ведёт на умолчание (`screen-runs`).
      assert.match(markup, /class="empty">Загрузка/);
    } finally {
      restoreWindow();
      restoreFetch();
    }
  });

  it('экран, названный демоном без доступной браузерной половины, показан с причиной', async () => {
    const restoreFetch = installFetch([
      { id: 'screen-runs', title: 'Прогоны', nav: { order: 0 }, params: [], path: '/' },
      { id: 'screen-mystery', title: 'Загадка', nav: { order: 1 }, params: [], path: '/mystery' },
    ]);
    const restoreWindow = installWindow('/mystery');
    try {
      const kernel = freshKernel();
      await bootShellAndScreens(kernel);
      const diagnostics = await kernel.settle();

      const markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
      assert.match(markup, /Загадка/);
      assert.match(markup, /screen-mystery/);
      assert.match(markup, /браузерная половина недоступна/);
    } finally {
      restoreWindow();
      restoreFetch();
    }
  });

  it('экран, чью строку заменил чужой модуль, показан заглушкой с причиной, а не встроенной половиной', async () => {
    // Признак `builtin: false` — единственное, чем страница отличает
    // заменённую строку от встроенной: `id` у замены тот же самый
    // (`ui-screens`, «встроенная половина MUST NOT применяться вовсе»).
    const restoreFetch = installFetch([
      { id: 'screen-runs', title: 'Прогоны', nav: { order: 0 }, params: [], path: '/' },
      { id: 'screen-backlog', title: 'Бэклог (свой)', nav: { order: 1 }, params: [], path: '/backlog', builtin: false },
    ]);
    const restoreWindow = installWindow('/backlog');
    try {
      const kernel = freshKernel();
      await bootShellAndScreens(kernel);
      const diagnostics = await kernel.settle();

      const markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
      assert.match(markup, /браузерная половина недоступна/);
      assert.match(markup, /screen-backlog/);
      // Пункт меню заменённого экрана на месте и несёт его заголовок.
      assert.match(markup, /Бэклог \(свой\)/);
      // Встроенная половина бэклога не применена: её «Загрузка» не показана.
      assert.doesNotMatch(markup, /Демон ищет файл/);
    } finally {
      restoreWindow();
      restoreFetch();
    }
  });

  it('причина отказа сборки состава названа на странице', async () => {
    const restoreFetch = installFetch(
      [{ id: 'screen-runs', title: 'Прогоны', nav: { order: 0 }, params: [], path: '/' }],
      'Модуль плагина ./my-screen.mjs не загружается',
    );
    const restoreWindow = installWindow('/');
    try {
      const kernel = freshKernel();
      await bootShellAndScreens(kernel);
      const diagnostics = await kernel.settle();

      const markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
      assert.match(markup, /Состав экранов не пересобран/);
      assert.match(markup, /my-screen\.mjs не загружается/);
      // Прежний состав при этом работает: экран прогонов на месте.
      assert.match(markup, /class="empty">Загрузка/);
    } finally {
      restoreWindow();
      restoreFetch();
    }
  });

  it('состав без отказа сборки полосы не показывает', async () => {
    const restoreFetch = installFetch([{ id: 'screen-runs', title: 'Прогоны', nav: { order: 0 }, params: [], path: '/' }]);
    const restoreWindow = installWindow('/');
    try {
      const kernel = freshKernel();
      await bootShellAndScreens(kernel);
      const diagnostics = await kernel.settle();

      const markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
      assert.doesNotMatch(markup, /Состав экранов не пересобран/);
    } finally {
      restoreWindow();
      restoreFetch();
    }
  });

  it('вклад с тем же id вместо встроенного даёт по тому же адресу другой экран', async () => {
    const restoreFetch = installFetch([{ id: 'screen-runs', title: 'Прогоны', nav: { order: 0 }, params: [], path: '/' }]);
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
      await kernel.ctx.plugin({ name: 'screens', apply: screensPlugin });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      const diagnostics = await kernel.settle();

      const markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
      assert.match(markup, /id="impostor"/);
      assert.doesNotMatch(markup, /class="empty">Загрузка/);
    } finally {
      restoreWindow();
      restoreFetch();
    }
  });
});

describe('screens: слот screen напрямую, вне каркаса', () => {
  it('заглушка недоступного экрана несёт его id и объяснение', async () => {
    const restoreFetch = installFetch([{ id: 'screen-riddle', title: 'Ребус', params: [], path: '/riddle' }]);
    try {
      const kernel = createBrowserKernel({ createEventSource: fakeEventSources().factory });
      bindRouterKernel(kernel.ctx);
      await kernel.ctx.plugin({ name: 'shell', apply: shellPlugin });
      await kernel.ctx.plugin({ name: 'screens', apply: screensPlugin });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await kernel.settle();

      const markup = renderToStaticMarkup(
        <KernelContext.Provider value={kernel.ctx}>
          <Slot
            of={SCREEN}
            props={{
              overview: undefined,
              navigate: () => {},
              params: {},
              backlog: undefined,
              widgets: undefined,
              snapshot: undefined,
            }}
            k="screen-riddle"
            default={null}
          />
        </KernelContext.Provider>,
      );
      assert.match(markup, /screen-riddle/);
    } finally {
      restoreFetch();
    }
  });
});
