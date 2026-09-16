import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { resolveConfig, type ResolvedConfig } from '../src/core/config/resolve.js';
import { introspect, isIntrospection } from '../src/core/plugins/introspect.js';
import { applyContextPlugin } from '../src/core/plugins/load.js';
import { loadPlugins } from '../src/parts/load.js';
import { BUILTIN_OWNER, createKernel } from '../src/core/plugins/kernel.js';
import { kernelFromRegistry } from '../src/core/plugins/registry.js';
import { declaredServices, requestedServices } from '../src/core/plugins/services.js';
import { tempDir } from './tmp.js';

interface Bed {
  readonly root: string;
  readonly home: string;
  readonly globalPath: string;
  readonly projectPath: string;
}

function bed(): Bed {
  const base = tempDir('introspect-');
  const root = join(base, 'work');
  const home = join(base, 'home');
  mkdirSync(join(root, '.stepcast'), { recursive: true });
  mkdirSync(join(home, '.stepcast'), { recursive: true });
  return {
    root,
    home,
    globalPath: join(home, '.stepcast', 'config.yml'),
    projectPath: join(root, '.stepcast', 'config.yml'),
  };
}

function resolved(place: Bed, project: string): ResolvedConfig {
  writeFileSync(place.projectPath, project);
  return resolveConfig({
    cwd: place.root,
    home: place.home,
    globalPath: place.globalPath,
    projectPath: place.projectPath,
  });
}

/**
 * Осмотр состава (`plugin-introspection`): обход объявленных и запрошенных
 * сервисов контекста (`services.ts`, design.md Решение 4, 5) на поднятом
 * вручную ядре, без загрузки плагинов с диска.
 */

describe('services: объявленные сервисы контекста', () => {
  it('сервис, объявленный плагинной областью, назван с её фибером; имя с префиксом slot: помечено слотом', async () => {
    const kernel = createKernel();
    const fiber = await applyContextPlugin(
      kernel,
      {
        name: 'provider',
        apply(ctx) {
          ctx.provide('plain-service');
          ctx.set('plain-service', {});
          ctx.provide('slot:widgets');
          ctx.set('slot:widgets', {});
        },
      },
      '<synthetic>',
    );

    const declared = declaredServices(kernel.ctx);
    const plain = declared.find((service) => service.name === 'plain-service');
    const slotted = declared.find((service) => service.name === 'slot:widgets');

    assert.ok(plain !== undefined);
    assert.equal(plain.fiber, fiber);
    assert.equal(plain.slot, false);

    assert.ok(slotted !== undefined);
    assert.equal(slotted.fiber, fiber);
    assert.equal(slotted.slot, true);
  });
});

describe('services: запрошенные сервисы области', () => {
  it('незакрытое внедрение показывает имя неразрешённым', async () => {
    const kernel = createKernel();
    const fiber = kernel.ctx.inject(['нет-такого-сервиса'], () => {});
    await kernel.settle();

    assert.deepEqual(requestedServices(fiber), [{ name: 'нет-такого-сервиса', resolved: false }]);
  });

  it('разрешённое внедрение показывает имя разрешённым', async () => {
    const kernel = createKernel();
    await applyContextPlugin(
      kernel,
      {
        name: 'provider',
        apply(ctx) {
          ctx.provide('svc');
          ctx.set('svc', {});
        },
      },
      '<a>',
    );
    const fiber = await applyContextPlugin(kernel, { name: 'consumer', inject: ['svc'], apply() {} }, '<b>');

    assert.deepEqual(requestedServices(fiber), [{ name: 'svc', resolved: true }]);
  });
});

describe('ContributionService: фибер владельца рядом с именем владельца', () => {
  it('вклад плагинной области отдаёт её фибер', async () => {
    const kernel = createKernel();
    const fiber = await applyContextPlugin(
      kernel,
      {
        name: 'contributor',
        inject: ['backends'],
        apply(ctx) {
          ctx.backends.register('from-plugin', { create: () => ({}) as never });
        },
      },
      '<synthetic>',
    );

    const entry = kernel.ctx.backends.entriesWithFiber().find((candidate) => candidate.name === 'from-plugin');
    assert.ok(entry !== undefined);
    assert.equal(entry.owner, 'contributor');
    assert.equal(entry.ownerFiber, fiber);
  });

  it('вклад на корневой области отдаёт корневой фибер и владельца «встроенный»', () => {
    const kernel = createKernel();
    kernel.ctx.backends.register('builtin-like', { create: () => ({}) as never });

    const entry = kernel.ctx.backends.entriesWithFiber().find((candidate) => candidate.name === 'builtin-like');
    assert.ok(entry !== undefined);
    assert.equal(entry.owner, BUILTIN_OWNER);
    assert.equal(entry.ownerFiber, kernel.ctx.fiber);
  });
});

