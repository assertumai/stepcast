import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { resolveConfig, type ResolvedConfig } from '../src/core/config/resolve.js';
import { StepcastError } from '../src/core/errors.js';
import { loadPlugins, pluginDeclarations } from '../src/core/plugins/load.js';
import { availableNames, predicateNames } from '../src/core/plugins/registry.js';
import { resolveWithPlugins, type ResolvedWithPlugins } from '../src/core/plugins/resolve.js';

interface Bed {
  readonly root: string;
  readonly home: string;
  readonly globalPath: string;
  readonly projectPath: string;
}

function bed(): Bed {
  const base = mkdtempSync(join(tmpdir(), 'stepcast-plugins-'));
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

function resolved(place: Bed, options: { global?: string; project?: string } = {}): ResolvedConfig {
  if (options.global !== undefined) writeFileSync(place.globalPath, options.global);
  if (options.project !== undefined) writeFileSync(place.projectPath, options.project);
  return resolveConfig({
    cwd: place.root,
    home: place.home,
    globalPath: place.globalPath,
    projectPath: place.projectPath,
  });
}

/** Модуль плагина на диске: загружается настоящим `import()`. */
function writeModule(path: string, body: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
}

const PLUGIN_BODY = `
export default {
  name: 'example',
  version: '1.2.0',
  backends: { codex: { create: () => ({ name: 'codex' }) } },
  predicates: [
    {
      name: 'http_ok',
      schema: { type: 'string' },
      evaluate: () => ({ predicate: 'http_ok', passed: true, hard: true }),
    },
  ],
};
`;

describe('plugin-contributions: загрузка плагинов', () => {
  it('разрешает путь от файла, в котором он объявлен', async () => {
    const place = bed();
    writeModule(join(place.root, '.stepcast', 'plugins', 'local.mjs'), PLUGIN_BODY);
    const config = resolved(place, { project: 'plugins: ["./plugins/local.mjs"]\n' });

    const registry = await loadPlugins(config, { projectRoot: place.root });

    assert.deepEqual(availableNames(registry, 'backends'), ['claude', 'codex']);
    assert.ok(predicateNames(registry).includes('http_ok'));
    assert.equal(registry.plugins.length, 1);
    assert.equal(registry.plugins[0]?.name, 'example');
    assert.equal(registry.plugins[0]?.version, '1.2.0');
    assert.equal(registry.plugins[0]?.source, join(place.root, '.stepcast', 'plugins', 'local.mjs'));
  });

  it('разрешает пакет из node_modules проекта', async () => {
    const place = bed();
    const pkg = join(place.root, 'node_modules', 'stepcast-plugin-example');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'stepcast-plugin-example', main: 'index.mjs' }));
    writeFileSync(join(pkg, 'index.mjs'), PLUGIN_BODY);
    const config = resolved(place, { project: 'plugins: ["stepcast-plugin-example"]\n' });

    const registry = await loadPlugins(config, { projectRoot: place.root });

    assert.ok(registry.backends.has('codex'));
    // На macOS временный каталог — симлинк, а разрешение пакета отдаёт
    // настоящий путь: сравниваются разрешённые.
    assert.equal(registry.plugins[0]?.source, realpathSync(join(pkg, 'index.mjs')));
  });

  it('объединяет слои и загружает повторённый модуль один раз', async () => {
    const place = bed();
    writeModule(join(place.root, '.stepcast', 'plugins', 'local.mjs'), PLUGIN_BODY);
    const config = resolved(place, {
      global: 'plugins: ["./plugins/местный"]\n',
      project: 'plugins: ["./plugins/local.mjs", "./plugins/местный"]\n',
    });

    // Порядок: сначала вклад глобального слоя, затем проектного; повтор внутри
    // проектного слоя схлопнут.
    assert.deepEqual(
      pluginDeclarations(config).map((declaration) => declaration.spec),
      ['./plugins/местный', './plugins/local.mjs'],
    );
    assert.deepEqual(config.config.plugins, ['./plugins/местный', './plugins/local.mjs']);
  });

  it('разрешает относительный путь глобального слоя от глобального файла', () => {
    const place = bed();
    const config = resolved(place, { global: 'plugins: ["./adapters/codex.mjs"]\n' });

    const [declaration] = pluginDeclarations(config);
    assert.equal(declaration?.declaredIn, place.globalPath);
  });

  it('отсутствующий модуль отказывает, называя объявление и файл', async () => {
    const place = bed();
    const config = resolved(place, { project: 'plugins: ["./plugins/нет.mjs"]\n' });

    await assert.rejects(
      () => loadPlugins(config, { projectRoot: place.root }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /не загружается/);
        assert.match(error.message, /\.\/plugins\/нет\.mjs/);
        assert.equal(error.file, place.projectPath);
        return true;
      },
    );
  });

  it('пакет, которого нет, отказывает с перечнем мест поиска', async () => {
    const place = bed();
    const config = resolved(place, { project: 'plugins: ["такого-пакета-нет"]\n' });

    await assert.rejects(
      () => loadPlugins(config, { projectRoot: place.root }),
      (error: unknown) =>
        error instanceof StepcastError &&
        /не найден/.test(error.message) &&
        (error.hint ?? '').includes(place.root),
    );
  });

  it('модуль без экспорта по умолчанию отказывает', async () => {
    const place = bed();
    writeModule(join(place.root, '.stepcast', 'plugins', 'пусто.mjs'), 'export const name = "example";\n');
    const config = resolved(place, { project: 'plugins: ["./plugins/пусто.mjs"]\n' });

    await assert.rejects(
      () => loadPlugins(config, { projectRoot: place.root }),
      (error: unknown) =>
        error instanceof StepcastError && /не экспортирует объект по умолчанию/.test(error.message),
    );
  });

  it('объект без имени отказывает, называя поле', async () => {
    const place = bed();
    writeModule(join(place.root, '.stepcast', 'plugins', 'безымянный.mjs'), 'export default { version: "1" };\n');
    const config = resolved(place, { project: 'plugins: ["./plugins/безымянный.mjs"]\n' });

    await assert.rejects(
      () => loadPlugins(config, { projectRoot: place.root }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /не соответствует контракту/);
        assert.match(error.message, /name/);
        return true;
      },
    );
  });

  it('вклад неверной формы отказывает, называя путь поля', async () => {
    const place = bed();
    writeModule(
      join(place.root, '.stepcast', 'plugins', 'кривой.mjs'),
      'export default { name: "broken", predicates: [{ name: "http_ok", schema: {} }] };\n',
    );
    const config = resolved(place, { project: 'plugins: ["./plugins/кривой.mjs"]\n' });

    await assert.rejects(
      () => loadPlugins(config, { projectRoot: place.root }),
      (error: unknown) => error instanceof StepcastError && /predicates\.0\.evaluate/.test(error.message),
    );
  });

  it('пустой список плагинов отклоняется разбором конфигурации', () => {
    const place = bed();

    assert.throws(
      () => resolved(place, { project: 'plugins: []\n' }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.at, 'plugins');
        assert.equal(error.file, place.projectPath);
        return true;
      },
    );
  });

  it('без объявлений реестр остаётся встроенным', async () => {
    const place = bed();
    const config = resolved(place, { project: 'defaults:\n  agent: claude\n' });

    const registry = await loadPlugins(config, { projectRoot: place.root });

    assert.deepEqual(registry.plugins, []);
    assert.deepEqual(availableNames(registry, 'backends'), ['claude']);
  });
});

