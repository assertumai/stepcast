import assert from 'node:assert/strict';
import { get, request } from 'node:http';
import { describe, it, type TestContext } from 'node:test';

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { dashboardPath } from '../src/ui/assets.js';
import { createUiServer, LOOPBACK, type UiServer } from '../src/ui/server.js';
import { createWatcher, type Watcher } from '../src/ui/watcher.js';
import { resolveConfig, type Config } from '../src/core/config/resolve.js';
import { projectKey, runPaths } from '../src/core/journal/paths.js';
import { makeJournalBed, seedRun } from './helpers.js';

/**
 * Сервер с закрытием, зарегистрированным сразу. Без этого упавшая проверка
 * оставляет слушающий сокет, и весь файл тестов повисает вместо отчёта об
 * отказе — то есть отказ теряется ровно тогда, когда он нужен.
 */
async function startServer(
  t: TestContext,
  options: { runsRoot: string; watcher?: Watcher; config?: Config; home?: string },
): Promise<UiServer> {
  const server = await createUiServer({ ...options, port: 0 });
  t.after(() => server.close());
  return server;
}

function startWatcher(t: TestContext, runsRoot: string, intervalMs: number): Watcher {
  const watcher = createWatcher({ runsRoot, intervalMs });
  t.after(() => watcher.dispose());
  return watcher;
}

interface Fetched {
  readonly code: number;
  readonly body: string;
}

function fetchPath(server: UiServer, path: string): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    get({ host: LOOPBACK, port: server.port, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ code: res.statusCode ?? 0, body }));
    }).on('error', reject);
  });
}

/** Разобранный JSON витрины: в проверках он читается точечно, по путям. */
type Json = Record<string, unknown>;

/** Точечный доступ к вложенному значению: `pick(json, 'projects', 0, 'runs')`. */
function pick(value: unknown, ...path: readonly (string | number)[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    assert.ok(current !== null && typeof current === 'object', `нет пути ${path.join('.')}`);
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

async function fetchJson(server: UiServer, path: string): Promise<{ code: number; json: Json }> {
  const { code, body } = await fetchPath(server, path);
  return { code, json: JSON.parse(body) as Json };
}

/** Адрес прогона в запросе: сегменты экранируются, ключ и id могут быть любыми. */
function address(key: string, runId: string): string {
  return encodeURIComponent(`${key}/${runId}`);
}

interface Stream {
  readonly events: Array<{ event: string; data: Json }>;
  close(): void;
}

/** Подключиться к SSE и накапливать разобранные события. */
function openStream(t: TestContext, server: UiServer, path: string): Stream {
  const events: Array<{ event: string; data: Json }> = [];
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
          events.push({ event: name, data: JSON.parse(data) as Json });
        }
      }
    });
  });
  req.end();
  t.after(() => req.destroy());

  return { events, close: () => req.destroy() };
}

/** Запрос произвольным методом: write-API проверяется тем же способом, что и чтение. */
function send(
  server: UiServer,
  options: { method: string; path: string; body?: string; origin?: string },
): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: LOOPBACK,
        port: server.port,
        path: options.path,
        method: options.method,
        headers: {
          'content-type': 'application/json',
          ...(options.origin === undefined ? {} : { origin: options.origin }),
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ code: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end(options.body ?? '');
  });
}

async function sendJson(
  server: UiServer,
  options: { method: string; path: string; body?: string; origin?: string },
): Promise<{ code: number; json: Json }> {
  const { code, body } = await send(server, options);
  return { code, json: JSON.parse(body === '' ? '{}' : body) as Json };
}

const settle = (ms = 80): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Собранная витрина для проверки страницы.
 *
 * `dist/ui-web/index.html` — артефакт сборки фронта: его нет ни в git, ни в
 * свежем worktree, поэтому проверка «страница отдаётся» не имеет права
 * полагаться на то, что он случайно лежит на диске — иначе `npm run check`
 * зелёный только в том каталоге, где кто-то однажды собрал фронт руками.
 * Здесь витрина создаётся сама, если её нет, и убирается за собой; уже
 * собранную настоящую витрину тест не трогает.
 */
