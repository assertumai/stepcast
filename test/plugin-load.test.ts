import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve as resolvePath, sep } from 'node:path';
import { describe, it } from 'node:test';

import { resolveConfig, type ResolvedConfig } from '../src/core/config/resolve.js';
import { StepcastError } from '../src/core/errors.js';
import { loadPlugins } from '../src/parts/load.js';
import { availableNames, predicateNames } from '../src/core/plugins/registry.js';
import { resolveWithPlugins, type ResolvedWithPlugins } from '../src/parts/resolve.js';
import { resolveAdapter } from '../src/core/backend/registry.js';
import { builtinRegistry } from '../src/parts/builtin.js';
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

    // Порядок: встроенные строки первыми, затем вклад глобального слоя, затем
    // проектного; повтор спецификатора внутри проектного слоя схлопнут в одну
    // строку — вставка нашла свой id в дереве и не сделала ничего (design.md,
    // Решение 4).
    assert.deepEqual(
      config.pluginTree.map((row) => row.id),
      ['pipeline', 'backend-claude', 'predicates', 'step-run', 'step-uses', 'step-script', 'step-agent', 'step-decision', './plugins/местный', './plugins/local.mjs'],
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

  // Сценарий `plugin-contributions`: «Плагин пытается объявить внутреннюю
  // форму». Запрет тот же, что у вида шага, и проверяется он тем же образцом:
  // вклад, назвавший `native`, был бы принят за встроенный предикат, чей
  // разбор отдаёт типизированную модель, а не значение под JSON Schema.
  it('вклад предиката не вправе нести поле внутренней формы native', async () => {
    const place = bed();
    writeModule(
      join(place.root, '.stepcast', 'plugins', 'предикат-самозванец.mjs'),
      'export default { name: "checks-impostor", predicates: [{ name: "http_ok", schema: {}, evaluate: () => ({ predicate: "http_ok", passed: true, hard: true }), native: { test: () => true, parse: () => ({}) } }] };\n',
    );
    const config = resolved(place, { project: 'plugins: ["./plugins/предикат-самозванец.mjs"]\n' });

    await assert.rejects(
      () => loadPlugins(config, { projectRoot: place.root }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /predicates\.0\.native/);
        assert.match(error.message, /внутренней форме встроенного предиката/);
        return true;
      },
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

  it('вклад вида шага не вправе нести поле внутренней формы native', async () => {
    // Поле `document` вкладу теперь разрешено — это его собственная форма
    // записи. Внутренней формой встроенных видов осталась `native`, и запрет
    // переехал на неё: вклад, случайно назвавший это поле, был бы принят за
    // встроенный вид, чей разбор отдаёт типизированную модель шага.
    const place = bed();
    writeModule(
      join(place.root, '.stepcast', 'plugins', 'самозванец.mjs'),
      'export default { name: "steps-impostor", steps: [{ name: "http", title: "HTTP", fields: { type: "object" }, execute: () => ({}), native: { test: () => true, parse: () => ({}) } }] };\n',
    );
    const config = resolved(place, { project: 'plugins: ["./plugins/самозванец.mjs"]\n' });

    await assert.rejects(
      () => loadPlugins(config, { projectRoot: place.root }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /steps\.0\.native/);
        return true;
      },
    );
  });

  it('форма document вклада проверяется при загрузке, называя промахнувшееся поле', async () => {
    const place = bed();
    const kind = (document: string): string =>
      `export default { name: "steps-broken", steps: [{ name: "deploy-kind", title: "Деплой", fields: { type: "object" }, execute: () => ({}), document: ${document} }] };\n`;

    // Без `parse`, с пустым перечнем ключей, со схемой, не являющейся объектом.
    const cases: readonly (readonly [string, string, RegExp])[] = [
      ['без-parse', kind('{ test: () => true, keys: ["deploy"], schema: { type: "object" } }'), /steps\.0\.document\.parse/],
      [
        'пустые-ключи',
        kind('{ test: () => true, keys: [], schema: { type: "object" }, parse: (raw) => raw }'),
        /steps\.0\.document\.keys/,
      ],
      [
        'схема-строкой',
        kind('{ test: () => true, keys: ["deploy"], schema: "объект", parse: (raw) => raw }'),
        /steps\.0\.document\.schema/,
      ],
    ];

    for (const [name, source, expected] of cases) {
      writeModule(join(place.root, '.stepcast', 'plugins', `${name}.mjs`), source);
      const config = resolved(place, { project: `plugins: ["./plugins/${name}.mjs"]\n` });

      await assert.rejects(
        () => loadPlugins(config, { projectRoot: place.root }),
        (error: unknown) => {
          assert.ok(error instanceof StepcastError, name);
          assert.match(error.message, expected, name);
          // Отказ называет и плагин — модулем, которым он объявлен.
          assert.match(error.message, new RegExp(`Плагин \\./plugins/${name}\\.mjs`), name);
          return true;
        },
      );
    }
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

/**
 * Поддельная установка пакета для проверки разрешения обоих подпутей
 * (`plugin-surface-split`, design.md, Решение 10): `package.json` с
 * объявленными `exports` и копия собранного движка рядом. Прогон из этого
 * репозитория доказывал бы только его раскладку; чужая установка отвечает на
 * вопрос, разрешится ли подпуть у того, кто поставил `stepcast` пакетом.
 */
function fakeInstall(): { readonly root: string; readonly engine: string } {
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
  return { root, engine };
}

/**
 * Доменные значения — вторая половина контракта вклада (`emptyUsage`,
 * `mergeUsage`, `sumUsage`, `describeRefusal`, `effectivePermissions`,
 * `defineBackend`, `definePredicate`, `defineStepKind`), переехавшие в
 * `stepcast/pipeline`: до переезда объявлений (задача 1) этот же перечень
 * проверял их присутствие в `stepcast/plugin`, теперь — их отсутствие там же
 * и присутствие в доменном подпути.
 */
const DOMAIN_VALUE_NAMES = [
  'emptyUsage',
  'mergeUsage',
  'sumUsage',
  'describeRefusal',
  'effectivePermissions',
  'defineBackend',
  'definePredicate',
  'defineStepKind',
] as const;

/**
 * Статические рёбра графа загрузки собранного модуля. Форм две, и обе
 * обязательны: `import … from '…'` (включая побочный `import '…'`) и
 * `export … from '…'` — у реэкспорта тот же рантайм-эффект, и именно из него
 * собран `dist/src/plugin.js` целиком (`tsc` сохраняет реэкспорт значения как
 * есть). Тот же приём разбора, что и в `test/plugin-surface.test.ts`, где обе
 * формы тоже перечислены рядом.
 *
 * Интересны только относительные специфики: `node:*` и пакеты из
 * `node_modules` доменными модулями движка не бывают.
 */
const GRAPH_IMPORT_RE = /(?:^|[\s;}])import\s+(?:[^'"();]*?\sfrom\s+)?['"](\.[^'"]+)['"]/gm;
const GRAPH_REEXPORT_RE = /(?:^|[\s;}])export\s+[^'"();]*?\sfrom\s+['"](\.[^'"]+)['"]/gm;

/** Модули, достижимые из точки входа по статическим рёбрам, — сама точка входа включительно. */
function walkLoadGraph(entry: string): Set<string> {
  const visited = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop();
    if (file === undefined || visited.has(file)) continue;
    // Специфик, встреченный в докстринге (собранный модуль сохраняет
    // комментарии), ведёт в несуществующий файл: такое ребро графа не
    // образует. Настоящее ребро при этом не потеряется молча — проверка ниже
    // требует, чтобы обход дошёл до поимённо названных модулей.
    if (!existsSync(file)) continue;
    visited.add(file);
    const source = readFileSync(file, 'utf8');
    for (const re of [GRAPH_IMPORT_RE, GRAPH_REEXPORT_RE]) {
      for (const match of source.matchAll(re)) {
        const specifier = match[1];
        if (specifier === undefined) continue;
        stack.push(resolvePath(dirname(file), specifier));
      }
    }
  }
  return visited;
}

describe('plugin-contributions: подпуть stepcast/plugin', () => {
  it('разрешается у того, кто поставил пакет, и отдаёт контракт', async () => {
    const { root, engine } = fakeInstall();

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

    for (const name of ['runProcess', 'StepcastError', 'parseDuration', 'definePlugin']) {
      assert.equal(typeof plugin[name], 'function', `${name} доступен автору плагина`);
    }
    // Внутренние пути ядра подпуть не публикует: что экспортировано, то и обещано.
    assert.equal(plugin.runPipeline, undefined);
    assert.equal(plugin.expandPipeline, undefined);
    // Доменные значения переехали в stepcast/pipeline (задача 1, задача 6.4):
    // ядерный подпуть их больше не отдаёт ни одного.
    for (const name of DOMAIN_VALUE_NAMES) {
      assert.equal(plugin[name], undefined, `${name} доменный — ядерный подпуть его не отдаёт`);
    }
  });

  /**
   * Задача 6.5: граница проверяется не составом экспорта (выше), а самим
   * графом загрузки — статические специфики собранного `dist/src/plugin.js`,
   * обойдённые рекурсивно тем же приёмом разбора, что и в
   * `test/plugin-surface.test.ts`. Обещание «ядерный подпуть не тянет ни
   * одного доменного модуля» держит рантайм-граф импорта, а не только то, что
   * подпуть экспортирует наружу: тип, стёртый сборкой, графа не оставляет —
   * этот тест ловит именно оставшееся.
   */
  it('загрузка ядерного подпутя не тянет доменных модулей движка', () => {
    const pluginJs = fileURLToPath(new URL('../src/plugin.js', import.meta.url));
    const domainPatterns = [/\/core\/backend\//, /\/core\/config\//, /\/core\/expect\//, /\/core\/journal\//, /\/core\/pipeline\//, /\/core\/plugins\/pipeline-contract\.js$/];

    const visited = walkLoadGraph(pluginJs);
    // Обход, не нашедший ни одного ребра, доказал бы пустоту, а не границу:
    // `dist/src/plugin.js` — сплошной реэкспорт, и разбор, видящий только
    // `import`, обошёл бы ровно один узел и прошёл бы при любом откате.
    // Поэтому сначала проверяется, что граф настоящий, и лишь потом — его
    // состав.
    assert.ok(visited.size > 1, `граф обхода вырожден: ${[...visited].join('\n')}`);
    for (const expected of ['core/errors.js', 'core/exec/process.js', 'core/units.js', 'core/plugins/define.js']) {
      assert.ok(
        [...visited].some((file) => file.endsWith(expected.split('/').join(sep))),
        `обход не дошёл до ${expected}: ${[...visited].join('\n')}`,
      );
    }

    const domainHits = [...visited].filter((file) => domainPatterns.some((pattern) => pattern.test(file)));
    assert.deepEqual(domainHits, [], domainHits.join('\n'));
  });
});

describe('plugin-contributions: подпуть stepcast/pipeline', () => {
  it('разрешается у того, кто поставил пакет, отдельно от stepcast/plugin', async () => {
    const { root, engine } = fakeInstall();

    const resolvedPath = createRequire(join(root, 'package.json')).resolve('stepcast/pipeline');
    assert.equal(resolvedPath, join(engine, 'dist', 'src', 'parts', 'pipeline', 'surface.js'));
    // Второй подпуть разрешается независимо от первого — оба объявлены
    // манифестом пакета, и разрешение одного не требуется для другого.
    const pluginPath = createRequire(join(root, 'package.json')).resolve('stepcast/plugin');
    assert.notEqual(resolvedPath, pluginPath);
  });

  it('отдаёт доменные значения и не отдаёт ядерных имён, взятых у соседа', async () => {
    const pipeline = (await import(
      pathToFileURL(fileURLToPath(new URL('../src/parts/pipeline/surface.js', import.meta.url))).href
    )) as Record<string, unknown>;

    for (const name of DOMAIN_VALUE_NAMES) {
      assert.equal(typeof pipeline[name], 'function', `${name} доступен автору доменного вклада`);
    }
    assert.equal(typeof pipeline.definePipelinePlugin, 'function');
    assert.equal(typeof pipeline.pipelineContext, 'function');
    // Ядерные имена — не обещание доменного подпутя (design.md, Решение 9):
    // домен не публикует ядро.
    for (const name of ['StepcastError', 'parseDuration', 'runProcess', 'definePlugin']) {
      assert.equal(pipeline[name], undefined, `${name} ядерный — доменный подпуть его не отдаёт`);
    }
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
