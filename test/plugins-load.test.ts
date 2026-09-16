import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { resolveConfig } from '../src/core/config/resolve.js';
import { ExitCode, StepcastError } from '../src/core/errors.js';
import {
  DECLARATIVE_CONTRIBUTION_FIELDS,
  StepcastPluginSchema,
  type DeclarativeContributionFields,
  type PipelinePlugin,
} from '../src/core/plugins/pipeline-contract.js';
import { toContextPlugin } from '../src/core/plugins/load.js';
import { declaredServices } from '../src/core/plugins/services.js';
import { createKernelShell } from '../src/parts/builtin.js';
import { loadPlugins } from '../src/parts/load.js';
import { availableNames } from '../src/core/plugins/registry.js';
import { DEFAULT_NATIVE_PREDICATES } from '../src/core/pipeline/schema.js';
import { tempDir } from './tmp.js';

/**
 * Мягкий отказ каталожной строки (`user-plugins`, design.md, Решение 10):
 * отдельно от `test/plugin-tree.test.ts`, который проверяет саму сборку
 * дерева, — здесь только поведение загрузки при отказе одной из строк.
 */

interface Bed {
  readonly root: string;
  readonly home: string;
}

function bed(): Bed {
  const base = tempDir('plugins-load-');
  const root = join(base, 'work');
  const home = join(base, 'home');
  mkdirSync(join(root, '.stepcast'), { recursive: true });
  mkdirSync(join(home, '.stepcast'), { recursive: true });
  return { root, home };
}

