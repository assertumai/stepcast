import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FiberState, Service } from 'cordis';

import { ExitCode, StepcastError } from '../src/core/errors.js';
import { BUILTIN_PREDICATE_NAMES, createBuiltinKernel } from '../src/core/plugins/builtin.js';
import type {
  BackendContribution,
  CommandContribution,
  PredicateContribution,
} from '../src/core/plugins/contract.js';
import {
  applyContextPlugin,
  applyDeclarativePlugin,
  loadPlugins,
} from '../src/core/plugins/load.js';
import { ContributionService, createKernel } from '../src/core/plugins/kernel.js';
import { availableNames, predicateNames, registryFromKernel } from '../src/core/plugins/registry.js';
import { resolveWithPlugins } from '../src/core/plugins/resolve.js';
import { resolveConfig, type ResolvedConfig } from '../src/core/config/resolve.js';
import { run as runCli } from '../src/cli/main.js';
import type { CliIo } from '../src/cli/args.js';
import { makeProject, withHome } from './helpers.js';
import { tempDir } from './tmp.js';

/**
 * Ядро как контекст (openspec/changes/cordis-kernel-daemon, tasks.md, раздел
 * 2): служебные сервисы, обратимость регистрации, две формы плагина,
 * неудовлетворённое внедрение, наполовину загруженный плагин.
 */

function backend(): BackendContribution {
  return { create: () => ({}) as never };
}

function predicate(name: string): PredicateContribution {
  return {
    name,
    schema: { type: 'string' },
    evaluate: () => ({ predicate: name, passed: true, hard: true }),
  };
}

function command(name: string): CommandContribution {
  return {
    name,
    spec: { description: name },
    run: () => ExitCode.ok,
  };
}

interface Bed {
  readonly root: string;
  readonly home: string;
  readonly globalPath: string;
  readonly projectPath: string;
}

