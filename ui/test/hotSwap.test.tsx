import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Context } from 'cordis';
import type { ComponentType } from 'react';

import { createBrowserKernel, type BrowserKernel } from '../src/kernel';
import { slot, slotServiceName } from '../src/slots.ts';
import type { PluginModuleLoader } from '../src/services/plugins';
import { fakeEventSources } from './support/live';
import { fakeStyleSink } from './support/styles';

/**
 * Замена браузерного плагина как кадр витрины (design.md
 * `hot-swap-preserves-data`): граница владения, атомарность замены для
 * рендерера, каскад зависимых областей, состояния отказа новой редакции,
 * принадлежность стилей области строки.
 *
 * Ядро поднимается с подставными загрузчиком модулей и приёмником стилей
 * (`createBrowserKernel({ loadPluginModule, styleSink })`, design.md, Решение
 * 8) — замена проверяется без сети и без браузера. Состав строк сверяется
 * напрямую через `kernel.ctx.plugins.reconcile(...)`, а не через поток
 * событий: сама доставка состава через `live` — предмет `ui/test/kernel.test.tsx`
 * и `ui/src/services/live.ts`, здесь проверяется сверка и её следствия.
 */

const LIST = slot<Record<string, never>, 'list'>('list', 'list');

interface PluginModule {
  readonly default?: (ctx: Context) => void;
  /** Ошибка сборки, пришедшая исполняемым модулем, — то же имя экспорта, что у виджета (`src/ui/sharedModules.ts`). */
  readonly __stepcastWidgetError?: {
    readonly file: string;
    readonly line: number;
    readonly column: number;
    readonly text: string;
  };
  readonly __stepcastWidgetStyle?: string;
}

type ModuleProgram = PluginModule | (() => PluginModule | Promise<PluginModule>);

/** Загрузчик, управляемый тестом: программы по `id@version`, счётчик вызовов. */
function fakeLoader(): {
  readonly load: PluginModuleLoader;
  readonly calls: string[];
  readonly set: (id: string, version: string, module: ModuleProgram) => void;
  readonly fail: (id: string, version: string, reason: string) => void;
} {
  const calls: string[] = [];
  const programs = new Map<string, () => PluginModule | Promise<PluginModule>>();

  const load: PluginModuleLoader = async (id, version) => {
    const key = `${id}@${version}`;
    calls.push(key);
    const factory = programs.get(key);
    if (factory === undefined) throw new Error(`не задана программа для ${key}`);
    return await factory();
  };

  return {
    load,
    calls,
    set(id, version, module) {
      programs.set(`${id}@${version}`, typeof module === 'function' ? module : () => module);
    },
    fail(id, version, reason) {
      programs.set(`${id}@${version}`, () => {
        throw new Error(reason);
      });
    },
  };
}

/** Слот `LIST` объявляется самим ядром — тем же приёмом, каким оно объявляет `root` (`ui/src/kernel.ts`). */
function declareList(kernel: BrowserKernel): void {
  kernel.ctx.provide(slotServiceName(LIST.name), LIST);
}

function bootKernel(loader: ReturnType<typeof fakeLoader>, styles: ReturnType<typeof fakeStyleSink>): BrowserKernel {
  const kernel = createBrowserKernel({
    createEventSource: fakeEventSources().factory,
    loadPluginModule: loader.load,
    styleSink: styles.sink,
  });
  declareList(kernel);
  return kernel;
}

/** Компонент, вносящий себя в `LIST` — маркер для проверки каскада и соседства. */
function contributor(label: string): PluginModule {
  const Marker: ComponentType<Record<string, never>> = () => null;
  Marker.displayName = label;
  return {
    default: (ctx) => {
      ctx.slots.contribute(LIST, { component: Marker });
    },
  };
}

