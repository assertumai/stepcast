import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { get, request } from 'node:http';
import { describe, it, type TestContext } from 'node:test';

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { dashboardPath } from '../src/ui/assets.js';
import { createUiServer, LOOPBACK, type UiServer } from '../src/ui/server.js';
import { runHref } from '../src/ui/routes.js';
import { createWatcher, type Watcher } from '../src/ui/watcher.js';
import { resolveConfig, type Config } from '../src/core/config/resolve.js';
import { projectKey, runPaths, stepDir } from '../src/core/journal/paths.js';
import { MAX_FILE_BYTES } from '../src/ui/file.js';
import { makeJournalBed, seedRun } from './helpers.js';
import { tempDir } from './tmp.js';

/**
 * Сервер с закрытием, зарегистрированным сразу. Без этого упавшая проверка
 * оставляет слушающий сокет, и весь файл тестов повисает вместо отчёта об
 * отказе — то есть отказ теряется ровно тогда, когда он нужен.
 */
async function startServer(
  t: TestContext,
  options: {
    runsRoot: string;
    watcher?: Watcher;
    config?: Config;
    home?: string;
    dashboardFile?: string;
  },
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

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  };
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Тест');
  writeFileSync(join(dir, 'a.txt'), 'x\n');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'начало');
}

function addWorktreeFor(repoDir: string, path: string): void {
  execFileSync('git', ['-C', repoDir, 'worktree', 'add', '--detach', '--quiet', path, 'HEAD']);
}

function worktreeRecords(repoDir: string): string[] {
  try {
    return readdirSync(join(repoDir, '.git', 'worktrees'));
  } catch {
    return [];
  }
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
    const body = options.body ?? '';
    const req = request(
      {
        host: LOOPBACK,
        port: server.port,
        path: options.path,
        method: options.method,
        headers: {
          'content-type': 'application/json',
          // DELETE без явного Content-Length теряет тело в http.request:
          // клиент отправляет запрос вовсе без него, будто тела не было.
          'content-length': Buffer.byteLength(body),
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
    req.end(body);
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

/**
 * Отсутствие собранной витрины проверяется на файле, которого нет, а не
 * удалением настоящего артефакта: демон принимает путь страницы параметром
 * (`dashboardFile`). Поэтому сценарий не зависит ни от порядка блоков в файле
 * (кеш разметки ведётся по файлу), ни от того, собран ли фронт на машине, и
 * не может оставить дерево без `dist/ui-web/index.html`, оборвись процесс
 * посреди проверки.
 */
describe('ui-dashboard: витрина не собрана', () => {
  it('отвечает 503 с командой сборки из package.json, не задевая API', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const key = projectKey(projectRoot);
    const server = await startServer(t, {
      runsRoot,
      dashboardFile: join(runsRoot, 'несобранная-витрина', 'index.html'),
    });

    const page = await fetchPath(server, '/');
    assert.equal(page.code, 503);

    const scriptMatch = /npm run ([\w:-]+)/.exec(page.body);
    assert.ok(scriptMatch !== null, 'текст отказа должен называть npm-команду сборки');
    const scriptName = (scriptMatch as RegExpExecArray)[1] as string;
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    assert.ok(
      Object.prototype.hasOwnProperty.call(pkg.scripts ?? {}, scriptName),
      `команда «${scriptName}», названная в отказе, не объявлена в package.json`,
    );

    const overview = await fetchJson(server, '/api/overview');
    assert.equal(overview.code, 200);

    const run = await fetchJson(server, `/api/run?run=${address(key, 'a')}`);
    assert.equal(run.code, 200);
  });
});

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

  // Обзор называет файл, которым запущен прогон: по нему первый экран
  // связывает прогон с пайплайном — имя для этого не годится (см.
  // `src/ui/grouping.ts` и `test/ui-grouping.test.ts`).
  it('называет в обзоре файл пайплайна относительно корня проекта', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    seedRun(runsRoot, projectRoot, {
      runId: 'b',
      manifest: { pipeline_file: join(projectRoot, '.stepcast', 'pipelines', 'ночной.yml') },
    });
    const server = await startServer(t, { runsRoot });

    const overview = await fetchJson(server, '/api/overview');
    const files = new Map(
      (pick(overview.json, 'projects', 0, 'runs') as Array<{ runId: string; pipelineFile?: string }>).map(
        (run) => [run.runId, run.pipelineFile],
      ),
    );

    assert.equal(files.get('a'), 'stepcast.yml');
    assert.equal(files.get('b'), '.stepcast/pipelines/ночной.yml');
  });

  // Файл вне корня проекта относительным не притворяется: он и не должен
  // совпасть ни с одним найденным пайплайном.
  it('оставляет файл пайплайна вне корня проекта абсолютным', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const outside = join(dirname(projectRoot), 'чужой.yml');
    seedRun(runsRoot, projectRoot, { runId: 'a', manifest: { pipeline_file: outside } });
    const server = await startServer(t, { runsRoot });

    const overview = await fetchJson(server, '/api/overview');
    assert.equal(pick(overview.json, 'projects', 0, 'runs', 0, 'pipelineFile'), outside);
  });

  // Требование ui-daemon: адрес страницы прогона разбирается общим модулем.
  it('отдаёт страницу витрины на адрес страницы прогона', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const key = projectKey(projectRoot);
    const dashboard = ensureDashboard(t);
    const server = await startServer(t, { runsRoot });

    const page = await fetchPath(server, runHref(key, 'a'));
    assert.equal(page.code, 200);
    assert.equal(page.body, readFileSync(dashboard, 'utf8'));
  });

  // Требование ui-daemon: отсутствие маршрута под /api/ — ошибка, а не страница.
  it('отвечает 404 на несуществующий маршрут API, а не страницей витрины', async (t) => {
    const { runsRoot } = makeJournalBed();
    const server = await startServer(t, { runsRoot });

    const missing = await fetchJson(server, `/api/${encodeURIComponent('нет-такого')}`);
    assert.equal(missing.code, 404);
    assert.equal(typeof missing.json.error, 'string');

    // Сценарий: «Голый `/api`» — корня у API нет, и страница витрины на этот
    // адрес была бы той же подменой ошибки разметкой.
    const bare = await fetchJson(server, '/api');
    assert.equal(bare.code, 404);
    assert.equal(typeof bare.json.error, 'string');
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

  // Сценарий ui-dashboard «Раскрытие прогона без файлов»: каталога нет, запись
  // хранилища есть — снимок собирается по ней, а не отказывает 404.
  it('раскрывает прогон без файлов по записи хранилища и отказывает, когда нет и записи', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, {
      runId: 'a',
      usage: {
        run_id: 'a',
        total: {
          tokens_in: 10,
          tokens_out: 5,
          cache_read: 0,
          cache_write: 0,
          billable_tokens: 15,
          wallclock_ms: 1000,
          cost_usd: 0.25,
        },
        unreported: [],
        jobs: {
          build: {
            billable_tokens: 15,
            wallclock_ms: 1000,
            cost_usd: 0.25,
            steps: {
              write: {
                billable_tokens: 15,
                wallclock_ms: 1000,
                cost_usd: 0.25,
                attempts: [
                  {
                    attempt: 1,
                    backend: 'claude',
                    model: 'opus',
                    billable_tokens: 15,
                    wallclock_ms: 1000,
                    cost_usd: 0.25,
                  },
                ],
              },
            },
          },
        },
      },
    });
    seedRun(runsRoot, projectRoot, { runId: 'b' });
    const key = projectKey(projectRoot);
    const server = await startServer(t, { runsRoot });

    // Файлы сняты, статистика сохранена — умолчание удаления.
    const removed = await sendJson(server, { method: 'DELETE', path: `/api/run?run=${address(key, 'a')}` });
    assert.equal(removed.json.stats, 'kept');
    assert.equal(existsSync(runPaths(runsRoot, key, 'a').dir), false);

    const byRecord = await fetchJson(server, `/api/run?run=${address(key, 'a')}`);
    assert.equal(byRecord.code, 200, 'прогон без файлов, но с записью, раскрывается сохранённой сводкой');
    assert.equal(byRecord.json.filesGone, true);
    assert.equal(pick(byRecord.json, 'total', 'billableTokens'), 15);
    assert.equal(pick(byRecord.json, 'total', 'costUsd'), 0.25);
    assert.equal(pick(byRecord.json, 'models', 0, 'model'), 'opus');
    assert.equal(pick(byRecord.json, 'jobs', 0, 'id'), 'build');
    assert.equal(pick(byRecord.json, 'jobs', 0, 'steps', 0, 'id'), 'write');

    // Ни каталога, ни записи — только тогда отказ.
    const dropped = await sendJson(server, {
      method: 'DELETE',
      path: '/api/usage-records',
      body: JSON.stringify({ records: [`${key}/a`] }),
    });
    assert.equal(dropped.code, 200);

    const gone = await fetchJson(server, `/api/run?run=${address(key, 'a')}`);
    assert.equal(gone.code, 404, '404 остаётся, когда нет ни каталога, ни записи');
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

/**
 * Плагин на диске проекта витрины: `.stepcast/config.yml` с `plugins` и
 * модуль рядом — тем же образом, каким `withPlugin` заводит плагин для CLI
 * (`test/cli-plugins.test.ts`), только поверх уже готового `projectRoot`
 * журнальной завязки (`makeJournalBed`), а не свежего `Project`.
 */
function withProjectPlugin(projectRoot: string, body: string, moduleName = 'probe'): void {
  mkdirSync(join(projectRoot, '.stepcast'), { recursive: true });
  writeFileSync(join(projectRoot, '.stepcast', 'config.yml'), `plugins: ["./plugins/${moduleName}.mjs"]\n`);
  const path = join(projectRoot, '.stepcast', 'plugins', `${moduleName}.mjs`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

/** Плагин с одним предикатом `always_ok`: минимум, достаточный, чтобы пройти схему документа. */
const PREDICATE_PLUGIN = `
export default {
  name: 'probe',
  predicates: [
    {
      name: 'always_ok',
      schema: { type: 'boolean' },
      evaluate: () => ({ predicate: 'always_ok', passed: true, hard: true }),
    },
  ],
};
`;

/** Плагин с бэкендом `probe`, чьё умолчание модели — `probe-model`. */
const BACKEND_PLUGIN = `
export default {
  name: 'probe',
  backends: {
    probe: {
      create: () => ({}),
      defaults: { default_model: 'probe-model' },
    },
  },
};
`;

/**
 * Плагин, отмечающий сам факт своей загрузки: отметка пишется при исполнении
 * модуля, то есть ровно тогда, когда демон его импортировал. Отсутствие файла
 * и есть доказательство, что импорта не было, — иного следа загрузка чужого
 * кода не оставляет.
 */
function markerPlugin(marker: string): string {
  return `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, 'загружен');
export default {
  name: 'probe',
  predicates: [
    {
      name: 'always_ok',
      schema: { type: 'boolean' },
      evaluate: () => ({ predicate: 'always_ok', passed: true, hard: true }),
    },
  ],
};
`;
}

/**
 * Слепок журнала: путь файла относительно корня прогонов и его содержимое.
 * Сверка двух слепков отвечает на вопрос «журнал остался тем же» — включая
 * появление и исчезновение файлов, а не только правку существующих.
 */
function journalSnapshot(runsRoot: string): Array<readonly [string, string]> {
  return readdirSync(runsRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return [relative(runsRoot, path), readFileSync(path, 'utf8')] as const;
    })
    .sort((a, b) => a[0].localeCompare(b[0]));
}

/** Пайплайн из одного шага с предикатом `always_ok` в `expect`. */
const PREDICATE_PIPELINE = `version: 1
kind: pipeline
name: демо
jobs:
  build:
    steps:
      - id: check
        run: [echo, ok]
        expect: [{ always_ok: true }]
`;

describe('ui-dashboard: удаление прогона', () => {
  // Требование ui-dashboard «Отказ от статистики требует отдельного
  // действия»: удаление без указания судьбы статистики сохраняет её, и
  // прогон остаётся в обзоре — файлов нет, а запись есть (Решение 10).
  it('снимает прогон с диска, но по умолчанию сохраняет его статистику и место в обзоре', async (t) => {
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
    assert.equal(removed.json.stats, 'kept');
    assert.equal(existsSync(runPaths(runsRoot, key, 'a').dir), false);

    const overview = await fetchJson(server, '/api/overview');
    const runs = pick(overview.json, 'projects', 0, 'runs') as Array<{ runId: string; filesGone: boolean }>;
    assert.deepEqual(
      runs.map((run) => run.runId).sort(),
      ['a', 'b'],
    );
    assert.equal(runs.find((run) => run.runId === 'a')?.filesGone, true);
  });

  it('stats: drop снимает и статистику — прогон целиком пропадает из обзора', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    seedRun(runsRoot, projectRoot, { runId: 'b' });
    const key = projectKey(projectRoot);
    const server = await startServer(t, { runsRoot });

    const removed = await sendJson(server, {
      method: 'DELETE',
      path: `/api/run?run=${address(key, 'a')}&stats=drop`,
    });
    assert.equal(removed.code, 200);
    assert.equal(removed.json.stats, 'removed');
    assert.equal(existsSync(runPaths(runsRoot, key, 'a').dir), false);

    const overview = await fetchJson(server, '/api/overview');
    const ids = (pick(overview.json, 'projects', 0, 'runs') as Array<{ runId: string }>).map(
      (run) => run.runId,
    );
    assert.deepEqual(ids, ['b']);
  });

  // Сценарий: «Идущий прогон» — живость определяется процессом, не статусом.
  it('не удаляет прогон с живым процессом', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, {
      runId: 'a',
      status: 'running',
      manifest: { started_at: new Date().toISOString(), pid: process.pid },
    });
    const key = projectKey(projectRoot);
    const server = await startServer(t, { runsRoot });

    const refused = await sendJson(server, {
      method: 'DELETE',
      path: `/api/run?run=${address(key, 'a')}`,
    });
    assert.equal(refused.code, 409);
    assert.equal(existsSync(runPaths(runsRoot, key, 'a').dir), true);
  });

  // Сценарий: «Оборванный прогон»
  it('удаляет прогон, застрявший в running после гибели процесса', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, {
      runId: 'a',
      status: 'running',
      manifest: { started_at: new Date().toISOString(), pid: 999_999_999 },
    });
    const key = projectKey(projectRoot);
    const server = await startServer(t, { runsRoot });

    const removed = await sendJson(server, {
      method: 'DELETE',
      path: `/api/run?run=${address(key, 'a')}`,
    });
    assert.equal(removed.code, 200);
    assert.equal(existsSync(runPaths(runsRoot, key, 'a').dir), false);
  });

  // Сценарий: «Прогон прежней формы без идентификатора процесса»
  it('удаляет прогон в running без pid в манифесте', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a', status: 'running' });
    const key = projectKey(projectRoot);
    const server = await startServer(t, { runsRoot });

    const removed = await sendJson(server, {
      method: 'DELETE',
      path: `/api/run?run=${address(key, 'a')}`,
    });
    assert.equal(removed.code, 200);
    assert.equal(existsSync(runPaths(runsRoot, key, 'a').dir), false);
  });

  // Сценарий: «Спящий прогон»
  it('не удаляет спящий прогон с живым процессом', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, {
      runId: 'a',
      status: 'running',
      wakeAt: '2026-08-23T22:00:00.000Z',
      manifest: { started_at: new Date().toISOString(), pid: process.pid },
    });
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

  // run-cleanup: удаление через API снимает записи рабочих деревьев тем же
  // ядром (`removeRun`), что и `stepcast gc` — не отдельной копией логики.
  it('снимает записи рабочих деревьев корня и части вместе с прогоном', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const partRepo = tempDir('ui-part-');
    initGitRepo(projectRoot);
    initGitRepo(partRepo);

    const key = projectKey(projectRoot);
    const paths = runPaths(runsRoot, key, 'a');
    const workDir = join(paths.dir, 'workspace', 'build');
    const partDir = join(workDir, 'public-site');
    mkdirSync(dirname(workDir), { recursive: true });
    addWorktreeFor(projectRoot, workDir);
    addWorktreeFor(partRepo, partDir);

    seedRun(runsRoot, projectRoot, {
      runId: 'a',
      manifest: { project_root: projectRoot, workspace: { mode: 'worktree' } },
      jobs: [
        {
          id: 'build',
          status: 'success',
          workspace: { mode: 'worktree', path: workDir, nested: [{ dir: 'public-site', repo: partRepo }] },
          steps: [],
        },
      ],
    });
    assert.equal(worktreeRecords(projectRoot).length, 1);
    assert.equal(worktreeRecords(partRepo).length, 1);

    const server = await startServer(t, { runsRoot });
    const removed = await sendJson(server, {
      method: 'DELETE',
      path: `/api/run?run=${address(key, 'a')}`,
    });

    assert.equal(removed.code, 200);
    assert.equal(removed.json.unresolvedWorktrees, undefined);
    assert.deepEqual(worktreeRecords(projectRoot), []);
    assert.deepEqual(worktreeRecords(partRepo), []);
  });
});