describe('plugin-contributions: умолчания бэкенда плагина', () => {
  const ADAPTER = `
export default {
  name: 'codex-adapter',
  backends: {
    codex: {
      create: () => ({ name: 'codex' }),
      defaults: { command: 'codex', sessions: false, structured_output: true },
    },
  },
};
`;

  function withAdapter(place: Bed, project: string): Promise<ResolvedWithPlugins> {
    writeModule(join(place.root, '.stepcast', 'plugins', 'codex.mjs'), ADAPTER);
    writeFileSync(place.projectPath, project);
    return resolveWithPlugins(
      {
        cwd: place.root,
        home: place.home,
        globalPath: place.globalPath,
        projectPath: place.projectPath,
      },
      {},
    );
  }

  it('умолчания видны в конфигурации с источником plugin:<имя>', async () => {
    const place = bed();
    const { resolved } = await withAdapter(place, 'plugins: ["./plugins/codex.mjs"]\n');

    assert.equal(resolved.config.backends.codex?.command, 'codex');
    assert.equal(resolved.config.backends.codex?.sessions, false);
    assert.equal(resolved.config.backends.codex?.structuredOutput, true);
    assert.deepEqual(resolved.provenance.get('backends.codex.command'), {
      kind: 'plugin',
      name: 'codex-adapter',
    });
  });

  it('пользовательский конфиг перекрывает умолчание плагина', async () => {
    const place = bed();
    writeFileSync(place.globalPath, 'backends:\n  codex:\n    command: /opt/codex/bin/codex\n');
    const { resolved } = await withAdapter(place, 'plugins: ["./plugins/codex.mjs"]\n');

    assert.equal(resolved.config.backends.codex?.command, '/opt/codex/bin/codex');
    assert.deepEqual(resolved.provenance.get('backends.codex.command'), {
      kind: 'file',
      path: place.globalPath,
    });
    // Умолчание, которого пользователь не трогал, осталось плагинным.
    assert.deepEqual(resolved.provenance.get('backends.codex.sessions'), {
      kind: 'plugin',
      name: 'codex-adapter',
    });
  });

  it('остальная конфигурация умолчаниями плагина не тронута', async () => {
    const place = bed();
    const before = resolved(place, { project: 'defaults:\n  agent: claude\n' });
    const after = await withAdapter(place, 'plugins: ["./plugins/codex.mjs"]\ndefaults:\n  agent: claude\n');

    for (const [path, value] of before.values) {
      if (path.startsWith('backends.codex') || path === 'plugins') continue;
      assert.deepEqual(after.resolved.values.get(path), value, `значение ${path}`);
      assert.deepEqual(after.resolved.provenance.get(path), before.provenance.get(path), `источник ${path}`);
    }
  });
});

