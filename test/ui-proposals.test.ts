import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { get, request } from 'node:http';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { createUiServer, LOOPBACK, type UiServer } from '../src/parts/ui/daemon/server.js';
import { proposeEntry } from '../src/parts/pipeline/domain/proposals/store.js';
import { makeJournalBed, seedRun } from './helpers.js';

/**
 * Маршруты экрана «Предложения» (`ui-proposals`, design.md Решение 2, 15):
 * `GET /api/proposals` отдаёт очередь всех проектов вместе с текущим
 * содержимым цели, `POST /api/proposals` решает одну названную запись.
 */

async function startServer(t: TestContext, options: { runsRoot: string; home?: string }): Promise<UiServer> {
  const server = await createUiServer({ ...options, port: 0 });
  t.after(() => server.close());
  return server;
}

type Json = Record<string, unknown>;

function fetchPath(server: UiServer, path: string): Promise<{ code: number; body: string }> {
  return new Promise((resolve, reject) => {
    get({ host: LOOPBACK, port: server.port, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ code: res.statusCode ?? 0, body }));
    }).on('error', reject);
  });
}

async function fetchJson(server: UiServer, path: string): Promise<{ code: number; json: Json }> {
  const { code, body } = await fetchPath(server, path);
  return { code, json: JSON.parse(body) as Json };
}