function ensureDashboard(t: TestContext): string {
  const path = dashboardPath();
  if (existsSync(path)) return path;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '<!doctype html><title>stepcast</title><div id="root"></div>\n');
  t.after(() => rmSync(path, { force: true }));
  return path;
}

describe('ui-dashboard: HTTP-витрина', () => {
  it('отдаёт страницу и обзор, слушая только петлю', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const dashboard = ensureDashboard(t);
    const server = await startServer(t, { runsRoot });

    const page = await fetchPath(server, '/');
    assert.equal(page.code, 200);
    assert.equal(page.body, readFileSync(dashboard, 'utf8'));

    const overview = await fetchJson(server, '/api/overview');
    assert.equal(overview.code, 200);
    assert.equal(pick(overview.json, 'projects', 0, 'runs', 0, 'runId'), 'a');

    const bound = server.server.address();
    assert.equal(typeof bound === 'object' && bound !== null ? bound.address : '', LOOPBACK);
  });

  it('отдаёт детальный снимок и отвечает 404 на неизвестный прогон', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const key = projectKey(projectRoot);
    const server = await startServer(t, { runsRoot });

    const found = await fetchJson(server, `/api/run?run=${address(key, 'a')}`);
    assert.equal(found.code, 200);
    assert.equal(found.json.runId, 'a');

    const missing = await fetchJson(server, `/api/run?run=${address(key, 'нет-такого')}`);
    assert.equal(missing.code, 404);

    const malformed = await fetchJson(
      server,
      `/api/run?run=${encodeURIComponent('однасегмент')}`,
    );
    assert.equal(malformed.code, 400);
  });

  // Сценарий: «Путь за пределы каталога прогона»
  it('отклоняет кодом 400 файл за пределами каталога прогона', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const key = projectKey(projectRoot);
    const server = await startServer(t, { runsRoot });

    const inside = await fetchJson(server, `/api/file?run=${address(key, 'a')}&path=run.json`);
    assert.equal(inside.code, 200);
    assert.match(String(inside.json.content), /"run_id"/);

    const outside = await fetchJson(
      server,
      `/api/file?run=${address(key, 'a')}&path=${encodeURIComponent('../../projects.json')}`,
    );
    assert.equal(outside.code, 400, 'выход за каталог прогона — ошибка клиента, не сбой сервера');
  });

  // Сценарий: «Новый прогон появляется сам»
  it('присылает по SSE начальный обзор и обновление после нового прогона', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const watcher = startWatcher(t, runsRoot, 20);
    const server = await startServer(t, { runsRoot, watcher });

    const stream = openStream(t, server, '/api/events');
    await settle();

    assert.equal(stream.events.length, 1);
    assert.equal(stream.events[0]?.event, 'overview');
    assert.deepEqual(pick(stream.events[0]?.data, 'projects'), []);

    seedRun(runsRoot, projectRoot, { runId: 'новый' });
    await settle(300);

    assert.ok(stream.events.length > 1, 'появление прогона должно дойти до клиента');
    assert.equal(pick(stream.events.at(-1)?.data, 'projects', 0, 'runs', 0, 'runId'), 'новый');
  });

  it('при подписке на прогон присылает и его снимок', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const key = projectKey(projectRoot);
    const server = await startServer(t, { runsRoot });

    const stream = openStream(t, server, `/api/events?run=${address(key, 'a')}`);
    await settle();

    assert.deepEqual(
      stream.events.map((item) => item.event),
      ['overview', 'run'],
    );
    assert.equal(pick(stream.events[1]?.data, 'runId'), 'a');
  });

  // Сценарий: «Закрытая вкладка не роняет демон»
  it('переживает отключение клиента и принимает следующего', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const watcher = startWatcher(t, runsRoot, 20);
    const server = await startServer(t, { runsRoot, watcher });

    const first = openStream(t, server, '/api/events');
    await settle();
    first.close();
    await settle();

    seedRun(runsRoot, projectRoot, { runId: 'a' });
    await settle(300);

    const after = await fetchJson(server, '/api/overview');
    assert.equal(after.code, 200);
    assert.equal(pick(after.json, 'projects', 0, 'runs', 0, 'runId'), 'a');
  });

  // Требование ui-daemon: изменения ограничены двумя названными действиями
  it('отклоняет изменяющий метод на маршруте, где изменений не бывает', async (t) => {
    const { runsRoot } = makeJournalBed();
    const server = await startServer(t, { runsRoot });

    const code = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: LOOPBACK, port: server.port, path: '/api/overview', method: 'DELETE' },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });

    assert.equal(code, 405);
  });
});