function bed(): Bed {
  const base = tempDir('kernel-');
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

function writeModule(path: string, body: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
}

describe('plugin-kernel: свежее ядро', () => {
  it('несёт три служебных сервиса, встроенный бэкенд зарегистрирован, встроенные предикаты зарезервированы', () => {
    const kernel = createBuiltinKernel();

    assert.ok(kernel.ctx.backends instanceof ContributionService);
    assert.ok(kernel.ctx.predicates instanceof ContributionService);
    assert.ok(kernel.ctx.commands instanceof ContributionService);
    assert.deepEqual([...kernel.ctx.backends.contributions.keys()], ['claude']);
    assert.deepEqual([...kernel.ctx.predicates.reserved].sort(), [...BUILTIN_PREDICATE_NAMES].sort());
    assert.deepEqual([...kernel.ctx.predicates.contributions.keys()], []);
  });
});

describe('plugin-kernel: обратимость регистрации', () => {
  it('disposer, возвращённый register, снимает один вклад, не трогая соседей', () => {
    const kernel = createKernel();
    const disposeA = kernel.ctx.backends.register('a', backend());
    kernel.ctx.backends.register('b', backend());

    disposeA();

    assert.deepEqual([...kernel.ctx.backends.contributions.keys()], ['b']);
  });

  it('снятие области плагина снимает все три вида его вкладов разом', async () => {
    const kernel = createKernel();
    const fiber = await applyContextPlugin(
      kernel,
      {
        name: 'multi',
        inject: ['backends', 'predicates', 'commands'],
        apply(ctx) {
          ctx.backends.register('b', backend());
          ctx.predicates.register('p', predicate('p'));
          ctx.commands.register('c', command('c'));
        },
      },
      '<synthetic>',
    );

    assert.equal(kernel.ctx.backends.contributions.size, 1);
    assert.equal(kernel.ctx.predicates.contributions.size, 1);
    assert.equal(kernel.ctx.commands.contributions.size, 1);

    await fiber.dispose();

    assert.equal(kernel.ctx.backends.contributions.size, 0);
    assert.equal(kernel.ctx.predicates.contributions.size, 0);
    assert.equal(kernel.ctx.commands.contributions.size, 0);
  });
});

describe('plugin-kernel: загрузить, выгрузить — следов нет', () => {
  it('состав вкладов, перечень плагинов и авторство совпадают с состоянием до загрузки; имя освобождается; плагин грузится заново', async () => {
    const kernel = createBuiltinKernel();
    const registry = registryFromKernel(kernel);

    const before = {
      backends: availableNames(registry, 'backends'),
      predicates: predicateNames(registry),
      commands: availableNames(registry, 'commands'),
      plugins: [...registry.plugins],
      owners: [...registry.owners],
    };

    const plugin = {
      name: 'temporary',
      backends: { temp: backend() },
      predicates: [predicate('temp_ok')],
      commands: [command('temp-cmd')],
    };

    const fiber = await applyDeclarativePlugin(kernel, plugin, '<synthetic-1>');
    assert.deepEqual(availableNames(registry, 'backends'), ['claude', 'temp']);
    assert.equal(registry.plugins.length, 1);

    await fiber.dispose();

    assert.deepEqual(availableNames(registry, 'backends'), before.backends);
    assert.deepEqual(predicateNames(registry), before.predicates);
    assert.deepEqual(availableNames(registry, 'commands'), before.commands);
    assert.deepEqual([...registry.plugins], before.plugins);
    assert.deepEqual([...registry.owners], before.owners);

    // Освобождённое имя достаётся следующему плагину без отказа по конфликту.
    const other = { name: 'other', backends: { temp: backend() } };
    const otherFiber = await applyDeclarativePlugin(kernel, other, '<synthetic-2>');
    assert.ok(registry.backends.has('temp'));
    await otherFiber.dispose();

    // Снятый плагин загружается заново без отказа.
    await applyDeclarativePlugin(kernel, plugin, '<synthetic-1-again>');
    assert.ok(registry.commands.has('temp-cmd'));
  });
});

describe('plugin-kernel: имена ядра заняты', () => {
  for (const name of ['backends', 'predicates', 'commands']) {
    it(`плагин, объявляющий сервис ${name}, получает отказ, называющий имя и принадлежность ядру`, async () => {
      const kernel = createKernel();

      await assert.rejects(
        () =>
          applyContextPlugin(
            kernel,
            {
              name: 'greedy',
              apply(ctx) {
                const dispose = ctx.provide(name);
                ctx.set(name, {});
                return dispose;
              },
            },
            '<synthetic>',
          ),
        (error: unknown) => {
          assert.ok(error instanceof StepcastError);
          assert.match(error.message, new RegExp(name));
          assert.match(error.message, /ядру/);
          return true;
        },
      );
    });
  }
});

describe('plugin-kernel: резерв встроенных имён принадлежит ядру', () => {
  it('сервис предикатов не даёт плагину занять имя несъёмным резервом', async () => {
    const kernel = createBuiltinKernel();

    // Резерв — не метод сервиса: сервис виден плагину как `ctx.predicates`, и
    // публичный `reserve` дал бы занять любое имя навсегда (резерв не эффект и
    // снятием области не снимается). Дотянуться до него плагину нечем.
    const service: Record<string, unknown> = kernel.ctx.predicates as unknown as Record<string, unknown>;
    assert.equal(service.reserve, undefined);
    assert.equal(
      Object.getOwnPropertyNames(Object.getPrototypeOf(service) as object).includes('reserve'),
      false,
    );

    // Всё, что плагину доступно, — регистрация вклада; она обратима, и снятие
    // области возвращает имя.
    const fiber = await applyContextPlugin(
      kernel,
      {
        name: 'reserver',
        inject: ['predicates'],
        apply(ctx) {
          ctx.predicates.register('своё_имя', predicate('своё_имя'));
        },
      },
      '<synthetic>',
    );
    assert.deepEqual([...kernel.ctx.predicates.reserved].sort(), [...BUILTIN_PREDICATE_NAMES].sort());

    await fiber.dispose();
    assert.equal(kernel.ctx.predicates.contributions.has('своё_имя'), false);
  });
});

describe('plugin-kernel: сервис с новым именем', () => {
  it('плагин заводит сервис, которого ядро не знает; сервис доступен и исчезает вместе с областью', async () => {
    const kernel = createKernel();

    const fiber = await applyContextPlugin(
      kernel,
      {
        name: 'widget-provider',
        apply(ctx) {
          ctx.provide('widget-thing');
          ctx.set('widget-thing', { hello: 'мир' });
        },
      },
      '<synthetic>',
    );

    assert.deepEqual(kernel.ctx.get('widget-thing'), { hello: 'мир' });

    await fiber.dispose();

    assert.equal(kernel.ctx.get('widget-thing'), undefined);
  });
});

describe('plugin-kernel: внедрение между плагинами', () => {
  it('плагин b получает тот же объект от a; снятие a снимает b; повторное появление перезапускает тело b', async () => {
    const kernel = createKernel();
    const seen: unknown[] = [];
    let runs = 0;

    let providerFiber = await applyContextPlugin(
      kernel,
      {
        name: 'a',
        apply(ctx) {
          ctx.provide('shared-thing');
          ctx.set('shared-thing', { marker: 'FIRST' });
        },
      },
      '<a>',
    );

    await applyContextPlugin(
      kernel,
      {
        name: 'b',
        inject: ['shared-thing', 'backends'],
        apply(ctx) {
          runs++;
          seen.push(ctx.get('shared-thing'));
          ctx.backends.register('from-b', backend());
        },
      },
      '<b>',
    );

    assert.equal(runs, 1);
    assert.deepEqual(seen, [{ marker: 'FIRST' }]);
    assert.ok(kernel.ctx.backends.contributions.has('from-b'));

    await providerFiber.dispose();
    await kernel.settle();

    assert.equal(kernel.ctx.backends.contributions.has('from-b'), false);

    providerFiber = await applyContextPlugin(
      kernel,
      {
        name: 'a',
        apply(ctx) {
          ctx.provide('shared-thing');
          ctx.set('shared-thing', { marker: 'SECOND' });
        },
      },
      '<a-2>',
    );
    await kernel.settle();

    assert.equal(runs, 2);
    assert.deepEqual(seen, [{ marker: 'FIRST' }, { marker: 'SECOND' }]);
    assert.ok(kernel.ctx.backends.contributions.has('from-b'));
  });
});

describe('plugin-kernel: неудовлетворённая зависимость', () => {
  const WAITER = `
const waiter = function waiter(ctx) {};
waiter.inject = ['служба-которой-нет'];
export default waiter;
`;

  it('отказ называет плагин, недостающее имя и файл объявления', async () => {
    const place = bed();
    writeModule(join(place.root, '.stepcast', 'plugins', 'waiter.mjs'), WAITER);
    const config = resolved(place, 'plugins: ["./plugins/waiter.mjs"]\n');

    await assert.rejects(
      () => loadPlugins(config, { projectRoot: place.root }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /waiter/);
        assert.match(error.message, /служба-которой-нет/);
        // Состав полей тот же, что у прочих отказов загрузки: без файла и
        // печать CLI, и карточка витрины показали бы отказ без расположения.
        assert.equal(error.file, place.projectPath);
        assert.equal(error.at, 'plugins');
        return true;
      },
    );
  });

  it('команда не доходит до диспетчеризации: код возврата — код ошибки конфигурации', async () => {
    const project = makeProject({});
    project.write('.stepcast/plugins/waiter.mjs', WAITER);
    project.write('.stepcast/config.yml', 'plugins: ["./plugins/waiter.mjs"]\n');

    const stdout: string[] = [];
    const stderr: string[] = [];
    const io: CliIo = { out: (line) => stdout.push(line), err: (line) => stderr.push(line), cwd: project.root };

    const code = await withHome(project.home, () => runCli(['status'], io));

    assert.equal(code, ExitCode.configError);
    assert.equal(stdout.join('\n'), '');
  });
});

