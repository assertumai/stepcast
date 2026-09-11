import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Context } from 'cordis';

import { LiveService } from '../src/services/live';
import { fakeEventSources as fakeFactory } from './support/live';
import type { Overview } from '../src/api';

/**
 * Сервис `live` на подставном источнике событий (design.md
 * `cordis-kernel-browser`, Решение 10): события доходят до данных, смена
 * наблюдаемого адреса не плодит подписок, снятие области закрывает источник.
 * Сам подставной источник — в `ui/test/support/live.ts`: им пользуются и
 * тесты ядра, которое заводит `live` наравне с реестром слотов.
 */

const SAMPLE_OVERVIEW = { projects: [] } as unknown as Overview;

describe('live: события доходят до данных', () => {
  it('overview, backlog, widgets, run — каждое своим полем; состояние переходит в live', () => {
    const ctx = new Context();
    const { factory, sources } = fakeFactory();
    new LiveService(ctx, factory);

    sources[0]!.emit('overview', SAMPLE_OVERVIEW);
    assert.deepEqual(ctx.live.get().overview, SAMPLE_OVERVIEW);
    assert.equal(ctx.live.get().state, 'live');

    sources[0]!.emit('run', { status: 'running' });
    assert.deepEqual(ctx.live.get().snapshot, { status: 'running' });
  });

  it('ошибка источника переводит состояние в offline', () => {
    const ctx = new Context();
    const { factory, sources } = fakeFactory();
    new LiveService(ctx, factory);

    sources[0]!.emit('error', undefined);
    assert.equal(ctx.live.get().state, 'offline');
  });

  it('подписчики уведомляются при изменении данных', () => {
    const ctx = new Context();
    const { factory, sources } = fakeFactory();
    new LiveService(ctx, factory);

    let notified = 0;
    ctx.live.subscribe(() => {
      notified++;
    });
    sources[0]!.emit('overview', SAMPLE_OVERVIEW);
    assert.equal(notified, 1);
  });
});

describe('live: смена наблюдаемого адреса', () => {
  it('не плодит подписок — закрывает прежнюю, открывает ровно одну новую', () => {
    const ctx = new Context();
    const { factory, sources } = fakeFactory();
    new LiveService(ctx, factory);

    ctx.live.follow('proj/run-1');
    assert.equal(sources.length, 2);
    assert.equal(sources[0]!.closed, true);
    assert.match(sources[1]!.url, /run=proj%2Frun-1/);
    assert.equal(sources[1]!.closed, false);

    // Повторный `follow` тем же адресом не пересоздаёт подписку.
    ctx.live.follow('proj/run-1');
    assert.equal(sources.length, 2);
    assert.equal(sources[1]!.closed, false);
  });

  it('следит за новым адресом', () => {
    const ctx = new Context();
    const { factory, sources } = fakeFactory();
    new LiveService(ctx, factory);

    ctx.live.follow('proj/run-1');
    ctx.live.follow('proj/run-2');
    assert.equal(sources.length, 3);
    assert.equal(sources[1]!.closed, true);
    assert.match(sources[2]!.url, /run=proj%2Frun-2/);
  });

  it('сбрасывает снимок прогона и переходит в connecting — обзор и очередь переживают смену', () => {
    const ctx = new Context();
    const { factory, sources } = fakeFactory();
    new LiveService(ctx, factory);

    sources[0]!.emit('overview', SAMPLE_OVERVIEW);
    sources[0]!.emit('run', { status: 'running' });
    assert.notEqual(ctx.live.get().snapshot, undefined);

    ctx.live.follow('proj/run-1');
    assert.equal(ctx.live.get().snapshot, undefined);
    assert.equal(ctx.live.get().state, 'connecting');
    assert.deepEqual(ctx.live.get().overview, SAMPLE_OVERVIEW);
  });
});

describe('live: время жизни подписки', () => {
  it('снятие области закрывает источник', async () => {
    const ctx = new Context();
    const { factory, sources } = fakeFactory();

    const fiber = await ctx.plugin({
      name: 'holder',
      apply(inner) {
        new LiveService(inner, factory);
      },
    });
    assert.equal(sources[0]!.closed, false);

    await fiber.dispose();
    assert.equal(sources[0]!.closed, true);
  });
});