describe('plugin-contributions: подпуть stepcast/plugin', () => {
  /**
   * Поддельная установка пакета: `package.json` с объявленными `exports` и
   * копия собранного движка рядом. Прогон из этого репозитория доказывал бы
   * только его раскладку; чужая установка отвечает на вопрос, разрешится ли
   * подпуть у того, кто поставил `stepcast` пакетом.
   */
  it('разрешается у того, кто поставил пакет, и отдаёт контракт', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stepcast-pkg-plugin-')));
    const engine = join(root, 'node_modules', 'stepcast');
    mkdirSync(engine, { recursive: true });
    // Пути считаются от скомпилированного теста (`dist/test/`): корневой
    // `package.json` лежит двумя уровнями выше, собранный движок — рядом.
    cpSync(fileURLToPath(new URL('../../package.json', import.meta.url)), join(engine, 'package.json'));
    cpSync(fileURLToPath(new URL('../src', import.meta.url)), join(engine, 'dist', 'src'), {
      recursive: true,
    });
    writeFileSync(join(root, 'package.json'), '{ "name": "потребитель", "type": "module" }\n');

    const resolvedPath = createRequire(join(root, 'package.json')).resolve('stepcast/plugin');
    assert.equal(resolvedPath, join(engine, 'dist', 'src', 'plugin.js'));
  });

  it('отдаёт автору плагина ровно объявленную поверхность', async () => {
    // Импортируется собственная сборка: у поддельной установки нет
    // зависимостей движка, и её импорт проверял бы наличие `node_modules`, а
    // не состав экспорта.
    const plugin = (await import(
      pathToFileURL(fileURLToPath(new URL('../src/plugin.js', import.meta.url))).href
    )) as Record<string, unknown>;

    for (const name of ['runProcess', 'emptyUsage', 'mergeUsage', 'sumUsage', 'describeRefusal', 'StepcastError']) {
      assert.equal(typeof plugin[name], 'function', `${name} доступен автору плагина`);
    }
    // Внутренние пути ядра подпуть не публикует: что экспортировано, то и обещано.
    assert.equal(plugin.runPipeline, undefined);
    assert.equal(plugin.expandPipeline, undefined);
  });
});