describe('ui-dashboard: отбор прогонов к удалению', () => {
  // Сценарии: «Отбор оборванных», «Отбор отказавших», «Прогон под двумя признаками»
  it('отбирает по каждому признаку и по их набору', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    seedRun(runsRoot, projectRoot, {
      runId: 'abandoned',
      status: 'running',
      manifest: { started_at: new Date().toISOString(), pid: 999_999_999 },
    });
    seedRun(runsRoot, projectRoot, { runId: 'failed', status: 'failed' });
    seedRun(runsRoot, projectRoot, { runId: 'success', status: 'success' });
    const server = await startServer(t, { runsRoot });

    const abandoned = await fetchJson(server, '/api/runs?trait=abandoned');
    assert.equal(abandoned.code, 200);
    assert.deepEqual(
      (abandoned.json.runs as Array<{ address: string }>).map((r) => r.address),
      [`${key}/abandoned`],
    );

    const both = await fetchJson(server, '/api/runs?trait=abandoned&trait=failed');
    assert.equal(both.json.count, 2);
    assert.deepEqual(
      (both.json.runs as Array<{ address: string }>).map((r) => r.address).sort(),
      [`${key}/abandoned`, `${key}/failed`].sort(),
    );
  });

  // Сценарий: «Отбор по сроку»
  it('отбирает по сроку старше указанного', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    seedRun(runsRoot, projectRoot, {
      runId: 'old',
      manifest: {
        started_at: '2026-07-01T00:00:00.000Z',
        finished_at: '2026-07-01T00:05:00.000Z',
      },
    });
    const server = await startServer(t, { runsRoot });

    const selected = await fetchJson(server, '/api/runs?older-than=7d');
    assert.deepEqual(
      (selected.json.runs as Array<{ address: string }>).map((r) => r.address),
      [`${key}/old`],
    );
  });

  // Сценарии: «Размер отобранного прогона», «Число и объём в подтверждении»
  it('называет размер каждого отобранного прогона и суммарный объём', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    seedRun(runsRoot, projectRoot, { runId: 'failed', status: 'failed' });
    writeFileSync(join(runPaths(runsRoot, key, 'failed').dir, 'груз.bin'), 'x'.repeat(10_000));
    const server = await startServer(t, { runsRoot });

    const selected = await fetchJson(server, '/api/runs?trait=failed');
    const runs = selected.json.runs as Array<{ address: string; sizeBytes: number }>;

    assert.equal(selected.json.count, 1);
    assert.ok(
      (runs[0]?.sizeBytes ?? 0) >= 10_000,
      'подтверждение без объёма не отвечает на «сколько места уйдёт»',
    );
    assert.equal(selected.json.totalBytes, runs[0]?.sizeBytes);
  });

  // Сценарий: «Отбор по всем проектам»
  it('без указания проекта берёт прогоны обоих проектов корня', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const other = makeJournalBed();
    const key = projectKey(projectRoot);
    const otherKey = projectKey(other.projectRoot);
    seedRun(runsRoot, projectRoot, { runId: 'failed-a', status: 'failed' });
    seedRun(runsRoot, other.projectRoot, { runId: 'failed-b', status: 'failed' });
    const server = await startServer(t, { runsRoot });

    const selected = await fetchJson(server, '/api/runs?trait=failed');
    assert.deepEqual(
      (selected.json.runs as Array<{ address: string }>).map((r) => r.address).sort(),
      [`${key}/failed-a`, `${otherKey}/failed-b`].sort(),
    );
  });

  // Сценарий: «Отбор одного проекта»
  it('сужает отбор до указанного проекта', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const other = makeJournalBed();
    const key = projectKey(projectRoot);
    seedRun(runsRoot, projectRoot, { runId: 'failed-a', status: 'failed' });
    seedRun(runsRoot, other.projectRoot, { runId: 'failed-b', status: 'failed' });
    const server = await startServer(t, { runsRoot });

    const selected = await fetchJson(server, `/api/runs?trait=failed&project=${key}`);
    assert.deepEqual(
      (selected.json.runs as Array<{ address: string }>).map((r) => r.address),
      [`${key}/failed-a`],
    );
  });

  // Сценарий: «Ключ проекта за пределами корня»
  it('отклоняет ключ проекта, уводящий за пределы корня прогонов', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const server = await startServer(t, { runsRoot });

    const refused = await fetchJson(
      server,
      `/api/runs?older-than=0s&project=${encodeURIComponent('../..')}`,
    );
    assert.equal(refused.code, 400);
    assert.equal(refused.json.runs, undefined, 'чужие каталоги не должны перечисляться');
  });

  // Сценарий: «Пустой отбор»
  it('пустой отбор отдаёт нулевые число и сумму', async (t) => {
    const { runsRoot } = makeJournalBed();
    const server = await startServer(t, { runsRoot });

    const selected = await fetchJson(server, '/api/runs?trait=failed');
    assert.equal(selected.code, 200);
    assert.equal(selected.json.count, 0);
    assert.equal(selected.json.totalBytes, 0);
    assert.deepEqual(selected.json.runs, []);
  });

  it('отклоняет неизвестный признак', async (t) => {
    const { runsRoot } = makeJournalBed();
    const server = await startServer(t, { runsRoot });

    const refused = await fetchJson(server, '/api/runs?trait=zombie');
    assert.equal(refused.code, 400);
  });

  it('отклоняет неразбираемый срок', async (t) => {
    const { runsRoot } = makeJournalBed();
    const server = await startServer(t, { runsRoot });

    const refused = await fetchJson(server, `/api/runs?older-than=${encodeURIComponent('скоро')}`);
    assert.equal(refused.code, 400);
  });

  // Сценарий: «Отбор ничего не удаляет»
  it('не удаляет ни одного каталога', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'failed', status: 'failed' });
    const key = projectKey(projectRoot);
    const server = await startServer(t, { runsRoot });

    await fetchJson(server, '/api/runs?trait=failed');

    assert.equal(existsSync(runPaths(runsRoot, key, 'failed').dir), true);
  });
});

