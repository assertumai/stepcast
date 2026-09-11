import assert from 'node:assert/strict';
import { get, request } from 'node:http';
import { mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { resolveConfig } from '../src/core/config/resolve.js';
import { loadPlugins } from '../src/core/plugins/load.js';
import type { KernelCache } from '../src/ui/pipelines.js';
import { createUiServer, LOOPBACK, type UiServer } from '../src/ui/server.js';
import { createWatcher, type Watcher } from '../src/ui/watcher.js';
import { UI_ROWS } from '../src/ui/screens/rows.js';
import { buildHomePlugins, directoryFingerprint, pluginDirPath } from '../src/ui/plugins.js';
import { createWidgetCompiler, type WidgetCompiler } from '../src/ui/widgets.js';
import { pluginModuleHref } from '../src/ui/routes.js';
import { makeJournalBed } from './helpers.js';
import { tempDir } from './tmp.js';

/**
 * Доставка браузерной половины плагина домашнего слоя (design.md изменения
 * `hot-swap-preserves-data`, задача 4.1—4.7 `user-plugins-from-files`):
 * отпечаток каталога и версия, сборка бандлом со стилями экспортом, адрес
 * `/plugins/<id>.js` в диспетчере, действующий состав у ядра демона, событие
 * `plugins` потока `/api/events`.
 */

function pluginsDir(home: string): string {
  const dir = join(home, '.stepcast', 'plugins');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Каталог плагина домашнего слоя с манифестом и файлами — тем же приёмом, что `writePluginDir` (`test/plugin-tree.test.ts`). */
function writePluginDir(
  home: string,
  id: string,
  manifest: Record<string, unknown>,
  files: Readonly<Record<string, string>> = {},
): string {
  const dir = join(pluginsDir(home), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

const SIMPLE_HALF = `export default function plugin() {}\n`;

describe('ui-plugins: отпечаток каталога плагина', () => {
  it('правка файла внутри каталога двигает версию', () => {
    const home = tempDir('ui-plugins-fp-');
    const dir = writePluginDir(home, 'demo', { browser: 'index.tsx' }, { 'index.tsx': SIMPLE_HALF });
    const before = directoryFingerprint(dir);

    const bumped = new Date(Date.now() + 5_000);
    writeFileSync(join(dir, 'index.tsx'), `${SIMPLE_HALF}// правка\n`);
    utimesSync(join(dir, 'index.tsx'), bumped, bumped);

    assert.notEqual(directoryFingerprint(dir), before);
  });

  it('правка внутри node_modules каталога плагина не двигает версию', () => {
    const home = tempDir('ui-plugins-fp-');
    const dir = writePluginDir(home, 'demo', { browser: 'index.tsx' }, { 'index.tsx': SIMPLE_HALF });
    mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
    const before = directoryFingerprint(dir);

    const bumped = new Date(Date.now() + 5_000);
    writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'module.exports = 2;\n');
    utimesSync(join(dir, 'node_modules', 'dep', 'index.js'), bumped, bumped);

    assert.equal(directoryFingerprint(dir), before);
  });

  it('плагин без browser в манифесте не входит в перечень', () => {
    const home = tempDir('ui-plugins-fp-');
    writePluginDir(home, 'server-only', { server: 'server.mjs' }, { 'server.mjs': 'export default {};\n' });
    writePluginDir(home, 'has-browser', { browser: 'index.tsx' }, { 'index.tsx': SIMPLE_HALF });

    const overview = buildHomePlugins(home);
    assert.deepEqual(
      overview.plugins.map((plugin) => plugin.id),
      ['has-browser'],
    );
  });

  it('каталога плагинов нет — перечень пуст, а не исключение', () => {
    const home = tempDir('ui-plugins-fp-');
    assert.deepEqual(buildHomePlugins(home), { plugins: [] });
  });

  it('символическая ссылка из каталога плагина наружу не разрешается', () => {
    const home = tempDir('ui-plugins-fp-');
    const outside = tempDir('ui-plugins-outside-');
    writeFileSync(join(outside, 'secret.tsx'), SIMPLE_HALF);
    const dir = writePluginDir(home, 'escape', { browser: 'escape.tsx' });
    symlinkSync(join(outside, 'secret.tsx'), join(dir, 'escape.tsx'));

    // Границу каталога плагина по реальному пути держит сам манифест
    // (`resolvePluginHalf`, `src/core/plugins/manifest.ts`) — плагин с половиной
    // за пределами своего каталога не перечисляется вовсе, а значит, не
    // попадает ни в поток, ни в состав, которым гейтится его адрес.
    assert.deepEqual(buildHomePlugins(home), { plugins: [] });
  });
});

describe('ui-plugins: сборка браузерной половины бандлом', () => {
  it('половина с локальным относительным импортом собирается в один модуль', async () => {
    const home = tempDir('ui-plugins-bundle-');
    const dir = writePluginDir(
      home,
      'demo',
      { browser: 'index.tsx' },
      {
        'index.tsx': "import { greeting } from './helper';\nexport default function plugin() { return greeting; }\n",
        'helper.ts': 'export const greeting = "hello";\n',
      },
    );

    const compiler = createWidgetCompiler();
    const outcome = await compiler.compileBundle(join(dir, 'index.tsx'), directoryFingerprint(dir));
    await compiler.dispose();

    assert.equal(outcome?.kind, 'ok');
    const code = (outcome as { readonly kind: 'ok'; readonly code: string }).code;
    assert.match(code, /hello/);
    // Импорт разрешён внутрь бандла — отдельного `from "./helper"` не осталось.
    assert.doesNotMatch(code, /from ".\/helper"/);
  });

  it('`import \'./styles.css\'` приходит экспортом стилей, а не отдельным запросом', async () => {
    const home = tempDir('ui-plugins-bundle-');
    const dir = writePluginDir(
      home,
      'demo',
      { browser: 'index.tsx' },
      {
        'index.tsx': "import './styles.css';\nexport default function plugin() {}\n",
        'styles.css': '.demo { color: red; }\n',
      },
    );

    const compiler = createWidgetCompiler();
    const outcome = await compiler.compileBundle(join(dir, 'index.tsx'), directoryFingerprint(dir));
    await compiler.dispose();

    assert.equal(outcome?.kind, 'ok');
    const code = (outcome as { readonly kind: 'ok'; readonly code: string }).code;
    assert.match(code, /__stepcastWidgetStyle/);
    assert.match(code, /color:\s*red/);
  });

  it('ошибка синтаксиса даёт модуль с разобранной ошибкой, а не бросок', async () => {
    const home = tempDir('ui-plugins-bundle-');
    const dir = writePluginDir(home, 'broken', { browser: 'index.tsx' }, { 'index.tsx': 'export default function( {\n' });

    const compiler = createWidgetCompiler();
    const outcome = await compiler.compileBundle(join(dir, 'index.tsx'), directoryFingerprint(dir));
    await compiler.dispose();

    assert.equal(outcome?.kind, 'error');
  });

  it('повторная сборка без правки берётся из кеша', async () => {
    const home = tempDir('ui-plugins-bundle-');
    const dir = writePluginDir(home, 'demo', { browser: 'index.tsx' }, { 'index.tsx': SIMPLE_HALF });

    const compiler = createWidgetCompiler();
    const key = directoryFingerprint(dir);
    const first = await compiler.compileBundle(join(dir, 'index.tsx'), key);
    const second = await compiler.compileBundle(join(dir, 'index.tsx'), key);
    await compiler.dispose();

    assert.equal(first, second);
  });
});

/** Сервер с закрытием, зарегистрированным сразу — тем же приёмом, что `test/ui-server.test.ts`. */
async function startServer(
  t: TestContext,
  options: { runsRoot: string; home: string; watcher?: Watcher; widgetCompiler?: WidgetCompiler; kernelCache?: KernelCache },
): Promise<UiServer> {
  const server = await createUiServer({ ...options, port: 0 });
  t.after(() => server.close());
  return server;
}

interface FetchedWithHeaders {
  readonly code: number;
  readonly body: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

function fetchWithHeaders(server: UiServer, path: string): Promise<FetchedWithHeaders> {
  return new Promise((resolve, reject) => {
    get({ host: LOOPBACK, port: server.port, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ code: res.statusCode ?? 0, body, headers: res.headers }));
    }).on('error', reject);
  });
}

interface Stream {
  readonly events: Array<{ event: string; data: unknown }>;
  close(): void;
}

function openStream(t: TestContext, server: UiServer, path: string): Stream {
  const events: Array<{ event: string; data: unknown }> = [];
  let carry = '';

  const req = request({ host: LOOPBACK, port: server.port, path }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      carry += chunk;
      const blocks = carry.split('\n\n');
      carry = blocks.pop() ?? '';
      for (const block of blocks) {
        const name = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (name !== undefined && data !== undefined) {
          events.push({ event: name, data: JSON.parse(data) as unknown });
        }
      }
    });
  });
  req.end();
  t.after(() => req.destroy());

  return { events, close: () => req.destroy() };
}