describe('plugin-kernel: отложенная регистрация', () => {
  const PROVIDER = `
export default function provider(ctx) {
  ctx.provide('awaited-service');
  ctx.set('awaited-service', { ready: true });
}
`;
  const DEFERRED = `
const deferred = function deferred(ctx) {
  ctx.inject(['awaited-service', 'backends'], (ctx2) => {
    ctx2.backends.register('deferred-backend', {
      create: () => ({}),
      defaults: { command: 'deferred-cmd' },
    });
  });
};
deferred.inject = ['awaited-service'];
export default deferred;
`;

  it('бэкенд, зарегистрированный после ожидания чужого сервиса, есть в реестре и участвует во втором проходе', async () => {
    const place = bed();
    writeModule(join(place.root, '.stepcast', 'plugins', 'provider.mjs'), PROVIDER);
    writeModule(join(place.root, '.stepcast', 'plugins', 'deferred.mjs'), DEFERRED);
    const options = {
      cwd: place.root,
      home: place.home,
      globalPath: place.globalPath,
      projectPath: place.projectPath,
    };
    writeFileSync(place.projectPath, 'plugins: ["./plugins/provider.mjs", "./plugins/deferred.mjs"]\n');

    const { resolved: out, registry } = await resolveWithPlugins(options, { projectRoot: place.root });

    assert.ok(registry.backends.has('deferred-backend'));
    assert.equal(out.config.backends['deferred-backend']?.command, 'deferred-cmd');
  });
});