describe('hot-swap: подписка и данные переживают замену', () => {
  it('замена не открывает нового источника событий и не запрашивает данные за сетью', async () => {
    const { factory, sources } = fakeEventSources();
    const loader = fakeLoader();
    const styles = fakeStyleSink();
    const kernel = createBrowserKernel({ createEventSource: factory, loadPluginModule: loader.load, styleSink: styles.sink });
    declareList(kernel);

    let fetchCalls = 0;
    const previousFetch = (globalThis as { fetch?: unknown }).fetch;
    (globalThis as { fetch?: unknown }).fetch = async () => {
      fetchCalls += 1;
      throw new Error('замена не должна ходить в сеть');
    };

    try {
      loader.set('a', '1', contributor('a-v1'));
      await kernel.ctx.plugins.reconcile([{ id: 'a', version: '1' }]);
      await kernel.settle();
      assert.equal(sources.length, 1);

      loader.set('a', '2', contributor('a-v2'));
      await kernel.ctx.plugins.reconcile([{ id: 'a', version: '2' }]);
      await kernel.settle();

      assert.equal(sources.length, 1, 'замена не открыла второго источника событий');
      assert.equal(sources[0]!.closed, false, 'прежний источник не закрыт заменой строки');
      assert.equal(fetchCalls, 0, 'замена не должна была отправить ни одного запроса');
    } finally {
      (globalThis as { fetch?: unknown }).fetch = previousFetch;
    }
  });
});

describe('hot-swap: своё уходит вместе со строкой', () => {
  it('сервис, заведённый строкой, снимается заменой — новая редакция получает свежий, а не унаследованный', async () => {
    const loader = fakeLoader();
    const styles = fakeStyleSink();
    const kernel = bootKernel(loader, styles);

    // `ctx.provide` регистрирует значение на области вызвавшего фибера и само
    // снимает его при снятии этой области (design.md, комментарий у
    // `SlotsService.contribute`) — тем же приёмом, каким слот несёт свои
    // дочерние объявления.
    function ownService(count: number): PluginModule {
      return { default: (ctx) => ctx.provide('own-service', { count }) };
    }

    type WithOwnService = { readonly 'own-service'?: { readonly count: number } };

    loader.set('a', '1', ownService(1));
    await kernel.ctx.plugins.reconcile([{ id: 'a', version: '1' }]);
    await kernel.settle();
    const first = (kernel.ctx as unknown as WithOwnService)['own-service'];
    assert.equal(first?.count, 1);

    loader.set('a', '2', ownService(2));
    await kernel.ctx.plugins.reconcile([{ id: 'a', version: '2' }]);
    await kernel.settle();

    // Действующий сервис — заведён заново новой редакцией, не унаследован от
    // старой: другое значение и другой объект, а не тот же, с которого читали.
    const second = (kernel.ctx as unknown as WithOwnService)['own-service'];
    assert.equal(second?.count, 2);
    assert.notEqual(second, first);
  });
});

