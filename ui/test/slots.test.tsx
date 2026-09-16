import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Context, type Fiber } from 'cordis';
import type { ComponentType } from 'react';

import { failedFibers, settle, unresolvedFibers } from '../../src/kernel/fibers';
// Расширение явно: `ui/src/slots.tsx` (рендерер) — тот же basename, esbuild и
// tsc(bundler) расходятся, что значит голое `./slots` (см. комментарий в `ui/src/kernel.ts`).
import { SlotsService, slot, slotServiceName, translateSlotNameConflict, type SlotDescriptor } from '../src/slots.ts';

/**
 * Реестр слотов (design.md `cordis-kernel-browser`, Решения 1-6):
 * четыре вида композиции, объявление и вклад одним вызовом, отказы состава,
 * снятие вклада каскадом, устойчивость снимка. Ядро не поднимается вовсе —
 * это дело `ui/test/kernel.test.tsx`; здесь только сервис `slots` на голом
 * `cordis.Context`.
 */

interface ItemProps {
  readonly label: string;
}

const Noop: ComponentType<ItemProps> = () => null;

function freshCtx(): Context {
  const ctx = new Context();
  new SlotsService(ctx);
  return ctx;
}

/** Объявить слот напрямую на корне — тем же приёмом, что ядро объявляет `root` (design.md, Решение 7). */
function declareSlot<Props, Kind extends 'single' | 'list' | 'keyed' | 'chain'>(
  ctx: Context,
  descriptor: SlotDescriptor<Props, Kind>,
  owner: string,
): Fiber & PromiseLike<Fiber> {
  return ctx.plugin({
    name: owner,
    apply(inner) {
      inner.provide(slotServiceName(descriptor.name), descriptor);
    },
  });
}

describe('slots: четыре вида композиции', () => {
  it('single: один вкладчик — отдаётся; до внесения — ничего', async () => {
    const ctx = freshCtx();
    const SINGLE = slot<ItemProps, 'single'>('single', 'single');
    await declareSlot(ctx, SINGLE, 'owner');

    assert.deepEqual(ctx.slots.getEntries(SINGLE.name), []);

    await ctx.plugin({
      name: 'a',
      apply(inner) {
        inner.slots.contribute(SINGLE, { component: Noop });
      },
    });
    await settle(ctx);

    const entries = ctx.slots.getEntries<ItemProps>(SINGLE.name);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.owner, 'a');
  });

  it('list: порядок — объявленный `order`, обратный порядку регистрации', async () => {
    const ctx = freshCtx();
    const LIST = slot<ItemProps, 'list'>('list', 'list');
    await declareSlot(ctx, LIST, 'owner');

    await ctx.plugin({ name: 'first', apply: (inner) => inner.slots.contribute(LIST, { component: Noop, order: 3 }) });
    await ctx.plugin({ name: 'second', apply: (inner) => inner.slots.contribute(LIST, { component: Noop, order: 2 }) });
    await ctx.plugin({ name: 'third', apply: (inner) => inner.slots.contribute(LIST, { component: Noop, order: 1 }) });
    await settle(ctx);

    const owners = ctx.slots.getEntries(LIST.name).map((entry) => entry.owner);
    assert.deepEqual(owners, ['third', 'second', 'first']);
  });

  it('list: при равном `order` — порядок регистрации, не порядок разрешения имени слота', async () => {
    const ctx = freshCtx();
    const LIST = slot<ItemProps, 'list'>('list', 'list');

    // Вкладчики зовутся раньше, чем слот объявлен: оба остаются в PENDING и
    // разрешаются одновременно, когда слот появляется, — порядок разрешения
    // здесь общий для обоих, и результат обязан всё равно идти по порядку
    // вызова `contribute()` (design.md, Решение 4).
    await ctx.plugin({ name: 'first', apply: (inner) => inner.slots.contribute(LIST, { component: Noop }) });
    await ctx.plugin({ name: 'second', apply: (inner) => inner.slots.contribute(LIST, { component: Noop }) });
    await declareSlot(ctx, LIST, 'owner');
    await settle(ctx);

    const owners = ctx.slots.getEntries(LIST.name).map((entry) => entry.owner);
    assert.deepEqual(owners, ['first', 'second']);
  });

  it('keyed: по ключу; неизвестный ключ — ничего', async () => {
    const ctx = freshCtx();
    const KEYED = slot<ItemProps, 'keyed'>('keyed', 'keyed');
    await declareSlot(ctx, KEYED, 'owner');

    await ctx.plugin({ name: 'runs', apply: (inner) => inner.slots.contribute(KEYED, { component: Noop, key: 'runs' }) });
    await ctx.plugin({ name: 'usage', apply: (inner) => inner.slots.contribute(KEYED, { component: Noop, key: 'usage' }) });
    await settle(ctx);

    const entries = ctx.slots.getEntries(KEYED.name);
    assert.deepEqual(
      entries.map((entry) => entry.key).sort(),
      ['runs', 'usage'],
    );
    assert.equal(entries.find((entry) => entry.key === 'runs')?.owner, 'runs');
    assert.equal(entries.find((entry) => entry.key === 'missing'), undefined);
  });

  it('chain: порядок вкладчиков — то же правило, что у `list`', async () => {
    const ctx = freshCtx();
    const CHAIN = slot<ItemProps, 'chain'>('chain', 'chain');
    await declareSlot(ctx, CHAIN, 'owner');

    await ctx.plugin({ name: 'outer', apply: (inner) => inner.slots.contribute(CHAIN, { component: Noop, order: 0 }) });
    await ctx.plugin({ name: 'inner', apply: (inner) => inner.slots.contribute(CHAIN, { component: Noop, order: 1 }) });
    await settle(ctx);

    const owners = ctx.slots.getEntries(CHAIN.name).map((entry) => entry.owner);
    assert.deepEqual(owners, ['outer', 'inner']);
  });
});

