import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { existsSync } from 'node:fs';

import { runPaths } from '../core/journal/paths.js';
import { readStatus } from '../core/journal/reader.js';
import { removeRun } from '../core/run/cleanup.js';
import { isStepcastError } from '../core/errors.js';
import type { Config } from '../core/config/resolve.js';
import { dashboardHtml } from './assets.js';
import { readJournalFile } from './file.js';
import { buildPipelines } from './pipelines.js';
import { readSettings, writeSettings, type SettingsPatch } from './settings.js';
import { buildSnapshot } from './snapshot.js';
import { createWatcher, type Watcher } from './watcher.js';

/**
 * HTTP-витрина журнала.
 *
 * Только петля: сервер, доступный всей сети, — грубый случай, которого здесь
 * быть не должно. Чтение журнала остаётся чтением: демон по-прежнему не пишет
 * в файлы прогонов. Записи ровно две, и обе — прямые действия пользователя,
 * а не наблюдение: удалить прогон из истории и записать дефолты в глобальную
 * конфигурацию. Всё остальное под запретом.
 */

/** Петлевой адрес: слушать `0.0.0.0` витрине незачем. */
export const LOOPBACK = '127.0.0.1';

/** Потолок тела запроса: витрина принимает настройки, а не файлы. */
const MAX_BODY_BYTES = 64 * 1024;

export interface UiServerOptions {
  readonly runsRoot: string;
  readonly port: number;
  readonly watcher?: Watcher;
  /**
   * Конфигурация для разбора пайплайнов. Без неё экран пайплайнов пуст:
   * раскрытие пайплайна опирается на умолчания конфигурации.
   */
  readonly config?: Config;
  /** Домашний каталог: определяет, какой глобальный конфиг правят настройки. */
  readonly home?: string;
}

export interface UiServer {
  readonly server: Server;
  readonly port: number;
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    // Витрина отдаёт живые данные: закешированный обзор хуже, чем никакого.
    'cache-control': 'no-store',
  });
  res.end(text);
}

/** Адрес прогона в API — `<projectKey>/<runId>`: принадлежность проекту часть адреса. */
function parseRunAddress(value: string | null): { key: string; runId: string } | undefined {
  if (value === null) return undefined;
  const parts = value.split('/').filter((part) => part !== '');
  if (parts.length !== 2) return undefined;
  const [key, runId] = parts as [string, string];
  // Ни ключ, ни идентификатор не должны утаскивать резолв вверх по дереву.
  if (key.includes('..') || runId.includes('..')) return undefined;
  return { key, runId };
}