describe('plugin-kernel: наполовину загруженный плагин', () => {
  it('отказ на втором вкладе снимает область в том же ядре: ни вклада, ни записи в перечне плагинов', async () => {
    const kernel = createBuiltinKernel();
    const registry = registryFromKernel(kernel);

    await assert.rejects(() =>
      applyContextPlugin(
        kernel,
        {
          name: 'broken',
          inject: ['backends', 'predicates'],
          apply(ctx) {
            ctx.predicates.register('half_ok', predicate('half_ok'));
            // Имя занято встроенным бэкендом — отказ посреди применения.
            ctx.backends.register('claude', backend());
          },
        },
        '<synthetic>',
      ),
    );

    // Проверяется ТО ЖЕ ядро, в котором отказ произошёл: свежее ядро о снятии
    // области не свидетельствует ничем (design.md, Решение 10).
    assert.equal(registry.predicates.has('half_ok'), false);
    assert.deepEqual([...registry.plugins], []);
    assert.equal(registry.owners.get('predicates:half_ok'), undefined);

    // Освобождённое имя достаётся следующему плагину в том же ядре.
    await applyDeclarativePlugin(kernel, { name: 'salvage', predicates: [predicate('half_ok')] }, '<synthetic-2>');
    assert.ok(registry.predicates.has('half_ok'));
    assert.equal(registry.owners.get('predicates:half_ok'), 'salvage');
  });

  it('поля отказа прежние: файл объявления, место и подсказка', async () => {
    const place = bed();
    const BROKEN = `
export default function broken(ctx) {
  ctx.predicates.register('half_ok', {
    name: 'half_ok',
    schema: { type: 'string' },
    evaluate: () => ({ predicate: 'half_ok', passed: true, hard: true }),
  });
  ctx.backends.register('claude', { create: () => ({}) });
}
broken.inject = ['backends', 'predicates', 'commands'];
`;
    writeModule(join(place.root, '.stepcast', 'plugins', 'broken.mjs'), BROKEN);
    const config = resolved(place, 'plugins: ["./plugins/broken.mjs"]\n');

    let caught: unknown;
    try {
      await loadPlugins(config, { projectRoot: place.root });
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof StepcastError);
    assert.equal(caught.file, place.projectPath);
    assert.equal(caught.at, 'plugins');
    assert.ok(caught.hint !== undefined);
  });
});

describe('plugin-kernel: две формы плагина', () => {
  it('декларативный объект и плагин контекста дают одинаково доступные вклады', async () => {
    const declarative = createBuiltinKernel();
    await applyDeclarativePlugin(declarative, { name: 'twin', backends: { twin: backend() } }, '<d>');

    const context = createBuiltinKernel();
    await applyContextPlugin(
      context,
      {
        name: 'twin',
        inject: ['backends'],
        apply(ctx) {
          ctx.backends.register('twin', backend());
        },
      },
      '<c>',
    );

    assert.deepEqual(
      availableNames(registryFromKernel(declarative), 'backends'),
      availableNames(registryFromKernel(context), 'backends'),
    );
  });

  it('безымянный плагин контекста отказывает: `default` именем не считается', async () => {
    const place = bed();
    // Именно та форма, которой пишут «функцию по умолчанию»: `Function.name` у
    // неё по спецификации ES — строка `default`. Без проверки плагин звался бы
    // `default` в перечне, в манифесте прогона и в тексте отказа о конфликте, а
    // два таких плагина стали бы неразличимы.
    writeModule(
      join(place.root, '.stepcast', 'plugins', 'anonymous.mjs'),
      'export default function (ctx) { ctx.provide("nameless"); }\n',
    );
    const config = resolved(place, 'plugins: ["./plugins/anonymous.mjs"]\n');

    await assert.rejects(
      () => loadPlugins(config, { projectRoot: place.root }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /обязан иметь имя/);
        assert.equal(error.file, place.projectPath);
        assert.equal(error.at, 'plugins');
        return true;
      },
    );
  });

  it('экспорт, не опознанный ни одной формой, отказывает, называя обе формы', async () => {
    const place = bed();
    writeModule(join(place.root, '.stepcast', 'plugins', 'string.mjs'), "export default 'просто строка';\n");
    const config = resolved(place, 'plugins: ["./plugins/string.mjs"]\n');

    await assert.rejects(
      () => loadPlugins(config, { projectRoot: place.root }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /не опознан/);
        assert.match(error.hint ?? '', /декларативный/);
        assert.match(error.hint ?? '', /apply/);
        return true;
      },
    );
  });
});