describe('slots: компонент и его дочерние слоты — один вызов', () => {
  it('дочерний слот существует, пока существует объявивший его вклад', async () => {
    const ctx = freshCtx();
    const ROOT = slot<ItemProps, 'single'>('root', 'single');
    const NAV = slot<ItemProps, 'list'>('nav', 'list');
    await declareSlot(ctx, ROOT, 'kernel');

    const shellFiber = await ctx.plugin({
      name: 'shell',
      apply(inner) {
        inner.slots.contribute(ROOT, { component: Noop, slots: [NAV] });
      },
    });
    await settle(ctx);
    assert.equal(ctx.slots.getEntries(ROOT.name).length, 1);

    await ctx.plugin({ name: 'item', apply: (inner) => inner.slots.contribute(NAV, { component: Noop }) });
    await settle(ctx);
    assert.deepEqual(
      ctx.slots.getEntries(NAV.name).map((entry) => entry.owner),
      ['item'],
    );

    // «Внести, снять, сравнить»: снятие вклада убирает и его дочерний слот, и
    // всё, что в него внесли, — состав возвращается к тому, каким был до
    // внесения (пустой `root`, `nav` недоступен никому).
    await shellFiber.dispose();
    await settle(ctx);
    assert.deepEqual(ctx.slots.getEntries(ROOT.name), []);
    assert.deepEqual(ctx.slots.getEntries(NAV.name), []);

    const stillWaiting = unresolvedFibers(await settle(ctx));
    assert.ok(
      stillWaiting.some((entry) => entry.plugin === 'item' && entry.missing.includes(slotServiceName('nav'))),
      'вкладчик дочернего слота остался ждать имя, которое исчезло вместе со снятой областью',
    );
  });

  it('снятие доходит до глубины: слот в слоте в слоте', async () => {
    const ctx = freshCtx();
    const ROOT = slot<ItemProps, 'single'>('root', 'single');
    const LEVEL1 = slot<ItemProps, 'single'>('level1', 'single');
    const LEVEL2 = slot<ItemProps, 'single'>('level2', 'single');
    await declareSlot(ctx, ROOT, 'kernel');

    const topFiber = await ctx.plugin({
      name: 'a',
      apply: (inner) => inner.slots.contribute(ROOT, { component: Noop, slots: [LEVEL1] }),
    });
    await ctx.plugin({
      name: 'b',
      apply: (inner) => inner.slots.contribute(LEVEL1, { component: Noop, slots: [LEVEL2] }),
    });
    await ctx.plugin({ name: 'c', apply: (inner) => inner.slots.contribute(LEVEL2, { component: Noop }) });
    await settle(ctx);

    assert.equal(ctx.slots.getEntries(ROOT.name).length, 1);
    assert.equal(ctx.slots.getEntries(LEVEL1.name).length, 1);
    assert.equal(ctx.slots.getEntries(LEVEL2.name).length, 1);

    await topFiber.dispose();
    await settle(ctx);

    assert.deepEqual(ctx.slots.getEntries(ROOT.name), []);
    assert.deepEqual(ctx.slots.getEntries(LEVEL1.name), []);
    assert.deepEqual(ctx.slots.getEntries(LEVEL2.name), []);
  });

  it('повторное внесение после снятия проходит без отказа', async () => {
    const ctx = freshCtx();
    const ROOT = slot<ItemProps, 'single'>('root', 'single');
    await declareSlot(ctx, ROOT, 'kernel');

    const first = await ctx.plugin({ name: 'a', apply: (inner) => inner.slots.contribute(ROOT, { component: Noop }) });
    await settle(ctx);
    await first.dispose();
    await settle(ctx);
    assert.deepEqual(ctx.slots.getEntries(ROOT.name), []);

    await ctx.plugin({ name: 'a2', apply: (inner) => inner.slots.contribute(ROOT, { component: Noop }) });
    await settle(ctx);
    assert.equal(ctx.slots.getEntries(ROOT.name).length, 1);
  });
});

