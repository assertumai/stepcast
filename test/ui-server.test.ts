import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { get, request } from 'node:http';
import { describe, it, type TestContext } from 'node:test';

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildSteps } from '../src/parts/ui/steps.js';
import { resetModelDiscoveryCache } from '../src/parts/pipeline/backend/models.js';
import { dashboardPath } from '../src/parts/ui/daemon/assets.js';
import { createUiServer, LOOPBACK, type UiServer } from '../src/parts/ui/daemon/server.js';
import {
  createKernelCache,
  disposeRaisedKernels,
  resolveWithCachedKernel,
  type KernelCache,
} from '../src/parts/ui/pipelines.js';
import { hrefFor, type RouteTable } from '../src/parts/ui/routes.js';
import { launchDecide, launchRun } from '../src/parts/ui/runLaunch.js';
import { declaration as runDeclaration } from '../src/parts/ui/screens/run/declaration.js';
import { createWatcher, type Watcher } from '../src/parts/ui/daemon/watcher.js';
import { resolveConfig, type Config } from '../src/parts/pipeline/config/resolve.js';
import { projectKey, runPaths, shortRunId, stepDir, usageStorePath } from '../src/parts/pipeline/run/journal/paths.js';
import { MAX_FILE_BYTES } from '../src/parts/ui/file.js';
import { proposeEntry } from '../src/parts/pipeline/domain/proposals/store.js';
import { runGcCommand } from '../src/parts/pipeline/commands/gc.js';
import type { ParsedArgs } from '../src/kernel/cli/args.js';
import {
  createWidgetCompiler,
  widgetsDirPath,
  type EsbuildTransformApi,
  type WidgetCompiler,
} from '../src/parts/ui/widgets.js';
import { makeJournalBed, seedRun, withHome } from './helpers.js';
import { tempDir } from './tmp.js';

function gcArgs(flags: ParsedArgs['flags'] = {}): ParsedArgs {
  return { command: 'gc', positional: [], flags };
}

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
    widgetCompiler?: WidgetCompiler;
    log?: (line: string) => void;
    config?: Config;
    home?: string;
    projectRoot?: string;
    dashboardFile?: string;
    kernelCache?: KernelCache;
  },
): Promise<UiServer> {
  const server = await createUiServer({ ...options, port: 0 });
  t.after(() => server.close());
  return server;
}

function startWatcher(t: TestContext, runsRoot: string, intervalMs: number, home?: string): Watcher {
  // Домашний каталог называется там, где проверка трогает файлы слоёв
  // (маршруты, плагины): иначе наблюдатель отпечатывал бы настоящий
  // `~/.stepcast` того, кто запустил проверку.
  const watcher = createWatcher({ runsRoot, intervalMs, ...(home === undefined ? {} : { home }) });
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

interface FetchedWithHeaders extends Fetched {
  readonly headers: Record<string, string | string[] | undefined>;
}

/** Как `fetchPath`, но с заголовками — виджет с ошибкой компиляции помечает ответ заголовком (design.md, Решение 8). */
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

/** Адрес страницы прогона: тот же встроенный маршрут, которым в браузере пользуется `hrefFor`. */
const RUN_ROUTE_TABLE: RouteTable = [
  { id: 'screen-run', path: '/runs/:projectKey/:runId', target: { kind: 'screen', id: runDeclaration.id } },
];

function runHref(projectKey: string, runId: string): string {
  const href = hrefFor({ kind: 'screen', id: runDeclaration.id }, { projectKey, runId }, RUN_ROUTE_TABLE);
  assert.ok(href !== undefined, 'маршрут страницы прогона обязан быть в таблице');
  return href;
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
  // `src/parts/ui/grouping.ts` и `test/ui-grouping.test.ts`).
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

    // Каждый кадр несёт обзор, очередь улучшений, состав виджетов, очередь
    // предложений, таблицу маршрутов, состав дашбордов, состав плагинов и
    // состав экранов — тем же потоком, той же подпиской.
    assert.deepEqual(
      stream.events.map((event) => event.event),
      ['overview', 'backlog', 'widgets', 'proposals', 'routes', 'dashboards', 'plugins', 'screens'],
    );
    assert.deepEqual(pick(stream.events[0]?.data, 'projects'), []);

    seedRun(runsRoot, projectRoot, { runId: 'новый' });
    await settle(300);

    const overviews = stream.events.filter((event) => event.event === 'overview');
    assert.ok(overviews.length > 1, 'появление прогона должно дойти до клиента');
    assert.equal(pick(overviews.at(-1)?.data, 'projects', 0, 'runs', 0, 'runId'), 'новый');
  });

  it('при подписке на прогон присылает и его снимок', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const key = projectKey(projectRoot);
    const server = await startServer(t, { runsRoot });

    const stream = openStream(t, server, `/api/events?run=${address(key, 'a')}`);
    await settle();

    // Состав браузерных строк и состав экранов отстают от прочих событий
    // такта: оба спрашиваются у ядра демона (`activePlugins`/`activeScreens`,
    // `src/parts/ui/daemon/server.ts`), а это `await` — отсюда они последними, а не между
    // `widgets` и `run`. Таблица маршрутов — синхронно из наблюдателя, поэтому
    // идёт прежде `run`. Порядок событий клиенту безразличен (каждое ложится в
    // своё поле снимка `live`), но перечень обмена проверяется целиком, чтобы
    // пропажа события не осталась незамеченной.
    assert.deepEqual(
      stream.events.map((item) => item.event),
      ['overview', 'backlog', 'widgets', 'proposals', 'routes', 'dashboards', 'run', 'plugins', 'screens'],
    );
    assert.equal(pick(stream.events[6]?.data, 'runId'), 'a');
  });

  /**
   * Поток несёт состав очереди и служит сигналом перечитать
   * `GET /api/proposals` (`ui-proposals`, Решение 15): содержимое записи — до
   * 256 КиБ на запись — в событие не идёт, иначе каждая вкладка получала бы
   * его дважды, вторым разом по собственному запросу маршрута.
   */
  it('событие proposals несёт состав очереди без содержимого записей', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    proposeEntry(projectRoot, { target: '.stepcast/widgets/clock.tsx', content: 'export default 1;\n' });
    const server = await startServer(t, { runsRoot });

    const stream = openStream(t, server, '/api/events');
    await settle();

    const event = stream.events.find((item) => item.event === 'proposals');
    assert.ok(event !== undefined, 'поток обязан нести состав очереди');
    const record = pick(event.data, 'projects', 0, 'records', 0) as Json;
    assert.equal(record.target, '.stepcast/widgets/clock.tsx');
    assert.equal(record.state, 'pending');
    assert.ok(!('content' in record), 'содержимое записи в поток не идёт');
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

const BACKLOG_ITEM = (status: string): string =>
  `# Очередь\n\n## work-item\n\nstatus: ${status}\ntitle: т\nwhy: з\ndone_when: к\n`;

describe('screen-scrum: перенос пункта доской', () => {
  const ITEMS = (...items: readonly string[]): string => `# Очередь\n\n${items.join('\n')}`;
  const ITEM = (slug: string, status: string): string =>
    `## ${slug}\n\nstatus: ${status}\ntitle: т\nwhy: з\ndone_when: к\n`;

  function movePayload(body: Record<string, unknown>): { method: string; path: string; body: string } {
    return { method: 'POST', path: '/api/backlog/move', body: JSON.stringify(body) };
  }

  function fieldOf(text: string, slug: string, field: string): string | undefined {
    const block = text.split(/^## /mu).find((part) => part.startsWith(slug));
    return new RegExp(`^${field}: (.*)$`, 'mu').exec(block ?? '')?.[1];
  }

  it('меняет статус и порядок в backlog.md одним запросом', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const tasks = join(projectRoot, 'backlog.md');
    writeFileSync(tasks, ITEMS(ITEM('one', 'todo'), ITEM('two', 'todo')));
    const server = await startServer(t, { runsRoot });
    const key = projectKey(projectRoot);

    const moved = await sendJson(server, movePayload({ project: key, slug: 'two', column: 'todo', before: 'one' }));

    assert.equal(moved.code, 200);
    const text = readFileSync(tasks, 'utf8');
    assert.equal(fieldOf(text, 'two', 'status'), 'todo');
    assert.ok(text.indexOf('## two') < text.indexOf('## one'), 'пункт обязан встать выше названного соседа');
  });

  it('переносит пункт в архив, не трогая его исход', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const tasks = join(projectRoot, 'backlog.md');
    writeFileSync(tasks, ITEMS(ITEM('done-item', 'done')));
    const server = await startServer(t, { runsRoot });

    const moved = await sendJson(
      server,
      movePayload({ project: projectKey(projectRoot), slug: 'done-item', column: 'archive' }),
    );

    assert.equal(moved.code, 200);
    assert.doesNotMatch(readFileSync(tasks, 'utf8'), /## done-item/u);
    const archive = readFileSync(join(projectRoot, 'archived.md'), 'utf8');
    assert.match(archive, /## done-item/u);
    assert.equal(fieldOf(archive, 'done-item', 'status'), 'done');
  });

  it('заводит колонку под незнакомый статус на названном месте и переносит в неё', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const tasks = join(projectRoot, 'backlog.md');
    writeFileSync(tasks, ITEMS(ITEM('one', 'todo'), ITEM('later', 'postponed')));
    const server = await startServer(t, { runsRoot });
    const key = projectKey(projectRoot);

    // Колонки ещё нет — писать её статус доска не вправе.
    const refused = await sendJson(server, movePayload({ project: key, slug: 'one', column: 'postponed' }));
    assert.equal(refused.code, 400);

    const added = await sendJson(server, {
      method: 'POST',
      path: '/api/board/columns',
      body: JSON.stringify({ project: key, id: 'postponed', title: 'Отложено', index: 1 }),
    });
    assert.equal(added.code, 200);
    const board = readFileSync(join(projectRoot, '.stepcast', 'board.yml'), 'utf8');
    assert.ok(board.indexOf('postponed') > board.indexOf('todo'));
    assert.ok(board.indexOf('postponed') < board.indexOf('in_progress'));

    const again = await sendJson(server, {
      method: 'POST',
      path: '/api/board/columns',
      body: JSON.stringify({ project: key, id: 'postponed', index: 0 }),
    });
    assert.equal(again.code, 400, 'повтор колонки — отказ');

    const moved = await sendJson(server, movePayload({ project: key, slug: 'one', column: 'postponed' }));
    assert.equal(moved.code, 200);
    assert.equal(fieldOf(readFileSync(tasks, 'utf8'), 'one', 'status'), 'postponed');
  });

  it('возвращает пункт из архива в очередь с новым статусом', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(join(projectRoot, 'backlog.md'), ITEMS(ITEM('live', 'todo')));
    writeFileSync(join(projectRoot, 'archived.md'), ITEMS(ITEM('old', 'done')));
    const server = await startServer(t, { runsRoot });

    const moved = await sendJson(
      server,
      movePayload({ project: projectKey(projectRoot), slug: 'old', column: 'todo' }),
    );

    assert.equal(moved.code, 200);
    const tasks = readFileSync(join(projectRoot, 'backlog.md'), 'utf8');
    assert.equal(fieldOf(tasks, 'old', 'status'), 'todo');
    assert.doesNotMatch(readFileSync(join(projectRoot, 'archived.md'), 'utf8'), /## old/u);
  });

  it('в работу доской не переводит: это дело запуска пайплайна', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const tasks = join(projectRoot, 'backlog.md');
    writeFileSync(tasks, ITEMS(ITEM('one', 'todo')));
    const server = await startServer(t, { runsRoot });

    const moved = await sendJson(
      server,
      movePayload({ project: projectKey(projectRoot), slug: 'one', column: 'in_progress' }),
    );

    assert.equal(moved.code, 400);
    assert.equal(fieldOf(readFileSync(tasks, 'utf8'), 'one', 'status'), 'todo');
  });

  it('неизвестный пункт — 404, файл не тронут', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const tasks = join(projectRoot, 'backlog.md');
    writeFileSync(tasks, ITEMS(ITEM('one', 'todo')));
    const before = readFileSync(tasks, 'utf8');
    const server = await startServer(t, { runsRoot });

    const moved = await sendJson(
      server,
      movePayload({ project: projectKey(projectRoot), slug: 'no-such', column: 'todo' }),
    );

    assert.equal(moved.code, 404);
    assert.equal(readFileSync(tasks, 'utf8'), before);
  });

  it('неизвестная колонка — отказ формата', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(join(projectRoot, 'backlog.md'), ITEMS(ITEM('one', 'todo')));
    const server = await startServer(t, { runsRoot });

    const moved = await sendJson(
      server,
      movePayload({ project: projectKey(projectRoot), slug: 'one', column: 'somewhere' }),
    );

    assert.equal(moved.code, 400);
  });
});

