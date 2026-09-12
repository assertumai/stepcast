import assert from 'node:assert/strict';
import { cpSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { resolveConfig, type ResolvedConfig } from '../src/core/config/resolve.js';
import { StepcastError } from '../src/core/errors.js';
import { loadPlugins } from '../src/core/plugins/load.js';
import { availableNames, predicateNames } from '../src/core/plugins/registry.js';
import { resolveWithPlugins, type ResolvedWithPlugins } from '../src/core/plugins/resolve.js';
import { resolveAdapter } from '../src/core/backend/registry.js';
import { builtinRegistry } from '../src/core/plugins/builtin.js';
import { tempDir } from './tmp.js';

interface Bed {
  readonly root: string;
  readonly home: string;
  readonly globalPath: string;
  readonly projectPath: string;
}

function bed(): Bed {
  const base = tempDir('plugins-');
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

    const { registry } = await loadPlugins(config, { projectRoot: place.root });

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

    const { registry } = await loadPlugins(config, { projectRoot: place.root });

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

    // Порядок: встроенная строка первой, затем вклад глобального слоя, затем
    // проектного; повтор спецификатора внутри проектного слоя схлопнут в одну
    // строку — вставка нашла свой id в дереве и не сделала ничего (design.md,
    // Решение 4).
    assert.deepEqual(
      config.pluginTree.map((row) => row.id),
      ['backend-claude', 'step-decision', './plugins/местный', './plugins/local.mjs'],
    );
    // `Config.plugins` — модули: псевдоспецификатора встроенной строки в нём нет.
    assert.deepEqual(config.config.plugins, ['./plugins/местный', './plugins/local.mjs']);
  });

  it('разрешает относительный путь глобального слоя от глобального файла', () => {
    const place = bed();
    const config = resolved(place, { global: 'plugins: ["./adapters/codex.mjs"]\n' });

    const row = config.pluginTree.find((item) => item.id === './adapters/codex.mjs');
    assert.equal(row?.source.kind, 'file');
    assert.equal(row?.source.kind === 'file' ? row.source.path : undefined, place.globalPath);
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

  it('вид шага без исполнителя отказывает при загрузке, называя плагин и поле', async () => {
    const place = bed();
    writeModule(
      join(place.root, '.stepcast', 'plugins', 'без-исполнителя.mjs'),
      'export default { name: "steps-broken", steps: [{ name: "http", title: "HTTP", fields: { type: "object" } }] };\n',
    );
    const config = resolved(place, { project: 'plugins: ["./plugins/без-исполнителя.mjs"]\n' });

    await assert.rejects(
      () => loadPlugins(config, { projectRoot: place.root }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /без-исполнителя\.mjs/);
        assert.match(error.message, /steps\.0\.execute/);
        return true;
      },
    );
  });

  it('схема полей вида шага, не являющаяся объектом, отказывает при загрузке', async () => {
    const place = bed();
    writeModule(
      join(place.root, '.stepcast', 'plugins', 'кривые-поля.mjs'),
      'export default { name: "steps-broken", steps: [{ name: "http", title: "HTTP", fields: "объект", execute: () => ({}) }] };\n',
    );
    const config = resolved(place, { project: 'plugins: ["./plugins/кривые-поля.mjs"]\n' });

    await assert.rejects(
      () => loadPlugins(config, { projectRoot: place.root }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /steps\.0\.fields/);
        return true;
      },
    );
  });

  it('вклад вида шага не вправе нести поле внутренней формы document', async () => {
    const place = bed();
    writeModule(
      join(place.root, '.stepcast', 'plugins', 'самозванец.mjs'),
      'export default { name: "steps-impostor", steps: [{ name: "http", title: "HTTP", fields: { type: "object" }, execute: () => ({}), document: {} }] };\n',
    );
    const config = resolved(place, { project: 'plugins: ["./plugins/самозванец.mjs"]\n' });

    await assert.rejects(
      () => loadPlugins(config, { projectRoot: place.root }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /steps\.0\.document/);
        return true;
      },
    );
  });

  it('waits не значением true отказывает при загрузке с названной причиной', async () => {
    // Дельта `step-kinds`: «вклад получает отказ с названной причиной».
    // Способность ожидания даётся ровно по этому полю, поэтому `waits: false`
    // — не «как раньше», а попытка объявить несуществующую третью
    // возможность; проглотить её молча значило бы оставить автора вклада в
    // уверенности, что он сроком распорядился.
    const place = bed();
    writeModule(
      join(place.root, '.stepcast', 'plugins', 'мнимое-ожидание.mjs'),
      'export default { name: "steps-waits", steps: [{ name: "http", title: "HTTP", fields: { type: "object" }, waits: false, execute: () => ({}) }] };\n',
    );
    const config = resolved(place, { project: 'plugins: ["./plugins/мнимое-ожидание.mjs"]\n' });

    await assert.rejects(
      () => loadPlugins(config, { projectRoot: place.root }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /steps\.0\.waits/);
        assert.match(error.message, /waits: true/);
        return true;
      },
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

    const { registry } = await loadPlugins(config, { projectRoot: place.root });

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
    const root = realpathSync(tempDir('pkg-plugin-'));
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

describe('plugin-contributions: перечисление моделей вклада бэкенда', () => {
  const WITH_MODELS = `
export default {
  name: 'with-models',
  backends: {
    codex: {
      create: () => ({ name: 'codex' }),
      models: {
        probe: (config) => ({ command: [config.command, '--help'], stdin: '' }),
        parse: () => [{ name: 'gpt' }],
      },
    },
  },
};
`;

  const BROKEN_PROBE = `
export default {
  name: 'broken-probe',
  backends: {
    codex: {
      create: () => ({ name: 'codex' }),
      models: { probe: 'not-a-function', parse: () => [] },
    },
  },
};
`;

  it('вклад, объявивший models с probe и parse, загружается', async () => {
    const place = bed();
    writeModule(join(place.root, '.stepcast', 'plugins', 'models.mjs'), WITH_MODELS);
    const config = resolved(place, { project: 'plugins: ["./plugins/models.mjs"]\n' });

    const { registry } = await loadPlugins(config, { projectRoot: place.root });

    assert.equal(registry.backends.get('codex')?.models?.parse({ stdout: '', stderr: '', exitCode: 0 })[0]?.name, 'gpt');
  });

  it('вклад, где probe не функция, отклоняется отказом с именем бэкенда и поля', async () => {
    const place = bed();
    writeModule(join(place.root, '.stepcast', 'plugins', 'broken.mjs'), BROKEN_PROBE);
    const config = resolved(place, { project: 'plugins: ["./plugins/broken.mjs"]\n' });

    await assert.rejects(
      () => loadPlugins(config, { projectRoot: place.root }),
      (error: unknown) =>
        error instanceof StepcastError &&
        /backends\.codex\.models\.probe/.test(error.message) &&
        /должна быть функцией/.test(error.message),
    );
  });

  it('вклад без models загружается как прежде', async () => {
    const place = bed();
    writeModule(join(place.root, '.stepcast', 'plugins', 'local.mjs'), PLUGIN_BODY);
    const config = resolved(place, { project: 'plugins: ["./plugins/local.mjs"]\n' });

    const { registry } = await loadPlugins(config, { projectRoot: place.root });

    assert.equal(registry.backends.get('codex')?.models, undefined);
  });
});

describe('codex-backend: загрузка плагина пакета', () => {
  // Собранный модуль — тот же, что отдаёт подпуть `stepcast/backends/codex`;
  // из теста он берётся путём, потому что самоссылка пакета разрешается через
  // `dist/`, а тесты и так исполняются из него.
  const MODULE = fileURLToPath(new URL('../src/backends/codex/index.js', import.meta.url));

  // Сценарий: «Плагин объявлен»
  it('объявленный ключом plugins, плагин даёт адаптер codex с умолчаниями вклада', async () => {
    const place = bed();
    writeFileSync(place.projectPath, `plugins: [${JSON.stringify(MODULE)}]\n`);
    const { resolved, registry } = await resolveWithPlugins(
      { cwd: place.root, home: place.home, globalPath: place.globalPath, projectPath: place.projectPath },
      {},
    );

    assert.deepEqual(availableNames(registry, 'backends'), ['claude', 'codex']);
    assert.equal(registry.plugins[0]?.name, 'codex');
    assert.equal(resolved.config.backends.codex?.command, 'codex');
    assert.equal(resolved.config.backends.codex?.sessions, true);
    assert.equal(resolved.config.backends.codex?.structuredOutput, true);
    assert.equal(resolved.config.backends.codex?.strictPermissions, false);
    assert.equal(resolved.config.backends.codex?.mcp, true);
    assert.equal(resolved.config.backends.codex?.cacheReadWeight, 0.1);
    assert.deepEqual(resolved.provenance.get('backends.codex.sessions'), { kind: 'plugin', name: 'codex' });

    const adapter = resolveAdapter('codex', resolved.config, registry);
    assert.equal(adapter.capabilities.sessionIdSource, 'backend');
  });

  // Сценарий: «Плагин не объявлен»
  it('без объявления бэкенд codex не существует', () => {
    const place = bed();
    const config = resolved(place, { global: 'backends:\n  codex:\n    command: codex\n' });
    assert.throws(
      () => resolveAdapter('codex', config.config, builtinRegistry()),
      (error: unknown) => error instanceof StepcastError && /не предоставлен ни встроенно, ни плагином/.test(error.message),
    );
  });
});