describe('ui-dashboard: групповое удаление прогонов', () => {
  // Сценарий: «Уборка оборванных разом»
  it('снимает группу прогонов одним запросом', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    seedRun(runsRoot, projectRoot, { runId: 'b' });
    seedRun(runsRoot, projectRoot, { runId: 'c' });
    const server = await startServer(t, { runsRoot });

    const result = await sendJson(server, {
      method: 'DELETE',
      path: '/api/runs',
      body: JSON.stringify({ runs: [`${key}/a`, `${key}/b`, `${key}/c`] }),
    });
    assert.equal(result.code, 200);
    const outcomes = result.json.outcomes as Array<{ address: string; outcome: string }>;
    assert.equal(outcomes.length, 3);
    assert.ok(outcomes.every((o) => o.outcome === 'removed'));
    assert.equal(existsSync(runPaths(runsRoot, key, 'a').dir), false);
    assert.equal(existsSync(runPaths(runsRoot, key, 'b').dir), false);
    assert.equal(existsSync(runPaths(runsRoot, key, 'c').dir), false);
  });

  // Сценарий: «Живой прогон в списке»
  it('пропускает живой прогон и удаляет остальные', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    seedRun(runsRoot, projectRoot, {
      runId: 'alive',
      status: 'running',
      manifest: { started_at: new Date().toISOString(), pid: process.pid },
    });
    seedRun(runsRoot, projectRoot, { runId: 'done' });
    const server = await startServer(t, { runsRoot });

    const result = await sendJson(server, {
      method: 'DELETE',
      path: '/api/runs',
      body: JSON.stringify({ runs: [`${key}/alive`, `${key}/done`] }),
    });
    assert.equal(result.code, 200);
    const outcomes = result.json.outcomes as Array<{ address: string; outcome: string }>;
    assert.equal(outcomes.find((o) => o.address === `${key}/alive`)?.outcome, 'skipped_alive');
    assert.equal(outcomes.find((o) => o.address === `${key}/done`)?.outcome, 'removed');
    assert.equal(existsSync(runPaths(runsRoot, key, 'alive').dir), true);
  });

  // Сценарий: «Прогон исчез до удаления»
  it('отсутствующий адрес даёт skipped_missing, а не отказ запроса', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    const server = await startServer(t, { runsRoot });

    const result = await sendJson(server, {
      method: 'DELETE',
      path: '/api/runs',
      body: JSON.stringify({ runs: [`${key}/нет-такого`] }),
    });
    assert.equal(result.code, 200);
    assert.equal(
      (result.json.outcomes as Array<{ outcome: string }>)[0]?.outcome,
      'skipped_missing',
    );
  });

  it('отклоняет адрес неверной формы без единого удаления', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const server = await startServer(t, { runsRoot });

    const result = await sendJson(server, {
      method: 'DELETE',
      path: '/api/runs',
      body: JSON.stringify({ runs: [`${key}/a`, 'однасегмент'] }),
    });
    assert.equal(result.code, 400);
    assert.equal(existsSync(runPaths(runsRoot, key, 'a').dir), true);
  });

  // Сценарий: «Список сверх предела»
  it('отклоняет список сверх предела без единого удаления', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const server = await startServer(t, { runsRoot });

    const runs = Array.from({ length: 501 }, (_, i) => `${key}/нет-${i}`);
    const result = await sendJson(server, {
      method: 'DELETE',
      path: '/api/runs',
      body: JSON.stringify({ runs }),
    });
    assert.equal(result.code, 413);
    assert.equal(existsSync(runPaths(runsRoot, key, 'a').dir), true);
  });

  it('отклоняет запрос со стороннего Origin', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const server = await startServer(t, { runsRoot });

    const result = await sendJson(server, {
      method: 'DELETE',
      path: '/api/runs',
      body: JSON.stringify({ runs: [`${key}/a`] }),
      origin: 'https://example.test',
    });
    assert.equal(result.code, 403);
    assert.equal(existsSync(runPaths(runsRoot, key, 'a').dir), true);
  });

  // Требование ui-dashboard «Отказ от статистики требует отдельного
  // действия»: групповое удаление без указания судьбы статистики её сохраняет.
  it('групповое удаление без stats сохраняет записи, с drop — снимает', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    seedRun(runsRoot, projectRoot, { runId: 'b' });
    const server = await startServer(t, { runsRoot });

    const kept = await sendJson(server, {
      method: 'DELETE',
      path: '/api/runs',
      body: JSON.stringify({ runs: [`${key}/a`] }),
    });
    assert.equal(kept.code, 200);
    const keptOutcome = (kept.json.outcomes as Array<{ address: string; stats?: string }>)[0];
    assert.equal(keptOutcome?.stats, 'kept');

    const dropped = await sendJson(server, {
      method: 'DELETE',
      path: '/api/runs',
      body: JSON.stringify({ runs: [`${key}/b`], stats: 'drop' }),
    });
    assert.equal(dropped.code, 200);
    const droppedOutcome = (dropped.json.outcomes as Array<{ address: string; stats?: string }>)[0];
    assert.equal(droppedOutcome?.stats, 'removed');
  });

  it('отклоняет негодное значение stats в теле запроса', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const server = await startServer(t, { runsRoot });

    const result = await sendJson(server, {
      method: 'DELETE',
      path: '/api/runs',
      body: JSON.stringify({ runs: [`${key}/a`], stats: 'both' }),
    });
    assert.equal(result.code, 400);
    assert.equal(existsSync(runPaths(runsRoot, key, 'a').dir), true);
  });
});

describe('ui-dashboard: одиночное удаление и судьба статистики', () => {
  it('отклоняет негодное значение stats в query-параметре', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const server = await startServer(t, { runsRoot });

    const result = await sendJson(server, {
      method: 'DELETE',
      path: `/api/run?run=${address(key, 'a')}&stats=${encodeURIComponent('и-то-и-другое')}`,
    });
    assert.equal(result.code, 400);
    assert.equal(existsSync(runPaths(runsRoot, key, 'a').dir), true);
  });
});