describe('screen-scrum: правка пункта панелью деталей', () => {
  const ITEMS = (...items: readonly string[]): string => `# Очередь\n\n${items.join('\n')}`;
  const ITEM = (slug: string, status: string, extra = ''): string =>
    `## ${slug}\n\nstatus: ${status}\ntitle: т\nwhy: з\ndone_when: к\n${extra}`;

  function editPayload(body: Record<string, unknown>): { method: string; path: string; body: string } {
    return { method: 'POST', path: '/api/backlog/item', body: JSON.stringify(body) };
  }

  function fieldOf(text: string, slug: string, field: string): string | undefined {
    const block = text.split(/^## /mu).find((part) => part.startsWith(slug));
    return new RegExp(`^${field}: (.*)$`, 'mu').exec(block ?? '')?.[1];
  }

  it('переписывает названные поля, не трогая остальные', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const queue = join(projectRoot, 'backlog.md');
    writeFileSync(queue, ITEMS(ITEM('one', 'todo'), ITEM('two', 'todo')));
    const server = await startServer(t, { runsRoot });

    const saved = await sendJson(
      server,
      editPayload({
        project: projectKey(projectRoot),
        slug: 'one',
        fields: { title: 'новый заголовок', track: 'express' },
      }),
    );

    assert.equal(saved.code, 200);
    const text = readFileSync(queue, 'utf8');
    assert.equal(fieldOf(text, 'one', 'title'), 'новый заголовок');
    assert.equal(fieldOf(text, 'one', 'why'), 'з');
    assert.equal(fieldOf(text, 'one', 'track'), 'express');
    assert.equal(fieldOf(text, 'two', 'title'), 'т');
  });

  it('пустое значение необязательного поля убирает само поле', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const queue = join(projectRoot, 'backlog.md');
    writeFileSync(queue, ITEMS(ITEM('one', 'todo', 'track: express\n')));
    const server = await startServer(t, { runsRoot });

    const saved = await sendJson(
      server,
      editPayload({ project: projectKey(projectRoot), slug: 'one', fields: { track: '' } }),
    );

    assert.equal(saved.code, 200);
    assert.equal(fieldOf(readFileSync(queue, 'utf8'), 'one', 'track'), undefined);
  });

  it('пустое обязательное поле — отказ, файл не тронут', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const queue = join(projectRoot, 'backlog.md');
    writeFileSync(queue, ITEMS(ITEM('one', 'todo')));
    const before = readFileSync(queue, 'utf8');
    const server = await startServer(t, { runsRoot });

    const saved = await sendJson(
      server,
      editPayload({ project: projectKey(projectRoot), slug: 'one', fields: { title: '  ' } }),
    );

    assert.equal(saved.code, 400);
    assert.equal(readFileSync(queue, 'utf8'), before);
  });

  it('негодное значение отвергается до записи: файл остаётся разбираемым', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const queue = join(projectRoot, 'backlog.md');
    writeFileSync(queue, ITEMS(ITEM('one', 'todo')));
    const before = readFileSync(queue, 'utf8');
    const server = await startServer(t, { runsRoot });

    const saved = await sendJson(
      server,
      editPayload({ project: projectKey(projectRoot), slug: 'one', fields: { track: 'Не Слаг' } }),
    );

    assert.equal(saved.code, 400);
    assert.equal(readFileSync(queue, 'utf8'), before);
  });

  it('статус панелью не правится: его задаёт колонка', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(join(projectRoot, 'backlog.md'), ITEMS(ITEM('one', 'todo')));
    const server = await startServer(t, { runsRoot });

    const saved = await sendJson(
      server,
      editPayload({ project: projectKey(projectRoot), slug: 'one', fields: { status: 'done' } }),
    );

    assert.equal(saved.code, 400);
  });

  it('правит и пункт архива — он лежит в другом файле, но остаётся пунктом', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(join(projectRoot, 'backlog.md'), ITEMS(ITEM('live', 'todo')));
    const archive = join(projectRoot, 'archived.md');
    writeFileSync(archive, ITEMS(ITEM('old', 'done')));
    const server = await startServer(t, { runsRoot });

    const saved = await sendJson(
      server,
      editPayload({ project: projectKey(projectRoot), slug: 'old', fields: { why: 'уточнённая причина' } }),
    );

    assert.equal(saved.code, 200);
    assert.equal(fieldOf(readFileSync(archive, 'utf8'), 'old', 'why'), 'уточнённая причина');
  });
});

describe('ui-dashboard: маршрут и поток очереди', () => {
  it('отдаёт очереди проектов маршрутом и страницу экрана своим адресом', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(join(projectRoot, 'backlog.md'), BACKLOG_ITEM('todo'));
    const dashboard = ensureDashboard(t);
    const server = await startServer(t, { runsRoot });

    const backlog = await fetchJson(server, '/api/backlog');
    assert.equal(backlog.code, 200);
    assert.equal(pick(backlog.json, 'projects', 0, 'items', 0, 'slug'), 'work-item');

    const page = await fetchPath(server, '/backlog');
    assert.equal(page.code, 200);
    assert.equal(page.body, readFileSync(dashboard, 'utf8'));
  });

  // Сценарий: «Статус пункта меняется на лету»
  it('шлёт по SSE событие backlog первым кадром и после правки файла очереди', async (t) => {
    // Прогон и файл очереди заводятся уже после старта наблюдателя — иначе
    // первый же такт `backfillUsageStore` (запускается в createUiServer)
    // сам меняет отпечаток хранилища расхода и даёт лишний кадр, не связанный
    // с очередью вовсе.
    const { runsRoot, projectRoot } = makeJournalBed();
    const watcher = startWatcher(t, runsRoot, 20);
    const server = await startServer(t, { runsRoot, watcher });

    const stream = openStream(t, server, '/api/events');
    await settle();

    assert.deepEqual(
      stream.events.map((event) => event.event),
      ['overview', 'backlog', 'widgets', 'proposals', 'routes', 'dashboards', 'plugins', 'screens'],
    );
    assert.deepEqual(pick(stream.events[1]?.data, 'projects'), []);

    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(join(projectRoot, 'backlog.md'), BACKLOG_ITEM('todo'));
    await settle(300);

    const events = stream.events.filter((event) => event.event === 'backlog');
    assert.equal(
      pick(events.at(-1)?.data, 'projects', 0, 'items', 0, 'status'),
      'todo',
      'появление файла очереди должно дойти без перезагрузки',
    );
  });

  // Сценарий: «Изменение прогона не перечитывает очередь»
  it('не повторяет кадр очереди, когда изменился только прогон', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(join(projectRoot, 'backlog.md'), BACKLOG_ITEM('todo'));
    const watcher = startWatcher(t, runsRoot, 20);
    const server = await startServer(t, { runsRoot, watcher });

    const stream = openStream(t, server, '/api/events');
    await settle();

    // Очередь не трогаем — меняется только корень прогонов.
    seedRun(runsRoot, projectRoot, { runId: 'b' });
    await settle(300);

    assert.ok(
      stream.events.filter((event) => event.event === 'overview').length > 1,
      'появление прогона обязано дойти обзором',
    );
    assert.equal(
      stream.events.filter((event) => event.event === 'backlog').length,
      1,
      'очередь весит сотни килобайт: неизменной её шлют один раз, первым кадром',
    );
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
 * Плагин контекста, заводящий сервис с именем, которого ядро не знает. Два
 * проекта, объявившие его оба, спорили бы за имя, если бы демон держал один
 * общий корень: изоляция проектов проверяется именно этим (design.md
 * изменения `cordis-kernel-daemon`, Решение 6).
 */
const SHARED_SERVICE_PLUGIN = `
export default function shared(ctx) {
  ctx.provide('shared-service');
  ctx.set('shared-service', { from: 'plugin' });
}
`;

/**
 * Плагин контекста, заводящий таймер эффектом области. Не остановленный,
 * `setInterval` держит событийный цикл живым — тот же симптом, что у
 * служебного процесса `esbuild` (design.md изменения `ui-runtime-widget-spike`,
 * Решение 12), только источник теперь плагин, а не компилятор виджетов.
 *
 * Отметка на диске пишется при заведении эффекта: без неё проба, в которой
 * плагин не загрузился вовсе, завершилась бы так же успешно, как проба, в
 * которой область снята, — то есть не проверяла бы ничего.
 */
function intervalPlugin(marker: string): string {
  return `
import { writeFileSync } from 'node:fs';

export default function withInterval(ctx) {
  ctx.effect(() => {
    const timer = setInterval(() => {}, 1000);
    writeFileSync(${JSON.stringify(marker)}, 'таймер заведён');
    return () => clearInterval(timer);
  });
}
`;
}

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

describe('ui-dashboard: отбор прогонов по явному списку адресов', () => {
  // Сценарий: «Объём выбранных прогонов»
  it('называет размер каждого из трёх адресов, их число и суммарный объём', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    seedRun(runsRoot, projectRoot, { runId: 'b' });
    seedRun(runsRoot, projectRoot, { runId: 'c' });
    writeFileSync(join(runPaths(runsRoot, key, 'a').dir, 'груз.bin'), 'x'.repeat(10_000));
    const server = await startServer(t, { runsRoot });

    const query = ['a', 'b', 'c'].map((runId) => `run=${address(key, runId)}`).join('&');
    const selected = await fetchJson(server, `/api/runs?${query}`);

    assert.equal(selected.code, 200);
    assert.equal(selected.json.count, 3);
    const runs = selected.json.runs as Array<{ address: string; sizeBytes: number }>;
    assert.deepEqual(
      runs.map((r) => r.address).sort(),
      [`${key}/a`, `${key}/b`, `${key}/c`].sort(),
    );
    assert.equal(
      selected.json.totalBytes,
      runs.reduce((sum, r) => sum + r.sizeBytes, 0),
    );
    assert.ok(existsSync(runPaths(runsRoot, key, 'a').dir), 'отбор ничего не удаляет');
  });

  // Сценарий: «Адреса вместе с признаком»
  it('отклоняет запрос, называющий и адреса, и признак', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const server = await startServer(t, { runsRoot });

    for (const extra of ['trait=failed', 'older-than=7d', `project=${key}`]) {
      const refused = await fetchJson(server, `/api/runs?run=${address(key, 'a')}&${extra}`);
      assert.equal(refused.code, 400, `run вместе с ${extra} должен быть отклонён`);
    }
  });

  // Сценарий: «Адрес исчезнувшего прогона»
  it('пропускает адрес исчезнувшего прогона, а остальные измеряет', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    seedRun(runsRoot, projectRoot, { runId: 'here' });
    const server = await startServer(t, { runsRoot });

    const selected = await fetchJson(
      server,
      `/api/runs?run=${address(key, 'here')}&run=${address(key, 'нет-такого')}`,
    );

    assert.equal(selected.code, 200);
    assert.equal(selected.json.count, 1);
    assert.deepEqual(
      (selected.json.runs as Array<{ address: string }>).map((r) => r.address),
      [`${key}/here`],
    );
  });

  // Сценарий: «Адрес неверной формы»
  it('отклоняет адрес неверной формы', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const server = await startServer(t, { runsRoot });

    const refused = await fetchJson(server, `/api/runs?run=${encodeURIComponent('однасегмент')}`);
    assert.equal(refused.code, 400);
    assert.equal(refused.json.runs, undefined);
  });

  // Сценарий: «Адрес за пределами корня»
  it('отклоняет адрес, уводящий за пределы корня прогонов', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const server = await startServer(t, { runsRoot });

    const refused = await fetchJson(server, `/api/runs?run=${encodeURIComponent('../..')}`);
    assert.equal(refused.code, 400);
    assert.equal(refused.json.runs, undefined);
  });

  // Сценарий: «Адрес назван дважды»
  it('меряет дважды названный адрес один раз', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(join(runPaths(runsRoot, key, 'a').dir, 'груз.bin'), 'x'.repeat(10_000));
    const server = await startServer(t, { runsRoot });

    const once = await fetchJson(server, `/api/runs?run=${address(key, 'a')}`);
    const twice = await fetchJson(server, `/api/runs?run=${address(key, 'a')}&run=${address(key, 'a')}`);

    assert.equal(twice.code, 200);
    assert.equal(twice.json.count, 1);
    assert.equal(twice.json.totalBytes, once.json.totalBytes);
    assert.deepEqual(
      (twice.json.runs as Array<{ address: string }>).map((r) => r.address),
      [`${key}/a`],
    );
  });

  // Повторы снимаются до проверки предела: предел считает прогоны, а не
  // строки запроса, и один адрес, названный 501 раз, — по-прежнему один прогон.
  it('не считает повторы одного адреса списком сверх предела', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const server = await startServer(t, { runsRoot });

    const query = Array.from({ length: 501 }, () => `run=${address(key, 'a')}`).join('&');
    const selected = await fetchJson(server, `/api/runs?${query}`);

    assert.equal(selected.code, 200);
    assert.equal(selected.json.count, 1);
  });

  // Сценарий: «Список сверх предела»
  it('отклоняет список адресов сверх предела и ничего не измеряет', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const server = await startServer(t, { runsRoot });

    // Короткие ASCII-адреса: длина запроса не должна упереться в предел
    // заголовков HTTP раньше проверки числа адресов, которую здесь и проверяем.
    const query = Array.from({ length: 501 }, (_, i) => `run=${address(key, `m${i}`)}`).join('&');
    const refused = await fetchJson(server, `/api/runs?${query}`);
    assert.equal(refused.code, 413);
    assert.equal(refused.json.runs, undefined);
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

describe('ui-dashboard: согласие отбора витрины с диском и с терминалом', () => {
  // Сценарий спеки ui-dashboard «Прогон, не дописавший своей записи»: демон
  // поднят раньше, чем прогон появился на диске, — без догона хранилище так и
  // осталось бы снимком на момент старта (design.md, Решение 2).
  it('видит прогон, засеянный после старта демона, в отборе записей хранилища', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    const server = await startServer(t, { runsRoot });

    seedRun(runsRoot, projectRoot, { runId: 'после-старта' });

    const selected = await fetchJson(server, `/api/usage-records?older-than=0s&project=${key}`);
    assert.deepEqual(
      (selected.json.records as Array<{ address: string }>).map((r) => r.address),
      [`${key}/после-старта`],
    );
  });

  // Сценарий спеки ui-dashboard «Метка „записи нет“ говорит о прогоне»: за
  // меткой стоит кнопка «вместе со статистикой», то есть разрушительное
  // действие, и врать ею опаснее, чем списком (design.md, Решение 2).
  it('называет прогон, засеянный после старта демона, прогоном с записью в хранилище', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    const server = await startServer(t, { runsRoot });

    seedRun(runsRoot, projectRoot, { runId: 'после-старта', status: 'failed' });

    const selected = await fetchJson(server, `/api/runs?trait=failed&project=${key}`);
    const runs = selected.json.runs as Array<{ address: string; hasUsageRecord: boolean }>;
    assert.deepEqual(
      runs.map((run) => run.address),
      [`${key}/после-старта`],
    );
    assert.equal(
      runs[0]?.hasUsageRecord,
      true,
      'сводка расхода у прогона подведена — сохранять при удалении есть что',
    );
  });

  // Риск design.md «Догон пишет в хранилище на GET-запросе»: дозапись может
  // отказать (корень только для чтения, кончилось место, чужой файл
  // хранилища), а маршруты витрины синхронны — брошенное исключение уронило бы
  // весь демон. Отбор обязан выродиться в «без свежих записей», а не в отказ.
  it('переживает отказ дозаписи хранилища на отборе и отвечает тем, что есть', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    // Демон поднят на пустом корне: файла хранилища ещё нет, и догону
    // придётся заводить его в корне, куда писать нельзя.
    const server = await startServer(t, { runsRoot });
    seedRun(runsRoot, projectRoot, { runId: 'после-старта', status: 'failed' });

    // Каталог без права на запись — тот же способ вызвать отказ, что и в
    // test/scratch.test.ts; читать содержимое корня он не мешает.
    chmodSync(runsRoot, 0o500);
    try {
      const byTrait = await fetchJson(server, `/api/runs?trait=failed&project=${key}`);
      assert.equal(byTrait.code, 200);
      const runs = byTrait.json.runs as Array<{ address: string; hasUsageRecord: boolean }>;
      assert.deepEqual(
        runs.map((run) => run.address),
        [`${key}/после-старта`],
        'отбор идёт по каталогам и от отказа дозаписи не зависит',
      );
      assert.equal(runs[0]?.hasUsageRecord, false, 'записи не появилось — метка обязана это признать');

      const byRecords = await fetchJson(server, `/api/usage-records?trait=failed&project=${key}`);
      assert.equal(byRecords.code, 200);
      assert.deepEqual(byRecords.json.records, []);

      const byAddress = await fetchJson(server, `/api/runs?run=${address(key, 'после-старта')}`);
      assert.equal(byAddress.code, 200);
      assert.equal(byAddress.json.count, 1);
    } finally {
      chmodSync(runsRoot, 0o700);
    }
  });

  // Сценарий спеки «Срок в витрине и в терминале» (design.md, Решение 4):
  // сначала отбор витрины (только смотрит), затем `stepcast gc --older-than`
  // (удаляет) на том же корне — множества обязаны совпасть.
  it('согласие по сроку: отбор витрины называет тот же набор, что удаляет stepcast gc', async (t) => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    const key = projectKey(projectRoot);
    const old = {
      started_at: '2020-01-01T00:00:00.000Z',
      finished_at: '2020-01-01T00:05:00.000Z',
    };
    const server = await startServer(t, { runsRoot });

    // Прогоны появляются после старта демона — спека требует согласия
    // «независимо от того, как давно поднят демон». Отбор каталогов на
    // хранилище не опирается вовсе, и красным до правки этот сценарий не
    // бывает: он сторожит согласие двух реализаций отбора по сроку, а
    // отставание хранилища ловит сценарий по записям ниже.
    seedRun(runsRoot, projectRoot, { runId: 'old-a', manifest: old });
    seedRun(runsRoot, projectRoot, { runId: 'old-b', manifest: old });
    seedRun(runsRoot, projectRoot, { runId: 'recent' });

    // Витрина — первой: отбор ничего не трогает.
    const selected = await fetchJson(server, `/api/runs?older-than=365d&project=${key}`);
    const shownShortIds = new Set(
      (selected.json.runs as Array<{ address: string }>).map((r) => shortRunId(r.address.slice(key.length + 1))),
    );
    assert.equal(shownShortIds.size, 2, 'сценарий обязан застать непустой отбор, иначе согласие тривиально');

    // Команда — второй: она и удаляет.
    const lines: string[] = [];
    withHome(home, () =>
      runGcCommand(gcArgs({ 'older-than': '365d' }), (line) => lines.push(line), projectRoot),
    );
    const removedShortIds = new Set(
      lines
        .filter((line) => line.startsWith('удалён: '))
        .map((line) => line.slice('удалён: '.length).split(' ')[0]!),
    );

    assert.deepEqual(shownShortIds, removedShortIds);
  });

  // Сценарий «Записи в витрине и в терминале»: то же согласие, но для цели
  // «записи хранилища» и `stepcast gc --stats`.
  it('согласие по записям: отбор витрины называет тот же набор, что снимает stepcast gc --stats', async (t) => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    const key = projectKey(projectRoot);
    const server = await startServer(t, { runsRoot });

    // Прогоны появляются после старта демона и своих записей не дописывают:
    // перенос при старте их не застал. Без догона в маршруте витрина назовёт
    // пустой набор — на этом сценарий и падает до правки. Команде в этом же
    // процессе перенос достаётся уже сделанным догоном витрины (её
    // собственный `backfillUsageStore` защёлкнут стартом демона); в своём
    // процессе она переносит сама, и согласие проверяется то же.
    seedRun(runsRoot, projectRoot, { runId: 'failed-a', status: 'failed' });
    seedRun(runsRoot, projectRoot, { runId: 'failed-b', status: 'failed' });
    seedRun(runsRoot, projectRoot, { runId: 'ok', status: 'success' });

    const selected = await fetchJson(server, `/api/usage-records?trait=failed&project=${key}`);
    const shownAddresses = new Set(
      (selected.json.records as Array<{ address: string }>).map((r) => r.address),
    );
    assert.equal(shownAddresses.size, 2, 'сценарий обязан застать непустой отбор, иначе согласие тривиально');

    const lines: string[] = [];
    withHome(home, () =>
      runGcCommand(gcArgs({ stats: true, failed: true }), (line) => lines.push(line), projectRoot),
    );
    const removedAddresses = new Set(
      lines
        .filter((line) => line.startsWith('снята запись: '))
        .map((line) => line.slice('снята запись: '.length)),
    );

    assert.deepEqual(shownAddresses, removedAddresses);
  });

  it('GET /api/runs называет число прогонов, чей статус не удалось прочитать', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, { runId: 'broken', status: 'failed' });
    writeFileSync(journal.paths.manifest, '{ не json');
    writeFileSync(journal.paths.status, '{ не json');
    const server = await startServer(t, { runsRoot });

    const selected = await fetchJson(server, '/api/runs?trait=failed');
    assert.deepEqual(selected.json.runs, []);
    assert.equal(selected.json.uncheckedCount, 1);
  });

  // Ни отбор по признаку, ни отбор по записям, ни отбор по явному адресу не
  // должны снимать каталоги или строки хранилища — отбор только показывает,
  // что удалится, а удаляет отдельный запрос (design.md, Решение 2, риск
  // «Догон пишет в хранилище на GET-запросе»).
  it('любой отбор не удаляет каталогов и не убавляет строк хранилища', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    const journal = seedRun(runsRoot, projectRoot, { runId: 'a', status: 'failed' });
    const server = await startServer(t, { runsRoot });
    const before = readFileSync(usageStorePath(runsRoot), 'utf8');

    await fetchJson(server, '/api/runs?trait=failed');
    await fetchJson(server, `/api/usage-records?trait=failed&project=${key}`);
    await fetchJson(server, `/api/runs?run=${address(key, 'a')}`);

    assert.ok(existsSync(journal.paths.dir), 'каталог прогона обязан остаться');
    const after = readFileSync(usageStorePath(runsRoot), 'utf8');
    assert.ok(after.startsWith(before), 'отбор может дописать хранилище, но не переписать и не урезать его');
  });
});