describe('hot-swap: соседняя строка не тронута', () => {
  /**
   * Вкладчик, считающий применения своей области и её снятия. Опознание вклада
   * отличает «состав тот же» от «состав другой», но не отличило бы соседа,
   * снятого и применённого заново вместе с тем же вкладом, от нетронутого, —
   * счётчики отвечают ровно на этот вопрос («область второй не снималась и не
   * применялась заново», спека `ui-hot-swap`).
   */
  function counted(label: string, counts: { applied: number; disposed: number }): PluginModule {
    const Marker: ComponentType<Record<string, never>> = () => null;
    Marker.displayName = label;
    return {
      default: (ctx) => {
        counts.applied += 1;
        ctx.effect(() => () => {
          counts.disposed += 1;
        }, `counter(${label})`);
        ctx.slots.contribute(LIST, { component: Marker });
      },
    };
  }

  it('область соседа не снималась и не применялась заново, опознание её вкладов не изменилось, уведомление реестра одно', async () => {
    const loader = fakeLoader();
    const styles = fakeStyleSink();
    const kernel = bootKernel(loader, styles);
    const neighbour = { applied: 0, disposed: 0 };

    loader.set('a', '1', contributor('a-v1'));
    loader.set('b', '1', counted('b', neighbour));
    await kernel.ctx.plugins.reconcile([
      { id: 'a', version: '1' },
      { id: 'b', version: '1' },
    ]);
    await kernel.settle();
    assert.deepEqual(neighbour, { applied: 1, disposed: 0 });

    const before = kernel.ctx.slots.getEntries(LIST.name);
    assert.equal(before.length, 2);
    const bBefore = before.find((entry) => (entry.component as { displayName?: string }).displayName === 'b');
    assert.ok(bBefore !== undefined);

    let notifications = 0;
    kernel.ctx.slots.subscribe(() => (notifications += 1));

    loader.set('a', '2', contributor('a-v2'));
    await kernel.ctx.plugins.reconcile([
      { id: 'a', version: '2' },
      { id: 'b', version: '1' },
    ]);
    await kernel.settle();

    assert.equal(notifications, 1, 'замена строки `a` обязана дать ровно одно уведомление реестра');

    const after = kernel.ctx.slots.getEntries(LIST.name);
    assert.equal(after.length, 2);
    const bAfter = after.find((entry) => (entry.component as { displayName?: string }).displayName === 'b');
    assert.equal(bAfter?.id, bBefore?.id, 'опознание вклада соседней строки не должно было измениться');
    assert.deepEqual(neighbour, { applied: 1, disposed: 0 }, 'область соседа не снималась и не применялась заново');
  });
});