describe('slots: отказы состава — не молча теряются', () => {
  it('второй вкладчик в `single` отвергнут, первый остаётся', async () => {
    const ctx = freshCtx();
    const SINGLE = slot<ItemProps, 'single'>('single', 'single');
    await declareSlot(ctx, SINGLE, 'owner');

    await ctx.plugin({ name: 'a', apply: (inner) => inner.slots.contribute(SINGLE, { component: Noop }) });
    await ctx.plugin({ name: 'b', apply: (inner) => inner.slots.contribute(SINGLE, { component: Noop }) });
    await settle(ctx);

    const entries = ctx.slots.getEntries(SINGLE.name);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.owner, 'a');

    const rejected = ctx.slots.getRejected();
    assert.equal(rejected.length, 1);
    assert.deepEqual(rejected[0], {
      reason: 'occupied',
      slotName: 'single',
      kind: 'single',
      key: undefined,
      owners: ['a', 'b'],
    });
  });

  it('повторный ключ в `keyed` отвергнут, называя слот, ключ и обоих претендентов', async () => {
    const ctx = freshCtx();
    const KEYED = slot<ItemProps, 'keyed'>('keyed', 'keyed');
    await declareSlot(ctx, KEYED, 'owner');

    await ctx.plugin({ name: 'a', apply: (inner) => inner.slots.contribute(KEYED, { component: Noop, key: 'runs' }) });
    await ctx.plugin({ name: 'b', apply: (inner) => inner.slots.contribute(KEYED, { component: Noop, key: 'runs' }) });
    await settle(ctx);

    const entries = ctx.slots.getEntries(KEYED.name);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.owner, 'a');

    const rejected = ctx.slots.getRejected();
    assert.equal(rejected.length, 1);
    assert.deepEqual(rejected[0], {
      reason: 'duplicate-key',
      slotName: 'keyed',
      kind: 'keyed',
      key: 'runs',
      owners: ['a', 'b'],
    });
  });

  it('вкладчик с другим видом в дескрипторе не меняет правило состава слота, а отвергается', async () => {
    const ctx = freshCtx();
    const SINGLE = slot<ItemProps, 'single'>('single', 'single');
    await declareSlot(ctx, SINGLE, 'owner');

    await ctx.plugin({ name: 'a', apply: (inner) => inner.slots.contribute(SINGLE, { component: Noop }) });
    // Тот же слот по имени, но дескриптор собран видом `list`: без сверки с
    // объявлением такой вклад молча превратил бы `single` в список — второй
    // вкладчик оказался бы принят, а на экране не появился бы и в отказах не
    // значился (требование `ui-kernel`: вид задаёт объявление слота, а
    // отвергнутый вклад не теряется молча).
    const LIAR = slot<ItemProps, 'list'>('single', 'list');
    await ctx.plugin({ name: 'liar', apply: (inner) => inner.slots.contribute(LIAR, { component: Noop }) });
    await settle(ctx);

    const entries = ctx.slots.getEntries(SINGLE.name);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.owner, 'a');

    const rejected = ctx.slots.getRejected();
    assert.equal(rejected.length, 1);
    assert.deepEqual(rejected[0], {
      reason: 'kind-mismatch',
      slotName: 'single',
      kind: 'single',
      contributedKind: 'list',
      owner: 'liar',
    });
  });

  it('отвергнутый расхождением вида вклад уходит из перечня вместе со своей областью', async () => {
    const ctx = freshCtx();
    const LIST = slot<ItemProps, 'list'>('list', 'list');
    await declareSlot(ctx, LIST, 'owner');

    const LIAR = slot<ItemProps, 'single'>('list', 'single');
    const fiber = await ctx.plugin({ name: 'liar', apply: (inner) => inner.slots.contribute(LIAR, { component: Noop }) });
    await settle(ctx);
    assert.equal(ctx.slots.getRejected().length, 1);

    await fiber.dispose();
    await settle(ctx);
    assert.deepEqual(ctx.slots.getRejected(), []);
  });

  it('вклад в необъявленный слот называется отказом, а не остаётся ожиданием', async () => {
    const ctx = freshCtx();
    const NOWHERE = slot<ItemProps, 'single'>('nowhere', 'single');

    await ctx.plugin({ name: 'orphan', apply: (inner) => inner.slots.contribute(NOWHERE, { component: Noop }) });
    const fibers = await settle(ctx);

    const unresolved = unresolvedFibers(fibers);
    assert.ok(
      unresolved.some((entry) => entry.plugin === 'orphan' && entry.missing.includes(slotServiceName('nowhere'))),
    );
  });

  it('вкладчик, загруженный раньше объявившего слот, принят без отказа', async () => {
    const ctx = freshCtx();
    const LATE = slot<ItemProps, 'single'>('late', 'single');

    await ctx.plugin({ name: 'early', apply: (inner) => inner.slots.contribute(LATE, { component: Noop }) });
    await declareSlot(ctx, LATE, 'owner');
    const fibers = await settle(ctx);

    assert.deepEqual(unresolvedFibers(fibers), []);
    assert.equal(ctx.slots.getEntries(LATE.name).length, 1);
  });
});

