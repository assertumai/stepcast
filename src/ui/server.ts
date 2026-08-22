import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { existsSync } from 'node:fs';

import { runPaths } from '../core/journal/paths.js';
import { isStepcastError } from '../core/errors.js';
import { DASHBOARD_HTML } from './assets.js';
import { readJournalFile } from './file.js';
import { buildSnapshot } from './snapshot.js';
import { createWatcher, type Watcher } from './watcher.js';

/**
 * HTTP-витрина журнала.
 *
 * Только чтение и только петля: демон ничего не пишет в журнал, а привязка к
 * `127.0.0.1` убирает грубый случай — сервер, доступный всей сети.
 */

/** Петлевой адрес: слушать `0.0.0.0` витрине незачем. */
export const LOOPBACK = '127.0.0.1';

export interface UiServerOptions {
  readonly runsRoot: string;
  readonly port: number;
  readonly watcher?: Watcher;
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

export function createUiServer(options: UiServerOptions): Promise<UiServer> {
  const { runsRoot } = options;
  const watcher = options.watcher ?? createWatcher({ runsRoot });
  const ownsWatcher = options.watcher === undefined;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${LOOPBACK}`);

    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Витрина только читает' });
      return;
    }

    switch (url.pathname) {
      case '/':
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(DASHBOARD_HTML);
        return;
      case '/api/overview':
        sendJson(res, 200, watcher.current());
        return;
      case '/api/run':
        handleSnapshot(runsRoot, url.searchParams.get('run'), res);
        return;
      case '/api/file':
        handleFile(runsRoot, url, res);
        return;
      case '/api/events':
        handleEvents(runsRoot, watcher, url, req, res);
        return;
      default:
        sendJson(res, 404, { error: 'Нет такого маршрута' });
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