function send(server: UiServer, options: { method: string; path: string; body?: string }): Promise<{ code: number; body: string }> {
  return new Promise((resolve, reject) => {
    const body = options.body ?? '';
    const req = request(
      {
        host: LOOPBACK,
        port: server.port,
        path: options.path,
        method: options.method,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        let responseBody = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (responseBody += chunk));
        res.on('end', () => resolve({ code: res.statusCode ?? 0, body: responseBody }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function sendJson(server: UiServer, options: { method: string; path: string; body?: string }): Promise<{ code: number; json: Json }> {
  const { code, body } = await send(server, options);
  return { code, json: JSON.parse(body === '' ? '{}' : body) as Json };
}

function pick(value: unknown, ...path: readonly (string | number)[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    assert.ok(current !== null && typeof current === 'object', `нет пути ${path.join('.')}`);
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

describe('ui-proposals: GET /api/proposals', () => {
  it('отдаёт очередь проекта вместе с текущим содержимым цели', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    mkdirSync(join(projectRoot, '.stepcast', 'widgets'), { recursive: true });
    writeFileSync(join(projectRoot, '.stepcast', 'widgets', 'clock.tsx'), 'export default 0;\n');
    proposeEntry(projectRoot, { target: '.stepcast/widgets/clock.tsx', content: 'export default 1;\n' });

    const server = await startServer(t, { runsRoot });
    const { code, json } = await fetchJson(server, '/api/proposals');
    assert.equal(code, 200);

    const projects = json.projects as Array<Json>;
    assert.equal(projects.length, 1);
    const records = projects[0]?.records as Array<Json>;
    assert.equal(records.length, 1);
    assert.equal(records[0]?.target, '.stepcast/widgets/clock.tsx');
    assert.equal(records[0]?.currentContent, 'export default 0;\n');
    assert.equal(records[0]?.content, 'export default 1;\n');
    assert.equal(pick(projects[0], 'mode'), 'queue');
  });

  /**
   * Режим доставки берётся из `.stepcast/config.yml` проекта, и неразбираемый
   * файл одного проекта не вправе гасить очереди остальных: причина идёт
   * негодной записью с именем файла — тем же правилом, каким показывается
   * негодная запись очереди.
   */
  it('неразбираемая конфигурация проекта не гасит очередь: режим queue и названная причина', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    proposeEntry(projectRoot, { target: '.stepcast/widgets/clock.tsx', content: 'export default 1;\n' });
    writeFileSync(join(projectRoot, '.stepcast', 'config.yml'), 'project: [не отображение вовсе]\n');

    const server = await startServer(t, { runsRoot });
    const { code, json } = await fetchJson(server, '/api/proposals');
    assert.equal(code, 200);

    const project = (json.projects as Array<Json>)[0] as Json;
    assert.equal((project.records as Array<Json>).length, 1, 'записи очереди обязаны остаться видны');
    assert.equal(project.mode, 'queue');
    const invalid = project.invalid as Array<Json>;
    assert.equal(invalid.length, 1);
    assert.equal(invalid[0]?.file, '.stepcast/config.yml');
    assert.match(String(invalid[0]?.reason), /cannot be parsed/);
  });

  it('предложение создания файла ещё не существующего — currentContent пуст (null)', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    proposeEntry(projectRoot, { target: '.stepcast/dashboards/release.yml', content: 'title: r\n' });

    const server = await startServer(t, { runsRoot });
    const { json } = await fetchJson(server, '/api/proposals');
    const records = (json.projects as Array<Json>)[0]?.records as Array<Json>;
    assert.equal(records[0]?.currentContent, null);
  });
});

describe('ui-proposals: POST /api/proposals — принятие', () => {
  it('принятие пишет цель, переводит запись в accepted и будит наблюдателя', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const record = proposeEntry(projectRoot, {
      target: '.stepcast/widgets/clock.tsx',
      content: 'export default 1;\n',
    });

    const server = await startServer(t, { runsRoot });
    const before = await fetchJson(server, '/api/proposals');
    const projectKeyValue = (before.json.projects as Array<Json>)[0]?.projectKey as string;

    const written = await sendJson(server, {
      method: 'POST',
      path: '/api/proposals',
      body: JSON.stringify({ project: projectKeyValue, id: record.id, decision: 'accept' }),
    });
    assert.equal(written.code, 200);
    assert.equal(readFileSync(join(projectRoot, '.stepcast', 'widgets', 'clock.tsx'), 'utf8'), 'export default 1;\n');

    const after = await fetchJson(server, '/api/proposals');
    const records = (after.json.projects as Array<Json>)[0]?.records as Array<Json>;
    assert.equal(records.find((r) => r.id === record.id)?.state, 'accepted');
  });

  it('принятие создаёт недостающий каталог дашбордов', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const record = proposeEntry(projectRoot, { target: '.stepcast/dashboards/release.yml', content: 'title: r\n' });
    assert.equal(existsSync(join(projectRoot, '.stepcast', 'dashboards')), false);

    const server = await startServer(t, { runsRoot });
    const overview = await fetchJson(server, '/api/proposals');
    const projectKeyValue = (overview.json.projects as Array<Json>)[0]?.projectKey as string;

    const written = await sendJson(server, {
      method: 'POST',
      path: '/api/proposals',
      body: JSON.stringify({ project: projectKeyValue, id: record.id, decision: 'accept' }),
    });
    assert.equal(written.code, 200);
    assert.equal(readFileSync(join(projectRoot, '.stepcast', 'dashboards', 'release.yml'), 'utf8'), 'title: r\n');
  });

  it('принятие не изменяет ни одного иного файла проекта', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(join(projectRoot, 'backlog.md'), '# Очередь\n');
    mkdirSync(join(projectRoot, '.stepcast', 'widgets'), { recursive: true });
    writeFileSync(join(projectRoot, '.stepcast', 'widgets', 'other.tsx'), 'export default 0;\n');
    const record = proposeEntry(projectRoot, {
      target: '.stepcast/widgets/clock.tsx',
      content: 'export default 1;\n',
    });

    const server = await startServer(t, { runsRoot });
    const overview = await fetchJson(server, '/api/proposals');
    const projectKeyValue = (overview.json.projects as Array<Json>)[0]?.projectKey as string;

    const beforeOther = readFileSync(join(projectRoot, '.stepcast', 'widgets', 'other.tsx'), 'utf8');
    const beforeBacklog = readFileSync(join(projectRoot, 'backlog.md'), 'utf8');

    await sendJson(server, {
      method: 'POST',
      path: '/api/proposals',
      body: JSON.stringify({ project: projectKeyValue, id: record.id, decision: 'accept' }),
    });

    assert.equal(readFileSync(join(projectRoot, '.stepcast', 'widgets', 'other.tsx'), 'utf8'), beforeOther);
    assert.equal(readFileSync(join(projectRoot, 'backlog.md'), 'utf8'), beforeBacklog);
  });

  it('отказ по разошедшемуся отпечатку — запись остаётся открытой, файл не тронут', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    mkdirSync(join(projectRoot, '.stepcast', 'widgets'), { recursive: true });
    writeFileSync(join(projectRoot, '.stepcast', 'widgets', 'clock.tsx'), 'original\n');
    const record = proposeEntry(projectRoot, { target: '.stepcast/widgets/clock.tsx', content: 'proposed\n' });
    writeFileSync(join(projectRoot, '.stepcast', 'widgets', 'clock.tsx'), 'изменено руками\n');

    const server = await startServer(t, { runsRoot });
    const overview = await fetchJson(server, '/api/proposals');
    const projectKeyValue = (overview.json.projects as Array<Json>)[0]?.projectKey as string;

    const written = await sendJson(server, {
      method: 'POST',
      path: '/api/proposals',
      body: JSON.stringify({ project: projectKeyValue, id: record.id, decision: 'accept' }),
    });
    assert.equal(written.code, 400);
    assert.match(String(written.json.error), /изменился с момента предложения/);
    assert.equal(readFileSync(join(projectRoot, '.stepcast', 'widgets', 'clock.tsx'), 'utf8'), 'изменено руками\n');

    const after = await fetchJson(server, '/api/proposals');
    const records = (after.json.projects as Array<Json>)[0]?.records as Array<Json>;
    assert.equal(records.find((r) => r.id === record.id)?.state, 'pending');
  });

  it('отказ принятия создания файла, который к моменту решения уже появился', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const record = proposeEntry(projectRoot, { target: '.stepcast/dashboards/release.yml', content: 'title: p\n' });
    mkdirSync(join(projectRoot, '.stepcast', 'dashboards'), { recursive: true });
    writeFileSync(join(projectRoot, '.stepcast', 'dashboards', 'release.yml'), 'title: созданный руками\n');

    const server = await startServer(t, { runsRoot });
    const overview = await fetchJson(server, '/api/proposals');
    const projectKeyValue = (overview.json.projects as Array<Json>)[0]?.projectKey as string;

    const written = await sendJson(server, {
      method: 'POST',
      path: '/api/proposals',
      body: JSON.stringify({ project: projectKeyValue, id: record.id, decision: 'accept' }),
    });
    assert.equal(written.code, 400);
    assert.equal(
      readFileSync(join(projectRoot, '.stepcast', 'dashboards', 'release.yml'), 'utf8'),
      'title: созданный руками\n',
    );
  });
});