describe('ui-dashboard: настройки дефолтов', () => {
  it('отдаёт действующие значения с их источниками', async (t) => {
    const { runsRoot, home } = makeJournalBed();
    const server = await startServer(t, { runsRoot, home });

    const settings = await fetchJson(server, '/api/settings');
    assert.equal(settings.code, 200);
    assert.equal(pick(settings.json, 'agent', 'value'), 'claude');
    assert.equal(pick(settings.json, 'agent', 'source'), 'built-in default');
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

/**
 * Двойник `claude --help`: скрипт-заглушка на месте `backends.claude.command`.
 * Аргумент `--help` даёт разбираемую справку с описанием `--model`, и каждый
 * настоящий запуск дописывает метку в `COUNTER_FILE` — так тест видит, сколько
 * раз демон действительно поднял процесс, не читая память демона напрямую.
 */
function writeStubClaude(home: string, counterFile: string): string {
  const path = join(home, 'stub-claude.js');
  writeFileSync(
    path,
    [
      '#!/usr/bin/env node',
      `const fs = require('fs');`,
      `fs.appendFileSync(${JSON.stringify(counterFile)}, 'x');`,
      `const n = fs.readFileSync(${JSON.stringify(counterFile)}, 'utf8').length;`,
      `process.stdout.write("  --model <model>  используйте 'run-" + n + "'\\n");`,
    ].join('\n'),
  );
  chmodSync(path, 0o755);
  return path;
}

/** Двойник CLI, который никогда не отвечает: для проверки, что /api/settings его не ждёт. */
function writeStubHangingClaude(home: string): string {
  const path = join(home, 'stub-hanging-claude.js');
  writeFileSync(path, ['#!/usr/bin/env node', 'setTimeout(() => {}, 60_000);'].join('\n'));
  chmodSync(path, 0o755);
  return path;
}

describe('ui-dashboard: перечисление моделей агентов', () => {
  it('по каждому агенту — список либо причина; codex до подключения — unsupported; ?refresh=1 перечисляет заново', async (t) => {
    resetModelDiscoveryCache();
    const { runsRoot, home } = makeJournalBed();
    const counterFile = join(home, 'counter');
    writeFileSync(counterFile, '');
    const stub = writeStubClaude(home, counterFile);
    writeFileSync(
      join(home, '.stepcast', 'config.yml'),
      `runs:\n  root: ${runsRoot}\nbackends:\n  claude:\n    command: ${stub}\n`,
    );
    const server = await startServer(t, { runsRoot, home });

    const first = await fetchJson(server, '/api/models');
    assert.equal(first.code, 200);
    const firstBackends = first.json.backends as Record<string, { status: string; models?: { name: string }[] }>;
    assert.equal(firstBackends.codex?.status, 'unsupported', 'codex до подключения — перечислять не умеет');
    assert.equal(firstBackends.claude?.status, 'ok');
    assert.deepEqual(firstBackends.claude?.models, [{ name: 'run-1' }]);

    const cached = await fetchJson(server, '/api/models');
    assert.deepEqual(
      (cached.json.backends as typeof firstBackends).claude?.models,
      [{ name: 'run-1' }],
      'без ?refresh — удержанный ответ, процесс заново не поднимается',
    );

    const refreshed = await fetchJson(server, '/api/models?refresh=1');
    assert.deepEqual(
      (refreshed.json.backends as typeof firstBackends).claude?.models,
      [{ name: 'run-2' }],
      '?refresh=1 обходит удержание и перечисляет заново',
    );
  });

  it('GET /api/settings отвечает прежним телом и не ждёт пробы, даже когда CLI зависает', async (t) => {
    resetModelDiscoveryCache();
    const { runsRoot, home } = makeJournalBed();
    const hanging = writeStubHangingClaude(home);
    writeFileSync(
      join(home, '.stepcast', 'config.yml'),
      `runs:\n  root: ${runsRoot}\nbackends:\n  claude:\n    command: ${hanging}\n`,
    );
    const server = await startServer(t, { runsRoot, home });

    const started = Date.now();
    const settings = await fetchJson(server, '/api/settings');
    const elapsedMs = Date.now() - started;

    assert.equal(settings.code, 200);
    assert.equal(pick(settings.json, 'agent', 'value'), 'claude');
    assert.ok(
      elapsedMs < 2_000,
      `/api/settings обязан отвечать не дожидаясь пробы (заняло ${elapsedMs} мс — зависший CLI ответил бы не раньше 60с)`,
    );
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

describe('ui-dashboard: каталог переиспользуемых шагов', () => {
  const GREET_MANIFEST = `
version: 1
kind: step
name: greet
description: Приветствует по имени.
file: ./main.cjs
params:
  type: object
  properties:
    name: { type: string, default: world, description: Кого приветствовать }
output_schema: ./output.schema.json
`;

  // Сценарий: «Каталог перечисляет шаги трёх слоёв»
  it('перечисляет шаг проекта наравне со встроенными пакета, называя слой каждого', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(join(projectRoot, 'stepcast.yml'), DEMO_PIPELINE);
    mkdirSync(join(projectRoot, '.stepcast', 'steps', 'greet'), { recursive: true });
    writeFileSync(join(projectRoot, '.stepcast', 'steps', 'greet', 'step.yml'), GREET_MANIFEST);
    writeFileSync(join(projectRoot, '.stepcast', 'steps', 'greet', 'main.cjs'), 'module.exports = () => {};\n');
    const steps = { code: 200, json: buildSteps(runsRoot, { home }) as unknown as Record<string, unknown> };
    assert.equal(steps.code, 200);
    const projectSteps = pick(steps.json, 'projects', 0, 'steps') as Array<{ name: string; layer: string }>;
    const greet = projectSteps.find((step) => step.name === 'greet');
    assert.equal(greet?.layer, 'project');
    // Пакет всегда поставляет хотя бы один встроенный образец — каталог не
    // пуст даже без единого шага проекта (design.md, решение 12).
    assert.ok(projectSteps.some((step) => step.layer === 'builtin'), JSON.stringify(projectSteps));
  });

  // Сценарий: «Параметры видны с типами и умолчаниями»
  it('показывает параметр именем, типом, обязательностью, умолчанием и описанием', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(join(projectRoot, 'stepcast.yml'), DEMO_PIPELINE);
    mkdirSync(join(projectRoot, '.stepcast', 'steps', 'greet'), { recursive: true });
    writeFileSync(join(projectRoot, '.stepcast', 'steps', 'greet', 'step.yml'), GREET_MANIFEST);
    writeFileSync(join(projectRoot, '.stepcast', 'steps', 'greet', 'main.cjs'), 'module.exports = () => {};\n');
    const steps = { code: 200, json: buildSteps(runsRoot, { home }) as unknown as Record<string, unknown> };
    const projectSteps = pick(steps.json, 'projects', 0, 'steps') as Array<{
      name: string;
      params: Array<{ name: string; type?: string; required: boolean; default?: unknown; description?: string }>;
    }>;
    const param = projectSteps.find((step) => step.name === 'greet')?.params[0];
    assert.equal(param?.name, 'name');
    assert.equal(param?.type, 'string');
    assert.equal(param?.required, false);
    assert.equal(param?.default, 'world');
    assert.equal(param?.description, 'Кого приветствовать');
  });

  // Сценарий: «Перекрытый шаг отмечен»
  it('отмечает перекрытый шаг домашнего слоя, а не пропускает его', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(join(projectRoot, 'stepcast.yml'), DEMO_PIPELINE);
    mkdirSync(join(projectRoot, '.stepcast', 'steps', 'greet'), { recursive: true });
    writeFileSync(join(projectRoot, '.stepcast', 'steps', 'greet', 'step.yml'), GREET_MANIFEST);
    writeFileSync(join(projectRoot, '.stepcast', 'steps', 'greet', 'main.cjs'), 'module.exports = () => {};\n');
    mkdirSync(join(home, '.stepcast', 'steps', 'greet'), { recursive: true });
    writeFileSync(join(home, '.stepcast', 'steps', 'greet', 'step.yml'), GREET_MANIFEST);
    writeFileSync(join(home, '.stepcast', 'steps', 'greet', 'main.cjs'), 'module.exports = () => {};\n');
    const steps = { code: 200, json: buildSteps(runsRoot, { home }) as unknown as Record<string, unknown> };
    const projectSteps = pick(steps.json, 'projects', 0, 'steps') as Array<{
      name: string;
      layer: string;
      overridden: boolean;
    }>;
    const greetSteps = projectSteps.filter((step) => step.name === 'greet');
    assert.deepEqual(
      greetSteps.map((step) => [step.layer, step.overridden]).sort(),
      [
        ['home', true],
        ['project', false],
      ],
    );
  });

  // Сценарий: «Чистый проект»
  it('проект без .stepcast/steps/ показывает встроенные шаги пакета, а не пустой список', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(join(projectRoot, 'stepcast.yml'), DEMO_PIPELINE);
    const steps = { code: 200, json: buildSteps(runsRoot, { home }) as unknown as Record<string, unknown> };
    const projectSteps = pick(steps.json, 'projects', 0, 'steps') as unknown[];
    assert.ok(projectSteps.length > 0);
  });

  // Сценарий: «Дефектный манифест»
  it('дефектный манифест показан с причиной отказа и файлом манифеста', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(join(projectRoot, 'stepcast.yml'), DEMO_PIPELINE);
    mkdirSync(join(projectRoot, '.stepcast', 'steps', 'greet'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.stepcast', 'steps', 'greet', 'step.yml'),
      `${GREET_MANIFEST}\nunexpected_field: 1\n`,
    );
    writeFileSync(join(projectRoot, '.stepcast', 'steps', 'greet', 'main.cjs'), 'module.exports = () => {};\n');
    const steps = { code: 200, json: buildSteps(runsRoot, { home }) as unknown as Record<string, unknown> };
    const projectSteps = pick(steps.json, 'projects', 0, 'steps') as Array<{
      name: string;
      error?: string;
      manifestPath: string;
    }>;
    const greet = projectSteps.find((step) => step.name === 'greet');
    assert.match(greet?.error ?? '', /unexpected_field/);
    assert.match(greet?.manifestPath ?? '', /step\.yml$/);
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

  it('патч, заменивший строку своим модулем, на работающем демоне снимает вклады прежнего модуля и вводит вклады нового', async (t) => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    withProjectPlugin(projectRoot, PREDICATE_PLUGIN); // id ключа plugins — сам спецификатор ./plugins/probe.mjs
    writeFileSync(join(projectRoot, 'stepcast.yml'), PREDICATE_PIPELINE);
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });
    const kernelCache = createKernelCache();
    const server = await startServer(t, { runsRoot, config, home, kernelCache });

    const before = await fetchJson(server, '/api/pipelines');
    assert.equal(pick(before.json, 'pipelines', 0, 'error'), undefined);

    // Патч заменяет строку, объявленную ключом plugins, модулем без
    // предикатов, но с бэкендом probe — тем же id, равным спецификатору
    // (design.md, Решение 4).
    writeFileSync(join(projectRoot, '.stepcast', 'plugins', 'backend.mjs'), BACKEND_PLUGIN);
    writeFileSync(
      join(projectRoot, '.stepcast', 'plugins.patch.yml'),
      'version: 1\nkind: plugins-patch\nplugins:\n  - id: ./plugins/probe.mjs\n    use: ./plugins/backend.mjs\n',
    );

    const after = await fetchJson(server, '/api/pipelines');
    assert.match(String(pick(after.json, 'pipelines', 0, 'error')), /неизвестный ключ always_ok/);

    const entry = kernelCache.entries.get(projectRoot);
    assert.ok(entry?.kernel.ctx.backends.contributions.has('probe'), 'вклад нового модуля действует');
    assert.ok(!(entry?.kernel.ctx.predicates.contributions.has('always_ok') ?? false), 'вклад прежнего модуля снят');
  });

  it('патч, объявивший действующую строку enabled: false, убирает её вклады из реестра проекта', async (t) => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    withProjectPlugin(projectRoot, PREDICATE_PLUGIN);
    writeFileSync(join(projectRoot, 'stepcast.yml'), PREDICATE_PIPELINE);
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });
    const kernelCache = createKernelCache();
    const server = await startServer(t, { runsRoot, config, home, kernelCache });

    const before = await fetchJson(server, '/api/pipelines');
    assert.equal(pick(before.json, 'pipelines', 0, 'error'), undefined);

    writeFileSync(
      join(projectRoot, '.stepcast', 'plugins.patch.yml'),
      'version: 1\nkind: plugins-patch\nplugins:\n  - id: ./plugins/probe.mjs\n    use: ./plugins/probe.mjs\n    enabled: false\n',
    );

    const after = await fetchJson(server, '/api/pipelines');
    assert.match(String(pick(after.json, 'pipelines', 0, 'error')), /неизвестный ключ always_ok/);
    const entry = kernelCache.entries.get(projectRoot);
    assert.ok(!(entry?.kernel.ctx.predicates.contributions.has('always_ok') ?? false));
  });

  it('строка с тем же id и модулем, перекочевавшая из домашнего патча в проектный, пересобирает ядро и грузится из нового каталога', async (t) => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    // Один и тот же относительный `use` в двух слоях означает два разных
    // файла на диске: он разрешается от файла, объявившего строку. Дерево, в
    // котором сменился только слой-источник, равным прежнему считаться не
    // вправе — иначе демон продолжил бы держать модуль домашнего каталога
    // (ui-daemon: правка любого файла, участвующего в сборке дерева).
    mkdirSync(join(home, '.stepcast', 'plugins'), { recursive: true });
    writeFileSync(join(home, '.stepcast', 'plugins', 'probe.mjs'), PREDICATE_PLUGIN);
    writeFileSync(
      join(home, '.stepcast', 'plugins.patch.yml'),
      'version: 1\nkind: plugins-patch\nplugins:\n  - id: probe\n    use: ./plugins/probe.mjs\n',
    );
    mkdirSync(join(projectRoot, '.stepcast', 'plugins'), { recursive: true });
    writeFileSync(join(projectRoot, '.stepcast', 'plugins', 'probe.mjs'), BACKEND_PLUGIN);
    writeFileSync(join(projectRoot, 'stepcast.yml'), PREDICATE_PIPELINE);
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });
    const kernelCache = createKernelCache();
    const server = await startServer(t, { runsRoot, config, home, kernelCache });

    const before = await fetchJson(server, '/api/pipelines');
    assert.equal(pick(before.json, 'pipelines', 0, 'error'), undefined, 'предикат домашнего модуля действует');

    // Тот же id и тот же `use` — но объявленные проектным патчем, то есть
    // разрешаемые от каталога проекта.
    writeFileSync(
      join(projectRoot, '.stepcast', 'plugins.patch.yml'),
      'version: 1\nkind: plugins-patch\nplugins:\n  - id: probe\n    use: ./plugins/probe.mjs\n',
    );

    const after = await fetchJson(server, '/api/pipelines');
    assert.match(String(pick(after.json, 'pipelines', 0, 'error')), /неизвестный ключ always_ok/);
    const entry = kernelCache.entries.get(projectRoot);
    assert.ok(entry?.kernel.ctx.backends.contributions.has('probe'), 'загружен модуль проектного каталога');
  });

  it('правка конфигурации, не меняющая ни одной строки дерева, ядро не пересобирает', async (t) => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    withProjectPlugin(projectRoot, PREDICATE_PLUGIN);
    writeFileSync(join(projectRoot, 'stepcast.yml'), PREDICATE_PIPELINE);
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });
    const kernelCache = createKernelCache();
    const server = await startServer(t, { runsRoot, config, home, kernelCache });

    await fetchJson(server, '/api/pipelines');
    const before = kernelCache.entries.get(projectRoot)?.kernel;
    assert.ok(before !== undefined);

    // Правка не трогает ни одной строки дерева — только defaults.model.
    writeFileSync(
      join(projectRoot, '.stepcast', 'config.yml'),
      'plugins: ["./plugins/probe.mjs"]\ndefaults:\n  model: opus\n',
    );

    await fetchJson(server, '/api/pipelines');
    const after = kernelCache.entries.get(projectRoot)?.kernel;
    assert.equal(after, before, 'ядро осталось тем же объектом — модули заново не импортировались');
  });

  it('собственное ядро демона (ключ — домашний каталог) собирает дерево с домашним патчем, без проектного слоя', async (t) => {
    const { home } = makeJournalBed();
    mkdirSync(join(home, '.stepcast', 'plugins'), { recursive: true });
    writeFileSync(join(home, '.stepcast', 'plugins', 'probe.mjs'), PREDICATE_PLUGIN);
    writeFileSync(
      join(home, '.stepcast', 'plugins.patch.yml'),
      'version: 1\nkind: plugins-patch\nplugins:\n  - id: home-probe\n    use: ./plugins/probe.mjs\n',
    );

    const kernelCache = createKernelCache();
    t.after(() => disposeRaisedKernels(kernelCache));
    const { registry } = await resolveWithCachedKernel(home, { cwd: home, home, projectPath: null }, home, kernelCache);

    assert.ok(registry.predicates.has('always_ok'), 'домашний патч подхвачен');
  });
});