/**
 * Запрос на изменение пришёл со своей же страницы.
 *
 * Петлевой порт открыт любой странице, которую откроет браузер пользователя:
 * без этой проверки чужой сайт мог бы фоновым запросом снести историю
 * прогонов. Чтение остаётся свободным — оно и так ничего не меняет.
 */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  // Запрос без Origin — не из браузера: curl и тесты обращаются к демону
  // напрямую, и запрещать это значило бы запрещать работу из терминала.
  if (origin === undefined) return true;

  try {
    return new URL(origin).hostname === LOOPBACK || new URL(origin).hostname === 'localhost';
  } catch {
    return false;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(new Error('Тело запроса слишком велико'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function handleSnapshot(runsRoot: string, address: string | null, res: ServerResponse): void {
  const parsed = parseRunAddress(address);
  if (parsed === undefined) {
    sendJson(res, 400, { error: 'Адрес прогона должен иметь вид <проект>/<прогон>' });
    return;
  }

  const paths = runPaths(runsRoot, parsed.key, parsed.runId);
  if (!existsSync(paths.dir)) {
    sendJson(res, 404, { error: `Прогон ${parsed.runId} не найден` });
    return;
  }

  sendJson(res, 200, buildSnapshot(paths, parsed.key));
}

function handleFile(runsRoot: string, url: URL, res: ServerResponse): void {
  const parsed = parseRunAddress(url.searchParams.get('run'));
  const requested = url.searchParams.get('path');

  if (parsed === undefined || requested === null) {
    sendJson(res, 400, { error: 'Нужны параметры run=<проект>/<прогон> и path' });
    return;
  }

  const paths = runPaths(runsRoot, parsed.key, parsed.runId);
  if (!existsSync(paths.dir)) {
    sendJson(res, 404, { error: `Прогон ${parsed.runId} не найден` });
    return;
  }

  try {
    sendJson(res, 200, readJournalFile(paths.dir, requested));
  } catch (error) {
    // Выход за каталог прогона — ошибка клиента, а не сбой сервера.
    const message = isStepcastError(error) ? error.message : 'Файл не читается';
    sendJson(res, isStepcastError(error) ? 400 : 404, { error: message });
  }
}

/**
 * Удаление прогона из истории.
 *
 * Идущий прогон не удаляется: снести каталог под работающим движком значит
 * оставить его писать в никуда и потерять уже сделанное. Разбирать такое
 * пользователю пришлось бы по последствиям, а не по отказу.
 */
function handleDelete(runsRoot: string, url: URL, watcher: Watcher, res: ServerResponse): void {
  const parsed = parseRunAddress(url.searchParams.get('run'));
  if (parsed === undefined) {
    sendJson(res, 400, { error: 'Адрес прогона должен иметь вид <проект>/<прогон>' });
    return;
  }

  const paths = runPaths(runsRoot, parsed.key, parsed.runId);
  if (!existsSync(paths.dir)) {
    sendJson(res, 404, { error: `Прогон ${parsed.runId} не найден` });
    return;
  }

  try {
    if (readStatus(paths).status === 'running') {
      sendJson(res, 409, {
        error: 'Прогон идёт: остановите его, прежде чем удалять',
      });
      return;
    }
  } catch {
    // Прогон без читаемого состояния удалить можно: он и так уже не описан.
  }

  removeRun(runsRoot, parsed.key, parsed.runId);
  // Обзор пересобирается сразу: иначе удалённый прогон повисит на экране до
  // следующего опроса, и пользователь решит, что удаление не сработало.
  watcher.poll();
  sendJson(res, 200, { removed: `${parsed.key}/${parsed.runId}` });
}

async function handleSettingsWrite(
  req: IncomingMessage,
  res: ServerResponse,
  home: string | undefined,
): Promise<void> {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 413, { error: 'Тело запроса слишком велико' });
    return;
  }

  let patch: SettingsPatch;
  try {
    patch = JSON.parse(body === '' ? '{}' : body) as SettingsPatch;
  } catch {
    sendJson(res, 400, { error: 'Тело запроса не разбирается как JSON' });
    return;
  }

  try {
    sendJson(res, 200, home === undefined ? writeSettings(patch) : writeSettings(patch, home));
  } catch (error) {
    const message = isStepcastError(error) ? error.message : (error as Error).message;
    sendJson(res, isStepcastError(error) ? 400 : 500, { error: message });
  }
}

function handleEvents(
  runsRoot: string,
  watcher: Watcher,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });

  const followed = parseRunAddress(url.searchParams.get('run'));

  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const push = (): void => {
    send('overview', watcher.current());
    if (followed === undefined) return;
    const paths = runPaths(runsRoot, followed.key, followed.runId);
    if (existsSync(paths.dir)) send('run', buildSnapshot(paths, followed.key));
  };

  push();
  const unsubscribe = watcher.subscribe(push);

  // Клиент закрыл вкладку — подписка снимается, лишней работы не остаётся.
  req.on('close', () => {
    unsubscribe();
    res.end();
  });
}

/** Страница витрины. Любой не-API адрес ведёт на неё: маршруты разбирает клиент. */
function handlePage(res: ServerResponse): void {
  const html = dashboardHtml();
  if (html === undefined) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Витрина не собрана. Соберите её командой npm run build:ui.\n');
    return;
  }

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

export function createUiServer(options: UiServerOptions): Promise<UiServer> {
  const { runsRoot, config, home } = options;
  const watcher = options.watcher ?? createWatcher({ runsRoot });
  const ownsWatcher = options.watcher === undefined;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${LOOPBACK}`);
    const method = req.method ?? 'GET';

    if (method !== 'GET' && !sameOrigin(req)) {
      sendJson(res, 403, { error: 'Запрос пришёл со стороннего адреса' });
      return;
    }

    if (method === 'DELETE' && url.pathname === '/api/run') {
      handleDelete(runsRoot, url, watcher, res);
      return;
    }

    if (method === 'PUT' && url.pathname === '/api/settings') {
      void handleSettingsWrite(req, res, home);
      return;
    }

    if (method !== 'GET') {
      sendJson(res, 405, { error: 'Такого действия у витрины нет' });
      return;
    }

    switch (url.pathname) {
      case '/api/overview':
        sendJson(res, 200, watcher.current());
        return;
      case '/api/run':
        handleSnapshot(runsRoot, url.searchParams.get('run'), res);
        return;
      case '/api/file':
        handleFile(runsRoot, url, res);
        return;
      case '/api/pipelines':
        if (config === undefined) {
          sendJson(res, 200, { pipelines: [], generatedAt: new Date().toISOString() });
          return;
        }
        sendJson(res, 200, buildPipelines(runsRoot, config));
        return;
      case '/api/settings':
        sendJson(res, 200, home === undefined ? readSettings() : readSettings(home));
        return;
      case '/api/events':
        handleEvents(runsRoot, watcher, url, req, res);
        return;
      default:
        // Адрес под /api — это обращение к API, и его отсутствие надо назвать,
        // а не подменять страницей.
        if (url.pathname.startsWith('/api/')) {
          sendJson(res, 404, { error: 'Нет такого маршрута' });
          return;
        }
        handlePage(res);
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, LOOPBACK, () => {
      server.removeListener('error', reject);
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : options.port;

      resolve({
        server,
        port,
        close: () =>
          new Promise<void>((done) => {
            if (ownsWatcher) watcher.dispose();
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
