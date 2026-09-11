import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Context } from 'cordis';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentType, ReactNode } from 'react';

import { createBrowserKernel, ROOT, type BrowserKernel } from '../src/kernel';
// Расширение явно в обоих — см. комментарий в `ui/src/kernel.ts` про `./slots.ts` vs `./slots.tsx`.
import { KernelFrame, Slot } from '../src/slots.tsx';
import { slot } from '../src/slots.ts';
import { fakeEventSources } from './support/live';

/**
 * Ядро витрины: корневой контекст, слот `root`, занятые ядром имена,
 * диагностики сборки (design.md `cordis-kernel-browser`, Решения 2, 6, 7), и
 * отрисовка (`<Slot>`, `KernelFrame`) через `react-dom/server` (Решения 11, 12).
 */

const Noop: ComponentType<Record<string, never>> = () => null;

/**
 * Ядро с подставным источником событий: `createBrowserKernel()` заводит сервис
 * `live` наравне с реестром слотов, а настоящий `EventSource` в Node
 * отсутствует — без подмены не поднялось бы ни одно ядро.
 */
function freshKernel(): BrowserKernel {
  return createBrowserKernel({ createEventSource: fakeEventSources().factory });
}

/**
 * Дать сверке состава дойти до конца: событие потока доставляется синхронно, а
 * сверка, им запущенная, — цепочка промисов с загрузкой модуля внутри
 * (`ui/src/services/plugins.ts`). `settle()` ждёт успокоения контекста, но
 * области, которая ещё не заведена, он не дождётся.
 */
const flush = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

describe('kernel: свежее ядро', () => {
  it('слот `root` объявлен, реестр слотов доступен, вкладчиков нет', () => {
    const kernel = freshKernel();
    assert.deepEqual(kernel.ctx.slots.getEntries(ROOT.name), []);
    assert.ok(kernel.ctx.slots instanceof Object);
  });

  it('плагин, объявляющий сервис `slots`, получает отказ, называющий имя и принадлежность ядру', async () => {
    const kernel = freshKernel();
    // Отказы собираются `settle()`, а не бросаются из вызова (design.md,
    // Решение 6) — загрузка не ждёт каждый плагин по отдельности.
    kernel.ctx.plugin({
      name: 'evil',
      apply(ctx) {
        ctx.provide('slots');
      },
    });

    const diagnostics = await kernel.settle();
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]!.kind, 'failed');
    assert.equal(diagnostics[0]!.plugin, 'evil');
    assert.match(diagnostics[0]!.message, /принадлежит ядру/);
  });

  it('сервис живых данных заведён самим ядром и уже открыл свою единственную подписку', () => {
    // Тот самый провал, который не ловился ничем: `ctx.live` не заводил никто,
    // и первая же отрисовка настоящего каркаса падала `TypeError` на
    // `ctx.live.subscribe` (`ui/src/plugins/shell.tsx`).
    const { factory, sources } = fakeEventSources();
    const kernel = createBrowserKernel({ createEventSource: factory });

    assert.notEqual(kernel.ctx.live, undefined);
    assert.equal(sources.length, 1);
    assert.equal(kernel.ctx.live.get().state, 'connecting');
  });

  it('плагин, объявляющий сервис `live`, получает отказ, называющий принадлежность ядру', async () => {
    const kernel = freshKernel();
    kernel.ctx.plugin({
      name: 'evil',
      apply(ctx) {
        ctx.provide('live');
      },
    });

    const diagnostics = await kernel.settle();
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]!.plugin, 'evil');
    assert.match(diagnostics[0]!.message, /живые данные витрины/);
  });

  it('плагин, объявляющий сервис состава браузерных строк, получает отказ, называющий имя и принадлежность ядру', async () => {
    const kernel = freshKernel();
    kernel.ctx.plugin({
      name: 'evil',
      apply(ctx) {
        ctx.provide('plugins');
      },
    });

    const diagnostics = await kernel.settle();
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]!.kind, 'failed');
    assert.equal(diagnostics[0]!.plugin, 'evil');
    assert.match(diagnostics[0]!.message, /состав браузерных строк/);
  });

  it('состав браузерных строк приходит событием `plugins` потока и запускает сверку сам', async () => {
    // Единственная связь демона с заменой: событие `plugins` → поле снимка
    // `live` → подписка ядра → сверка состава. Проверяется целиком, а не
    // прямым вызовом `reconcile` (`ui/test/hotSwap.test.tsx`): без этого шва
    // сверка не запускается вовсе, и разъехаться он может молча.
    const { factory, sources } = fakeEventSources();
    const loaded: string[] = [];
    const kernel = createBrowserKernel({
      createEventSource: factory,
      loadPluginModule: async (id, version) => {
        loaded.push(`${id}@${version}`);
        return {
          default: (ctx: Context) => {
            ctx.slots.contribute(ROOT, { component: Noop });
          },
        };
      },
    });

    sources[0]!.emit('plugins', { plugins: [{ id: 'demo', version: '1' }] });
    await flush();
    await kernel.settle();

    assert.deepEqual(loaded, ['demo@1']);
    assert.deepEqual(kernel.ctx.live.get().plugins, [{ id: 'demo', version: '1' }]);
    assert.equal(kernel.ctx.slots.getEntries(ROOT.name).length, 1);

    // Тот же состав следующим событием — ни второй загрузки, ни повторного
    // применения: сверка сравнивает версию строки, а ядро — ссылку на состав.
    sources[0]!.emit('plugins', { plugins: [{ id: 'demo', version: '1' }] });
    await flush();
    assert.deepEqual(loaded, ['demo@1']);

    // Строка исчезла из состава, присланного демоном, — её область снята.
    sources[0]!.emit('plugins', { plugins: [] });
    await flush();
    await kernel.settle();
    assert.deepEqual(kernel.ctx.slots.getEntries(ROOT.name), []);
  });

  it('плагин, объявляющий слот с именем `root`, получает отказ — имя уже занято ядром', async () => {
    const kernel = freshKernel();
    await kernel.ctx.plugin({
      name: 'evil',
      apply(ctx) {
        ctx.slots.contribute(ROOT, { component: Noop, slots: [ROOT] });
      },
    });

    const diagnostics = await kernel.settle();
    assert.ok(diagnostics.some((d) => d.kind === 'failed' && d.plugin === 'evil'));
  });
});