describe('ui-dashboard: изоляция и снятие контекстов ядра (cordis-kernel-daemon)', () => {
  it('два проекта с одноимённым сервисом раскрываются оба, не споря по конфликту имён', async (t) => {
    const first = makeJournalBed();
    const second = makeJournalBed();
    seedRun(first.runsRoot, first.projectRoot, { runId: 'a' });
    withProjectPlugin(first.projectRoot, SHARED_SERVICE_PLUGIN);
    writeFileSync(join(first.projectRoot, 'stepcast.yml'), DEMO_PIPELINE);
    withProjectPlugin(second.projectRoot, SHARED_SERVICE_PLUGIN);
    writeFileSync(join(second.projectRoot, 'stepcast.yml'), DEMO_PIPELINE);
    // Второй проект живёт под тем же корнем прогонов, что и первый — иначе
    // обход `listProjects` его не увидит вовсе.
    seedRun(first.runsRoot, second.projectRoot, { runId: 'b' });
    const { config } = resolveConfig({ cwd: first.home, home: first.home, projectPath: null });
    const server = await startServer(t, { runsRoot: first.runsRoot, config, home: first.home });

    const pipelines = await fetchJson(server, '/api/pipelines');
    const views = pipelines.json.pipelines as Array<{ projectPath: string; error?: string }>;
    const own = views.find((view) => view.projectPath === first.projectRoot);
    const other = views.find((view) => view.projectPath === second.projectRoot);
    assert.ok(own !== undefined && other !== undefined, JSON.stringify(views));
    assert.equal(own?.error, undefined, own?.error);
    assert.equal(other?.error, undefined, other?.error);
  });

  it('контекст, поднятый в чужой кеш не сервером, close() не снимает', async (t) => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    withProjectPlugin(projectRoot, SHARED_SERVICE_PLUGIN);
    writeFileSync(join(projectRoot, 'stepcast.yml'), DEMO_PIPELINE);
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });

    // Ядро поднято ХОЗЯИНОМ кеша, до сервера: именно такое сервер снимать не
    // вправе. Кеш, отданный ему пустым, он наполняет сам — и то, что наполнил,
    // снимает (проверка ниже).
    const kernelCache = createKernelCache();
    t.after(() => disposeRaisedKernels(kernelCache));
    await resolveWithCachedKernel(projectRoot, { cwd: projectRoot, home }, projectRoot, kernelCache);
    assert.equal(kernelCache.entries.size, 1);
    const [entry] = [...kernelCache.entries.values()];

    const server = await startServer(t, { runsRoot, config, home, kernelCache });
    const pipelines = await fetchJson(server, '/api/pipelines');
    assert.equal(pick(pipelines.json, 'pipelines', 0, 'error'), undefined);
    // Запись проекта та же: объявления плагинов не менялись, и сервер взял
    // готовое ядро, а не поднял своё. Вторая запись — `home:<home>`: любой
    // запрос под `/api/` теперь ищет обработчик в реестре собственного ядра
    // демона (`src/parts/ui/daemon/kernel.ts`, `ui-daemon`, «Настройки и маршруты живут в
    // одном контексте демона»), и этот запрос завёл её впервые.
    assert.equal(kernelCache.entries.size, 2);
    assert.equal([...kernelCache.entries.values()][0], entry);

    await server.close();

    assert.deepEqual(entry?.kernel.ctx.get('shared-service'), { from: 'plugin' });
  });

  it('контекст, поднятый сервером в полученный извне кеш, close() снимает', async (t) => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    withProjectPlugin(projectRoot, SHARED_SERVICE_PLUGIN);
    writeFileSync(join(projectRoot, 'stepcast.yml'), DEMO_PIPELINE);
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });
    const kernelCache = createKernelCache();
    const server = await startServer(t, { runsRoot, config, home, kernelCache });

    const pipelines = await fetchJson(server, '/api/pipelines');
    assert.equal(pick(pipelines.json, 'pipelines', 0, 'error'), undefined);
    // Две записи: проект, раскрытый `/api/pipelines`, и `home:<home>` —
    // собственное ядро демона, которое дispatcher резолвит на каждый запрос
    // под `/api/`, чтобы найти обработчик в его реестре (`src/parts/ui/daemon/kernel.ts`).
    assert.equal(kernelCache.entries.size, 2);
    const projectEntry = kernelCache.entries.get(projectRoot);
    assert.deepEqual(projectEntry?.kernel.ctx.get('shared-service'), { from: 'plugin' });

    await server.close();

    // Кеш чужой, но контекст поднял сервер — значит он же его и снимает: иначе
    // демон тёк бы каждым раскрытым проектом (ui-daemon spec, «Остановка
    // снимает контексты»).
    assert.equal(projectEntry?.kernel.ctx.get('shared-service'), undefined);
  });

  /**
   * Область плагина держит таймер; не снятая при `close()`, она держит
   * событийный цикл, и поднявший сервер процесс не завершится сам —
   * проверяется отдельным процессом, как и у служебного процесса компилятора
   * виджетов (design.md изменения `ui-runtime-widget-spike`, Решение 12).
   *
   * Проба обязана раскрыть пайплайны по-настоящему: без `config` обзор
   * пайплайнов отвечает пустым списком, не обходя проекты вовсе, и проба
   * завершилась бы одинаково при любом поведении `close()`. Отсюда и
   * конфигурация, и проверка непустого ответа внутри пробы, и отметка,
   * оставленная эффектом плагина на диске.
   */
  it('close() снимает поднятые сервером контексты проектов: процесс завершается сам', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const marker = join(projectRoot, '.stepcast', 'таймер.txt');
    withProjectPlugin(projectRoot, intervalPlugin(marker));
    writeFileSync(join(projectRoot, 'stepcast.yml'), DEMO_PIPELINE);

    const moduleUrl = (path: string): string =>
      JSON.stringify(pathToFileURL(fileURLToPath(new URL(path, import.meta.url))).href);
    const probe = [
      `import { createUiServer } from ${moduleUrl('../src/parts/ui/daemon/server.js')};`,
      `import { resolveConfig } from ${moduleUrl('../src/parts/pipeline/config/resolve.js')};`,
      `const home = ${JSON.stringify(home)};`,
      'const { config } = resolveConfig({ cwd: home, home, projectPath: null });',
      `const server = await createUiServer({ runsRoot: ${JSON.stringify(runsRoot)}, config, home, port: 0 });`,
      `const res = await fetch(\`http://127.0.0.1:\${server.port}/api/pipelines\`);`,
      'const body = await res.json();',
      "if (body.pipelines.length === 0) throw new Error('пайплайны не раскрыты: ' + JSON.stringify(body));",
      'if (body.pipelines[0].error) throw new Error(body.pipelines[0].error);',
      'await server.close();',
      "console.log('done');",
    ].join('\n');

    const out = execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.match(out, /done/);
    assert.equal(existsSync(marker), true, 'плагин с таймером не был загружен — проба ничего не проверила');
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

  it('слой backend: встроенная модель Claude действует без пользовательских настроек', async (t) => {
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
    assert.equal(pick(step, 'model'), 'sonnet');
    assert.deepEqual(pick(step, 'modelOrigin'), { layer: 'backend', backend: 'claude' });
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

describe('ui-dashboard: конфигурация агентов и tier', () => {
  it('сохраняет модели каждого агента и подключает поставляемый Codex', async (t) => {
    const { runsRoot, home } = makeJournalBed();
    const server = await startServer(t, { runsRoot, home });
    const file = join(home, '.stepcast', 'config.yml');
    writeFileSync(file, `# сохранить комментарий\n${readFileSync(file, 'utf8')}`);
    const saved = await sendJson(server, {
      method: 'PUT', path: '/api/settings',
      body: JSON.stringify({
        agent: 'codex', connectCodex: true,
        backends: {
          claude: { defaultModel: 'opus', modelTiers: { deep: 'opus', mini: 'haiku' } },
          codex: { defaultModel: 'gpt-5.6-terra', modelTiers: { deep: 'codex-deep' } },
        },
      }),
    });
    assert.equal(saved.code, 200, JSON.stringify(saved.json));
    const backends = saved.json.backends as Array<{ name: string; defaultModel: string; modelTiers: Record<string, string>; available: boolean }>;
    assert.equal(backends.find((b) => b.name === 'claude')?.defaultModel, 'opus');
    assert.equal(backends.find((b) => b.name === 'codex')?.modelTiers.deep, 'codex-deep');
    assert.equal(backends.find((b) => b.name === 'codex')?.available, true);
    assert.equal(pick(saved.json, 'agent', 'value'), 'codex');
    assert.match(readFileSync(file, 'utf8'), /# сохранить комментарий/);
    assert.match(readFileSync(file, 'utf8'), /stepcast\/backends\/codex/);

    const cleared = await sendJson(server, {
      method: 'PUT', path: '/api/settings',
      body: JSON.stringify({ backends: { claude: { defaultModel: null, modelTiers: { deep: null } } } }),
    });
    assert.equal(cleared.code, 200);
    const claude = (cleared.json.backends as typeof backends).find((b) => b.name === 'claude');
    assert.equal(claude?.defaultModel, 'sonnet');
    assert.equal(claude?.modelTiers.deep, undefined);
    assert.equal(claude?.modelTiers.mini, 'haiku');
  });

  it('отклоняет неправильные правки целиком, не меняя файл', async (t) => {
    const { runsRoot, home } = makeJournalBed();
    const server = await startServer(t, { runsRoot, home });
    const file = join(home, '.stepcast', 'config.yml');
    const before = readFileSync(file, 'utf8');
    for (const patch of [
      null, [], { backends: { claude: { modelTiers: { typo: 'opus' } } } },
      { backends: { claude: { modelTiers: { deep: 123 } } } },
      { backends: { claude: { defaultModel: '   ' } } },
      { backends: { missing: { defaultModel: 'x' } } }, { agent: 'codex' },
    ]) {
      const result = await sendJson(server, { method: 'PUT', path: '/api/settings', body: JSON.stringify(patch) });
      assert.equal(result.code, 400, JSON.stringify(patch));
      assert.equal(readFileSync(file, 'utf8'), before);
    }
  });

  it('показывает Claude и доступный к подключению Codex с исходными моделями', async (t) => {
    const { runsRoot, home } = makeJournalBed();
    const server = await startServer(t, { runsRoot, home });
    const result = await fetchJson(server, '/api/settings');
    assert.equal(result.code, 200);
    const backends = result.json.backends as Array<{ name: string; defaultModel: string; available: boolean }>;
    assert.equal(backends.find((b) => b.name === 'claude')?.defaultModel, 'sonnet');
    assert.equal(backends.find((b) => b.name === 'codex')?.defaultModel, 'gpt-5.6-terra');
    assert.equal(backends.find((b) => b.name === 'codex')?.available, false);
  });
});

const HOOK_WIDGET = `import { useState } from 'react';

export default function Clock() {
  const [n, setN] = useState(0);
  return <button onClick={() => setN(n + 1)}>{n}</button>;
}
`;

const BROKEN_WIDGET = `export default function Broken() {
  return <div>
}
`;

function writeWidget(projectRoot: string, id: string, source: string): string {
  const dir = widgetsDirPath(projectRoot);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.tsx`);
  writeFileSync(file, source);
  return file;
}

describe('ui-dashboard: маршрут модуля виджета', () => {
  it('отдаёт рабочий виджет ES-модулем text/javascript', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const key = projectKey(projectRoot);
    writeWidget(projectRoot, 'clock', HOOK_WIDGET);
    const server = await startServer(t, { runsRoot });

    const res = await fetchWithHeaders(server, `/widgets/${encodeURIComponent(key)}/clock.js`);
    assert.equal(res.code, 200);
    assert.match(String(res.headers['content-type']), /text\/javascript/);
    assert.match(res.body, /from "react\/jsx-runtime"/);
    assert.match(res.body, /Clock as default/);
    assert.equal(res.headers['x-stepcast-widget-error'], undefined);
  });

  it('непроходящий файл — 200, модуль ошибки и заголовок-пометка', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const key = projectKey(projectRoot);
    writeWidget(projectRoot, 'broken', BROKEN_WIDGET);
    const server = await startServer(t, { runsRoot });

    const res = await fetchWithHeaders(server, `/widgets/${encodeURIComponent(key)}/broken.js`);
    assert.equal(res.code, 200);
    assert.equal(res.headers['x-stepcast-widget-error'], '1');
    assert.match(res.body, /__stepcastWidgetError/);
    assert.match(res.body, /broken\.tsx/);
  });

  it('исправление файла даёт рабочий модуль по следующему запросу, без перезапуска демона', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const key = projectKey(projectRoot);
    const file = writeWidget(projectRoot, 'flaky', BROKEN_WIDGET);
    const server = await startServer(t, { runsRoot });

    const before = await fetchWithHeaders(server, `/widgets/${encodeURIComponent(key)}/flaky.js`);
    assert.equal(before.headers['x-stepcast-widget-error'], '1');

    writeFileSync(file, HOOK_WIDGET);
    const bumped = new Date(Date.now() + 5_000);
    utimesSync(file, bumped, bumped);

    const after = await fetchWithHeaders(server, `/widgets/${encodeURIComponent(key)}/flaky.js`);
    assert.equal(after.headers['x-stepcast-widget-error'], undefined);
    assert.match(after.body, /Clock as default/);
  });

  it('неизвестный ключ проекта, неизвестный id и путь под /widgets сверх объявленных форм — один и тот же 404', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const key = projectKey(projectRoot);
    writeWidget(projectRoot, 'clock', HOOK_WIDGET);
    const server = await startServer(t, { runsRoot });

    const unknownKey = await fetchJson(server, '/widgets/no-such-project-key/clock.js');
    const unknownId = await fetchJson(server, `/widgets/${encodeURIComponent(key)}/ghost.js`);
    const extraSegment = await fetchPath(server, `/widgets/${encodeURIComponent(key)}/clock.js/extra`);
    const bareRuntime = await fetchPath(server, '/widgets/runtime/does-not-exist.js');

    assert.equal(unknownKey.code, 404);
    assert.equal(unknownId.code, 404);
    assert.equal(extraSegment.code, 404);
    assert.equal(bareRuntime.code, 404);
    // Ответы неотличимы по составу: причина отказа демоном не называется.
    assert.deepEqual(unknownKey.json, unknownId.json);
  });

  it('обход каталога и символическая ссылка наружу отклонены на маршруте, содержимое не отдано', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const key = projectKey(projectRoot);
    const dir = widgetsDirPath(projectRoot);
    mkdirSync(dir, { recursive: true });
    const outside = tempDir('outside-widget-');
    writeFileSync(join(outside, 'secret.tsx'), 'export default "секрет";\n');
    symlinkSync(join(outside, 'secret.tsx'), join(dir, 'escape.tsx'));
    const server = await startServer(t, { runsRoot });

    const dotdot = await fetchPath(
      server,
      `/widgets/${encodeURIComponent(key)}/${encodeURIComponent('../secret')}.js`,
    );
    const separator = await fetchPath(
      server,
      `/widgets/${encodeURIComponent(key)}/${encodeURIComponent('sub/clock')}.js`,
    );
    const escaped = await fetchPath(server, `/widgets/${encodeURIComponent(key)}/escape.js`);

    assert.equal(dotdot.code, 404);
    assert.equal(separator.code, 404);
    assert.equal(escaped.code, 404);
    assert.doesNotMatch(escaped.body, /секрет/);
  });

  it('запрос виджета не пишет в каталог проекта', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const key = projectKey(projectRoot);
    const file = writeWidget(projectRoot, 'clock', HOOK_WIDGET);
    const before = readFileSync(file, 'utf8');
    const entriesBefore = readdirSync(projectRoot).sort();
    const server = await startServer(t, { runsRoot });

    await fetchPath(server, `/widgets/${encodeURIComponent(key)}/clock.js`);

    assert.equal(readFileSync(file, 'utf8'), before);
    assert.deepEqual(readdirSync(projectRoot).sort(), entriesBefore);
  });

  it('два сервера витрины с разными корнями не смешивают виджеты проектов', async (t) => {
    const bedA = makeJournalBed();
    const bedB = makeJournalBed();
    seedRun(bedA.runsRoot, bedA.projectRoot, { runId: 'a' });
    seedRun(bedB.runsRoot, bedB.projectRoot, { runId: 'b' });
    const keyA = projectKey(bedA.projectRoot);
    const keyB = projectKey(bedB.projectRoot);
    writeWidget(bedA.projectRoot, 'clock', HOOK_WIDGET);
    writeWidget(bedB.projectRoot, 'clock', HOOK_WIDGET.replace(/Clock/g, 'ClockB'));

    const serverA = await startServer(t, { runsRoot: bedA.runsRoot });
    const serverB = await startServer(t, { runsRoot: bedB.runsRoot });

    const resA = await fetchPath(serverA, `/widgets/${encodeURIComponent(keyA)}/clock.js`);
    const resB = await fetchPath(serverB, `/widgets/${encodeURIComponent(keyB)}/clock.js`);
    const crossA = await fetchPath(serverA, `/widgets/${encodeURIComponent(keyB)}/clock.js`);

    assert.match(resA.body, /Clock as default/);
    assert.match(resB.body, /ClockB as default/);
    assert.equal(crossA.code, 404, 'ключ чужого проекта неизвестен этому серверу');
  });
});

describe('ui-dashboard: событие widgets в потоке /api/events', () => {
  it('присылает widgets при появлении файла, не присылает повторно на такте без изменений', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const watcher = startWatcher(t, runsRoot, 10_000);
    const server = await startServer(t, { runsRoot, watcher });

    const stream = openStream(t, server, '/api/events');
    await settle();
    assert.deepEqual(
      stream.events.map((event) => event.event),
      ['overview', 'backlog', 'widgets', 'proposals', 'routes', 'dashboards', 'plugins', 'screens'],
    );
    assert.deepEqual(pick(stream.events[2]?.data, 'projects'), [{ projectKey: projectKey(projectRoot), widgets: [] }]);

    writeWidget(projectRoot, 'clock', HOOK_WIDGET);
    watcher.poll();
    await settle();

    const widgetsEvents = stream.events.filter((event) => event.event === 'widgets');
    assert.equal(widgetsEvents.length, 2, 'появление файла обязано прислать второе событие widgets');
    assert.equal(pick(widgetsEvents.at(-1)?.data, 'projects', 0, 'widgets', 0, 'id'), 'clock');
  });

  it('не присылает widgets на такте, где сдвинулся только обзор идущего прогона', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, { runId: 'a', status: 'running' });
    writeWidget(projectRoot, 'clock', HOOK_WIDGET);
    const watcher = startWatcher(t, runsRoot, 10_000);
    const server = await startServer(t, { runsRoot, watcher });

    const stream = openStream(t, server, '/api/events');
    await settle();
    const before = stream.events.filter((event) => event.event === 'widgets').length;

    journal.writeStatus({
      run_id: journal.paths.runId,
      pipeline: 'demo',
      lock_hash: 'abc',
      status: 'success',
      workspace: { mode: 'cwd' },
      inputs: {},
      jobs: [],
      budget: { tokens_used: 0, wallclock_ms: 0 },
      updated_at: '2026-08-01T01:00:00.000Z',
    });
    watcher.poll();
    await settle();

    const after = stream.events.filter((event) => event.event === 'widgets').length;
    assert.equal(after, before, 'смена только обзора не должна прислать widgets повторно');
  });

  it('версия виджета в событии меняется вместе с файлом', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const file = writeWidget(projectRoot, 'clock', HOOK_WIDGET);
    const watcher = startWatcher(t, runsRoot, 10_000);
    const server = await startServer(t, { runsRoot, watcher });

    const stream = openStream(t, server, '/api/events');
    await settle();
    const firstVersion = pick(
      stream.events.filter((event) => event.event === 'widgets').at(-1)?.data,
      'projects',
      0,
      'widgets',
      0,
      'version',
    );

    writeFileSync(file, HOOK_WIDGET.replace('Clock', 'ClockV2'));
    const bumped = new Date(Date.now() + 5_000);
    utimesSync(file, bumped, bumped);
    watcher.poll();
    await settle();

    const secondVersion = pick(
      stream.events.filter((event) => event.event === 'widgets').at(-1)?.data,
      'projects',
      0,
      'widgets',
      0,
      'version',
    );
    assert.notEqual(secondVersion, firstVersion);
  });
});

describe('ui-dashboard: жизненный цикл компилятора виджетов', () => {
  it('компилятор, полученный снаружи, не останавливается при close()', async (t) => {
    const { runsRoot } = makeJournalBed();
    let disposed = false;
    const compiler: WidgetCompiler = {
      compile: async () => undefined,
      compileBundle: async () => undefined,
      dispose: async () => {
        disposed = true;
      },
    };
    const server = await startServer(t, { runsRoot, widgetCompiler: compiler });
    await server.close();
    assert.equal(disposed, false, 'сервер не должен останавливать компилятор, полученный снаружи');
  });

  /**
   * Нативный `esbuild` держит служебный дочерний процесс; не остановленный,
   * он удерживает событийный цикл, и процесс, поднимавший сервер, не
   * завершается сам (design.md, Решение 12). Проверяется отдельным процессом:
   * зависший `execFileSync` — сам по себе диагноз, а не только его вывод.
   */
  it('после запроса виджета и закрытия сервера служебный процесс компилятора не остаётся, процесс завершается сам', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const key = projectKey(projectRoot);
    writeWidget(projectRoot, 'clock', HOOK_WIDGET);

    const serverModulePath = fileURLToPath(new URL('../src/parts/ui/daemon/server.js', import.meta.url));
    const serverModuleUrl = pathToFileURL(serverModulePath).href;
    const probe = [
      `import { createUiServer } from ${JSON.stringify(serverModuleUrl)};`,
      `const server = await createUiServer({ runsRoot: ${JSON.stringify(runsRoot)}, port: 0 });`,
      `const res = await fetch(\`http://127.0.0.1:\${server.port}/widgets/${encodeURIComponent(key)}/clock.js\`);`,
      'await res.text();',
      'await server.close();',
      "console.log('done');",
    ].join('\n');

    const out = execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.match(out, /done/);
  });

  it('до первого запроса виджета компилятор не поднят, а первый запрос поднимает его один раз', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const key = projectKey(projectRoot);
    writeWidget(projectRoot, 'clock', HOOK_WIDGET);

    let loads = 0;
    const stub: EsbuildTransformApi = {
      transform: async () => ({ code: 'export default null;\n' }),
      stop: () => undefined,
    };
    // Счётчик стоит на самом подъёме компилятора: так проверка ловит и
    // прогрев виджетов сервером при старте, и перенос импорта из `compile()`
    // в фабрику — оба сделали бы демон без виджетов платящим за компилятор
    // (требование ui-daemon, сценарий «Демон без виджетов не поднимает компилятор»).
    const compiler = createWidgetCompiler({
      loadCompiler: async () => {
        loads += 1;
        return stub;
      },
    });
    t.after(() => compiler.dispose());

    const server = await startServer(t, { runsRoot, widgetCompiler: compiler });
    assert.equal(loads, 0, 'заведение компилятора и подъём сервера не должны поднимать службу');

    await fetchPath(server, '/');
    await fetchJson(server, '/api/overview');
    await fetchJson(server, '/api/backlog');
    assert.equal(loads, 0, 'экраны витрины без виджетов не поднимают компилятор');

    await fetchPath(server, `/widgets/${encodeURIComponent(key)}/clock.js`);
    assert.equal(loads, 1, 'первый запрос виджета обязан поднять компилятор');

    await fetchPath(server, `/widgets/${encodeURIComponent(key)}/clock.js`);
    assert.equal(loads, 1, 'подъём службы платится один раз за жизнь компилятора');
  });

  /**
   * Сценарий «Зависимости компилятора нет» целиком, как его видит демон:
   * отдельным процессом, где разрешение `esbuild` отказывает хуком загрузчика.
   * Внутри этого процесса пакет установлен, и снести его проверка не может —
   * а именно эта ветка обязана дать и названную ошибку в ответе, и строку в
   * логе демона, не уронив остальные экраны (требование ui-daemon).
   */
  it('без зависимости компилятора виджет отвечает названной ошибкой, лог получает строку, остальные экраны живы', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const key = projectKey(projectRoot);
    writeWidget(projectRoot, 'clock', HOOK_WIDGET);

    const probeDir = tempDir('no-esbuild-');
    const loader = join(probeDir, 'loader.mjs');
    writeFileSync(
      loader,
      [
        'export function resolve(specifier, context, next) {',
        "  if (specifier === 'esbuild') {",
        "    const error = new Error('Cannot find package esbuild');",
        "    error.code = 'ERR_MODULE_NOT_FOUND';",
        '    throw error;',
        '  }',
        '  return next(specifier, context);',
        '}',
      ].join('\n'),
    );
    const register = join(probeDir, 'register.mjs');
    writeFileSync(
      register,
      [
        "import { register } from 'node:module';",
        `register(${JSON.stringify(pathToFileURL(loader).href)});`,
      ].join('\n'),
    );

    const serverModuleUrl = pathToFileURL(fileURLToPath(new URL('../src/parts/ui/daemon/server.js', import.meta.url))).href;
    const probe = [
      `import { createUiServer } from ${JSON.stringify(serverModuleUrl)};`,
      'const lines = [];',
      `const server = await createUiServer({ runsRoot: ${JSON.stringify(runsRoot)}, port: 0, log: (line) => lines.push(line) });`,
      `const res = await fetch(\`http://127.0.0.1:\${server.port}/widgets/${encodeURIComponent(key)}/clock.js\`);`,
      'const body = await res.text();',
      'const overview = await fetch(`http://127.0.0.1:${server.port}/api/overview`);',
      'const overviewCode = overview.status;',
      'await overview.text();',
      'await server.close();',
      'console.log(JSON.stringify({ status: res.status, mark: res.headers.get("x-stepcast-widget-error"), body, lines, overviewCode }));',
    ].join('\n');

    // `--no-deprecation`: `module.register()` объявлен устаревшим в пользу
    // `registerHooks()`, которого нет в ранних 22.x из объявленных `engines`.
    // Предупреждение — шум в отчёте проверки, а не свойство демона.
    const out = execFileSync(
      process.execPath,
      ['--no-deprecation', '--import', register, '--input-type=module', '-e', probe],
      { encoding: 'utf8', timeout: 20_000 },
    );
    const result = JSON.parse(out.trim().split('\n').at(-1) as string) as {
      status: number;
      mark: string | null;
      body: string;
      lines: string[];
      overviewCode: number;
    };

    assert.equal(result.status, 200, 'ошибка компилятора приходит модулем, а не отказом запроса');
    assert.equal(result.mark, '1');
    assert.match(result.body, /esbuild/, 'ответ обязан называть отсутствующую зависимость');
    assert.ok(
      result.lines.some((line) => /esbuild/.test(line)),
      `в логе демона обязана быть строка об отказе: ${JSON.stringify(result.lines)}`,
    );
    assert.equal(result.overviewCode, 200, 'остальные экраны витрины отвечают как прежде');
  });
});