const settle = (ms = 80): Promise<void> => new Promise((done) => setTimeout(done, ms));

function pick(value: unknown, ...path: readonly (string | number)[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    assert.ok(current !== null && typeof current === 'object', `нет пути ${path.join('.')}`);
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

describe('ui-plugins: адрес /plugins/<id>.js в диспетчере', () => {
  it('отдаёт собранную половину действующего плагина, 200 и text/javascript', async (t) => {
    const { runsRoot, home } = makeJournalBed();
    writePluginDir(home, 'demo', { browser: 'index.tsx' }, { 'index.tsx': SIMPLE_HALF });
    const server = await startServer(t, { runsRoot, home });

    const res = await fetchWithHeaders(server, pluginModuleHref('demo', '1'));
    assert.equal(res.code, 200);
    assert.match(String(res.headers['content-type']), /text\/javascript/);
    assert.doesNotMatch(res.body, /__stepcastWidgetError/);
  });

  it('ошибка сборки — тоже 200, исполняемый модуль с заголовком-пометкой', async (t) => {
    const { runsRoot, home } = makeJournalBed();
    writePluginDir(home, 'broken', { browser: 'index.tsx' }, { 'index.tsx': 'export default function( {\n' });
    const server = await startServer(t, { runsRoot, home });

    const res = await fetchWithHeaders(server, pluginModuleHref('broken', '1'));
    assert.equal(res.code, 200);
    assert.equal(res.headers['x-stepcast-widget-error'], '1');
    assert.match(res.body, /__stepcastWidgetError/);
  });

  it('небезопасный сегмент, неизвестный id, плагин без браузерной половины — один и тот же 404', async (t) => {
    const { runsRoot, home } = makeJournalBed();
    writePluginDir(home, 'server-only', { server: 'server.mjs' }, { 'server.mjs': 'export default {};\n' });
    const server = await startServer(t, { runsRoot, home });

    const unsafe = await fetchWithHeaders(server, `/plugins/${encodeURIComponent('../secret')}.js`);
    const unknown = await fetchWithHeaders(server, '/plugins/ghost.js');
    const noBrowser = await fetchWithHeaders(server, '/plugins/server-only.js');

    for (const res of [unsafe, unknown, noBrowser]) {
      assert.equal(res.code, 404);
    }
  });

  it('строка вне действующего состава (отключена патчем) — 404', async (t) => {
    const { runsRoot, home } = makeJournalBed();
    writePluginDir(home, 'demo', { browser: 'index.tsx' }, { 'index.tsx': SIMPLE_HALF });
    writeFileSync(
      join(home, '.stepcast', 'plugins.patch.yml'),
      'version: 1\nkind: plugins-patch\nplugins:\n  - id: demo\n    use: irrelevant\n    enabled: false\n',
    );
    const server = await startServer(t, { runsRoot, home });

    const res = await fetchWithHeaders(server, pluginModuleHref('demo', '1'));
    assert.equal(res.code, 404);
  });

  it('каталог плагинов не перечисляется в ответе', async (t) => {
    const { runsRoot, home } = makeJournalBed();
    writePluginDir(home, 'demo', { browser: 'index.tsx' }, { 'index.tsx': SIMPLE_HALF });
    const server = await startServer(t, { runsRoot, home });

    const res = await fetchWithHeaders(server, '/plugins/');
    assert.equal(res.code, 404);
  });
});

describe('ui-plugins: действующий состав у ядра демона', () => {
  it('каталог плагина с браузерной половиной попадает в состав', async () => {
    const home = tempDir('ui-plugins-kernel-');
    mkdirSync(join(home, '.stepcast'), { recursive: true });
    writeFileSync(join(home, '.stepcast', 'config.yml'), 'runs:\n  root: /tmp\n');
    writePluginDir(home, 'demo', { browser: 'index.tsx' }, { 'index.tsx': SIMPLE_HALF });

    const resolved = resolveConfig({ cwd: home, home, projectPath: null, builtinRows: UI_ROWS.map((row) => row.id) });
    const collected: { readonly id: string }[] = [];
    await loadPlugins(resolved, {
      projectRoot: home,
      builtinRows: UI_ROWS,
      onDirectoryRow: ({ row, manifest }) => {
        if (manifest.browser !== undefined) collected.push({ id: row.id });
      },
    });

    assert.deepEqual(
      collected.map((c) => c.id),
      ['demo'],
    );
  });

  it('enabled: false в патче убирает плагин из состава и даёт 404 на его адресе', async (t) => {
    const { runsRoot, home } = makeJournalBed();
    writePluginDir(home, 'demo', { browser: 'index.tsx' }, { 'index.tsx': SIMPLE_HALF });
    const server = await startServer(t, { runsRoot, home });

    const before = await fetchWithHeaders(server, pluginModuleHref('demo', '1'));
    assert.equal(before.code, 200);

    writeFileSync(
      join(home, '.stepcast', 'plugins.patch.yml'),
      'version: 1\nkind: plugins-patch\nplugins:\n  - id: demo\n    use: irrelevant\n    enabled: false\n',
    );

    const after = await fetchWithHeaders(server, pluginModuleHref('demo', '1'));
    assert.equal(after.code, 404);
  });

  it('строка, объявленная патчем вне каталога плагинов, отдаётся по своему каталогу из манифеста', async (t) => {
    const { runsRoot, home } = makeJournalBed();
    // Каталожная строка вправе лежать где угодно: путь называет патч, а не
    // имя каталога внутри `~/.stepcast/plugins/`. Состав обязан нести тот
    // каталог, который назвал манифест, иначе отпечаток считался бы по
    // несуществующему пути, а половина искалась бы не там, где она есть.
    const dir = join(home, '.stepcast', 'elsewhere', 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ browser: 'index.tsx' }));
    writeFileSync(join(dir, 'index.tsx'), 'export default function plugin() { return "elsewhere"; }\n');
    writeFileSync(
      join(home, '.stepcast', 'plugins.patch.yml'),
      'version: 1\nkind: plugins-patch\nplugins:\n  - id: demo\n    use: ./elsewhere/demo\n',
    );
    const server = await startServer(t, { runsRoot, home });

    const res = await fetchWithHeaders(server, pluginModuleHref('demo', '1'));
    assert.equal(res.code, 200);
    assert.match(res.body, /elsewhere/);
  });

  it('два запроса подряд с неизменным деревом отдают тот же состав, а не пустой', async (t) => {
    const { runsRoot, home } = makeJournalBed();
    writePluginDir(home, 'demo', { browser: 'index.tsx' }, { 'index.tsx': SIMPLE_HALF });
    const server = await startServer(t, { runsRoot, home });

    const first = await fetchWithHeaders(server, pluginModuleHref('demo', '1'));
    const second = await fetchWithHeaders(server, pluginModuleHref('demo', '1'));
    assert.equal(first.code, 200);
    assert.equal(second.code, 200);
  });
});