describe('ui-proposals: POST /api/proposals — отклонение', () => {
  it('отклонение переводит запись в rejected и не трогает цель', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    mkdirSync(join(projectRoot, '.stepcast', 'widgets'), { recursive: true });
    writeFileSync(join(projectRoot, '.stepcast', 'widgets', 'clock.tsx'), 'original\n');
    const record = proposeEntry(projectRoot, { target: '.stepcast/widgets/clock.tsx', content: 'proposed\n' });

    const server = await startServer(t, { runsRoot });
    const overview = await fetchJson(server, '/api/proposals');
    const projectKeyValue = (overview.json.projects as Array<Json>)[0]?.projectKey as string;

    const written = await sendJson(server, {
      method: 'POST',
      path: '/api/proposals',
      body: JSON.stringify({ project: projectKeyValue, id: record.id, decision: 'reject' }),
    });
    assert.equal(written.code, 200);
    assert.equal(readFileSync(join(projectRoot, '.stepcast', 'widgets', 'clock.tsx'), 'utf8'), 'original\n');

    const after = await fetchJson(server, '/api/proposals');
    const records = (after.json.projects as Array<Json>)[0]?.records as Array<Json>;
    assert.equal(records.find((r) => r.id === record.id)?.state, 'rejected');
  });
});