describe('hot-swap: каскад зависимых областей', () => {
  // `apply` — тело эффекта фибера, и cordis разбирает его ВОЗВРАЩЁННОЕ
  // значение как сам эффект (`Fiber._execute`, node_modules/cordis):
  // `ctx.inject(...)` отдаёт `Fiber & PromiseLike<Fiber>`, и вернуть его
  // напрямую из `apply` значило бы отдать cordis фибер вместо disposer'а —
  // «Invalid effect» после того, как `inject` разрешится. Поэтому `inject`/
  // `provide` здесь — операторы тела, а не хвостовое выражение стрелочной
  // функции (та же форма, что и `SlotsService.contribute`, у которой нет
  // `return` перед `this.ctx.inject(...)`).
  function provider(name: string): PluginModule {
    return {
      default: (ctx) => {
        ctx.provide(name, {});
      },
    };
  }

  function middle(waitFor: string, provides: string, label: string): PluginModule {
    const Marker: ComponentType<Record<string, never>> = () => null;
    Marker.displayName = label;
    return {
      default: (ctx) => {
        ctx.inject([waitFor], (inner) => {
          inner.provide(provides, {});
          inner.slots.contribute(LIST, { component: Marker });
        });
      },
    };
  }

  function leaf(waitFor: string, label: string): PluginModule {
    const Marker: ComponentType<Record<string, never>> = () => null;
    Marker.displayName = label;
    return {
      default: (ctx) => {
        ctx.inject([waitFor], (inner) => {
          inner.slots.contribute(LIST, { component: Marker });
        });
      },
    };
  }

  it('зависимый оживает сам, когда новая редакция снова объявляет тот же сервис', async () => {
    const loader = fakeLoader();
    const styles = fakeStyleSink();
    const kernel = bootKernel(loader, styles);

    loader.set('provider', '1', provider('svc'));
    loader.set('dependent', '1', leaf('svc', 'dependent'));
    await kernel.ctx.plugins.reconcile([
      { id: 'provider', version: '1' },
      { id: 'dependent', version: '1' },
    ]);
    await kernel.settle();
    assert.equal(kernel.ctx.slots.getEntries(LIST.name).length, 1);

    loader.set('provider', '2', provider('svc'));
    await kernel.ctx.plugins.reconcile([
      { id: 'provider', version: '2' },
      { id: 'dependent', version: '1' },
    ]);
    const diagnostics = await kernel.settle();

    // Заменяющая строка (`provider`) ни разу не назвала `dependent` — cordis
    // сам снял и заново применил зависимую область (design.md, Решение 5).
    const entries = kernel.ctx.slots.getEntries(LIST.name);
    assert.equal(entries.length, 1);
    assert.deepEqual(
      diagnostics.filter((d) => d.kind === 'unresolved'),
      [],
    );
  });

  it('каскад идёт до глубины: цепочка из трёх зависимостей перезапущена целиком', async () => {
    const loader = fakeLoader();
    const styles = fakeStyleSink();
    const kernel = bootKernel(loader, styles);

    loader.set('a', '1', provider('svc-a'));
    loader.set('b', '1', middle('svc-a', 'svc-b', 'b'));
    loader.set('c', '1', leaf('svc-b', 'c'));
    await kernel.ctx.plugins.reconcile([
      { id: 'a', version: '1' },
      { id: 'b', version: '1' },
      { id: 'c', version: '1' },
    ]);
    await kernel.settle();
    assert.equal(kernel.ctx.slots.getEntries(LIST.name).length, 2);
    const before = kernel.ctx.slots.getEntries(LIST.name).map((entry) => entry.id);

    loader.set('a', '2', provider('svc-a'));
    await kernel.ctx.plugins.reconcile([
      { id: 'a', version: '2' },
      { id: 'b', version: '1' },
      { id: 'c', version: '1' },
    ]);
    await kernel.settle();

    const after = kernel.ctx.slots.getEntries(LIST.name);
    assert.equal(after.length, 2, 'цепочка обязана была перезапуститься целиком, а не остаться снятой');
    // Перезапуск — новые области, значит и новое опознание вкладов.
    assert.notDeepEqual(after.map((entry) => entry.id), before);
  });

  it('новая редакция, не объявившая сервис, оставляет зависимых снятыми и названными в отказах', async () => {
    const loader = fakeLoader();
    const styles = fakeStyleSink();
    const kernel = bootKernel(loader, styles);

    loader.set('a', '1', provider('svc-a'));
    loader.set('b', '1', middle('svc-a', 'svc-b', 'b'));
    loader.set('c', '1', leaf('svc-b', 'c'));
    await kernel.ctx.plugins.reconcile([
      { id: 'a', version: '1' },
      { id: 'b', version: '1' },
      { id: 'c', version: '1' },
    ]);
    await kernel.settle();

    // Вторая редакция `a` больше не объявляет `svc-a`.
    loader.set('a', '2', { default: () => undefined });
    await kernel.ctx.plugins.reconcile([
      { id: 'a', version: '2' },
      { id: 'b', version: '1' },
      { id: 'c', version: '1' },
    ]);
    const diagnostics = await kernel.settle();

    assert.deepEqual(kernel.ctx.slots.getEntries(LIST.name), []);
    const unresolved = diagnostics.filter((d) => d.kind === 'unresolved');
    assert.ok(unresolved.some((d) => d.plugin === 'b' && d.slot?.includes('svc-a')));
    assert.ok(unresolved.some((d) => d.plugin === 'c' && d.slot?.includes('svc-b')));
  });
});