describe('ui-routes: экран «Маршруты»', () => {
  it('GET /api/routes отдаёт действующую таблицу с источником каждого поля', async (t) => {
    const { runsRoot } = makeJournalBed();
    const server = await startServer(t, { runsRoot });

    const { code, json } = await fetchJson(server, '/api/routes');
    assert.equal(code, 200);
    const routes = json.routes as Array<{ id: string; path: string; sources: { path: { layer: string; file: string } } }>;
    const runsEntry = routes.find((route) => route.id === 'screen-runs');
    assert.equal(runsEntry?.path, '/');
    assert.equal(runsEntry?.sources.path.layer, 'builtin');
  });

  it('POST /api/routes пишет строку в домашний слой, встроенный файл не переписывается', async (t) => {
    const { runsRoot } = makeJournalBed();
    const { home } = makeJournalBed();
    const server = await startServer(t, { runsRoot, home });

    const newRoute = { id: 'my-route', path: '/mine', target: { screen: 'screen-runs' } };
    const written = await sendJson(server, {
      method: 'POST',
      path: '/api/routes',
      body: JSON.stringify({ layer: 'home', route: newRoute }),
    });
    assert.equal(written.code, 200);

    const after = await fetchJson(server, '/api/routes');
    const mine = (after.json.routes as Array<{ id: string; path: string; sources: { path: { layer: string } } }>).find(
      (route) => route.id === 'my-route',
    );
    assert.equal(mine?.path, '/mine');
    assert.equal(mine?.sources.path.layer, 'home');

    const builtinContent = readFileSync(join(process.cwd(), 'src', 'builtin', 'routes.yml'), 'utf8');
    assert.doesNotMatch(builtinContent, /my-route/, 'встроенный файл поставки не должен быть переписан');
  });

  it('POST /api/routes на проектный слой без известного корня проекта отказывает', async (t) => {
    const { runsRoot } = makeJournalBed();
    const { home } = makeJournalBed();
    const server = await startServer(t, { runsRoot, home });

    const newRoute = { id: 'my-route', path: '/mine', target: { screen: 'screen-runs' } };
    const written = await sendJson(server, {
      method: 'POST',
      path: '/api/routes',
      body: JSON.stringify({ layer: 'project', route: newRoute }),
    });
    assert.equal(written.code, 400);
  });

  it('POST /api/routes в проектный слой поднятого в каталоге проекта демона пишет туда', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const { home } = makeJournalBed();
    const server = await startServer(t, { runsRoot, home, projectRoot });

    const newRoute = { id: 'my-route', path: '/mine', target: { screen: 'screen-runs' } };
    const written = await sendJson(server, {
      method: 'POST',
      path: '/api/routes',
      body: JSON.stringify({ layer: 'project', route: newRoute }),
    });
    assert.equal(written.code, 200);
    assert.match(readFileSync(join(projectRoot, '.stepcast', 'routes.yml'), 'utf8'), /my-route/);
  });

  it('POST /api/routes в файл, который не разбирается, отказывает и не переписывает файл', async (t) => {
    const { runsRoot } = makeJournalBed();
    const { home } = makeJournalBed();
    mkdirSync(join(home, '.stepcast'), { recursive: true });
    const brokenPath = join(home, '.stepcast', 'routes.yml');
    const brokenContent = 'routes: [{ id: bad, path: 7 }]\n';
    writeFileSync(brokenPath, brokenContent);
    const server = await startServer(t, { runsRoot, home });

    const newRoute = { id: 'my-route', path: '/mine', target: { screen: 'screen-runs' } };
    const written = await sendJson(server, {
      method: 'POST',
      path: '/api/routes',
      body: JSON.stringify({ layer: 'home', route: newRoute }),
    });
    assert.equal(written.code, 400);
    assert.equal(readFileSync(brokenPath, 'utf8'), brokenContent);
  });

  it('такт без правки маршрутов и состава не повторяет события routes и screens', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const { home } = makeJournalBed();
    const watcher = startWatcher(t, runsRoot, 20, home);
    const server = await startServer(t, { runsRoot, home, watcher });

    const stream = openStream(t, server, '/api/events');
    await settle();

    // Такты идут: появление прогона будит наблюдателя, и обзор приходит
    // снова. Ни таблица маршрутов, ни состав экранов при этом не менялись —
    // значит, и повторяться не должны (`ui-daemon`, «Неизменное не
    // пересылается»).
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    await settle(300);

    const overviews = stream.events.filter((event) => event.event === 'overview').length;
    assert.ok(overviews > 1, 'такты обязаны идти, иначе проверка ничего не сторожит');
    assert.equal(stream.events.filter((event) => event.event === 'routes').length, 1);
    assert.equal(stream.events.filter((event) => event.event === 'screens').length, 1);
  });

  it('правка файла маршрутов при открытом потоке присылает новую таблицу событием routes', async (t) => {
    const { runsRoot } = makeJournalBed();
    const { home } = makeJournalBed();
    const watcher = startWatcher(t, runsRoot, 20, home);
    const server = await startServer(t, { runsRoot, home, watcher });

    const stream = openStream(t, server, '/api/events');
    await settle();

    mkdirSync(join(home, '.stepcast'), { recursive: true });
    writeFileSync(join(home, '.stepcast', 'routes.yml'), 'routes:\n  - id: screen-cleanup\n    nav:\n      title: Чистка\n');
    await settle(300);

    const routeEvents = stream.events.filter((event) => event.event === 'routes');
    assert.equal(routeEvents.length, 2, 'правка обязана дойти до открытой вкладки вторым событием');
    const routes = (routeEvents.at(-1)?.data.routes ?? []) as Array<{ id: string; nav?: { title?: string } }>;
    assert.equal(routes.find((route) => route.id === 'screen-cleanup')?.nav?.title, 'Чистка');
  });

  it('GET /api/routes отдаёт отключённые строки отдельно от действующих', async (t) => {
    const { runsRoot } = makeJournalBed();
    const { home } = makeJournalBed();
    mkdirSync(join(home, '.stepcast'), { recursive: true });
    writeFileSync(join(home, '.stepcast', 'routes.yml'), 'routes:\n  - id: screen-agents\n    enabled: false\n');
    const server = await startServer(t, { runsRoot, home });

    const { json } = await fetchJson(server, '/api/routes');
    const routes = json.routes as Array<{ id: string }>;
    assert.equal(routes.some((route) => route.id === 'screen-agents'), false, 'отключённый маршрут не действует');
    const disabled = json.disabled as Array<{ id: string; path: string; disabledBy: { layer: string } }>;
    // Перечень отключённых — вход обратно: без него включить маршрут можно
    // было бы только правкой файла руками.
    assert.equal(disabled.find((route) => route.id === 'screen-agents')?.path, '/agents');
    assert.equal(disabled.find((route) => route.id === 'screen-agents')?.disabledBy.layer, 'home');
  });

  it('отказ сборки таблицы при работающем демоне не гасит прежнюю: она отдаётся вместе с причиной', async (t) => {
    const { runsRoot } = makeJournalBed();
    const { home } = makeJournalBed();
    const watcher = createWatcher({ runsRoot, home, intervalMs: 10_000 });
    t.after(() => watcher.dispose());
    const server = await startServer(t, { runsRoot, home, watcher });

    const before = await fetchJson(server, '/api/routes');
    assert.equal(before.json.buildError, undefined);

    mkdirSync(join(home, '.stepcast'), { recursive: true });
    writeFileSync(join(home, '.stepcast', 'routes.yml'), 'routes:\n  - id: bad\n    bogus: 1\n');
    watcher.poll();

    const after = await fetchJson(server, '/api/routes');
    const routes = after.json.routes as Array<{ id: string; path: string }>;
    assert.equal(routes.find((route) => route.id === 'screen-runs')?.path, '/', 'прежние маршруты продолжают действовать');
    assert.match(String(after.json.buildError), /bogus/, 'причина отказа едет рядом с прежней таблицей');
  });

  it('сохраняет комментарии и другие строки файла при записи', async (t) => {
    const { runsRoot } = makeJournalBed();
    const { home } = makeJournalBed();
    mkdirSync(join(home, '.stepcast'), { recursive: true });
    const path = join(home, '.stepcast', 'routes.yml');
    writeFileSync(path, '# мои маршруты\nroutes:\n  - id: screen-cleanup # правил вручную\n    enabled: false\n');
    const server = await startServer(t, { runsRoot, home });

    const newRoute = { id: 'my-route', path: '/mine', target: { screen: 'screen-runs' } };
    const written = await sendJson(server, {
      method: 'POST',
      path: '/api/routes',
      body: JSON.stringify({ layer: 'home', route: newRoute }),
    });
    assert.equal(written.code, 200);

    const text = readFileSync(path, 'utf8');
    assert.match(text, /# мои маршруты/);
    assert.match(text, /# правил вручную/);
    assert.match(text, /enabled: false/);
    assert.match(text, /my-route/);
  });
});