function writePluginDir(baseDir: string, id: string, manifest: Record<string, unknown> | undefined, files: Readonly<Record<string, string>> = {}): string {
  const dir = join(baseDir, '.stepcast', 'plugins', id);
  mkdirSync(dir, { recursive: true });
  if (manifest !== undefined) writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

describe('plugins-load: мягкий отказ каталожной строки', () => {
  it('сломанный каталожный плагин не мешает соседям: их вклады в реестре, отказ — в итогах', async () => {
    const place = bed();
    // Каталог без plugin.json — отказавшая строка.
    mkdirSync(join(place.home, '.stepcast', 'plugins', 'broken'), { recursive: true });
    writePluginDir(place.home, 'good', { server: 'server.mjs' }, {
      'server.mjs': 'export default { name: "good", predicates: [] };\n',
    });

    const config = resolveConfig({ cwd: place.root, home: place.home });
    const { registry, outcomes } = await loadPlugins(config, { projectRoot: place.root });

    assert.deepEqual(registry.plugins.map((plugin) => plugin.name), ['good']);
    const broken = outcomes.find((outcome) => outcome.row.id === 'broken');
    assert.equal(broken?.status, 'failed');
    assert.match(broken?.error?.message ?? '', /манифест/i);
    const good = outcomes.find((outcome) => outcome.row.id === 'good');
    assert.equal(good?.status, 'active');
  });

  it('команда, зависящая от конфигурации, исполняется несмотря на сломанный каталожный плагин', async () => {
    const place = bed();
    mkdirSync(join(place.home, '.stepcast', 'plugins', 'broken'), { recursive: true });

    const config = resolveConfig({ cwd: place.root, home: place.home });
    // `loadPlugins` не бросает — вызывающая команда получает реестр и работает дальше.
    const { registry } = await loadPlugins(config, { projectRoot: place.root });
    assert.deepEqual(registry.plugins, []);
  });

  it('явная строка (ключ plugins) при отказе по-прежнему прекращает загрузку', async () => {
    const place = bed();
    writeFileSync(join(place.root, '.stepcast', 'config.yml'), 'plugins: ["./missing.mjs"]\n');
    const config = resolveConfig({ cwd: place.root, home: place.home });

    await assert.rejects(
      () => loadPlugins(config, { projectRoot: place.root }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /не загружается/);
        return true;
      },
    );
  });

  it('явная строка (каталог, названный руками через патч) при отказе прекращает загрузку', async () => {
    const place = bed();
    writeFileSync(
      join(place.home, '.stepcast', 'plugins.patch.yml'),
      'version: 1\nkind: plugins-patch\nplugins:\n  - id: mine\n    use: ./does-not-exist\n',
    );
    const config = resolveConfig({ cwd: place.root, home: place.home });

    await assert.rejects(() => loadPlugins(config, { projectRoot: place.root }));
  });

  it('незакрытое внедрение каталожной строки — её состояние, а не конец загрузки', async () => {
    const place = bed();
    writePluginDir(place.home, 'waiting', { server: 'server.mjs' }, {
      'server.mjs':
        'export default { name: "waiting", inject: ["нет-такого-сервиса"], apply(ctx) { ctx.predicates.register("never", { name: "never", schema: { type: "boolean" }, evaluate: () => ({ predicate: "never", passed: true, hard: true }) }); } };\n',
    });
    writePluginDir(place.home, 'good', { server: 'server.mjs' }, {
      'server.mjs':
        'export default { name: "good", predicates: [{ name: "good_one", schema: { type: "boolean" }, evaluate: () => ({ predicate: "good_one", passed: true, hard: true }) }] };\n',
    });

    const config = resolveConfig({ cwd: place.root, home: place.home });
    // Отказ рождается после успокоения контекста, когда строка уже применена:
    // он обязан снять её область целиком, иначе «отказавшая» строка осталась бы
    // в перечне плагинов (design.md, Решение 10).
    const { registry, outcomes } = await loadPlugins(config, { projectRoot: place.root });

    const waiting = outcomes.find((outcome) => outcome.row.id === 'waiting');
    assert.equal(waiting?.status, 'failed');
    assert.match(waiting?.error?.message ?? '', /нет-такого-сервиса/);
    // Снятая область имён уже не назовёт — поэтому загрузчик снимает их до
    // `dispose()` и оставляет в итоге: осмотр (`plugin-introspection`,
    // «Запрошенное и не разрешённое») обязан показать неразрешённое имя моделью,
    // а не одним текстом причины.
    assert.deepEqual(waiting?.requestedServices, [{ name: 'нет-такого-сервиса', resolved: false }]);
    assert.deepEqual(registry.plugins.map((plugin) => plugin.name), ['good']);
    // Встроенные предикаты — вклады строки `predicates` (`builtin-predicates-as-row`),
    // всегда в составе рядом с плагинным `good_one`.
    assert.deepEqual(availableNames(registry, 'predicates'), [...DEFAULT_NATIVE_PREDICATES, 'good_one'].sort());
  });

  it('отказ вклада вызывающего на каталожной строке не оставляет её регистраций', async () => {
    const place = bed();
    writePluginDir(place.home, 'clock', { server: 'server.mjs' }, {
      'server.mjs':
        'export default { name: "clock", predicates: [{ name: "clock_tick", schema: { type: "boolean" }, evaluate: () => ({ predicate: "clock_tick", passed: true, hard: true }) }] };\n',
    });

    const config = resolveConfig({ cwd: place.root, home: place.home });
    const { registry, outcomes } = await loadPlugins(config, {
      projectRoot: place.root,
      // Вызывающий (витрина) заводит свой вклад в области строки и отказывает:
      // строка обязана стать отказавшей и не оставить за собой ни вклада.
      onDirectoryRow: () => {
        throw new StepcastError('сервис состава плагинов отказал');
      },
    });

    assert.equal(outcomes.find((outcome) => outcome.row.id === 'clock')?.status, 'failed');
    assert.deepEqual(registry.plugins, []);
    // Только встроенные — вклад строки `clock` снят вместе с её областью.
    assert.deepEqual(availableNames(registry, 'predicates'), [...DEFAULT_NATIVE_PREDICATES].sort());
  });

  it('несколько сломанных каталожных строк все получают состояние failed, ни одна не прерывает соседей', async () => {
    const place = bed();
    mkdirSync(join(place.home, '.stepcast', 'plugins', 'broken-a'), { recursive: true });
    mkdirSync(join(place.home, '.stepcast', 'plugins', 'broken-b'), { recursive: true });
    writePluginDir(place.home, 'good', { server: 'server.mjs' }, {
      'server.mjs': 'export default { name: "good", predicates: [] };\n',
    });

    const config = resolveConfig({ cwd: place.root, home: place.home });
    const { registry, outcomes } = await loadPlugins(config, { projectRoot: place.root });

    assert.deepEqual(registry.plugins.map((plugin) => plugin.name), ['good']);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'failed').length, 2);
    assert.deepEqual(availableNames(registry, 'predicates'), [...DEFAULT_NATIVE_PREDICATES].sort());
  });
});

