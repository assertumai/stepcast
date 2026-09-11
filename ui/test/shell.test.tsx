import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentType, ReactElement } from 'react';

import type { Fiber } from 'cordis';

import { createBrowserKernel, KernelContext, ROOT, type BrowserKernel } from '../src/kernel';
import { KernelFrame, Slot } from '../src/slots.tsx';
import shellPlugin, { NAV, SCREEN } from '../src/plugins/shell.tsx';
import { bindRouterKernel } from '../src/router';
import { fakeEventSources } from './support/live';
import type { Overview, BacklogOverview, WidgetsOverview, RunSnapshot } from '../src/api';

/**
 * Механика каркаса — слот `screen` по ключу маршрута, слот `nav`, полоса
 * связи (design.md `cordis-kernel-browser`, Решение 8, 9) — проверяется
 * синтетическими вкладами, не настоящим экраном: какой именно экран сидит на
 * каком ключе — дело состава (`ui/test/screens.test.tsx`), а не каркаса.
 */

type ScreenProps = {
  readonly overview: Overview | undefined;
  readonly navigate: (href: string) => void;
  readonly params: Readonly<Record<string, string>>;
  readonly backlog: BacklogOverview | undefined;
  readonly widgets: WidgetsOverview | undefined;
  readonly snapshot: RunSnapshot | undefined;
};

const EMPTY_SCREEN_PROPS: ScreenProps = {
  overview: undefined,
  navigate: () => {},
  params: {},
  backlog: undefined,
  widgets: undefined,
  snapshot: undefined,
};

/** Ядро с подставным источником событий — см. тот же помощник в `ui/test/kernel.test.tsx`. */
function freshKernel(): BrowserKernel {
  const kernel = createBrowserKernel({ createEventSource: fakeEventSources().factory });
  bindRouterKernel(kernel.ctx);
  return kernel;
}

/**
 * Минимальное `window` для `useRoute()`: он читает `window.location.pathname`
 * прямо в теле компонента. Серверный рендерер эффектов не исполняет, поэтому
 * подписки на `popstate` здесь не случается, но `addEventListener` объявлен —
 * чтобы подмена не разошлась с настоящим окном по поверхности.
 */
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

const Legacy: ComponentType<ScreenProps> = () => <span id="legacy">legacy</span>;

function Harness({ kernel, routeKey }: { readonly kernel: BrowserKernel; readonly routeKey: string }): ReactElement {
  return (
    <KernelContext.Provider value={kernel.ctx}>
      <Slot of={SCREEN} props={EMPTY_SCREEN_PROPS} k={routeKey} default={<Legacy {...EMPTY_SCREEN_PROPS} />} />
    </KernelContext.Provider>
  );
}

async function bootShellStub(kernel: BrowserKernel): Promise<void> {
  await kernel.ctx.plugin({
    name: 'shell-stub',
    apply: (ctx) => ctx.slots.contribute(ROOT, { component: () => null, slots: [NAV, SCREEN] }),
  });
}

const Sample: ComponentType<ScreenProps> = () => <span id="sample">sample экран</span>;

async function bootSample(kernel: BrowserKernel): Promise<Fiber> {
  return kernel.ctx.plugin({
    name: 'sample',
    apply: (ctx) => ctx.slots.contribute(SCREEN, { component: Sample, key: 'sample' }),
  });
}

describe('shell: слот screen по ключу маршрута', () => {
  it('ключ, которого в screen нет, отдаётся содержимому по умолчанию', async () => {
    const kernel = freshKernel();
    await bootShellStub(kernel);
    await bootSample(kernel);
    const diagnostics = await kernel.settle();
    assert.deepEqual(diagnostics, []);

    const markup = renderToStaticMarkup(<Harness kernel={kernel} routeKey="другой-ключ" />);
    assert.match(markup, /id="legacy"/);
  });

  it('ключ, для которого есть вклад, отдаёт его, а не заглушку', async () => {
    const kernel = freshKernel();
    await bootShellStub(kernel);
    await bootSample(kernel);
    await kernel.settle();

    const markup = renderToStaticMarkup(<Harness kernel={kernel} routeKey="sample" />);
    assert.doesNotMatch(markup, /id="legacy"/);
    assert.match(markup, /id="sample"/);
  });

  it('вклад с тем же ключом на место снятого меняет экран', async () => {
    const kernel = freshKernel();
    await bootShellStub(kernel);
    const sampleFiber = await bootSample(kernel);
    await kernel.settle();

    let markup = renderToStaticMarkup(<Harness kernel={kernel} routeKey="sample" />);
    assert.match(markup, /id="sample"/);

    await sampleFiber.dispose();
    await kernel.settle();

    const Replacement: ComponentType<ScreenProps> = () => <span id="replacement">replacement</span>;
    await kernel.ctx.plugin({
      name: 'replacement',
      apply: (ctx) => ctx.slots.contribute(SCREEN, { component: Replacement, key: 'sample' }),
    });
    await kernel.settle();

    markup = renderToStaticMarkup(<Harness kernel={kernel} routeKey="sample" />);
    assert.match(markup, /id="replacement"/);
  });
});