describe('introspect: приписывание вклада строке дерева', () => {
  it('встроенная строка движка названа своим вкладом', async () => {
    const place = bed();
    const config = resolved(place, '');

    const { registry, outcomes } = await loadPlugins(config, { projectRoot: place.root });
    const model = introspect(outcomes, kernelFromRegistry(registry), 'cli');

    const backendRow = model.rows.find((row) => row.id === 'backend-claude');
    const stepRow = model.rows.find((row) => row.id === 'step-decision');
    assert.deepEqual(backendRow?.contributions.backends, ['claude']);
    assert.deepEqual(stepRow?.contributions.steps, ['decision']);
  });

  // Задача 7.4 (builtin-predicates-as-row): все десять встроенных предикатов
  // числятся за строкой `predicates`, а не за встроенным вне строк.
  it('строка predicates названа всеми десятью встроенными предикатами', async () => {
    const place = bed();
    const config = resolved(place, '');

    const { registry, outcomes } = await loadPlugins(config, { projectRoot: place.root });
    const model = introspect(outcomes, kernelFromRegistry(registry), 'cli');

    const predicatesRow = model.rows.find((row) => row.id === 'predicates');
    assert.deepEqual(
      [...(predicatesRow?.contributions.predicates ?? [])].sort(),
      ['changed_only', 'cmd', 'exit_code', 'file_exists', 'judge', 'knowledge_valid', 'matches', 'not_matches', 'schema', 'script'],
    );
  });

  it('замена встроенной строки патчем меняет автора вклада', async () => {
    const place = bed();
    writeFileSync(
      join(place.root, '.stepcast', 'replacement.mjs'),
      "export default { name: 'replacement', backends: { claude: { create: () => ({}) } } };\n",
    );
    writeFileSync(
      join(place.root, '.stepcast', 'plugins.patch.yml'),
      'version: 1\nkind: plugins-patch\nplugins:\n  - id: backend-claude\n    use: ./replacement.mjs\n',
    );
    const config = resolved(place, '');

    const { registry, outcomes } = await loadPlugins(config, { projectRoot: place.root });
    const model = introspect(outcomes, kernelFromRegistry(registry), 'cli');

    // Встроенная строка `backend-claude` больше не значится в дереве вовсе —
    // на её месте строка-замена с тем же `id`, и вклад `claude` теперь у неё.
    const rows = model.rows.filter((row) => row.id === 'backend-claude');
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]?.contributions.backends, ['claude']);
    assert.equal(rows[0]?.plugin?.name, 'replacement');
  });

  it('отключённая строка присутствует со своим состоянием и без вкладов', async () => {
    const place = bed();
    writeFileSync(
      join(place.root, '.stepcast', 'plugins.patch.yml'),
      'version: 1\nkind: plugins-patch\nplugins:\n  - id: backend-claude\n    use: stepcast:backend-claude\n    enabled: false\n',
    );
    const config = resolved(place, '');

    const { registry, outcomes } = await loadPlugins(config, { projectRoot: place.root });
    const model = introspect(outcomes, kernelFromRegistry(registry), 'cli');

    const row = model.rows.find((candidate) => candidate.id === 'backend-claude');
    assert.deepEqual(row?.state, { kind: 'disabled' });
    assert.deepEqual(row?.contributions, { backends: [], predicates: [], commands: [], steps: [] });
    assert.deepEqual(row?.declaredServices, []);
    assert.deepEqual(row?.requestedServices, []);
  });
});