describe('slots: повторное объявление живого слота отказывает', () => {
  it('второй претендент отказывает, называя имя и обоих владельцев', async () => {
    const ctx = freshCtx();
    const DUP = slot<ItemProps, 'single'>('dup', 'single');
    await declareSlot(ctx, DUP, 'first');

    await assert.rejects(Promise.resolve(declareSlot(ctx, DUP, 'second')));

    const [failed] = failedFibers(await settle(ctx));
    assert.ok(failed, 'область второго претендента обязана остаться в FAILED');
    const error = await failed.await().catch((reason: unknown) => reason);
    const translated = translateSlotNameConflict(error, failed.name);
    assert.ok(translated);
    assert.equal(translated.conflict.slotName, 'dup');
    assert.deepEqual(translated.conflict.owners, ['first', 'second']);
  });

  it('освобождённое снятием объявившего имя достаётся следующему претенденту', async () => {
    const ctx = freshCtx();
    const DUP = slot<ItemProps, 'single'>('dup', 'single');
    const firstFiber = await declareSlot(ctx, DUP, 'first');

    await firstFiber.dispose();
    await settle(ctx);

    await assert.doesNotReject(Promise.resolve(declareSlot(ctx, DUP, 'second')));
  });
});

describe('slots: устойчивость снимка', () => {
  it('два чтения без изменения состава дают ту же ссылку', async () => {
    const ctx = freshCtx();
    const SINGLE = slot<ItemProps, 'single'>('single', 'single');
    await declareSlot(ctx, SINGLE, 'owner');
    await ctx.plugin({ name: 'a', apply: (inner) => inner.slots.contribute(SINGLE, { component: Noop }) });
    await settle(ctx);

    const first = ctx.slots.getEntries(SINGLE.name);
    const second = ctx.slots.getEntries(SINGLE.name);
    assert.equal(first, second);
  });

  it('снимок никогда не тронутого слота — тоже стабильная ссылка', () => {
    const ctx = freshCtx();
    const first = ctx.slots.getEntries('never-touched');
    const second = ctx.slots.getEntries('never-touched');
    assert.equal(first, second);
  });
});