describe('hot-swap: отказы замены', () => {
  it('отказ загрузки новой редакции оставляет прежнюю работать, называя причину и обе версии', async () => {
    const loader = fakeLoader();
    const styles = fakeStyleSink();
    const kernel = bootKernel(loader, styles);

    loader.set('a', '1', contributor('a-v1'));
    await kernel.ctx.plugins.reconcile([{ id: 'a', version: '1' }]);
    await kernel.settle();
    assert.equal(kernel.ctx.slots.getEntries(LIST.name).length, 1);

    loader.fail('a', '2', 'сеть недоступна');
    await kernel.ctx.plugins.reconcile([{ id: 'a', version: '2' }]);
    const diagnostics = await kernel.settle();

    // Прежняя редакция по-прежнему на странице.
    assert.equal(kernel.ctx.slots.getEntries(LIST.name).length, 1);
    const failed = diagnostics.find((d) => d.plugin === 'a');
    assert.ok(failed, 'отказ обязан быть назван в диагностиках');
    assert.match(failed!.message, /сеть недоступна/);
    assert.match(failed!.message, /1/);
    assert.match(failed!.message, /2/);
  });

  it('модуль ошибки сборки не применяется пустым: прежняя редакция работает, причина названа местом и текстом', async () => {
    const loader = fakeLoader();
    const styles = fakeStyleSink();
    const kernel = bootKernel(loader, styles);

    loader.set('a', '1', contributor('a-v1'));
    await kernel.ctx.plugins.reconcile([{ id: 'a', version: '1' }]);
    await kernel.settle();

    // Демон отдаёт ошибку сборки тем же 200 и исполняемым модулем
    // (`errorModuleText`, `src/ui/widgets.ts`): `import()` не бросает, и без
    // чтения этого экспорта сломанная половина применилась бы как пустая —
    // молча, без единой строки в диагностиках.
    loader.set('a', '2', {
      __stepcastWidgetError: { file: '/plugins/a/index.tsx', line: 3, column: 5, text: 'Expected identifier' },
    });
    await kernel.ctx.plugins.reconcile([{ id: 'a', version: '2' }]);
    const diagnostics = await kernel.settle();

    assert.equal(kernel.ctx.slots.getEntries(LIST.name).length, 1, 'прежняя редакция обязана остаться на странице');
    const failed = diagnostics.find((d) => d.plugin === 'a');
    assert.ok(failed, 'ошибка сборки обязана быть названа, а не применена пустой');
    assert.match(failed!.message, /Expected identifier/);
    assert.match(failed!.message, /index\.tsx:3:5/);
    assert.match(failed!.message, /работает прежняя 1/);
  });

  it('половина без экспорта по умолчанию не применяется пустой, а называется отказом', async () => {
    const loader = fakeLoader();
    const styles = fakeStyleSink();
    const kernel = bootKernel(loader, styles);

    loader.set('a', '1', contributor('a-v1'));
    await kernel.ctx.plugins.reconcile([{ id: 'a', version: '1' }]);
    await kernel.settle();

    loader.set('a', '2', {});
    await kernel.ctx.plugins.reconcile([{ id: 'a', version: '2' }]);
    const diagnostics = await kernel.settle();

    assert.equal(kernel.ctx.slots.getEntries(LIST.name).length, 1);
    const failed = diagnostics.find((d) => d.plugin === 'a');
    assert.ok(failed);
    assert.match(failed!.message, /не экспортирует применение по умолчанию/);
  });

  it('отказ замены уведомляет подписчика ядра — полоса диагностик узнаёт о нём, а не один `console.error`', async () => {
    const loader = fakeLoader();
    const styles = fakeStyleSink();
    const kernel = bootKernel(loader, styles);

    loader.set('a', '1', contributor('a-v1'));
    await kernel.ctx.plugins.reconcile([{ id: 'a', version: '1' }]);
    await kernel.settle();

    // Состав приходит потоком уже после монтирования страницы, и отказ
    // замены случается позже любого эффекта монтирования: без этой подписки
    // `KernelRoot` (`ui/src/slots.tsx`) не пересобрал бы диагностики вовсе.
    let notified = 0;
    const unsubscribe = kernel.subscribe(() => {
      notified += 1;
    });

    loader.fail('a', '2', 'сеть недоступна');
    await kernel.ctx.plugins.reconcile([{ id: 'a', version: '2' }]);

    assert.ok(notified > 0, 'отказ замены обязан уведомить подписчика ядра');
    const diagnostics = await kernel.settle();
    assert.ok(diagnostics.some((d) => d.plugin === 'a' && /сеть недоступна/.test(d.message)));

    unsubscribe();
    notified = 0;
    loader.set('a', '3', contributor('a-v3'));
    await kernel.ctx.plugins.reconcile([{ id: 'a', version: '3' }]);
    assert.equal(notified, 0, 'отписка обязана снимать уведомления');
  });

  it('отказ применения оставляет строку без вкладов, прежняя редакция не применяется заново', async () => {
    const loader = fakeLoader();
    const styles = fakeStyleSink();
    const kernel = bootKernel(loader, styles);

    loader.set('a', '1', contributor('a-v1'));
    await kernel.ctx.plugins.reconcile([{ id: 'a', version: '1' }]);
    await kernel.settle();

    loader.set('a', '2', {
      default: () => {
        throw new Error('редакция сломана');
      },
    });
    await kernel.ctx.plugins.reconcile([{ id: 'a', version: '2' }]);
    const diagnostics = await kernel.settle();

    assert.deepEqual(kernel.ctx.slots.getEntries(LIST.name), [], 'ни прежних, ни новых вкладов быть не должно');
    const failed = diagnostics.find((d) => d.plugin === 'a');
    assert.ok(failed);
    assert.match(failed!.message, /редакция сломана/);
  });

  it('отказ одной строки не мешает замене другой, следующая версия снимает состояние отказа', async () => {
    const loader = fakeLoader();
    const styles = fakeStyleSink();
    const kernel = bootKernel(loader, styles);

    loader.set('a', '1', contributor('a-v1'));
    loader.set('b', '1', contributor('b-v1'));
    await kernel.ctx.plugins.reconcile([
      { id: 'a', version: '1' },
      { id: 'b', version: '1' },
    ]);
    await kernel.settle();

    loader.fail('a', '2', 'бум');
    loader.set('b', '2', contributor('b-v2'));
    await kernel.ctx.plugins.reconcile([
      { id: 'a', version: '2' },
      { id: 'b', version: '2' },
    ]);
    let diagnostics = await kernel.settle();
    assert.ok(diagnostics.some((d) => d.plugin === 'a'));
    assert.equal(kernel.ctx.slots.getEntries(LIST.name).length, 2, 'строка `b` обязана была смениться, несмотря на отказ `a`');

    loader.set('a', '3', contributor('a-v3'));
    await kernel.ctx.plugins.reconcile([
      { id: 'a', version: '3' },
      { id: 'b', version: '2' },
    ]);
    diagnostics = await kernel.settle();
    assert.equal(
      diagnostics.some((d) => d.plugin === 'a'),
      false,
      'исправленная редакция обязана снять состояние отказа',
    );
    assert.equal(kernel.ctx.slots.getEntries(LIST.name).length, 2);
  });
});