describe('shell: настоящий каркас на настоящем ядре', () => {
  /** Объявление минимального экрана — те же поля, что несёт `ScreenDeclaration` (`src/ui/screens/declaration.ts`). */
  const SAMPLE_DECLARATION = { id: 'screen-sample', title: 'Пример', nav: { order: 0 }, params: [], path: '/' };

  function sampleNavItem({ navigate }: { readonly navigate: (href: string) => void }): ReactElement {
    return (
      <a
        className="nav-item"
        href="/"
        onClick={(event) => {
          event.preventDefault();
          navigate('/');
        }}
      >
        {SAMPLE_DECLARATION.title}
      </a>
    );
  }

  async function bootSampleScreen(kernel: BrowserKernel): Promise<void> {
    kernel.ctx.screens.set(new Map([[SAMPLE_DECLARATION.id, SAMPLE_DECLARATION]]), undefined);
    await kernel.ctx.plugin({
      name: 'sample-screen',
      apply: (ctx) => {
        ctx.slots.contribute(NAV, { component: sampleNavItem, order: 0 });
        ctx.slots.contribute(SCREEN, { component: Sample, key: SAMPLE_DECLARATION.id });
      },
    });
  }

  it('отрисовывается целиком: пункт меню, экран по маршруту `/`, состояние связи', async () => {
    const restore = installWindow('/');
    try {
      const kernel = freshKernel();
      await kernel.ctx.plugin({ name: 'shell', apply: shellPlugin });
      await bootSampleScreen(kernel);
      const diagnostics = await kernel.settle();
      assert.deepEqual(diagnostics, []);

      const markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
      assert.match(markup, /class="shell"/);
      assert.match(markup, /Пример/);
      assert.match(markup, /подключение к демону/);
      assert.match(markup, /id="sample"/);
    } finally {
      restore();
    }
  });

  it('ключ маршрута, которого нет в слоте экранов, открывает экран по умолчанию действующего состава', async () => {
    const restore = installWindow('/orphan');
    try {
      const kernel = freshKernel();
      await kernel.ctx.plugin({ name: 'shell', apply: shellPlugin });
      // Состав называет два экрана, вклад в слот есть только у первого:
      // адрес второго разбирается, но показывать по нему нечего — и это ведёт
      // на экран по умолчанию (`ui-kernel`, «Ключа нет в слоте экранов»), а не
      // на пустое место.
      kernel.ctx.screens.set(
        new Map([
          [SAMPLE_DECLARATION.id, SAMPLE_DECLARATION],
          ['screen-orphan', { id: 'screen-orphan', title: 'Сирота', nav: { order: 1 }, params: [], path: '/orphan' }],
        ]),
        undefined,
      );
      await kernel.ctx.plugin({
        name: 'sample-screen',
        apply: (ctx) => ctx.slots.contribute(SCREEN, { component: Sample, key: SAMPLE_DECLARATION.id }),
      });
      const diagnostics = await kernel.settle();

      const markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
      assert.match(markup, /id="sample"/);
      assert.doesNotMatch(markup, /Экран не найден в действующем составе/);
    } finally {
      restore();
    }
  });

  it('данные сервиса `live` доходят до экрана через props слота', async () => {
    const restore = installWindow('/');
    try {
      const { factory, sources } = fakeEventSources();
      const kernel = createBrowserKernel({ createEventSource: factory });
      bindRouterKernel(kernel.ctx);
      await kernel.ctx.plugin({ name: 'shell', apply: shellPlugin });

      let received: Overview | undefined;
      const Watching: ComponentType<ScreenProps> = ({ overview }) => {
        received = overview;
        return <span id="sample">sample</span>;
      };
      kernel.ctx.screens.set(new Map([[SAMPLE_DECLARATION.id, SAMPLE_DECLARATION]]), undefined);
      await kernel.ctx.plugin({
        name: 'sample-screen',
        apply: (ctx) => ctx.slots.contribute(SCREEN, { component: Watching, key: SAMPLE_DECLARATION.id }),
      });
      const diagnostics = await kernel.settle();

      // Событие демона приходит в сервис, а не в компонент: экран получает
      // обзор тем, что передал ему слот (требование `ui-kernel`, «Компонент
      // получает данные извне»).
      sources[0]!.emit('overview', { projects: [] });

      renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
      assert.deepEqual(received, { projects: [] });
    } finally {
      restore();
    }
  });
});