describe('ui-dashboards: GET/POST /api/dashboards', () => {
  const DOCUMENT = {
    title: 'Релиз',
    grid: { columns: 12 },
    cells: [{ id: 'a', widget: 'runs', at: { column: 0, row: 0, width: 4, height: 2 } }],
  };

  it('GET /api/dashboards отдаёт оба слоя с их источником', async (t) => {
    const { runsRoot } = makeJournalBed();
    const { home } = makeJournalBed();
    mkdirSync(join(home, '.stepcast', 'dashboards'), { recursive: true });
    writeFileSync(join(home, '.stepcast', 'dashboards', 'release.yml'), 'cells: []\n');
    const server = await startServer(t, { runsRoot, home });

    const { code, json } = await fetchJson(server, '/api/dashboards');
    assert.equal(code, 200);
    const dashboards = json.dashboards as Array<{ id: string; layer: string; file: string }>;
    const release = dashboards.find((d) => d.id === 'release');
    assert.equal(release?.layer, 'home');
    assert.equal(release?.file, join(home, '.stepcast', 'dashboards', 'release.yml'));
  });

  it('POST /api/dashboards создаёт файл дашборда в домашнем слое', async (t) => {
    const { runsRoot } = makeJournalBed();
    const { home } = makeJournalBed();
    const server = await startServer(t, { runsRoot, home });

    const written = await sendJson(server, {
      method: 'POST',
      path: '/api/dashboards',
      body: JSON.stringify({ layer: 'home', id: 'release', document: DOCUMENT }),
    });
    assert.equal(written.code, 200);

    const after = await fetchJson(server, '/api/dashboards');
    const dashboards = after.json.dashboards as Array<{ id: string; document: { title: string } }>;
    assert.equal(dashboards.find((d) => d.id === 'release')?.document.title, 'Релиз');
  });

  it('POST /api/dashboards правит существующий файл, отпечаток сверяется', async (t) => {
    const { runsRoot } = makeJournalBed();
    const { home } = makeJournalBed();
    const server = await startServer(t, { runsRoot, home });

    await sendJson(server, {
      method: 'POST',
      path: '/api/dashboards',
      body: JSON.stringify({ layer: 'home', id: 'release', document: DOCUMENT }),
    });

    const fingerprintPath = join(home, '.stepcast', 'dashboards', 'release.yml');
    const stat = statSync(fingerprintPath);

    const changed = { ...DOCUMENT, title: 'Другое название' };
    const written = await sendJson(server, {
      method: 'POST',
      path: '/api/dashboards',
      body: JSON.stringify({
        layer: 'home',
        id: 'release',
        document: changed,
        baseFingerprint: { mtimeMs: stat.mtimeMs, size: stat.size },
      }),
    });
    assert.equal(written.code, 200);

    const after = await fetchJson(server, '/api/dashboards');
    const dashboards = after.json.dashboards as Array<{ id: string; document: { title: string } }>;
    assert.equal(dashboards.find((d) => d.id === 'release')?.document.title, 'Другое название');
  });

  it('POST /api/dashboards с неизвестным слоем отклонён', async (t) => {
    const { runsRoot } = makeJournalBed();
    const { home } = makeJournalBed();
    const server = await startServer(t, { runsRoot, home });

    const written = await sendJson(server, {
      method: 'POST',
      path: '/api/dashboards',
      body: JSON.stringify({ layer: 'bogus', id: 'release', document: DOCUMENT }),
    });
    assert.equal(written.code, 400);
  });

  it('POST /api/dashboards в неразбираемый файл отклонён названным местом разбора, файл не изменён', async (t) => {
    const { runsRoot } = makeJournalBed();
    const { home } = makeJournalBed();
    mkdirSync(join(home, '.stepcast', 'dashboards'), { recursive: true });
    const path = join(home, '.stepcast', 'dashboards', 'release.yml');
    // Повтор ключа `cells:`: YAML такой файл не разбирает, а разбор «как
    // получится» даёт схемно верный объект — именно на нём сохранение и
    // переписало бы чужой блок молча.
    const broken =
      'grid:\n  columns: 12\ncells:\n  - id: a\n    widget: runs\n    at: { column: 0, row: 0, width: 4, height: 2 }\ncells:\n  - id: b\n    widget: usage\n    at: { column: 0, row: 0, width: 4, height: 2 }\n';
    writeFileSync(path, broken);
    const server = await startServer(t, { runsRoot, home });
    // Отпечаток передан настоящий: отказ обязан прийти от разбора файла, а не
    // от сверки отпечатка, которая иначе перехватила бы запрос раньше.
    const stat = statSync(path);

    const written = await sendJson(server, {
      method: 'POST',
      path: '/api/dashboards',
      body: JSON.stringify({
        layer: 'home',
        id: 'release',
        document: DOCUMENT,
        baseFingerprint: { mtimeMs: stat.mtimeMs, size: stat.size },
      }),
    });
    assert.equal(written.code, 400);
    assert.match(String(written.json.error), /is not valid YAML/);
    assert.match(String(written.json.error), /line 7|строка 7/);
    assert.equal(readFileSync(path, 'utf8'), broken);
  });

  it('POST /api/dashboards с наложением ячеек отклонён, а не отвечает удачей на пропавший дашборд', async (t) => {
    const { runsRoot } = makeJournalBed();
    const { home } = makeJournalBed();
    const server = await startServer(t, { runsRoot, home });

    const overlapping = {
      grid: { columns: 12 },
      cells: [
        { id: 'a', widget: 'runs', at: { column: 0, row: 0, width: 4, height: 2 } },
        { id: 'b', widget: 'usage', at: { column: 2, row: 1, width: 4, height: 2 } },
      ],
    };
    const written = await sendJson(server, {
      method: 'POST',
      path: '/api/dashboards',
      body: JSON.stringify({ layer: 'home', id: 'release', document: overlapping }),
    });
    assert.equal(written.code, 400);
    assert.match(String(written.json.error), /overlap/);

    const after = await fetchJson(server, '/api/dashboards');
    assert.deepEqual(after.json.dashboards, []);
    assert.deepEqual(after.json.failures, []);
  });

  it('POST /api/dashboards с разошедшимся отпечатком отклонён названной причиной', async (t) => {
    const { runsRoot } = makeJournalBed();
    const { home } = makeJournalBed();
    const server = await startServer(t, { runsRoot, home });
    await sendJson(server, {
      method: 'POST',
      path: '/api/dashboards',
      body: JSON.stringify({ layer: 'home', id: 'release', document: DOCUMENT }),
    });

    const written = await sendJson(server, {
      method: 'POST',
      path: '/api/dashboards',
      body: JSON.stringify({
        layer: 'home',
        id: 'release',
        document: DOCUMENT,
        baseFingerprint: { mtimeMs: 0, size: 0 },
      }),
    });
    assert.equal(written.code, 400);
    assert.match(String(written.json.error), /has changed since it was opened/);
  });

  it('правка файла дашборда приходит потоком, не пересылая routes, screens и widgets', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const { home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    mkdirSync(join(home, '.stepcast', 'dashboards'), { recursive: true });
    const path = join(home, '.stepcast', 'dashboards', 'release.yml');
    writeFileSync(path, 'title: Релиз\ncells: []\n');
    const watcher = startWatcher(t, runsRoot, 10_000, home);
    const server = await startServer(t, { runsRoot, home, watcher });

    const stream = openStream(t, server, '/api/events');
    await settle();
    const count = (name: string): number => stream.events.filter((event) => event.event === name).length;
    const before = { routes: count('routes'), screens: count('screens'), widgets: count('widgets') };
    assert.equal(count('dashboards'), 1, 'состав дашбордов приходит первым же обменом');

    writeFileSync(path, 'title: Другое\ncells: []\n');
    const bumped = new Date(Date.now() + 5_000);
    utimesSync(path, bumped, bumped);
    watcher.poll();
    await settle();

    const dashboards = stream.events.filter((event) => event.event === 'dashboards');
    assert.equal(dashboards.length, 2, 'правка файла обязана прислать новое содержимое');
    assert.equal(pick(dashboards.at(-1)?.data, 'dashboards', 0, 'document', 'title'), 'Другое');
    assert.deepEqual(
      { routes: count('routes'), screens: count('screens'), widgets: count('widgets') },
      before,
      'правка дашборда не пересылает ни таблицу маршрутов, ни состав экранов, ни виджеты',
    );
  });

  it('такт без правки каталогов дашбордов событие не отправляет', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const { home } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, { runId: 'a', status: 'running' });
    mkdirSync(join(home, '.stepcast', 'dashboards'), { recursive: true });
    writeFileSync(join(home, '.stepcast', 'dashboards', 'release.yml'), 'title: Релиз\ncells: []\n');
    const watcher = startWatcher(t, runsRoot, 10_000, home);
    const server = await startServer(t, { runsRoot, home, watcher });

    const stream = openStream(t, server, '/api/events');
    await settle();
    const before = stream.events.filter((event) => event.event === 'dashboards').length;

    journal.writeStatus({
      run_id: journal.paths.runId,
      pipeline: 'demo',
      lock_hash: 'abc',
      status: 'success',
      workspace: { mode: 'cwd' },
      inputs: {},
      jobs: [],
      budget: { tokens_used: 0, wallclock_ms: 0 },
      updated_at: '2026-08-01T01:00:00.000Z',
    });
    watcher.poll();
    await settle();

    const after = stream.events.filter((event) => event.event === 'dashboards').length;
    assert.equal(after, before, 'смена только обзора не должна прислать dashboards повторно');
  });

  it('сломанный файл приходит потоком причиной рядом с исправными дашбордами', async (t) => {
    const { runsRoot } = makeJournalBed();
    const { home } = makeJournalBed();
    mkdirSync(join(home, '.stepcast', 'dashboards'), { recursive: true });
    writeFileSync(join(home, '.stepcast', 'dashboards', 'release.yml'), 'title: Релиз\ncells: []\n');
    writeFileSync(join(home, '.stepcast', 'dashboards', 'broken.yml'), 'cells: []\nbogus: 1\n');
    const server = await startServer(t, { runsRoot, home });

    const stream = openStream(t, server, '/api/events');
    await settle();
    const last = stream.events.filter((event) => event.event === 'dashboards').at(-1)?.data;
    assert.equal(pick(last, 'dashboards', 0, 'id'), 'release');
    assert.equal(pick(last, 'failures', 0, 'id'), 'broken');
    assert.match(String(pick(last, 'failures', 0, 'reason')), /bogus/);
  });

  it('отключение строки ui-dashboards патчем убирает GET /api/dashboards, оставляя прочие маршруты', async (t) => {
    const { runsRoot } = makeJournalBed();
    const { home } = makeJournalBed();
    mkdirSync(join(home, '.stepcast'), { recursive: true });
    writeFileSync(
      join(home, '.stepcast', 'plugins.patch.yml'),
      'version: 1\nkind: plugins-patch\nplugins:\n  - id: ui-dashboards\n    use: stepcast:ui-dashboards\n    enabled: false\n',
    );
    const server = await startServer(t, { runsRoot, home });

    const dashboards = await fetchJson(server, '/api/dashboards');
    assert.equal(dashboards.code, 404);

    const routes = await fetchJson(server, '/api/routes');
    assert.equal(routes.code, 200);
    const overview = await fetchJson(server, '/api/overview');
    assert.equal(overview.code, 200);

    // Отключение строки правки не гасит показ: событие потока `dashboards`
    // заводит строка каркаса `ui-shell`, а не `ui-dashboards` (`ui-dashboards`,
    // Решение 11 — конструктор отдельно от показа).
    const stream = openStream(t, server, '/api/events');
    await settle();
    assert.ok(stream.events.some((event) => event.event === 'dashboards'), 'показ дашбордов не должен гаснуть');
  });
});