describe('introspect: встроенное вне строк дерева', () => {
  it('поздний вклад корневой области показан встроенным владельцем и ни за одной строкой не числится', async () => {
    const place = bed();
    const config = resolved(place, '');

    const { registry, outcomes } = await loadPlugins(config, { projectRoot: place.root });
    const kernel = kernelFromRegistry(registry);
    // Регистрация на корне после того, как все строки применены, — граница
    // правила приписывания (design.md, Решение 2: «Граница правила названа
    // честно»). Сегодня таких вкладов движок не делает; осмотр обязан не
    // соврать, если появятся.
    kernel.ctx.backends.register('поздний', { create: () => ({}) as never });
    const model = introspect(outcomes, kernel, 'cli');

    assert.equal(model.builtin.owner, BUILTIN_OWNER);
    assert.ok(model.builtin.contributions.backends.includes('поздний'));
    for (const row of model.rows) {
      assert.ok(!row.contributions.backends.includes('поздний'), `строка ${row.id} присвоила чужой вклад`);
    }
  });

  it('вклады ядра, заведённые до первой строки, названы встроенными, а вклад строки остаётся за строкой', async () => {
    const place = bed();
    const config = resolved(place, '');

    const { registry, outcomes } = await loadPlugins(config, { projectRoot: place.root });
    const model = introspect(outcomes, kernelFromRegistry(registry), 'cli');

    // Четыре служебных сервиса заводятся `createKernelShell` до применения
    // первой строки; виды шага (`run`, `uses`, `script`, `agent`, `decision`)
    // с этого пункта вносят строки `step-*`, а не сборка ядра
    // (`builtin-step-kinds-as-rows`) — во встроенном вне строк их не осталось.
    assert.deepEqual(model.builtin.contributions.steps, []);
    assert.deepEqual(
      model.builtin.declaredServices.map((service) => service.name),
      ['backends', 'predicates', 'commands', 'steps'],
    );
    // `claude` и виды шага — вклады своих строк, и во встроенном вне строк их нет.
    assert.deepEqual(model.builtin.contributions.backends, []);
    // Встроенные предикаты — вклад строки `predicates` (`builtin-predicates-as-row`),
    // и во встроенном вне строк дерева их тоже не осталось.
    assert.deepEqual(model.builtin.contributions.predicates, []);
    for (const name of ['run', 'uses', 'script', 'agent', 'decision']) {
      const row = model.rows.find((candidate) => candidate.id === `step-${name}`);
      assert.deepEqual(row?.contributions.steps, [name]);
    }
  });

  // Задача 7.4 (builtin-step-kinds-as-rows): отключение строки вида шага
  // снимает её вклад из реестра, но не из дерева — строка остаётся видна
  // отключённой, а прочие виды шага не задеты (`plugin-tree`, Решение 5).
  it('отключённая строка вида шага снимает свой вклад из реестра, оставаясь видимой отключённой, прочие виды на месте', async () => {
    const place = bed();
    writeFileSync(
      join(place.root, '.stepcast', 'plugins.patch.yml'),
      'version: 1\nkind: plugins-patch\nplugins:\n  - id: step-script\n    use: stepcast:step-script\n    enabled: false\n',
    );
    const config = resolved(place, '');

    const { registry, outcomes } = await loadPlugins(config, { projectRoot: place.root });
    const model = introspect(outcomes, kernelFromRegistry(registry), 'cli');

    const row = model.rows.find((candidate) => candidate.id === 'step-script');
    assert.deepEqual(row?.state, { kind: 'disabled' });
    assert.deepEqual(row?.contributions, { backends: [], predicates: [], commands: [], steps: [] });
    assert.ok(!registry.steps.has('script'));
    for (const name of ['run', 'uses', 'agent', 'decision']) {
      assert.ok(registry.steps.has(name), `вид ${name} остался в реестре`);
    }
  });
});

describe('introspect: приписывание, которого не было', () => {
  it('итоги без областей дают названную причину, а не пустые перечни, выданные за состав', async () => {
    const place = bed();
    const config = resolved(place, '');

    const { registry, outcomes } = await loadPlugins(config, { projectRoot: place.root });
    // Итоги, выведенные из строк (путь готового реестра, `CommandEnv` без
    // `pluginOutcomes`): ни областей, ни окон применения.
    const withoutFibers = outcomes.map((outcome) => ({ row: outcome.row, status: outcome.status }));
    const model = introspect(withoutFibers, kernelFromRegistry(registry), 'cli', {
      attribution: { available: false, reason: 'реестр пришёл готовым' },
    });

    assert.deepEqual(model.attribution, { available: false, reason: 'реестр пришёл готовым' });
    for (const row of model.rows) assert.deepEqual(row.contributions.backends, []);
  });
});

describe('introspect: разбор чужого осмотра', () => {
  it('свой осмотр разбирается как осмотр, а неполная строка — нет', async () => {
    const place = bed();
    const config = resolved(place, '');
    const { registry, outcomes } = await loadPlugins(config, { projectRoot: place.root });
    const model = introspect(outcomes, kernelFromRegistry(registry), 'cli');

    // Через JSON — тем же путём, каким осмотр приходит команде от демона.
    assert.equal(isIntrospection(JSON.parse(JSON.stringify(model))), true);
    assert.equal(isIntrospection({ version: 1, surface: 'daemon', rows: [{ place: 1, id: 'a', use: 'b' }] }), false);
    assert.equal(isIntrospection({ ...model, builtin: undefined }), false);
    assert.equal(isIntrospection({ ...model, attribution: { available: false } }), false);
    assert.equal(isIntrospection(null), false);
  });
});