describe('ui-dashboard: отбор и снятие записей хранилища расхода', () => {
  // Требование run-cleanup «Отбор progonov к удалению» перенесённое на
  // записи: GET /api/runs называет по каждому кандидату, есть ли у него
  // запись в хранилище.
  it('GET /api/runs называет по каждому кандидату наличие записи в хранилище', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    seedRun(runsRoot, projectRoot, { runId: 'failed', status: 'failed' });
    const server = await startServer(t, { runsRoot });

    // Запись есть — файлы всё ещё на диске, но хранилище уже перенесло её
    // при старте демона.
    const withRecord = await fetchJson(server, '/api/runs?trait=failed');
    const candidate = (withRecord.json.runs as Array<{ address: string; hasUsageRecord: boolean }>)[0];
    assert.equal(candidate?.address, `${key}/failed`);
    assert.equal(candidate?.hasUsageRecord, true);
  });

  it('GET /api/usage-records отбирает по возрасту, исходу и проекту', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    seedRun(runsRoot, projectRoot, {
      runId: 'old-failed',
      status: 'failed',
      manifest: { started_at: '2020-01-01T00:00:00.000Z', finished_at: '2020-01-01T00:05:00.000Z' },
    });
    seedRun(runsRoot, projectRoot, { runId: 'recent-ok', status: 'success' });
    const server = await startServer(t, { runsRoot });

    const byAge = await fetchJson(server, '/api/usage-records?older-than=365d');
    assert.deepEqual(
      (byAge.json.records as Array<{ address: string }>).map((r) => r.address),
      [`${key}/old-failed`],
    );

    const byOutcome = await fetchJson(server, '/api/usage-records?trait=failed');
    assert.deepEqual(
      (byOutcome.json.records as Array<{ address: string }>).map((r) => r.address),
      [`${key}/old-failed`],
    );

    const byProject = await fetchJson(server, `/api/usage-records?trait=failed&project=${key}`);
    assert.equal(byProject.json.count, 1);

    const empty = await fetchJson(server, '/api/usage-records');
    assert.deepEqual(empty.json.records, []);
  });

  it('DELETE /api/usage-records снимает записи по явному списку адресов и не трогает файлов', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    const journal = seedRun(runsRoot, projectRoot, { runId: 'a' });
    seedRun(runsRoot, projectRoot, { runId: 'b' });
    const server = await startServer(t, { runsRoot });

    const result = await sendJson(server, {
      method: 'DELETE',
      path: '/api/usage-records',
      body: JSON.stringify({ records: [`${key}/a`, `${key}/нет-такого`] }),
    });
    assert.equal(result.code, 200);
    const outcomes = result.json.outcomes as Array<{ address: string; outcome: string }>;
    assert.equal(outcomes.find((o) => o.address === `${key}/a`)?.outcome, 'removed');
    assert.equal(outcomes.find((o) => o.address === `${key}/нет-такого`)?.outcome, 'skipped_missing');

    // Файлы прогона не тронуты — снятие записи не снимает статистику вместо файлов.
    assert.equal(existsSync(journal.paths.dir), true);
  });

  it('отклоняет список сверх предела и адрес неверной формы для DELETE /api/usage-records', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const server = await startServer(t, { runsRoot });

    const badAddress = await sendJson(server, {
      method: 'DELETE',
      path: '/api/usage-records',
      body: JSON.stringify({ records: ['однасегмент'] }),
    });
    assert.equal(badAddress.code, 400);

    const tooMany = await sendJson(server, {
      method: 'DELETE',
      path: '/api/usage-records',
      body: JSON.stringify({ records: Array.from({ length: 501 }, (_, i) => `${key}/нет-${i}`) }),
    });
    assert.equal(tooMany.code, 413);
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

  it('раскрывает пайплайн секцией project того проекта, которому он принадлежит', async (t) => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    mkdirSync(join(projectRoot, '.stepcast'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.stepcast', 'config.yml'),
      'project:\n  check: ./gradlew check\n',
    );
    writeFileSync(
      join(projectRoot, 'stepcast.yml'),
      `version: 1
kind: pipeline
name: свой
jobs:
  build:
    steps:
      - id: check
        run: \${project.check}
`,
    );
    // Конфигурация демона проектного слоя не знает — она общая для всех
    // проектов корня прогонов. Команда проверки объявлена в репозитории, и
    // читать её витрина обязана оттуда же.
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });
    const server = await startServer(t, { runsRoot, config, home });

    const pipelines = await fetchJson(server, '/api/pipelines');
    assert.equal(pick(pipelines.json, 'pipelines', 0, 'error'), undefined);
    assert.equal(pick(pipelines.json, 'pipelines', 0, 'name'), 'свой');
    assert.equal(
      pick(pipelines.json, 'pipelines', 0, 'jobs', 0, 'steps', 0, 'command'),
      './gradlew check',
    );
  });

  it('показывает нечитаемую конфигурацию проекта ошибкой, а не чужими значениями', async (t) => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    mkdirSync(join(projectRoot, '.stepcast'), { recursive: true });
    writeFileSync(join(projectRoot, '.stepcast', 'config.yml'), 'project:\n  check: "   "\n');
    writeFileSync(join(projectRoot, 'stepcast.yml'), DEMO_PIPELINE);
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });
    const server = await startServer(t, { runsRoot, config, home });

    const pipelines = await fetchJson(server, '/api/pipelines');
    assert.equal(pick(pipelines.json, 'pipelines', 0, 'file'), 'stepcast.yml');
    assert.match(String(pick(pipelines.json, 'pipelines', 0, 'error')), /схеме/);
  });
});

describe('ui-dashboard: пайплайн раскрыт реестром вкладов своего проекта', () => {
  it('предикат плагина в expect раскрывает пайплайн устройством, а не ошибкой', async (t) => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    withProjectPlugin(projectRoot, PREDICATE_PLUGIN);
    writeFileSync(join(projectRoot, 'stepcast.yml'), PREDICATE_PIPELINE);
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });
    const server = await startServer(t, { runsRoot, config, home });

    const pipelines = await fetchJson(server, '/api/pipelines');
    assert.equal(pick(pipelines.json, 'pipelines', 0, 'error'), undefined);
    assert.deepEqual(
      (pick(pipelines.json, 'pipelines', 0, 'jobs') as Array<{ id: string }>).map((job) => job.id),
      ['build'],
    );
  });

  it('тот же предикат в until.check работы — тоже раскрыт устройством', async (t) => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    withProjectPlugin(projectRoot, PREDICATE_PLUGIN);
    writeFileSync(
      join(projectRoot, 'stepcast.yml'),
      `version: 1
kind: pipeline
name: с циклом
jobs:
  build:
    until:
      max_iterations: 2
      check: [{ always_ok: true }]
    budget: { tokens: 100k }
    steps:
      - id: check
        run: [echo, ok]
`,
    );
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });
    const server = await startServer(t, { runsRoot, config, home });

    const pipelines = await fetchJson(server, '/api/pipelines');
    assert.equal(pick(pipelines.json, 'pipelines', 0, 'error'), undefined);
    assert.deepEqual(
      (pick(pipelines.json, 'pipelines', 0, 'jobs') as Array<{ id: string }>).map((job) => job.id),
      ['build'],
    );
  });

  it('реестр одного проекта не расширяет разбор пайплайна соседнего', async (t) => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    const other = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    seedRun(runsRoot, other.projectRoot, { runId: 'b' });
    withProjectPlugin(projectRoot, PREDICATE_PLUGIN);
    writeFileSync(join(projectRoot, 'stepcast.yml'), PREDICATE_PIPELINE);
    writeFileSync(join(other.projectRoot, 'stepcast.yml'), PREDICATE_PIPELINE);
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });
    const server = await startServer(t, { runsRoot, config, home });

    const pipelines = await fetchJson(server, '/api/pipelines');
    const views = pipelines.json.pipelines as Array<{ projectPath: string; error?: string }>;
    const own = views.find((view) => view.projectPath === projectRoot);
    const neighbor = views.find((view) => view.projectPath === other.projectRoot);
    assert.ok(own !== undefined && neighbor !== undefined, JSON.stringify(views));
    assert.equal(own?.error, undefined);
    assert.match(neighbor?.error ?? '', /неизвестный ключ always_ok/);
  });

  it('шаг без своей модели с агентом плагинного бэкенда показывает умолчание плагина, слой backend', async (t) => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    withProjectPlugin(projectRoot, BACKEND_PLUGIN);
    writeFileSync(
      join(projectRoot, 'stepcast.yml'),
      `version: 1
kind: pipeline
name: demo
jobs:
  ask:
    steps:
      - id: a
        agent: probe
        prompt: спроси
`,
    );
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });
    const server = await startServer(t, { runsRoot, config, home });

    const pipelines = await fetchJson(server, '/api/pipelines');
    const step = pick(pipelines.json, 'pipelines', 0, 'jobs', 0, 'steps', 0);
    assert.equal(pick(step, 'model'), 'probe-model');
    assert.deepEqual(pick(step, 'modelOrigin'), { layer: 'backend', backend: 'probe' });
  });
});