const MINIMAL_PIPELINE_YAML = 'version: 1\nkind: pipeline\nname: minimal\njobs:\n  build:\n    steps:\n      - id: compile\n        run: [echo, ok]\n        expect: [{ exit_code: 0 }]\n';

describe('ui-daemon: POST /api/run', () => {
  interface Launched {
    readonly cwd: string;
    readonly runsRoot: string;
    readonly projectKey: string;
    readonly pipeline: string;
  }

  function stubLaunch(): { launchRun: (options: Launched) => void; calls: Launched[] } {
    const calls: Launched[] = [];
    return { launchRun: (options) => calls.push(options), calls };
  }

  it('запускает известный пайплайн подставным пуском с ожидаемым cwd и файлом', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'seed' });
    writeFileSync(join(projectRoot, 'stepcast.yml'), MINIMAL_PIPELINE_YAML);
    const key = projectKey(projectRoot);
    const { launchRun, calls } = stubLaunch();
    const server = await createUiServer({ runsRoot, port: 0, launchRun });
    t.after(() => server.close());

    const written = await sendJson(server, {
      method: 'POST',
      path: '/api/run',
      body: JSON.stringify({ project: key, pipeline: 'stepcast.yml' }),
    });
    assert.equal(written.code, 202);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.cwd, projectRoot);
    assert.equal(calls[0]?.runsRoot, runsRoot);
    assert.equal(calls[0]?.projectKey, key);
    assert.equal(calls[0]?.pipeline, 'stepcast.yml');
  });

  it('неизвестный проект отклонён без единого пуска', async (t) => {
    const { runsRoot } = makeJournalBed();
    const { launchRun, calls } = stubLaunch();
    const server = await createUiServer({ runsRoot, port: 0, launchRun });
    t.after(() => server.close());

    const written = await sendJson(server, {
      method: 'POST',
      path: '/api/run',
      body: JSON.stringify({ project: 'нет-такого', pipeline: 'stepcast.yml' }),
    });
    assert.equal(written.code, 400);
    assert.equal(calls.length, 0);
  });

  it('неизвестный файл пайплайна отклонён без единого пуска', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'seed' });
    writeFileSync(join(projectRoot, 'stepcast.yml'), MINIMAL_PIPELINE_YAML);
    const key = projectKey(projectRoot);
    const { launchRun, calls } = stubLaunch();
    const server = await createUiServer({ runsRoot, port: 0, launchRun });
    t.after(() => server.close());

    const written = await sendJson(server, {
      method: 'POST',
      path: '/api/run',
      body: JSON.stringify({ project: key, pipeline: 'нет-такого.yml' }),
    });
    assert.equal(written.code, 400);
    assert.equal(calls.length, 0);
  });

  it('лишние поля тела отклонены', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'seed' });
    writeFileSync(join(projectRoot, 'stepcast.yml'), MINIMAL_PIPELINE_YAML);
    const key = projectKey(projectRoot);
    const { launchRun, calls } = stubLaunch();
    const server = await createUiServer({ runsRoot, port: 0, launchRun });
    t.after(() => server.close());

    const written = await sendJson(server, {
      method: 'POST',
      path: '/api/run',
      body: JSON.stringify({ project: key, pipeline: 'stepcast.yml', bogus: 1 }),
    });
    assert.equal(written.code, 400);
    assert.equal(calls.length, 0);
  });

  it('запускает пайплайн поставки stepcast:migrate-widgets наравне с файлом проекта', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'seed' });
    const key = projectKey(projectRoot);
    const { launchRun, calls } = stubLaunch();
    const server = await createUiServer({ runsRoot, port: 0, launchRun });
    t.after(() => server.close());

    const written = await sendJson(server, {
      method: 'POST',
      path: '/api/run',
      body: JSON.stringify({ project: key, pipeline: 'stepcast:migrate-widgets' }),
    });
    assert.equal(written.code, 202);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.cwd, projectRoot);
    assert.equal(calls[0]?.pipeline, 'stepcast:migrate-widgets');
  });

  it('неизвестное имя пайплайна поставки отклонено без единого пуска', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'seed' });
    const key = projectKey(projectRoot);
    const { launchRun, calls } = stubLaunch();
    const server = await createUiServer({ runsRoot, port: 0, launchRun });
    t.after(() => server.close());

    const written = await sendJson(server, {
      method: 'POST',
      path: '/api/run',
      body: JSON.stringify({ project: key, pipeline: 'stepcast:no-such-thing' }),
    });
    assert.equal(written.code, 400);
    assert.equal(calls.length, 0);
  });

  it('живой прогон того же пайплайна не отменяет новый запуск', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'running', status: 'running' });
    writeFileSync(join(projectRoot, 'stepcast.yml'), MINIMAL_PIPELINE_YAML);
    const key = projectKey(projectRoot);
    const { launchRun, calls } = stubLaunch();
    const server = await createUiServer({ runsRoot, port: 0, launchRun });
    t.after(() => server.close());

    const written = await sendJson(server, {
      method: 'POST',
      path: '/api/run',
      body: JSON.stringify({ project: key, pipeline: 'stepcast.yml' }),
    });
    assert.equal(written.code, 202);
    assert.equal(calls.length, 1);
  });

  it('настоящий пуск: отказ порождения процесса назван, а не роняет демон', async () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const errors: Error[] = [];
    // Отказ `spawn` приходит событием после возврата — то есть после 202. Без
    // слушателя 'error' это необработанное исключение процесса демона, и оно
    // погасило бы витрину; проверка падала бы вместе с ним, а не ассертом.
    launchRun({
      cwd: projectRoot,
      runsRoot,
      projectKey: projectKey(projectRoot),
      pipeline: 'stepcast.yml',
      execPath: join(projectRoot, 'нет-такого-узла'),
      onError: (error) => errors.push(error),
    });
    await settle();

    assert.equal(errors.length, 1);
    assert.match(errors[0]?.message ?? '', /ENOENT/);
  });

  it('отключение строки ui-run-launch патчем убирает только POST /api/run', async (t) => {
    const { runsRoot } = makeJournalBed();
    const { home } = makeJournalBed();
    mkdirSync(join(home, '.stepcast'), { recursive: true });
    writeFileSync(
      join(home, '.stepcast', 'plugins.patch.yml'),
      'version: 1\nkind: plugins-patch\nplugins:\n  - id: ui-run-launch\n    use: stepcast:ui-run-launch\n    enabled: false\n',
    );
    const server = await createUiServer({ runsRoot, home, port: 0 });
    t.after(() => server.close());

    // `/api/run` несёт три вклада разных строк по методу (`GET` — снимок
    // прогона у `screen-run`, `DELETE` — снятие у `screen-runs`, `POST` — пуск
    // у `ui-run-launch`): отключение одного метода оставляет путь известным
    // другим, и диспетчер отвечает 405, а не 404 (`ui-screens`, «Сервер
    // витрины знает механизм регистрации маршрутов, а не имена экранов»).
    const run = await sendJson(server, { method: 'POST', path: '/api/run', body: '{}' });
    assert.equal(run.code, 405);

    const overview = await fetchJson(server, '/api/overview');
    assert.equal(overview.code, 200);
    const dashboards = await fetchJson(server, '/api/dashboards');
    assert.equal(dashboards.code, 200);
  });
});