describe('ui-plugins: событие plugins потока /api/events', () => {
  it('приходит первым обменом при подключении', async (t) => {
    const { runsRoot, home } = makeJournalBed();
    writePluginDir(home, 'demo', { browser: 'index.tsx' }, { 'index.tsx': SIMPLE_HALF });
    const watcher = createWatcher({ runsRoot, home, intervalMs: 10_000 });
    t.after(() => watcher.dispose());
    const server = await startServer(t, { runsRoot, home, watcher });

    const stream = openStream(t, server, '/api/events');
    await settle();

    assert.deepEqual(
      stream.events.map((event) => event.event),
      ['overview', 'backlog', 'widgets', 'plugins'],
    );
    assert.equal(pick(stream.events[3]?.data, 'plugins', 0, 'id'), 'demo');
  });

  it('правка файла внутри каталога плагина шлёт его заново с новой версией', async (t) => {
    const { runsRoot, home } = makeJournalBed();
    const dir = writePluginDir(home, 'demo', { browser: 'index.tsx' }, { 'index.tsx': SIMPLE_HALF });
    const watcher = createWatcher({ runsRoot, home, intervalMs: 10_000 });
    t.after(() => watcher.dispose());
    const server = await startServer(t, { runsRoot, home, watcher });

    const stream = openStream(t, server, '/api/events');
    await settle();
    const firstVersion = pick(
      stream.events.filter((event) => event.event === 'plugins').at(-1)?.data,
      'plugins',
      0,
      'version',
    );

    const bumped = new Date(Date.now() + 5_000);
    writeFileSync(join(dir, 'index.tsx'), `${SIMPLE_HALF}// v2\n`);
    utimesSync(join(dir, 'index.tsx'), bumped, bumped);
    watcher.poll();
    await settle();

    const events = stream.events.filter((event) => event.event === 'plugins');
    assert.equal(events.length, 2);
    const secondVersion = pick(events.at(-1)?.data, 'plugins', 0, 'version');
    assert.notEqual(secondVersion, firstVersion);
  });

  it('такт без изменений не шлёт событие повторно', async (t) => {
    const { runsRoot, home } = makeJournalBed();
    writePluginDir(home, 'demo', { browser: 'index.tsx' }, { 'index.tsx': SIMPLE_HALF });
    const watcher = createWatcher({ runsRoot, home, intervalMs: 10_000 });
    t.after(() => watcher.dispose());
    const server = await startServer(t, { runsRoot, home, watcher });

    const stream = openStream(t, server, '/api/events');
    await settle();
    const before = stream.events.filter((event) => event.event === 'plugins').length;

    watcher.poll();
    await settle();

    const after = stream.events.filter((event) => event.event === 'plugins').length;
    assert.equal(after, before);
  });

  it('отключённая патчем строка в поток не попадает — то же членство, что и у адреса', async (t) => {
    const { runsRoot, home } = makeJournalBed();
    writePluginDir(home, 'demo', { browser: 'index.tsx' }, { 'index.tsx': SIMPLE_HALF });
    writePluginDir(home, 'kept', { browser: 'index.tsx' }, { 'index.tsx': SIMPLE_HALF });
    writeFileSync(
      join(home, '.stepcast', 'plugins.patch.yml'),
      'version: 1\nkind: plugins-patch\nplugins:\n  - id: demo\n    use: irrelevant\n    enabled: false\n',
    );
    const watcher = createWatcher({ runsRoot, home, intervalMs: 10_000 });
    t.after(() => watcher.dispose());
    const server = await startServer(t, { runsRoot, home, watcher });

    const stream = openStream(t, server, '/api/events');
    await settle();

    const last = stream.events.filter((event) => event.event === 'plugins').at(-1);
    const ids = (pick(last?.data, 'plugins') as readonly { readonly id: string }[]).map((row) => row.id);
    // Наблюдатель видит на диске оба каталога — патч знает только ядро демона.
    assert.deepEqual(buildHomePlugins(home).plugins.map((row) => row.id), ['demo', 'kept']);
    assert.deepEqual(ids, ['kept']);
    // И ровно то же членство у адреса: отключённая строка — 404, оставшаяся — 200.
    assert.equal((await fetchWithHeaders(server, pluginModuleHref('demo', '1'))).code, 404);
    assert.equal((await fetchWithHeaders(server, pluginModuleHref('kept', '1'))).code, 200);
  });

  it('снятие каталога плагина убирает его из события', async (t) => {
    const { runsRoot, home } = makeJournalBed();
    writePluginDir(home, 'demo', { browser: 'index.tsx' }, { 'index.tsx': SIMPLE_HALF });
    const watcher = createWatcher({ runsRoot, home, intervalMs: 10_000 });
    t.after(() => watcher.dispose());
    const server = await startServer(t, { runsRoot, home, watcher });

    const stream = openStream(t, server, '/api/events');
    await settle();
    assert.equal(pick(stream.events.filter((e) => e.event === 'plugins').at(-1)?.data, 'plugins', 0, 'id'), 'demo');

    rmSync(pluginDirPath(home, 'demo'), { recursive: true, force: true });
    watcher.poll();
    await settle();

    const last = stream.events.filter((e) => e.event === 'plugins').at(-1);
    assert.deepEqual(pick(last?.data, 'plugins'), []);
  });
});