describe('slots: устойчивое опознание вклада (hot-swap-preserves-data, Решение 4)', () => {
  it('снятие вклада, стоявшего раньше других, не меняет опознания оставшихся', async () => {
    const ctx = freshCtx();
    const LIST = slot<ItemProps, 'list'>('list', 'list');
    await declareSlot(ctx, LIST, 'owner');

    const first = await ctx.plugin({ name: 'a', apply: (inner) => inner.slots.contribute(LIST, { component: Noop }) });
    await ctx.plugin({ name: 'b', apply: (inner) => inner.slots.contribute(LIST, { component: Noop }) });
    await ctx.plugin({ name: 'c', apply: (inner) => inner.slots.contribute(LIST, { component: Noop }) });
    await settle(ctx);

    const before = ctx.slots.getEntries(LIST.name);
    assert.equal(before.length, 3);
    const [, bId, cId] = before.map((entry) => entry.id);

    await first.dispose();
    await settle(ctx);

    const after = ctx.slots.getEntries(LIST.name);
    assert.equal(after.length, 2);
    assert.deepEqual(
      after.map((entry) => entry.id),
      [bId, cId],
    );
  });

  it('два вклада одного владельца в один слот различимы опознанием', async () => {
    const ctx = freshCtx();
    const LIST = slot<ItemProps, 'list'>('list', 'list');
    await declareSlot(ctx, LIST, 'owner');

    await ctx.plugin({
      name: 'twice',
      apply(inner) {
        inner.slots.contribute(LIST, { component: Noop, order: 0 });
        inner.slots.contribute(LIST, { component: Noop, order: 1 });
      },
    });
    await settle(ctx);

    const entries = ctx.slots.getEntries(LIST.name);
    assert.equal(entries.length, 2);
    assert.notEqual(entries[0]!.id, entries[1]!.id);
  });

  it('снятый и внесённый заново вклад получает опознание, отличное от прежнего', async () => {
    const ctx = freshCtx();
    const SINGLE = slot<ItemProps, 'single'>('single', 'single');
    await declareSlot(ctx, SINGLE, 'owner');

    const first = await ctx.plugin({ name: 'a', apply: (inner) => inner.slots.contribute(SINGLE, { component: Noop }) });
    await settle(ctx);
    const firstId = ctx.slots.getEntries(SINGLE.name)[0]!.id;

    await first.dispose();
    await settle(ctx);
    await ctx.plugin({ name: 'a2', apply: (inner) => inner.slots.contribute(SINGLE, { component: Noop }) });
    await settle(ctx);

    const secondId = ctx.slots.getEntries(SINGLE.name)[0]!.id;
    assert.notEqual(firstId, secondId);
  });
});

describe('slots: окно замены — `batch()` (hot-swap-preserves-data, Решение 3)', () => {
  it('несколько add/remove внутри окна дают ровно одно уведомление', async () => {
    const ctx = freshCtx();
    const LIST = slot<ItemProps, 'list'>('list', 'list');
    await declareSlot(ctx, LIST, 'owner');

    let notifications = 0;
    ctx.slots.subscribe(() => (notifications += 1));

    await ctx.slots.batch(async () => {
      const a = await ctx.plugin({ name: 'a', apply: (inner) => inner.slots.contribute(LIST, { component: Noop }) });
      await settle(ctx);
      await a.dispose();
      await settle(ctx);
      await ctx.plugin({ name: 'b', apply: (inner) => inner.slots.contribute(LIST, { component: Noop }) });
      await settle(ctx);
    });

    assert.equal(notifications, 1);
  });

  it('окно с `await` внутри себя тоже даёт одно уведомление', async () => {
    const ctx = freshCtx();
    const SINGLE = slot<ItemProps, 'single'>('single', 'single');
    await declareSlot(ctx, SINGLE, 'owner');

    let notifications = 0;
    ctx.slots.subscribe(() => (notifications += 1));

    await ctx.slots.batch(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await ctx.plugin({ name: 'a', apply: (inner) => inner.slots.contribute(SINGLE, { component: Noop }) });
      await settle(ctx);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.equal(notifications, 1);
  });

  it('отказ внутри окна пробрасывается, а подписчик всё равно уведомлён', async () => {
    const ctx = freshCtx();
    const SINGLE = slot<ItemProps, 'single'>('single', 'single');
    await declareSlot(ctx, SINGLE, 'owner');

    let notifications = 0;
    ctx.slots.subscribe(() => (notifications += 1));

    await assert.rejects(
      ctx.slots.batch(async () => {
        await ctx.plugin({ name: 'a', apply: (inner) => inner.slots.contribute(SINGLE, { component: Noop }) });
        await settle(ctx);
        throw new Error('boom');
      }),
      /boom/,
    );

    assert.equal(notifications, 1);
  });

  it('вложенные окна не дают двух уведомлений', async () => {
    const ctx = freshCtx();
    const SINGLE = slot<ItemProps, 'single'>('single', 'single');
    await declareSlot(ctx, SINGLE, 'owner');

    let notifications = 0;
    ctx.slots.subscribe(() => (notifications += 1));

    await ctx.slots.batch(() =>
      ctx.slots.batch(async () => {
        await ctx.plugin({ name: 'a', apply: (inner) => inner.slots.contribute(SINGLE, { component: Noop }) });
        await settle(ctx);
      }),
    );

    assert.equal(notifications, 1);
  });
});