describe('kernel: диагностики сборки', () => {
  it('отказ одного вклада снимает только его область, соседи остаются в силе', async () => {
    const kernel = freshKernel();
    const NAV = slot<Record<string, never>, 'list'>('nav', 'list');

    await kernel.ctx.plugin({
      name: 'good',
      apply(ctx) {
        ctx.slots.contribute(ROOT, { component: Noop, slots: [NAV] });
      },
    });
    await kernel.ctx.plugin({
      name: 'neighbour',
      apply(ctx) {
        ctx.slots.contribute(NAV, { component: Noop });
      },
    });
    await kernel.ctx.plugin({
      name: 'orphan',
      apply(ctx) {
        ctx.slots.contribute(slot<Record<string, never>, 'single'>('nowhere', 'single'), { component: Noop });
      },
    });

    const diagnostics = await kernel.settle();
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]!.kind, 'unresolved');
    assert.equal(diagnostics[0]!.plugin, 'orphan');
    assert.equal(diagnostics[0]!.slot, 'nowhere');

    // Соседи, не имевшие отношения к отказу, работают как ни в чём не бывало.
    assert.equal(kernel.ctx.slots.getEntries(ROOT.name).length, 1);
    assert.equal(kernel.ctx.slots.getEntries(NAV.name).length, 1);
  });

  it('второй вкладчик в `root` отвергнут диагностикой `rejected`, называющей слот и плагин', async () => {
    const kernel = freshKernel();
    await kernel.ctx.plugin({ name: 'a', apply: (ctx) => ctx.slots.contribute(ROOT, { component: Noop }) });
    await kernel.ctx.plugin({ name: 'b', apply: (ctx) => ctx.slots.contribute(ROOT, { component: Noop }) });

    const diagnostics = await kernel.settle();
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]!.kind, 'rejected');
    assert.equal(diagnostics[0]!.plugin, 'b');
    assert.equal(diagnostics[0]!.slot, 'root');

    assert.equal(kernel.ctx.slots.getEntries(ROOT.name)[0]!.owner, 'a');
  });

  it('плагин, отказавший на одном объявлении, снимается целиком — его прочие вклады тоже уходят', async () => {
    const kernel = freshKernel();
    const SLOT_A = slot<Record<string, never>, 'list'>('slot-a', 'list');
    const SLOT_B = slot<Record<string, never>, 'list'>('slot-b', 'list');
    const DUP = slot<Record<string, never>, 'single'>('dup', 'single');
    const SUCCESS = slot<Record<string, never>, 'single'>('success', 'single');

    await kernel.ctx.plugin({
      name: 'setup',
      apply: (ctx) => ctx.slots.contribute(ROOT, { component: Noop, slots: [SLOT_A, SLOT_B] }),
    });
    await kernel.ctx.plugin({
      name: 'owner',
      apply: (ctx) => ctx.slots.contribute(SLOT_A, { component: Noop, slots: [DUP] }),
    });
    await kernel.settle();

    await kernel.ctx.plugin({
      name: 'multi',
      apply(ctx) {
        // Первый вызов успевает объявить `success` — второй отказывает: имя
        // `dup` уже занял `owner`. Оба вызова — одна и та же плагинная
        // область, и её обязано снять отказом целиком.
        ctx.slots.contribute(SLOT_B, { component: Noop, slots: [SUCCESS] });
        ctx.slots.contribute(SLOT_A, { component: Noop, slots: [DUP] });
      },
    });

    const diagnostics = await kernel.settle();
    assert.ok(diagnostics.some((d) => d.kind === 'failed' && d.plugin === 'multi' && d.slot === 'dup'));
    // `multi` снят целиком: даже успевшее объявление `success` не осталось.
    assert.equal(kernel.ctx.slots.getEntries(SLOT_B.name).length, 0);
  });
});

