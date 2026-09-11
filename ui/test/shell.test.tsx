import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentType, ReactElement } from 'react';

import { createBrowserKernel, KernelContext, ROOT, type BrowserKernel } from '../src/kernel';
import { KernelFrame, Slot } from '../src/slots.tsx';
import shellPlugin, { NAV, SCREEN } from '../src/plugins/shell.tsx';
import runsPlugin from '../src/plugins/runs.tsx';
import { fakeEventSources } from './support/live';
import type { Overview } from '../src/api';

type ScreenProps = { readonly overview: Overview | undefined; readonly navigate: (href: string) => void };

/**
 * Каркас и первый экран — вклад плагина `runs` в реальный слот `screen`
 * (design.md `cordis-kernel-browser`, Решение 8, 9). Часть проверок идёт на
 * `shell-stub` (он объявляет те же дочерние слоты, что настоящий каркас, —
 * иначе вклад `runs` в `nav` остаётся ждать необъявленное имя), но последняя
 * группа поднимает настоящий `shell` целиком: именно там живут обращения
 * каркаса к сервисам ядра, и без них проверялось бы всё, кроме продакшен-пути.
 */

/** Ядро с подставным источником событий — см. тот же помощник в `ui/test/kernel.test.tsx`. */
function freshKernel(): BrowserKernel {
  return createBrowserKernel({ createEventSource: fakeEventSources().factory });
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
      <Slot
        of={SCREEN}
        props={{ overview: undefined, navigate: () => {} }}
        k={routeKey}
        default={<Legacy overview={undefined} navigate={() => {}} />}
      />
    </KernelContext.Provider>
  );
}

async function bootShellStub(kernel: BrowserKernel): Promise<void> {
  await kernel.ctx.plugin({
    name: 'shell-stub',
    apply: (ctx) => ctx.slots.contribute(ROOT, { component: () => null, slots: [NAV, SCREEN] }),
  });
}

describe('shell+runs: экран «Прогоны» вкладом в реальный слот `screen`', () => {
  it('ключ, которого в `screen` нет, отдаётся содержимому по умолчанию', async () => {
    const kernel = freshKernel();
    await bootShellStub(kernel);
    await kernel.ctx.plugin({ name: 'runs', apply: runsPlugin });
    const diagnostics = await kernel.settle();
    assert.deepEqual(diagnostics, []);

    const markup = renderToStaticMarkup(<Harness kernel={kernel} routeKey="pipelines" />);
    assert.match(markup, /id="legacy"/);
  });

  it('ключ `runs` отдаёт настоящий экран «Прогоны», без карточки-заглушки', async () => {
    const kernel = freshKernel();
    await bootShellStub(kernel);
    await kernel.ctx.plugin({ name: 'runs', apply: runsPlugin });
    await kernel.settle();

    const markup = renderToStaticMarkup(<Harness kernel={kernel} routeKey="runs" />);
    // Настоящий экран — таблица прогонов (`Runs.tsx`), не заглушка и не легаси-фолбэк.
    assert.doesNotMatch(markup, /id="legacy"/);
    // `overview` не задан в этом тесте — `Runs.tsx` показывает свою
    // собственную загрузку, а не заглушку `Legacy` и не пустую страницу.
    assert.match(markup, /class="empty">Загрузка/);
  });

  it('вклад с тем же ключом на место снятого меняет экран', async () => {
    const kernel = freshKernel();
    await bootShellStub(kernel);
    const runsFiber = await kernel.ctx.plugin({ name: 'runs', apply: runsPlugin });
    await kernel.settle();

    let markup = renderToStaticMarkup(<Harness kernel={kernel} routeKey="runs" />);
    // `overview` не задан в этом тесте — `Runs.tsx` показывает свою
    // собственную загрузку, а не заглушку `Legacy` и не пустую страницу.
    assert.match(markup, /class="empty">Загрузка/);

    await runsFiber.dispose();
    await kernel.settle();

    const Replacement: ComponentType<ScreenProps> = () => <span id="replacement">replacement</span>;
    await kernel.ctx.plugin({
      name: 'replacement',
      apply: (ctx) => ctx.slots.contribute(SCREEN, { component: Replacement, key: 'runs' }),
    });
    await kernel.settle();

    markup = renderToStaticMarkup(<Harness kernel={kernel} routeKey="runs" />);
    assert.match(markup, /id="replacement"/);
  });
});

describe('shell: настоящий каркас на настоящем ядре', () => {
  /**
   * Продакшен-путь целиком: `createBrowserKernel()` + `shell` + `runs` +
   * корневой рендерер — тот самый состав, который поднимает `ui/src/main.tsx`.
   * Именно его отсутствие в дорожке тестов позволило каркасу звать сервис
   * (`ctx.live`), которого ядро не заводило: типы молчали (`declare module
   * 'cordis'` обещает поле всякому контексту), а витрина падала первой же
   * отрисовкой.
   */
  it('отрисовывается целиком: пункт меню из `runs`, экран «Прогоны», состояние связи', async () => {
    const restore = installWindow('/');
    try {
      const kernel = freshKernel();
      await kernel.ctx.plugin({ name: 'shell', apply: shellPlugin });
      await kernel.ctx.plugin({ name: 'runs', apply: runsPlugin });
      const diagnostics = await kernel.settle();
      assert.deepEqual(diagnostics, []);

      const markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
      // Каркас: меню с пунктом из `runs` и полоса состояния связи из сервиса
      // `live` (свежая подписка — «подключение», данных ещё нет).
      assert.match(markup, /class="shell"/);
      assert.match(markup, /Прогоны/);
      assert.match(markup, /подключение к демону/);
      // Экран по ключу маршрута `/` — настоящий `Runs.tsx`, а не легаси-ветка.
      assert.match(markup, /class="empty">Загрузка/);
    } finally {
      restore();
    }
  });

  it('данные сервиса `live` доходят до экрана через props слота', async () => {
    const restore = installWindow('/');
    try {
      const { factory, sources } = fakeEventSources();
      const kernel = createBrowserKernel({ createEventSource: factory });
      await kernel.ctx.plugin({ name: 'shell', apply: shellPlugin });
      await kernel.ctx.plugin({ name: 'runs', apply: runsPlugin });
      const diagnostics = await kernel.settle();

      // Событие демона приходит в сервис, а не в компонент: экран получает
      // обзор тем, что передал ему слот (требование `ui-kernel`, «Компонент
      // получает данные извне»).
      sources[0]!.emit('overview', { projects: [] });

      const markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
      assert.match(markup, /живое обновление/);
      // Обзор дошёл: «Загрузка» сменилась ответом экрана на пустой обзор.
      assert.doesNotMatch(markup, /class="empty">Загрузка/);
      assert.match(markup, /Прогонов пока нет/);
    } finally {
      restore();
    }
  });
});