/**
 * Пайплайн для экрана пайплайнов: демон ищет его в самом проекте, а не в
 * журнале, поэтому его приходится класть на диск проекта.
 */
const DEMO_PIPELINE = `version: 1
kind: pipeline
name: demo
jobs:
  build:
    steps:
      - id: compile
        run: [echo, ok]
  check:
    needs: [build]
    steps:
      - id: verify
        run: [echo, ok]
`;

describe('ui-dashboard: удаление прогона', () => {
  it('снимает прогон с диска и из обзора', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    seedRun(runsRoot, projectRoot, { runId: 'b' });
    const key = projectKey(projectRoot);
    const server = await startServer(t, { runsRoot });

    const removed = await sendJson(server, {
      method: 'DELETE',
      path: `/api/run?run=${address(key, 'a')}`,
    });
    assert.equal(removed.code, 200);
    assert.equal(existsSync(runPaths(runsRoot, key, 'a').dir), false);

    const overview = await fetchJson(server, '/api/overview');
    const ids = (pick(overview.json, 'projects', 0, 'runs') as Array<{ runId: string }>).map(
      (run) => run.runId,
    );
    assert.deepEqual(ids, ['b']);
  });

  it('не удаляет идущий прогон', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a', status: 'running' });
    const key = projectKey(projectRoot);
    const server = await startServer(t, { runsRoot });

    const refused = await sendJson(server, {
      method: 'DELETE',
      path: `/api/run?run=${address(key, 'a')}`,
    });
    assert.equal(refused.code, 409);
    assert.equal(existsSync(runPaths(runsRoot, key, 'a').dir), true);
  });

  it('отклоняет адрес, ведущий за пределы корня прогонов', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const server = await startServer(t, { runsRoot });

    const refused = await sendJson(server, {
      method: 'DELETE',
      path: `/api/run?run=${encodeURIComponent('../../etc/passwd')}`,
    });
    assert.equal(refused.code, 400);
  });

  it('отклоняет изменение, пришедшее со стороннего адреса', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const key = projectKey(projectRoot);
    const server = await startServer(t, { runsRoot });

    const refused = await sendJson(server, {
      method: 'DELETE',
      path: `/api/run?run=${address(key, 'a')}`,
      origin: 'https://example.test',
    });
    assert.equal(refused.code, 403);
    assert.equal(existsSync(runPaths(runsRoot, key, 'a').dir), true);
  });
});

