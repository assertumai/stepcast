import assert from 'node:assert/strict';
import { get, request } from 'node:http';
import { describe, it, type TestContext } from 'node:test';

import { createUiServer, LOOPBACK, type UiServer } from '../src/ui/server.js';
import { createWatcher, type Watcher } from '../src/ui/watcher.js';
import { projectKey } from '../src/core/journal/paths.js';
import { makeJournalBed, seedRun } from './helpers.js';

/**
 * Сервер с закрытием, зарегистрированным сразу. Без этого упавшая проверка
 * оставляет слушающий сокет, и весь файл тестов повисает вместо отчёта об
 * отказе — то есть отказ теряется ровно тогда, когда он нужен.
 */
async function startServer(
  t: TestContext,
  options: { runsRoot: string; watcher?: Watcher },
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

const settle = (ms = 80): Promise<void> => new Promise((done) => setTimeout(done, ms));

describe('ui-dashboard: HTTP-витрина', () => {
  it('отдаёт страницу и обзор, слушая только петлю', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const server = await startServer(t, { runsRoot });

    const page = await fetchPath(server, '/');
    assert.equal(page.code, 200);
    assert.match(page.body, /<title>stepcast<\/title>/);

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

  // Требование ui-daemon: «Наблюдение не изменяет журнал»
  it('отклоняет методы, изменяющие состояние', async (t) => {
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