describe('ui-dashboard: кеш реестров вкладов у демона', () => {
  it('плагин, объявленный после старта демона, раскрывает документ следующим запросом без перезапуска', async (t) => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(join(projectRoot, 'stepcast.yml'), PREDICATE_PIPELINE);
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });
    const server = await startServer(t, { runsRoot, config, home });

    const before = await fetchJson(server, '/api/pipelines');
    assert.match(String(pick(before.json, 'pipelines', 0, 'error')), /неизвестный ключ always_ok/);

    // Объявление появляется в конфигурации проекта уже после того, как демон
    // поднят: ключ кеша — список объявлений, а не только корень проекта, и
    // расхождение с прежним пустым списком обязано пересобрать реестр.
    withProjectPlugin(projectRoot, PREDICATE_PLUGIN);

    const after = await fetchJson(server, '/api/pipelines');
    assert.equal(pick(after.json, 'pipelines', 0, 'error'), undefined);
  });

  it('два проекта с разными плагинами раскрыты каждый своим реестром, повторный запрос даёт тот же ответ', async (t) => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    const other = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    seedRun(runsRoot, other.projectRoot, { runId: 'b' });
    withProjectPlugin(projectRoot, PREDICATE_PLUGIN);
    withProjectPlugin(other.projectRoot, BACKEND_PLUGIN);
    writeFileSync(join(projectRoot, 'stepcast.yml'), PREDICATE_PIPELINE);
    writeFileSync(
      join(other.projectRoot, 'stepcast.yml'),
      `version: 1
kind: pipeline
name: demo
jobs:
  ask:
    steps:
      - id: a
        agent: probe
        prompt: спроси
`,
    );
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });
    const server = await startServer(t, { runsRoot, config, home });

    const first = await fetchJson(server, '/api/pipelines');
    const second = await fetchJson(server, '/api/pipelines');
    assert.deepEqual(second.json.pipelines, first.json.pipelines);

    const views = first.json.pipelines as Array<{
      projectPath: string;
      error?: string;
      jobs: Array<{ steps: Array<{ model?: string }> }>;
    }>;
    const predicateProject = views.find((view) => view.projectPath === projectRoot);
    const backendProject = views.find((view) => view.projectPath === other.projectRoot);
    assert.ok(predicateProject !== undefined && backendProject !== undefined, JSON.stringify(views));
    assert.equal(predicateProject?.error, undefined);
    assert.equal(backendProject?.jobs[0]?.steps[0]?.model, 'probe-model');
  });

  it('кешируется реестр, но не конфигурация: правка defaults.model видна следующим запросом', async (t) => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    withProjectPlugin(projectRoot, PREDICATE_PLUGIN);
    const projectConfigFile = join(projectRoot, '.stepcast', 'config.yml');
    writeFileSync(projectConfigFile, 'plugins: ["./plugins/probe.mjs"]\ndefaults:\n  model: opus\n');
    writeFileSync(
      join(projectRoot, 'stepcast.yml'),
      `version: 1
kind: pipeline
name: demo
jobs:
  ask:
    steps:
      - id: a
        prompt: спроси
        expect: [{ always_ok: true }]
`,
    );
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });
    const server = await startServer(t, { runsRoot, config, home });

    const before = await fetchJson(server, '/api/pipelines');
    assert.equal(pick(before.json, 'pipelines', 0, 'error'), undefined);
    assert.equal(pick(before.json, 'pipelines', 0, 'jobs', 0, 'steps', 0, 'model'), 'opus');

    // Список объявлений не менялся — значит реестр берётся из кеша. Кешируется
    // при этом он один: конфигурация разрешается заново на каждый обход, иначе
    // экран показывал бы значения, которых в проекте уже нет.
    writeFileSync(projectConfigFile, 'plugins: ["./plugins/probe.mjs"]\ndefaults:\n  model: sonnet\n');

    const after = await fetchJson(server, '/api/pipelines');
    assert.equal(pick(after.json, 'pipelines', 0, 'error'), undefined);
    assert.equal(pick(after.json, 'pipelines', 0, 'jobs', 0, 'steps', 0, 'model'), 'sonnet');
    assert.deepEqual(pick(after.json, 'pipelines', 0, 'jobs', 0, 'steps', 0, 'modelOrigin'), {
      layer: 'config',
      file: projectConfigFile,
    });
  });
});

describe('ui-daemon: демон загружает только объявленные плагины показываемых проектов', () => {
  it('проект без файлов пайплайнов не приводит к загрузке своих плагинов', async (t) => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    const other = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    seedRun(runsRoot, other.projectRoot, { runId: 'b' });
    // Плагин объявлен, но пайплайнов у проекта нет: раскрывать нечего, а
    // значит и повода исполнять чужой код нет. Порядок проверок в обходе
    // («нет файлов — дальше» раньше сборки реестра) и есть граница доверия.
    const marker = join(projectRoot, '.stepcast', 'загружен.txt');
    withProjectPlugin(projectRoot, markerPlugin(marker));
    writeFileSync(join(other.projectRoot, 'stepcast.yml'), DEMO_PIPELINE);
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });
    const server = await startServer(t, { runsRoot, config, home });

    const pipelines = await fetchJson(server, '/api/pipelines');
    const views = pipelines.json.pipelines as Array<{ projectPath: string }>;
    assert.deepEqual(
      views.map((view) => view.projectPath),
      [other.projectRoot],
    );
    assert.equal(existsSync(marker), false, 'модуль плагина проекта без пайплайнов был импортирован');
  });

  it('проект без объявленных плагинов раскрыт, и лежащий рядом модуль не загружен', async (t) => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    // Модуль на диске есть, но конфигурация его не объявляет: списка «плагинов
    // витрины» демон не заводит и находкой на диске не пользуется.
    const marker = join(projectRoot, '.stepcast', 'загружен.txt');
    mkdirSync(join(projectRoot, '.stepcast', 'plugins'), { recursive: true });
    writeFileSync(join(projectRoot, '.stepcast', 'plugins', 'probe.mjs'), markerPlugin(marker));
    writeFileSync(join(projectRoot, 'stepcast.yml'), DEMO_PIPELINE);
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });
    const server = await startServer(t, { runsRoot, config, home });

    const pipelines = await fetchJson(server, '/api/pipelines');
    assert.equal(pick(pipelines.json, 'pipelines', 0, 'error'), undefined);
    assert.equal(pick(pipelines.json, 'pipelines', 0, 'name'), 'demo');
    assert.equal(existsSync(marker), false, 'необъявленный модуль был импортирован');
  });

  it('сборка реестров и ответ экрана не трогают файлов журнала', async (t) => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    withProjectPlugin(projectRoot, PREDICATE_PLUGIN);
    writeFileSync(join(projectRoot, 'stepcast.yml'), PREDICATE_PIPELINE);
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });
    const server = await startServer(t, { runsRoot, config, home });

    // Слепок снимается после старта демона: проверяется именно раскрытие с
    // загрузкой плагинов, а не то, что делает подъём сервера.
    const before = journalSnapshot(runsRoot);
    const pipelines = await fetchJson(server, '/api/pipelines');
    assert.equal(pick(pipelines.json, 'pipelines', 0, 'error'), undefined);

    assert.deepEqual(journalSnapshot(runsRoot), before);
  });
});

describe('ui-dashboard: отказ загрузки плагина — карточка проекта, а не погасший экран', () => {
  it('несуществующий модуль плагина — карточки с причиной, файлом объявления и спецификатором', async (t) => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    mkdirSync(join(projectRoot, '.stepcast'), { recursive: true });
    writeFileSync(join(projectRoot, '.stepcast', 'config.yml'), 'plugins: ["./plugins/нет.mjs"]\n');
    writeFileSync(join(projectRoot, 'stepcast.yml'), DEMO_PIPELINE);
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });
    const server = await startServer(t, { runsRoot, config, home });

    const pipelines = await fetchJson(server, '/api/pipelines');
    assert.match(String(pick(pipelines.json, 'pipelines', 0, 'error')), /не загружается/);
    assert.match(String(pick(pipelines.json, 'pipelines', 0, 'error')), /\.\/plugins\/нет\.mjs/);
    assert.equal(pick(pipelines.json, 'pipelines', 0, 'errorFile'), '.stepcast/config.yml');
    assert.equal(pick(pipelines.json, 'pipelines', 0, 'errorAt'), 'plugins');
  });

  it('конфликт имён вкладов — карточка с текстом отказа, файлом объявления и местом', async (t) => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    withProjectPlugin(
      projectRoot,
      `
export default {
  name: 'impostor',
  predicates: [
    {
      name: 'exit_code',
      schema: { type: 'number' },
      evaluate: () => ({ predicate: 'exit_code', passed: true, hard: true }),
    },
  ],
};
`,
    );
    writeFileSync(join(projectRoot, 'stepcast.yml'), DEMO_PIPELINE);
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });
    const server = await startServer(t, { runsRoot, config, home });

    const pipelines = await fetchJson(server, '/api/pipelines');
    assert.match(String(pick(pipelines.json, 'pipelines', 0, 'error')), /Имя предиката exit_code занято/);
    // Конфликт имён бросает реестр, который про конфигурацию не знает: без
    // дописанного загрузчиком места карточка вышла бы без ответа на вопрос
    // «какой конфиг это объявил» — не тем составом полей, каким показана
    // нечитаемая конфигурация.
    assert.equal(pick(pipelines.json, 'pipelines', 0, 'errorFile'), '.stepcast/config.yml');
    assert.equal(pick(pipelines.json, 'pipelines', 0, 'errorAt'), 'plugins');
    assert.match(String(pick(pipelines.json, 'pipelines', 0, 'errorHint')), /снимите один из плагинов/);
  });

  it('плагин, объявленный глобальным конфигом, назван в карточке абсолютным путём', async (t) => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    // Файл объявления лежит вне корня проекта: имя относительно него вышло бы
    // цепочкой `../../..` до домашнего каталога — путём, который ни на что не
    // указывает и вдобавок врёт про принадлежность файла проекту.
    const globalConfigFile = join(home, '.stepcast', 'config.yml');
    writeFileSync(globalConfigFile, `runs:\n  root: ${runsRoot}\nplugins: ["./plugins/нет.mjs"]\n`);
    writeFileSync(join(projectRoot, 'stepcast.yml'), DEMO_PIPELINE);
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });
    const server = await startServer(t, { runsRoot, config, home });

    const pipelines = await fetchJson(server, '/api/pipelines');
    assert.match(String(pick(pipelines.json, 'pipelines', 0, 'error')), /не загружается/);
    assert.equal(pick(pipelines.json, 'pipelines', 0, 'errorFile'), globalConfigFile);
    assert.equal(pick(pipelines.json, 'pipelines', 0, 'errorAt'), 'plugins');
  });

  it('сломанный плагин одного проекта не скрывает пайплайны соседнего исправного', async (t) => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    const other = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    seedRun(runsRoot, other.projectRoot, { runId: 'b' });
    mkdirSync(join(projectRoot, '.stepcast'), { recursive: true });
    writeFileSync(join(projectRoot, '.stepcast', 'config.yml'), 'plugins: ["./plugins/нет.mjs"]\n');
    writeFileSync(join(projectRoot, 'stepcast.yml'), DEMO_PIPELINE);
    writeFileSync(join(other.projectRoot, 'stepcast.yml'), DEMO_PIPELINE);
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });
    const server = await startServer(t, { runsRoot, config, home });

    const pipelines = await fetchJson(server, '/api/pipelines');
    const views = pipelines.json.pipelines as Array<{ projectPath: string; error?: string; name: string }>;
    const broken = views.find((view) => view.projectPath === projectRoot);
    const healthy = views.find((view) => view.projectPath === other.projectRoot);
    assert.ok(broken !== undefined && healthy !== undefined, JSON.stringify(views));
    assert.match(broken?.error ?? '', /не загружается/);
    assert.equal(healthy?.error, undefined);
    assert.equal(healthy?.name, 'demo');
  });

  it('исправленное объявление плагина действует следующим запросом — отказ не закеширован', async (t) => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    mkdirSync(join(projectRoot, '.stepcast'), { recursive: true });
    writeFileSync(join(projectRoot, '.stepcast', 'config.yml'), 'plugins: ["./plugins/нет.mjs"]\n');
    writeFileSync(join(projectRoot, 'stepcast.yml'), PREDICATE_PIPELINE);
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });
    const server = await startServer(t, { runsRoot, config, home });

    const before = await fetchJson(server, '/api/pipelines');
    assert.match(String(pick(before.json, 'pipelines', 0, 'error')), /не загружается/);

    // Тот же спецификатор, но модуль появляется на диске: ключ кеша (список
    // объявлений) не менялся, а результат обязан быть другим — отказ
    // предыдущей попытки закеширован не был.
    withProjectPlugin(projectRoot, PREDICATE_PLUGIN, 'нет');

    const after = await fetchJson(server, '/api/pipelines');
    assert.equal(pick(after.json, 'pipelines', 0, 'error'), undefined);
  });
});