describe('plugins-load: адаптер декларативной формы объявляет inject по вкладам', () => {
  /**
   * Состав `inject` виден наружу печатью осмотра (`plugin-introspection`,
   * Решение 5: «сервисы запрошены»), поэтому он закреплён здесь, а не оставлен
   * на совести адаптера: плагин без предикатов не должен казаться «ждущим»
   * сервис предикатов, а плагин с бэкендом обязан называть его зависимостью.
   */
  it('называет ровно те служебные сервисы, в которые плагин вносит вклад', () => {
    assert.deepEqual(toContextPlugin({ name: 'пустой' }, DECLARATIVE_CONTRIBUTION_FIELDS).inject, []);
    assert.deepEqual(
      toContextPlugin({ name: 'бэкендный', backends: { own: { create: () => ({}) as never } } }, DECLARATIVE_CONTRIBUTION_FIELDS).inject,
      ['backends'],
    );
    assert.deepEqual(
      toContextPlugin({
        name: 'оба',
        backends: { own: { create: () => ({}) as never } },
        steps: [{ name: 'own', title: 'Свой', fields: {}, execute: () => ({}) as never }],
      }, DECLARATIVE_CONTRIBUTION_FIELDS).inject,
      ['backends', 'steps'],
    );
  });

  it('пустой перечень вкладов зависимостью не считается', () => {
    assert.deepEqual(toContextPlugin({ name: 'пустые перечни', backends: {}, predicates: [], commands: [], steps: [] }, DECLARATIVE_CONTRIBUTION_FIELDS).inject, []);
  });

  /**
   * Сценарий дельты `plugin-contributions` «Ключ формы и сервис не
   * расходятся» (задача 8, находка ревью: таблица не читалась ни одним
   * тестом). Ключи схемы декларативной формы и имена сервисов, в которые их
   * вносит загрузчик, обязаны совпадать — иначе ключ, добавленный в схему без
   * таблицы, молча ни во что не регистрировался бы, а имя, оставшееся в
   * таблице после правки схемы, вело бы в никуда.
   */
  it('ключи схемы декларативной формы и таблица сервисов не расходятся', () => {
    const schemaKeys = Object.keys(StepcastPluginSchema.shape).filter((key) => key !== 'name' && key !== 'version');
    assert.deepEqual(Object.keys(DECLARATIVE_CONTRIBUTION_FIELDS).sort(), schemaKeys.sort());

    // Каждому ключу отвечает ровно одно имя сервиса: двух ключей, ведущих в
    // один сервис, таблица не знает.
    const services = Object.values(DECLARATIVE_CONTRIBUTION_FIELDS).map((field) => field.service);
    assert.equal(new Set(services).size, services.length);

    // И тот же перечень — ровно то, что адаптер объявляет зависимостями
    // плагина, назвавшего все ключи формы: второго перечня в его теле нет.
    assert.deepEqual(
      toContextPlugin({
        name: 'все-ключи',
        backends: { own: { create: () => ({}) as never } },
        predicates: [{ name: 'own_p', schema: {}, evaluate: () => ({ predicate: 'own_p', passed: true, hard: true }) }],
        commands: [{ name: 'own-cmd', spec: { description: 'своя' }, run: () => ExitCode.ok }],
        steps: [{ name: 'own', title: 'Свой', fields: {}, execute: () => ({}) as never }],
      }, DECLARATIVE_CONTRIBUTION_FIELDS).inject,
      services,
    );
  });

  // Задача 7.3 (`cli-commands-as-rows`, design.md Решение 11): таблица —
  // параметр сборки, и обход своей таблицы не несёт. Ключ, который плагин
  // объявил непустым, а поданная таблица не называет, обязан отказать по
  // имени — молчаливый пропуск превратил бы опечатку состава в тихую потерю
  // вклада, а не в ответ, который можно заметить.
  it('ключ декларативной формы, которого поданная таблица не называет, отказывает, называя ключ и плагин', () => {
    // Убрана деструктуризацией с остатком, а не присвоением `undefined`:
    // таблица типа `Partial<…>`, и ключ, которого она не называет, обязан
    // отсутствовать, а не значить `undefined` явно (`exactOptionalPropertyTypes`).
    const { predicates: _predicates, ...withoutPredicates } = DECLARATIVE_CONTRIBUTION_FIELDS;

    assert.throws(
      () =>
        toContextPlugin(
          {
            name: 'без-предикатов-в-таблице',
            predicates: [{ name: 'own_p', schema: {}, evaluate: () => ({ predicate: 'own_p', passed: true, hard: true }) }],
          },
          withoutPredicates,
        ),
      (error: unknown) =>
        error instanceof StepcastError &&
        /без-предикатов-в-таблице/.test(error.message) &&
        /predicates/.test(error.message),
    );
  });

  /**
   * Находка ревью: требование дельты `plugin-kernel` — загрузчик собственного
   * перечня ключей формы не несёт. Регистрация обязана идти по ключам
   * поданной таблицы, а перечень, выведенный от схемы, — служить одной только
   * проверке на неизвестный ключ. Ключ, которого в схеме нет, сегодня не
   * пройдёт типом (`DeclarativeContributionFields` замкнут на четыре имени) —
   * отсюда приведение: проверяется именно то, чем обход ходит, а не то, что
   * разрешает тип.
   */
  it('регистрация идёт по ключам поданной таблицы, а не по перечню, выведенному от схемы', () => {
    const withExtraKey = {
      ...DECLARATIVE_CONTRIBUTION_FIELDS,
      widgets: {
        service: 'widgets',
        entries: (plugin: PipelinePlugin) =>
          ((plugin as unknown as { widgets?: readonly string[] }).widgets ?? []).map((name) => ({
            name,
            contribution: { name },
          })),
      },
    } as DeclarativeContributionFields;

    const plugin = { name: 'с-чужим-ключом', widgets: ['часы'] } as unknown as PipelinePlugin;

    assert.deepEqual(toContextPlugin(plugin, withExtraKey).inject, ['widgets']);
  });

  // Обратная сторона: ключ, объявленный плагином пустым (или не объявленный
  // вовсе), не отказывает, даже если таблица его не называет, — то же
  // молчание, каким `.loose()` уже встречает лишний ключ схемы.
  it('пустой либо необъявленный ключ таблицей может не называться — это не отказ', () => {
    const { predicates: _predicates, ...withoutPredicates } = DECLARATIVE_CONTRIBUTION_FIELDS;

    assert.deepEqual(
      toContextPlugin({ name: 'без-упоминания-предикатов' }, withoutPredicates).inject,
      [],
    );
    assert.deepEqual(
      toContextPlugin({ name: 'с-пустыми-предикатами', predicates: [] }, withoutPredicates).inject,
      [],
    );
  });
});

/**
 * Задача 6.5 (`pipeline-owns-services`): граница ядра — одно имя. Проверяется
 * не перечислением модулей, а самим составом объявленных сервисов: ядро без
 * единой применённой строки не держит ни одного доменного имени (design.md,
 * Решение 5). Находка ревью: задача была отмечена выполненной без этого теста.
 */
describe('plugins-load: ядро без строк объявляет один сервис', () => {
  it('на корневой области объявлен только commands; доменных имён нет и они свободны', () => {
    const kernel = createKernelShell();

    assert.deepEqual(declaredServices(kernel.ctx).map((service) => service.name), ['commands']);
    for (const name of ['backends', 'predicates', 'steps']) {
      assert.equal(kernel.ctx.get(name), undefined, `имя ${name} занято ядром`);
    }
  });
});