describe('ui-dashboard: настройки дефолтов', () => {
  it('отдаёт действующие значения с их источниками', async (t) => {
    const { runsRoot, home } = makeJournalBed();
    const server = await startServer(t, { runsRoot, home });

    const settings = await fetchJson(server, '/api/settings');
    assert.equal(settings.code, 200);
    assert.equal(pick(settings.json, 'agent', 'value'), 'claude');
    assert.equal(pick(settings.json, 'agent', 'source'), 'встроенное умолчание');
    assert.equal(pick(settings.json, 'model', 'value'), undefined);
    assert.equal(settings.json.file, join(home, '.stepcast', 'config.yml'));
    assert.equal(
      (pick(settings.json, 'backends') as Array<{ name: string }>).some(
        (backend) => backend.name === 'claude',
      ),
      true,
    );
  });

  it('записывает модель в глобальный конфиг и сохраняет комментарии', async (t) => {
    const { runsRoot, home } = makeJournalBed();
    const file = join(home, '.stepcast', 'config.yml');
    const before = readFileSync(file, 'utf8');
    writeFileSync(file, `# корень прогонов задан тестом\n${before}`);
    const server = await startServer(t, { runsRoot, home });

    const saved = await sendJson(server, {
      method: 'PUT',
      path: '/api/settings',
      body: JSON.stringify({ agent: 'claude', model: 'opus' }),
    });
    assert.equal(saved.code, 200);
    assert.equal(pick(saved.json, 'model', 'value'), 'opus');
    assert.equal(pick(saved.json, 'model', 'source'), file);

    const text = readFileSync(file, 'utf8');
    assert.match(text, /# корень прогонов задан тестом/);
    assert.match(text, /model: opus/);

    // Значение переживает перечитывание: правится файл, а не память демона.
    const resolved = resolveConfig({ cwd: home, home, projectPath: null });
    assert.equal(resolved.config.defaults.model, 'opus');
  });

  it('снимает модель пустым значением, возвращая пайплайны к модели бэкенда', async (t) => {
    const { runsRoot, home } = makeJournalBed();
    const server = await startServer(t, { runsRoot, home });

    await sendJson(server, {
      method: 'PUT',
      path: '/api/settings',
      body: JSON.stringify({ model: 'opus' }),
    });
    const cleared = await sendJson(server, {
      method: 'PUT',
      path: '/api/settings',
      body: JSON.stringify({ model: null }),
    });

    assert.equal(cleared.code, 200);
    assert.equal(pick(cleared.json, 'model', 'value'), undefined);
    assert.doesNotMatch(readFileSync(join(home, '.stepcast', 'config.yml'), 'utf8'), /model:/);
  });

  it('отклоняет агента, которого не объявлял ни один бэкенд', async (t) => {
    const { runsRoot, home } = makeJournalBed();
    const server = await startServer(t, { runsRoot, home });

    const refused = await sendJson(server, {
      method: 'PUT',
      path: '/api/settings',
      body: JSON.stringify({ agent: 'нет-такого' }),
    });

    assert.equal(refused.code, 400);
    assert.match(String(refused.json.error), /нет-такого/);
    assert.doesNotMatch(readFileSync(join(home, '.stepcast', 'config.yml'), 'utf8'), /agent:/);
  });
});

describe('ui-dashboard: пайплайны проектов', () => {
  it('находит пайплайн проекта и показывает его работы', async (t) => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(join(projectRoot, 'stepcast.yml'), DEMO_PIPELINE);
    const { config } = resolveConfig({ cwd: projectRoot, home, projectPath: null });
    const server = await startServer(t, { runsRoot, config, home });

    const pipelines = await fetchJson(server, '/api/pipelines');
    assert.equal(pipelines.code, 200);
    assert.equal(pick(pipelines.json, 'pipelines', 0, 'name'), 'demo');
    assert.equal(pick(pipelines.json, 'pipelines', 0, 'file'), 'stepcast.yml');
    assert.deepEqual(
      (pick(pipelines.json, 'pipelines', 0, 'jobs') as Array<{ id: string }>).map((job) => job.id),
      ['build', 'check'],
    );
    // Раскладка приходит готовой: браузеру остаётся отрисовка.
    assert.equal(pick(pipelines.json, 'pipelines', 0, 'graph', 'nodes', 1, 'column'), 1);
  });

  it('показывает неразбираемый пайплайн с ошибкой, а не пропускает его молча', async (t) => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(join(projectRoot, 'stepcast.yml'), 'version: 1\nkind: pipeline\nname: broken\n');
    const { config } = resolveConfig({ cwd: projectRoot, home, projectPath: null });
    const server = await startServer(t, { runsRoot, config, home });

    const pipelines = await fetchJson(server, '/api/pipelines');
    assert.equal(pipelines.code, 200);
    assert.equal(typeof pick(pipelines.json, 'pipelines', 0, 'error'), 'string');
  });

  it('не принимает за пайплайн определение работы в том же каталоге', async (t) => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(
      join(projectRoot, 'stepcast.yml'),
      'version: 1\nkind: job\nid: solo\nsteps: []\n',
    );
    const { config } = resolveConfig({ cwd: projectRoot, home, projectPath: null });
    const server = await startServer(t, { runsRoot, config, home });

    const pipelines = await fetchJson(server, '/api/pipelines');
    assert.deepEqual(pipelines.json.pipelines, []);
  });
});