describe('ui-dashboard: слой модели шага', () => {
  it('слой step: шаг объявляет модель сам', async (t) => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(
      join(projectRoot, 'stepcast.yml'),
      `version: 1
kind: pipeline
name: demo
jobs:
  ask:
    steps:
      - id: a
        prompt: спроси
        model: opus
`,
    );
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });
    const server = await startServer(t, { runsRoot, config, home });

    const pipelines = await fetchJson(server, '/api/pipelines');
    const step = pick(pipelines.json, 'pipelines', 0, 'jobs', 0, 'steps', 0);
    assert.equal(pick(step, 'model'), 'opus');
    assert.deepEqual(pick(step, 'modelOrigin'), { layer: 'step' });
  });

  it('слой pipeline: модель пришла из умолчаний документа', async (t) => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(
      join(projectRoot, 'stepcast.yml'),
      `version: 1
kind: pipeline
name: demo
defaults:
  model: opus
jobs:
  ask:
    steps:
      - id: a
        prompt: спроси
`,
    );
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });
    const server = await startServer(t, { runsRoot, config, home });

    const pipelines = await fetchJson(server, '/api/pipelines');
    const step = pick(pipelines.json, 'pipelines', 0, 'jobs', 0, 'steps', 0);
    assert.equal(pick(step, 'model'), 'opus');
    assert.deepEqual(pick(step, 'modelOrigin'), { layer: 'pipeline' });
  });

  it('слой config: проект со своим defaults.model показан своим значением и своим файлом', async (t) => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    mkdirSync(join(projectRoot, '.stepcast'), { recursive: true });
    const projectConfigFile = join(projectRoot, '.stepcast', 'config.yml');
    writeFileSync(projectConfigFile, 'defaults:\n  model: opus\n');
    writeFileSync(
      join(projectRoot, 'stepcast.yml'),
      `version: 1
kind: pipeline
name: demo
jobs:
  ask:
    steps:
      - id: a
        prompt: спроси
`,
    );
    // Демон поднят с другим умолчанием модели: карточка обязана показать
    // значение проекта, а не каталога демона.
    writeFileSync(
      join(home, '.stepcast', 'config.yml'),
      `runs:\n  root: ${runsRoot}\ndefaults:\n  model: sonnet\n`,
    );
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });
    const server = await startServer(t, { runsRoot, config, home });

    const pipelines = await fetchJson(server, '/api/pipelines');
    const step = pick(pipelines.json, 'pipelines', 0, 'jobs', 0, 'steps', 0);
    assert.equal(pick(step, 'model'), 'opus');
    assert.deepEqual(pick(step, 'modelOrigin'), { layer: 'config', file: projectConfigFile });
  });

  it('слой config: значение глобального файла названо именно им, а не проектным', async (t) => {
    // Экран настроек правит только глобальный файл, поэтому обязан отличать
    // «моё значение» от «значения ближнего слоя»: различает их имя файла на
    // карточке шага, и оно должно совпадать с файлом, который называет
    // `/api/settings`.
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(
      join(projectRoot, 'stepcast.yml'),
      `version: 1
kind: pipeline
name: demo
jobs:
  ask:
    steps:
      - id: a
        prompt: спроси
`,
    );
    const globalConfigFile = join(home, '.stepcast', 'config.yml');
    writeFileSync(globalConfigFile, `runs:\n  root: ${runsRoot}\ndefaults:\n  model: sonnet\n`);
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });
    const server = await startServer(t, { runsRoot, config, home });

    const pipelines = await fetchJson(server, '/api/pipelines');
    const step = pick(pipelines.json, 'pipelines', 0, 'jobs', 0, 'steps', 0);
    assert.equal(pick(step, 'model'), 'sonnet');
    assert.deepEqual(pick(step, 'modelOrigin'), { layer: 'config', file: globalConfigFile });

    const settings = await fetchJson(server, '/api/settings');
    assert.equal(pick(settings.json, 'file'), globalConfigFile);
  });

  it('слой backend: модель — умолчание бэкенда шага', async (t) => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(
      join(projectRoot, 'stepcast.yml'),
      `version: 1
kind: pipeline
name: demo
jobs:
  ask:
    steps:
      - id: a
        prompt: спроси
`,
    );
    writeFileSync(
      join(home, '.stepcast', 'config.yml'),
      `runs:\n  root: ${runsRoot}\nbackends:\n  claude:\n    default_model: haiku\n`,
    );
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });
    const server = await startServer(t, { runsRoot, config, home });

    const pipelines = await fetchJson(server, '/api/pipelines');
    const step = pick(pipelines.json, 'pipelines', 0, 'jobs', 0, 'steps', 0);
    assert.equal(pick(step, 'model'), 'haiku');
    assert.deepEqual(pick(step, 'modelOrigin'), { layer: 'backend', backend: 'claude' });
  });

  it('слой none: модель не задана ни на одном из четырёх звеньев', async (t) => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(
      join(projectRoot, 'stepcast.yml'),
      `version: 1
kind: pipeline
name: demo
jobs:
  ask:
    steps:
      - id: a
        prompt: спроси
`,
    );
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });
    const server = await startServer(t, { runsRoot, config, home });

    const pipelines = await fetchJson(server, '/api/pipelines');
    const step = pick(pipelines.json, 'pipelines', 0, 'jobs', 0, 'steps', 0);
    assert.equal(pick(step, 'model'), undefined);
    assert.deepEqual(pick(step, 'modelOrigin'), { layer: 'none' });
  });

  it('нечитаемая конфигурация проекта не выдаёт слой модели, а даёт карточку с объяснением', async (t) => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    mkdirSync(join(projectRoot, '.stepcast'), { recursive: true });
    writeFileSync(join(projectRoot, '.stepcast', 'config.yml'), 'project:\n  check: "   "\n');
    writeFileSync(join(projectRoot, 'stepcast.yml'), DEMO_PIPELINE);
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });
    const server = await startServer(t, { runsRoot, config, home });

    const pipelines = await fetchJson(server, '/api/pipelines');
    assert.match(String(pick(pipelines.json, 'pipelines', 0, 'error')), /схеме/);
    assert.deepEqual(pick(pipelines.json, 'pipelines', 0, 'jobs'), []);
  });
});

describe('ui-dashboard: расход поперёк прогонов', () => {
  // Сценарий: «Агрегат приходит одним ответом»
  it('GET /api/usage без параметра отдаёт весь период наблюдений, с days=7 — неделю', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'recent', manifest: { started_at: new Date().toISOString() } });
    seedRun(runsRoot, projectRoot, { runId: 'old', manifest: { started_at: '2020-01-01T00:00:00.000Z' } });
    const server = await startServer(t, { runsRoot });

    const all = await fetchJson(server, '/api/usage');
    assert.equal(all.code, 200);
    assert.equal(pick(all.json, 'total', 'runs'), 2);
    assert.equal(typeof pick(all.json, 'from'), 'string');
    assert.equal(typeof pick(all.json, 'to'), 'string');
    assert.ok(Array.isArray(pick(all.json, 'models')));
    assert.ok(Array.isArray(pick(all.json, 'days')));
    assert.ok(Array.isArray(pick(all.json, 'pipelines')));
    assert.equal(typeof pick(all.json, 'runsWithoutBreakdown'), 'number');
    assert.equal(typeof pick(all.json, 'undated'), 'number');

    const week = await fetchJson(server, '/api/usage?days=7');
    assert.equal(week.code, 200);
    // Прогон 2020 года старше недели: в неделю входит только недавний.
    assert.equal(pick(week.json, 'total', 'runs'), 1);
    assert.equal((pick(week.json, 'days') as unknown[]).length, 7);
  });

  // Сценарий: «Пустой период»
  it('период без единого прогона отдаёт нулевой итог с рядом дней, а не отказ', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'old', manifest: { started_at: '2020-01-01T00:00:00.000Z' } });
    const server = await startServer(t, { runsRoot });

    const empty = await fetchJson(server, '/api/usage?days=1');
    assert.equal(empty.code, 200);
    assert.equal(pick(empty.json, 'total', 'runs'), 0);
    assert.equal(pick(empty.json, 'total', 'billableTokens'), 0);
    assert.deepEqual(pick(empty.json, 'models'), []);
    assert.deepEqual(pick(empty.json, 'pipelines'), []);
    assert.equal((pick(empty.json, 'days') as unknown[]).length, 1);
  });

  // Сценарии: «Негодный период», «Период сверх предела»
  it('отклоняет негодный days кодом 400, а не подменяет умолчанием', async (t) => {
    const { runsRoot } = makeJournalBed();
    const server = await startServer(t, { runsRoot });

    // 3651 — на день больше объявленного предела; 100000000 — период, чей ряд
    // дней занял бы демона на минуты; 1e400 — период, не влезающий в Date.
    for (const bad of ['0', '-1', '1.5', 'abc', '3651', '100000000', '1e400']) {
      const refused = await fetchJson(server, `/api/usage?days=${bad}`);
      assert.equal(refused.code, 400, `days=${bad} должен отклоняться`);
    }

    // Предел — годная величина: отклоняется то, что за ним.
    const limit = await fetchJson(server, '/api/usage?days=3650');
    assert.equal(limit.code, 200);
  });

  it('отклоняет метод, отличный от GET, кодом 405', async (t) => {
    const { runsRoot } = makeJournalBed();
    const server = await startServer(t, { runsRoot });

    const result = await sendJson(server, { method: 'DELETE', path: '/api/usage' });
    assert.equal(result.code, 405);
  });
});