describe('ui-daemon: POST /api/run/decision', () => {
  interface Decided {
    readonly cwd: string;
    readonly run: string;
    readonly outcome: string;
    readonly step?: string;
    readonly reason?: string;
    readonly from?: string;
  }

  function stubDecide(): { launchDecide: (options: Decided) => void; calls: Decided[] } {
    const calls: Decided[] = [];
    return { launchDecide: (options) => calls.push(options), calls };
  }

  const AWAITING = [
    {
      wait_id: 'w1',
      job: 'apply',
      step: 'gate',
      outcomes: { approve: { effect: 'continue' as const }, deny: { effect: 'reject' as const }, redo: { effect: 'restart' as const } },
      since: '2026-08-01T00:00:00.000Z',
    },
  ];

  it('запрос по проверенному прогону порождает stepcast decide и ничего не пишет в его каталог', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, { runId: 'seed', status: 'running', awaiting: AWAITING });
    const key = projectKey(projectRoot);
    const { launchDecide, calls } = stubDecide();
    const server = await createUiServer({ runsRoot, port: 0, launchDecide });
    t.after(() => server.close());

    const before = readFileSync(journal.paths.status, 'utf8');
    const written = await sendJson(server, {
      method: 'POST',
      path: '/api/run/decision',
      body: JSON.stringify({ run: `${key}/seed`, outcome: 'approve' }),
    });

    assert.equal(written.code, 202);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.cwd, projectRoot);
    assert.equal(calls[0]?.run, 'seed');
    assert.equal(calls[0]?.outcome, 'approve');
    // Демон в файлы прогонов не пишет (design.md, решение 5) — состояние
    // осталось байт в байт тем же, что и до запроса.
    assert.equal(readFileSync(journal.paths.status, 'utf8'), before);
  });

  it('неизвестный проект отклонён без единого пуска', async (t) => {
    const { runsRoot } = makeJournalBed();
    const { launchDecide, calls } = stubDecide();
    const server = await createUiServer({ runsRoot, port: 0, launchDecide });
    t.after(() => server.close());

    const written = await sendJson(server, {
      method: 'POST',
      path: '/api/run/decision',
      body: JSON.stringify({ run: 'нет-такого/seed', outcome: 'approve' }),
    });
    assert.equal(written.code, 400);
    assert.equal(calls.length, 0);
  });

  it('прогон без ожиданий отклонён без единого пуска', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'seed', status: 'success' });
    const key = projectKey(projectRoot);
    const { launchDecide, calls } = stubDecide();
    const server = await createUiServer({ runsRoot, port: 0, launchDecide });
    t.after(() => server.close());

    const written = await sendJson(server, {
      method: 'POST',
      path: '/api/run/decision',
      body: JSON.stringify({ run: `${key}/seed`, outcome: 'approve' }),
    });
    assert.equal(written.code, 400);
    assert.equal(calls.length, 0);
  });

  it('исход вне перечня ожидания отклонён без единого пуска', async (t) => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'seed', status: 'running', awaiting: AWAITING });
    const key = projectKey(projectRoot);
    const { launchDecide, calls } = stubDecide();
    const server = await createUiServer({ runsRoot, port: 0, launchDecide });
    t.after(() => server.close());

    const written = await sendJson(server, {
      method: 'POST',
      path: '/api/run/decision',
      body: JSON.stringify({ run: `${key}/seed`, outcome: 'nonsense' }),
    });
    assert.equal(written.code, 400);
    assert.equal(calls.length, 0);
  });

  it('отказ порождения не роняет демон', async () => {
    const { projectRoot } = makeJournalBed();
    const errors: Error[] = [];
    launchDecide({
      cwd: projectRoot,
      run: 'seed',
      outcome: 'approve',
      execPath: join(projectRoot, 'нет-такого-узла'),
      onError: (error) => errors.push(error),
    });
    await settle();
    assert.equal(errors.length, 1);
    assert.match(errors[0]?.message ?? '', /ENOENT/);
  });

  it('отключение строки screen-decisions патчем убирает маршрут и экран', async (t) => {
    const { runsRoot } = makeJournalBed();
    const { home } = makeJournalBed();
    mkdirSync(join(home, '.stepcast'), { recursive: true });
    writeFileSync(
      join(home, '.stepcast', 'plugins.patch.yml'),
      'version: 1\nkind: plugins-patch\nplugins:\n  - id: screen-decisions\n    use: stepcast:screen-decisions\n    enabled: false\n',
    );
    const server = await createUiServer({ runsRoot, home, port: 0 });
    t.after(() => server.close());

    const written = await sendJson(server, {
      method: 'POST',
      path: '/api/run/decision',
      body: '{}',
    });
    assert.equal(written.code, 404);

    const screens = await fetchJson(server, '/api/screens');
    assert.equal(screens.code, 200);
    const ids = (screens.json as { screens: { id: string }[] }).screens.map((entry) => entry.id);
    assert.ok(!ids.includes('screen-decisions'));

    const overview = await fetchJson(server, '/api/overview');
    assert.equal(overview.code, 200);
  });
});