describe('hot-swap: стили принадлежат области строки', () => {
  function withStyle(css: string, label: string): PluginModule {
    const Marker: ComponentType<Record<string, never>> = () => null;
    Marker.displayName = label;
    return {
      default: (ctx) => ctx.slots.contribute(LIST, { component: Marker }),
      __stepcastWidgetStyle: css,
    };
  }

  it('стили сняты вместе со строкой, три замены подряд не копят их', async () => {
    const loader = fakeLoader();
    const styles = fakeStyleSink();
    const kernel = bootKernel(loader, styles);

    loader.set('a', '1', withStyle('.v1{color:red}', 'a-v1'));
    await kernel.ctx.plugins.reconcile([{ id: 'a', version: '1' }]);
    await kernel.settle();
    assert.equal(styles.active().length, 1);
    assert.equal(styles.active()[0]!.css, '.v1{color:red}');

    loader.set('a', '2', withStyle('.v2{color:blue}', 'a-v2'));
    await kernel.ctx.plugins.reconcile([{ id: 'a', version: '2' }]);
    await kernel.settle();
    assert.equal(styles.active().length, 1, 'действующей обязана остаться ровно одна редакция стилей');
    assert.equal(styles.active()[0]!.css, '.v2{color:blue}');

    loader.set('a', '3', withStyle('.v3{color:green}', 'a-v3'));
    await kernel.ctx.plugins.reconcile([{ id: 'a', version: '3' }]);
    await kernel.settle();
    assert.equal(styles.active().length, 1);
    assert.equal(styles.active()[0]!.css, '.v3{color:green}');
    assert.equal(styles.applied.length, 3, 'три постановки — по одной на редакцию');
    assert.equal(styles.removed.length, 2, 'две сняты вместе с прежними редакциями');
  });

  it('снятие ядра целиком уносит стили строк вместе с их областями', async () => {
    const loader = fakeLoader();
    const styles = fakeStyleSink();
    const kernel = bootKernel(loader, styles);

    loader.set('a', '1', withStyle('.v1{color:red}', 'a-v1'));
    await kernel.ctx.plugins.reconcile([{ id: 'a', version: '1' }]);
    await kernel.settle();
    assert.equal(styles.active().length, 1);

    // Стиль — эффект области строки, а не запись рядом с ней: снимается тем
    // же, чем снимается область. Иначе `dispose()` унёс бы область, оставив
    // правила в документе, и проверить это можно только снятием ядра — своя
    // замена сняла бы их и так.
    await kernel.dispose();
    assert.deepEqual(styles.active(), []);
  });

  it('строка без стилей не оставляет их, снятие строки убирает действующий стиль', async () => {
    const loader = fakeLoader();
    const styles = fakeStyleSink();
    const kernel = bootKernel(loader, styles);

    loader.set('a', '1', withStyle('.v1{color:red}', 'a-v1'));
    await kernel.ctx.plugins.reconcile([{ id: 'a', version: '1' }]);
    await kernel.settle();
    assert.equal(styles.active().length, 1);

    await kernel.ctx.plugins.reconcile([]);
    await kernel.settle();
    assert.deepEqual(styles.active(), []);
  });
});

