import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { resolveConfig } from '../src/core/config/resolve.js';
import { StepcastError } from '../src/core/errors.js';
import { toContextPlugin } from '../src/core/plugins/load.js';
import { loadPlugins } from '../src/parts/load.js';
import { availableNames } from '../src/core/plugins/registry.js';
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
    assert.deepEqual(availableNames(registry, 'predicates'), ['good_one']);
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
    assert.deepEqual(availableNames(registry, 'predicates'), []);
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
    assert.deepEqual(availableNames(registry, 'predicates'), []);
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
    assert.deepEqual(toContextPlugin({ name: 'пустой' }).inject, []);
    assert.deepEqual(
      toContextPlugin({ name: 'бэкендный', backends: { own: { create: () => ({}) as never } } }).inject,
      ['backends'],
    );
    assert.deepEqual(
      toContextPlugin({
        name: 'оба',
        backends: { own: { create: () => ({}) as never } },
        steps: [{ name: 'own', title: 'Свой', fields: {}, execute: () => ({}) as never }],
      }).inject,
      ['backends', 'steps'],
    );
  });

  it('пустой перечень вкладов зависимостью не считается', () => {
    assert.deepEqual(toContextPlugin({ name: 'пустые перечни', backends: {}, predicates: [], commands: [], steps: [] }).inject, []);
  });
});