describe('plugin-kernel: окружение команды', () => {
  it('команда плагина достаёт через контекст сервис своего же плагина', async () => {
    const place = bed();
    const PLUGIN = `
export default function withOwnService(ctx) {
  ctx.provide('own-service');
  ctx.set('own-service', { greeting: 'привет' });
  ctx.commands.register('greet', {
    name: 'greet',
    spec: { description: 'своя команда' },
    run: (args, io, env) => {
      const service = env.ctx.get('own-service');
      io.out(service.greeting);
      return 0;
    },
  });
}
withOwnService.inject = ['commands'];
`;
    writeModule(join(place.root, '.stepcast', 'plugins', 'own-service.mjs'), PLUGIN);
    const options = {
      cwd: place.root,
      home: place.home,
      globalPath: place.globalPath,
      projectPath: place.projectPath,
    };
    writeFileSync(place.projectPath, 'plugins: ["./plugins/own-service.mjs"]\n');

    const { resolved: out, registry, ctx } = await resolveWithPlugins(options, { projectRoot: place.root });
    const contribution = registry.commands.get('greet');
    assert.ok(contribution !== undefined);

    const printed: string[] = [];
    const io: CliIo = { out: (line) => printed.push(line), err: () => {}, cwd: place.root };
    const code = await contribution.run({ command: 'greet', positional: [], flags: {} }, io, {
      cwd: place.root,
      config: out.config,
      registry,
      ctx,
    });

    assert.equal(code, 0);
    assert.deepEqual(printed, ['привет']);
  });
});

/**
 * Публикуемая поверхность и её стык с cordis.
 *
 * Собственные `.d.ts` cordis реэкспортируют друг друга относительными путями
 * без расширения, чего `moduleResolution: NodeNext` не разрешает: под таким
 * резолвером `import { Context } from 'cordis'` не даёт ни одного имени, а
 * `skipLibCheck` этого не лечит. Наш компилятор обходит это ручным
 * объявлением (`src/core/plugins/cordis.d.ts`), но оно живёт в `src` и в `dist`
 * не эмитится — значит публикуемый тип контекста не вправе на cordis ссылаться
 * вовсе. Отсюда обе проверки ниже: что в опубликованных объявлениях библиотеки
 * нет, и что ручное объявление не разошлось с установленной версией.
 */
describe('plugin-kernel: поверхность плагина не требует cordis', () => {
  /** Объявления, которые автор плагина читает, импортируя `stepcast/plugin`. */
  const PUBLISHED = [
    '../src/plugin.d.ts',
    '../src/core/plugins/context.d.ts',
    '../src/core/plugins/contract.d.ts',
  ];

  for (const relative of PUBLISHED) {
    it(`${relative} не ссылается на cordis`, () => {
      const path = fileURLToPath(new URL(relative, import.meta.url));
      // Файл читается из `dist`: проверяется то, что уедет пользователю, а не
      // исходник. Его отсутствие — тоже отказ: объявления обязаны эмититься.
      const source = readFileSync(path, 'utf8');
      // Именно объявление импорта, а не любое упоминание: слово `cordis` в
      // комментарии объясняет, почему библиотеки здесь нет, и запрещать его
      // значило бы запрещать объяснение.
      const imports = /^\s*(?:import|export)\b[^\n]*['"]cordis['"]/m;
      assert.equal(imports.test(source), false, `${relative} тянет типы cordis`);
    });
  }

  it('ручное объявление cordis совпадает с установленной версией по рантайму', () => {
    const ctx = createKernel().ctx as unknown as Record<string, unknown>;

    // Ровно то, что объявлено в `src/core/plugins/context.ts` как контракт
    // плагина, плюс то, чем пользуется само ядро.
    for (const name of ['effect', 'get', 'set', 'provide', 'inject', 'plugin']) {
      assert.equal(typeof ctx[name], 'function', `Context.${name} не функция в установленной версии cordis`);
    }
    assert.equal(typeof Service, 'function');
    assert.equal(FiberState.PENDING, 0);

    const fiber = ctx.fiber as Record<string, unknown>;
    assert.equal(typeof fiber.dispose, 'function');
    assert.equal(typeof fiber.await, 'function');
    assert.ok(typeof (ctx.registry as Record<string, unknown>).values === 'function');
  });
});