describe('ui-dashboard: вывод шага', () => {
  /**
   * Каталог шага той же раскладки, что заводит движок: `jobs/<job>/steps/01-<step>`,
   * а у работы с циклом — `jobs/<job>/steps/iter-<N>/01-<step>`.
   */
  function makeStepDir(
    runsRoot: string,
    projectRoot: string,
    runId: string,
    jobId: string,
    stepId: string,
    iteration?: number,
  ): string {
    const key = projectKey(projectRoot);
    const paths = runPaths(runsRoot, key, runId);
    const dir = stepDir(paths, jobId, 1, stepId, iteration);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Запись шага, которую движок кладёт в каталог шага по его завершении. */
  function writeStepRecord(dir: string, stepId: string): void {
    writeFileSync(
      join(dir, 'step.json'),
      JSON.stringify({
        id: stepId,
        index: 1,
        kind: 'run',
        key: `key/${stepId}`,
        status: 'success',
        attempts: [],
      }),
    );
  }

  function outputPath(
    key: string,
    runId: string,
    jobId: string,
    stepId: string,
    params: Readonly<Record<string, string | number>> = {},
  ): string {
    const query = new URLSearchParams({ run: `${key}/${runId}`, job: jobId, step: stepId });
    for (const [name, value] of Object.entries(params)) query.set(name, String(value));
    return `/api/step-output?${query.toString()}`;
  }

  // Сценарий: «Вывод идущего шага появляется сам»
  it('отдаёт дописанное после смещения и пусто на повторном запросе с тем же концом', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, {
      runId: 'a',
      status: 'running',
      manifest: { started_at: new Date().toISOString(), pid: process.pid },
    });
    const key = projectKey(projectRoot);
    const dir = makeStepDir(runsRoot, projectRoot, 'a', 'build', 'compile');
    writeFileSync(join(dir, 'stdout.log'), 'первая строка\n');
    const server = await startServer(t, { runsRoot });

    const first = await fetchJson(server, outputPath(key, 'a', 'build', 'compile', { stdoutOffset: 0 }));
    assert.equal(first.code, 200);
    assert.deepEqual(first.json.attempts, [1]);
    assert.equal(first.json.attempt, 1);
    assert.equal(first.json.done, false, 'прогон идёт, и запись шага ещё не легла в status.json');
    const stdout1 = pick(first.json, 'stdout') as { exists: boolean; content: string; offset: number };
    assert.equal(stdout1.exists, true);
    assert.equal(stdout1.content, 'первая строка\n');
    const offsetAfterFirst = stdout1.offset;
    assert.equal(offsetAfterFirst, Buffer.byteLength('первая строка\n'));

    writeFileSync(join(dir, 'stdout.log'), 'вторая строка\n', { flag: 'a' });
    const second = await fetchJson(
      server,
      outputPath(key, 'a', 'build', 'compile', { stdoutOffset: offsetAfterFirst }),
    );
    const stdout2 = pick(second.json, 'stdout') as { content: string; offset: number };
    assert.equal(stdout2.content, 'вторая строка\n');
    const offsetAfterSecond = stdout2.offset;

    const third = await fetchJson(
      server,
      outputPath(key, 'a', 'build', 'compile', { stdoutOffset: offsetAfterSecond }),
    );
    const stdout3 = pick(third.json, 'stdout') as { content: string };
    assert.equal(stdout3.content, '', 'файл не менялся — дописанного нет');
  });

  // Сценарий: «Шаг с повтором»
  it('перечисляет попытки по файлам на диске и отдаёт вывод запрошенной', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const key = projectKey(projectRoot);
    const dir = makeStepDir(runsRoot, projectRoot, 'a', 'build', 'compile');
    writeFileSync(join(dir, 'stdout.log'), 'попытка один\n');
    writeFileSync(join(dir, 'stdout.2.log'), 'попытка два\n');
    const server = await startServer(t, { runsRoot });

    const byDefault = await fetchJson(
      server,
      outputPath(key, 'a', 'build', 'compile', { stdoutOffset: 0 }),
    );
    assert.deepEqual(byDefault.json.attempts, [1, 2]);
    assert.equal(byDefault.json.attempt, 2, 'по умолчанию — наибольшая существующая попытка');
    assert.equal(pick(byDefault.json, 'stdout', 'content'), 'попытка два\n');

    const first = await fetchJson(
      server,
      outputPath(key, 'a', 'build', 'compile', { attempt: 1, stdoutOffset: 0 }),
    );
    assert.equal(first.json.attempt, 1);
    assert.equal(pick(first.json, 'stdout', 'content'), 'попытка один\n');
  });

  // Сценарий: «Шаг завершился» / «Прогон брошен»
  it('называет вывод завершённым по записи шага, по не-последней попытке и по мёртвому прогону', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, {
      runId: 'running-unrecorded',
      status: 'running',
      manifest: { started_at: new Date().toISOString(), pid: process.pid },
    });
    const key = projectKey(projectRoot);
    makeStepDir(runsRoot, projectRoot, 'running-unrecorded', 'build', 'compile');
    writeFileSync(
      join(stepDir(runPaths(runsRoot, key, 'running-unrecorded'), 'build', 1, 'compile'), 'stdout.log'),
      'x',
    );
    const server = await startServer(t, { runsRoot });

    const running = await fetchJson(
      server,
      outputPath(key, 'running-unrecorded', 'build', 'compile', { stdoutOffset: 0 }),
    );
    assert.equal(running.json.done, false);

    // Запись шага уже лежит в его каталоге.
    seedRun(runsRoot, projectRoot, {
      runId: 'recorded',
      status: 'running',
      manifest: { started_at: new Date().toISOString(), pid: process.pid },
    });
    const recordedDir = makeStepDir(runsRoot, projectRoot, 'recorded', 'build', 'compile');
    writeFileSync(join(recordedDir, 'stdout.log'), 'x');
    writeStepRecord(recordedDir, 'compile');
    const recorded = await fetchJson(
      server,
      outputPath(key, 'recorded', 'build', 'compile', { stdoutOffset: 0 }),
    );
    assert.equal(recorded.json.done, true, 'запись шага легла в каталог — дописывать больше нечего');

    // Прогон, застрявший в running после гибели процесса.
    seedRun(runsRoot, projectRoot, {
      runId: 'abandoned',
      status: 'running',
      manifest: { started_at: new Date().toISOString(), pid: 999_999_999 },
    });
    const abandonedDir = makeStepDir(runsRoot, projectRoot, 'abandoned', 'build', 'compile');
    writeFileSync(join(abandonedDir, 'stdout.log'), 'x');
    const abandoned = await fetchJson(
      server,
      outputPath(key, 'abandoned', 'build', 'compile', { stdoutOffset: 0 }),
    );
    assert.equal(abandoned.json.done, true, 'процесс мёртв — дописывать некому');

    // Запрошена не последняя из существующих попыток.
    seedRun(runsRoot, projectRoot, {
      runId: 'retried',
      status: 'running',
      manifest: { started_at: new Date().toISOString(), pid: process.pid },
    });
    const retriedDir = makeStepDir(runsRoot, projectRoot, 'retried', 'build', 'compile');
    writeFileSync(join(retriedDir, 'stdout.log'), 'x');
    writeFileSync(join(retriedDir, 'stdout.2.log'), 'x');
    const notLast = await fetchJson(
      server,
      outputPath(key, 'retried', 'build', 'compile', { attempt: 1, stdoutOffset: 0 }),
    );
    assert.equal(notLast.json.done, true, 'в свой файл эта попытка больше не допишет');
    const last = await fetchJson(
      server,
      outputPath(key, 'retried', 'build', 'compile', { attempt: 2, stdoutOffset: 0 }),
    );
    assert.equal(last.json.done, false, 'последняя попытка идущего прогона ещё может дописать');
  });

  // Сценарий: «Шаг работы с циклом на новой итерации»
  it('не считает шаг новой итерации завершённым по одноимённому шагу прошлой', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    // Работа с `until`: шаги первой итерации уже записаны в состоянии прогона,
    // и запись одноимённого шага лежит там всё время второй итерации.
    seedRun(runsRoot, projectRoot, {
      runId: 'loop',
      status: 'running',
      manifest: { started_at: new Date().toISOString(), pid: process.pid },
      jobs: [
        {
          id: 'build',
          status: 'running',
          iterations: 1,
          steps: [
            { id: 'compile', index: 1, kind: 'run', key: 'build/compile', status: 'success', attempts: [] },
          ],
        },
      ],
    });
    const key = projectKey(projectRoot);

    const first = makeStepDir(runsRoot, projectRoot, 'loop', 'build', 'compile', 1);
    writeFileSync(join(first, 'stdout.log'), 'итерация один\n');
    writeStepRecord(first, 'compile');

    const second = makeStepDir(runsRoot, projectRoot, 'loop', 'build', 'compile', 2);
    writeFileSync(join(second, 'stdout.log'), 'итерация два\n');

    const server = await startServer(t, { runsRoot });
    const running = await fetchJson(server, outputPath(key, 'loop', 'build', 'compile', { stdoutOffset: 0 }));
    assert.equal(pick(running.json, 'stdout', 'content'), 'итерация два\n', 'показана идущая итерация');
    assert.equal(running.json.done, false, 'шаг идущей итерации своей записи ещё не написал');

    writeStepRecord(second, 'compile');
    const finished = await fetchJson(server, outputPath(key, 'loop', 'build', 'compile', { stdoutOffset: 0 }));
    assert.equal(finished.json.done, true, 'запись шага этой итерации легла в её каталог');
  });

  it('перечисляет попытку, у которой на диске остался только stderr', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const key = projectKey(projectRoot);
    const dir = makeStepDir(runsRoot, projectRoot, 'a', 'build', 'compile');
    // Процесс не запустился, и стороны вывода на диске оказалась лишь одна.
    writeFileSync(join(dir, 'stderr.log'), 'команда не найдена\n');
    const server = await startServer(t, { runsRoot });

    const answer = await fetchJson(
      server,
      outputPath(key, 'a', 'build', 'compile', { stdoutOffset: 0, stderrOffset: 0 }),
    );
    assert.deepEqual(answer.json.attempts, [1], 'попытка есть, хоть stdout.log и не заведён');
    assert.equal(pick(answer.json, 'stdout', 'exists'), false);
    assert.equal(pick(answer.json, 'stderr', 'content'), 'команда не найдена\n');
  });

  // Сценарий: «Дописанное сверх потолка»
  it('отдаёт дописанное сверх потолка кусками и не называет вывод завершённым, пока остаток не дочитан', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const key = projectKey(projectRoot);
    const dir = makeStepDir(runsRoot, projectRoot, 'a', 'build', 'compile');
    const tail = 'хвост\n';
    // Полтора потолка после смещения: одним ответом такое не отдаётся.
    writeFileSync(join(dir, 'stdout.log'), `${'a'.repeat(MAX_FILE_BYTES + MAX_FILE_BYTES / 2)}${tail}`);
    const server = await startServer(t, { runsRoot });

    const chunk = await fetchJson(server, outputPath(key, 'a', 'build', 'compile', { stdoutOffset: 1 }));
    const first = pick(chunk.json, 'stdout') as { content: string; offset: number; bytes: number };
    assert.equal(
      Buffer.byteLength(first.content),
      MAX_FILE_BYTES,
      'за раз отдаётся не больше потолка, а не весь остаток файла',
    );
    assert.ok(first.offset < first.bytes, 'остаток ещё не прочитан');
    assert.equal(chunk.json.done, false, 'прогон не жив, но непрочитанный остаток держит опрос');

    const rest = await fetchJson(
      server,
      outputPath(key, 'a', 'build', 'compile', { stdoutOffset: first.offset }),
    );
    const second = pick(rest.json, 'stdout') as { content: string; offset: number; bytes: number };
    assert.ok(second.content.endsWith(tail), 'следующий кусок продолжает с того же места, без дыры');
    assert.equal(second.offset, second.bytes);
    assert.equal(rest.json.done, true, 'всё дочитано, и дописывать больше некому');
  });

  it('не отдаёт недописанный символ на конце окна, отданного с конца', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, {
      runId: 'a',
      status: 'running',
      manifest: { started_at: new Date().toISOString(), pid: process.pid },
    });
    const key = projectKey(projectRoot);
    const dir = makeStepDir(runsRoot, projectRoot, 'a', 'build', 'compile');
    const letter = Buffer.from('я', 'utf8');
    // Файл крупнее потолка, оборванный на середине двухбайтового символа:
    // так выглядит лог, который пишут прямо сейчас.
    writeFileSync(
      join(dir, 'stdout.log'),
      Buffer.concat([Buffer.from('я'.repeat(MAX_FILE_BYTES)), letter.subarray(0, 1)]),
    );
    const server = await startServer(t, { runsRoot });

    const head = await fetchJson(server, outputPath(key, 'a', 'build', 'compile', { stdoutOffset: 0 }));
    const stdout = pick(head.json, 'stdout') as { content: string; offset: number; bytes: number };
    assert.ok(!stdout.content.includes('�'), 'обрубок символа не превращается в вопросительный ромб');
    assert.equal(stdout.offset, stdout.bytes - 1, 'недописанный байт остался непрочитанным');

    writeFileSync(join(dir, 'stdout.log'), letter.subarray(1), { flag: 'a' });
    const next = await fetchJson(
      server,
      outputPath(key, 'a', 'build', 'compile', { stdoutOffset: stdout.offset }),
    );
    assert.equal(pick(next.json, 'stdout', 'content'), 'я', 'символ дочитан целиком следующим куском');
  });

  it('отвечает ошибкой на нечитаемый каталог шага и остаётся на связи', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const key = projectKey(projectRoot);
    // На месте каталога шагов — файл: так же выглядит гонка чтения с удалением
    // прогона, только воспроизводимо.
    const steps = join(runPaths(runsRoot, key, 'a').jobs, 'build', 'steps');
    mkdirSync(dirname(steps), { recursive: true });
    writeFileSync(steps, 'не каталог');
    const server = await startServer(t, { runsRoot });

    const broken = await fetchJson(server, outputPath(key, 'a', 'build', 'compile', { stdoutOffset: 0 }));
    assert.ok(broken.code >= 400, 'сбой чтения — ответ одному запросу, а не падение демона');
    assert.equal(typeof broken.json.error, 'string');

    const alive = await fetchJson(server, '/api/overview');
    assert.equal(alive.code, 200, 'демон продолжает отвечать');
  });

  // Сценарии: «Идентификатор работы за пределами раскладки», «Шаг, ещё ничего не написавший»
  it('отклоняет составной идентификатор и не считает отсутствие каталога ошибкой', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const key = projectKey(projectRoot);
    const server = await startServer(t, { runsRoot });

    const badJob = await fetchJson(
      server,
      outputPath(key, 'a', '../etc', 'compile', { stdoutOffset: 0 }),
    );
    assert.equal(badJob.code, 400);

    const badStep = await fetchJson(
      server,
      outputPath(key, 'a', 'build', 'no/such', { stdoutOffset: 0 }),
    );
    assert.equal(badStep.code, 400);

    const noDir = await fetchJson(
      server,
      outputPath(key, 'a', 'build', 'not-started', { stdoutOffset: 0 }),
    );
    assert.equal(noDir.code, 200, 'шаг без каталога — не ошибка, а «вывода пока нет»');
    assert.deepEqual(noDir.json.attempts, []);
    assert.equal(noDir.json.stdout, undefined);
  });

  // Сценарий: «Вывод крупнее потолка» / «Смещение восстановления»
  it('отдаёт крупный вывод с конца и распознаёт усечённый или заменённый файл по смещению', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const key = projectKey(projectRoot);
    const dir = makeStepDir(runsRoot, projectRoot, 'a', 'build', 'compile');
    const tail = 'причина отказа в конце\n';
    const big = `начало\n${'я'.repeat(MAX_FILE_BYTES)}${tail}`;
    writeFileSync(join(dir, 'stdout.log'), big);
    const server = await startServer(t, { runsRoot });

    const head = await fetchJson(server, outputPath(key, 'a', 'build', 'compile', { stdoutOffset: 0 }));
    const stdout = pick(head.json, 'stdout') as {
      truncated: boolean;
      truncatedFrom: number;
      content: string;
      offset: number;
      bytes: number;
    };
    assert.equal(stdout.truncated, true);
    assert.ok(stdout.content.endsWith(tail));
    assert.ok(!stdout.content.includes('начало'));
    assert.equal(stdout.offset, stdout.bytes);
    assert.equal(typeof stdout.truncatedFrom, 'number');

    // Смещение больше текущего размера — файл усечён или заменён.
    writeFileSync(join(dir, 'stdout.log'), 'заново\n');
    const restarted = await fetchJson(
      server,
      outputPath(key, 'a', 'build', 'compile', { stdoutOffset: stdout.offset }),
    );
    const restartedStdout = pick(restarted.json, 'stdout') as { restarted: boolean; content: string };
    assert.equal(restartedStdout.restarted, true);
    assert.equal(restartedStdout.content, 'заново\n');
  });

  it('для командного шага отдаёт оба потока со своими смещениями', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const key = projectKey(projectRoot);
    const dir = makeStepDir(runsRoot, projectRoot, 'a', 'build', 'compile');
    writeFileSync(join(dir, 'stdout.log'), 'вывод\n');
    // `stderr.log` создаётся процессом всегда, даже пустым — пустой поток
    // отличим от отсутствующего именно этим.
    writeFileSync(join(dir, 'stderr.log'), '');
    const server = await startServer(t, { runsRoot });

    const both = await fetchJson(
      server,
      outputPath(key, 'a', 'build', 'compile', { stdoutOffset: 0, stderrOffset: 0 }),
    );
    assert.equal(pick(both.json, 'stdout', 'content'), 'вывод\n');
    const stderr = pick(both.json, 'stderr') as { exists: boolean; content: string };
    assert.equal(stderr.exists, true, 'пустой файл всё равно существует');
    assert.equal(stderr.content, '');

    // Без параметра поток не запрошен вовсе — и не возвращается в ответе.
    const stdoutOnly = await fetchJson(
      server,
      outputPath(key, 'a', 'build', 'compile', { stdoutOffset: 0 }),
    );
    assert.equal(stdoutOnly.json.stderr, undefined);
  });
});