describe('kernel: dispose()', () => {
  it('снимает все области плагинов', async () => {
    const kernel = freshKernel();
    await kernel.ctx.plugin({ name: 'a', apply: (ctx) => ctx.slots.contribute(ROOT, { component: Noop }) });
    await kernel.settle();
    assert.equal(kernel.ctx.slots.getEntries(ROOT.name).length, 1);

    await kernel.dispose();
    assert.equal(kernel.ctx.slots.getEntries(ROOT.name).length, 0);
  });
});

describe('kernel: рендерер <Slot>', () => {
  const NAV = slot<Record<string, never>, 'list'>('nav', 'list');

  it('корневой слот отрисован', async () => {
    const kernel = freshKernel();
    const Shell: ComponentType<Record<string, never>> = () => <div id="shell">shell</div>;
    await kernel.ctx.plugin({ name: 'shell', apply: (ctx) => ctx.slots.contribute(ROOT, { component: Shell }) });
    const diagnostics = await kernel.settle();

    const markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
    assert.match(markup, /id="shell"/);
    assert.match(markup, /shell/);
  });

  it('нет вкладчика в `root` — внятная страница, не пустота', async () => {
    const kernel = freshKernel();
    const diagnostics = await kernel.settle();

    const markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
    assert.match(markup, /каркас/);
  });

  it('вкладчик дочернего слота виден в разметке; снятие убирает его из следующей отрисовки', async () => {
    const kernel = freshKernel();
    const Shell: ComponentType<Record<string, never>> = () => (
      <div id="shell">
        <Slot of={NAV} props={{}} />
      </div>
    );
    const NavItem: ComponentType<Record<string, never>> = () => <a id="nav-item">runs</a>;

    await kernel.ctx.plugin({
      name: 'shell',
      apply: (ctx) => ctx.slots.contribute(ROOT, { component: Shell, slots: [NAV] }),
    });
    const itemFiber = await kernel.ctx.plugin({
      name: 'runs',
      apply: (ctx) => ctx.slots.contribute(NAV, { component: NavItem }),
    });
    let diagnostics = await kernel.settle();

    let markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
    assert.match(markup, /id="nav-item"/);

    await itemFiber.dispose();
    diagnostics = await kernel.settle();
    markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
    assert.doesNotMatch(markup, /id="nav-item"/);
  });

  it('диагностика видна в разметке', async () => {
    const kernel = freshKernel();
    await kernel.ctx.plugin({
      name: 'orphan',
      apply: (ctx) => ctx.slots.contribute(slot<Record<string, never>, 'single'>('nowhere', 'single'), { component: Noop }),
    });
    const diagnostics = await kernel.settle();
    assert.ok(diagnostics.length > 0);

    const markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
    assert.match(markup, /orphan/);
    assert.match(markup, /nowhere/);
  });

  it('`keyed`: ключа нет в слоте — содержимое по умолчанию', async () => {
    const kernel = freshKernel();
    const KEYED = slot<Record<string, never>, 'keyed'>('keyed-render', 'keyed');
    const Shell: ComponentType<Record<string, never>> = () => (
      <Slot of={KEYED} props={{}} k="missing" default={<span id="fallback">fallback</span>} />
    );
    await kernel.ctx.plugin({
      name: 'shell',
      apply: (ctx) => ctx.slots.contribute(ROOT, { component: Shell, slots: [KEYED] }),
    });
    await kernel.ctx.plugin({
      name: 'present',
      apply: (ctx) => ctx.slots.contribute(KEYED, { component: Noop, key: 'present' }),
    });
    const diagnostics = await kernel.settle();

    const markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
    assert.match(markup, /id="fallback"/);
  });

  it('`chain`: звено оборачивает следующее — и волено его не показать', async () => {
    const kernel = freshKernel();
    const CHAIN = slot<Record<string, never>, 'chain'>('chain-render', 'chain');
    const Shell: ComponentType<Record<string, never>> = () => (
      <Slot of={CHAIN} props={{}} default={<span id="leaf">leaf</span>} />
    );
    const Wrap: ComponentType<{ readonly next: ReactNode }> = ({ next }) => <div id="wrap">{next}</div>;

    await kernel.ctx.plugin({
      name: 'shell',
      apply: (ctx) => ctx.slots.contribute(ROOT, { component: Shell, slots: [CHAIN] }),
    });
    await kernel.ctx.plugin({
      name: 'wrapper',
      apply: (ctx) => ctx.slots.contribute<Record<string, never>, 'chain'>(CHAIN, { component: Wrap }),
    });
    let diagnostics = await kernel.settle();

    let markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
    assert.match(markup, /id="wrap"/);
    assert.match(markup, /id="leaf"/);

    // Второе звено решает не отрисовывать `next` вовсе — ни оно, ни
    // содержимое по умолчанию в разметке не появляются.
    const Hide: ComponentType<{ readonly next: ReactNode }> = () => <div id="hide">hidden</div>;
    await kernel.ctx.plugin({
      name: 'hider',
      apply: (ctx) => ctx.slots.contribute<Record<string, never>, 'chain'>(CHAIN, { component: Hide, order: -1 }),
    });
    diagnostics = await kernel.settle();
    markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
    assert.match(markup, /id="hide"/);
    assert.doesNotMatch(markup, /id="leaf"/);
  });

  it('`list`: все вкладчики в объявленном порядке', async () => {
    const kernel = freshKernel();
    const LIST = slot<Record<string, never>, 'list'>('list-render', 'list');
    const Shell: ComponentType<Record<string, never>> = () => <Slot of={LIST} props={{}} />;
    const First: ComponentType<Record<string, never>> = () => <span id="first">first</span>;
    const Second: ComponentType<Record<string, never>> = () => <span id="second">second</span>;

    await kernel.ctx.plugin({
      name: 'shell',
      apply: (ctx) => ctx.slots.contribute(ROOT, { component: Shell, slots: [LIST] }),
    });
    await kernel.ctx.plugin({ name: 'b', apply: (ctx) => ctx.slots.contribute(LIST, { component: Second, order: 1 }) });
    await kernel.ctx.plugin({ name: 'a', apply: (ctx) => ctx.slots.contribute(LIST, { component: First, order: 0 }) });
    const diagnostics = await kernel.settle();

    const markup = renderToStaticMarkup(<KernelFrame kernel={kernel} diagnostics={diagnostics} />);
    assert.ok(markup.indexOf('id="first"') < markup.indexOf('id="second"'), markup);
  });
});