describe('hot-swap: строка, исчезнувшая из состава', () => {
  it('строка, снятая составом раньше, чем её импорт успел завершиться, на странице не остаётся', async () => {
    const loader = fakeLoader();
    const styles = fakeStyleSink();
    const kernel = bootKernel(loader, styles);

    // Импорт идёт по сети десятки миллисекунд, а сверки запускаются потоком
    // событий и друг друга не ждут: состав «строка появилась» и состав «строки
    // нет» приходят двумя событиями подряд. Снятие обязано ставиться по
    // ЖЕЛАЕМОМУ составу, а не по уже применённым строкам, — иначе вторая
    // сверка не нашла бы строку вовсе, а первая применила бы её после и
    // навсегда.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    loader.set('a', '1', async () => {
      await gate;
      return contributor('a');
    });

    const appearing = kernel.ctx.plugins.reconcile([{ id: 'a', version: '1' }]);
    const vanishing = kernel.ctx.plugins.reconcile([]);
    release();
    await appearing;
    await vanishing;
    await kernel.settle();

    assert.deepEqual(kernel.ctx.slots.getEntries(LIST.name), []);
  });

  it('снята, её вкладов в слотах не осталось', async () => {
    const loader = fakeLoader();
    const styles = fakeStyleSink();
    const kernel = bootKernel(loader, styles);

    loader.set('a', '1', contributor('a'));
    loader.set('b', '1', contributor('b'));
    await kernel.ctx.plugins.reconcile([
      { id: 'a', version: '1' },
      { id: 'b', version: '1' },
    ]);
    await kernel.settle();
    assert.equal(kernel.ctx.slots.getEntries(LIST.name).length, 2);

    await kernel.ctx.plugins.reconcile([{ id: 'b', version: '1' }]);
    await kernel.settle();

    const remaining = kernel.ctx.slots.getEntries(LIST.name);
    assert.equal(remaining.length, 1);
    assert.equal((remaining[0]!.component as { displayName?: string }).displayName, 'b');
  });
});
