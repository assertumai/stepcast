import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Мелкие помощники ответа и разбора запроса, общие нескольким серверным
 * половинам экранов (`ui-screens`): каждая когда-то жила веткой одного
 * `src/parts/ui/daemon/server.ts`, и вынесена сюда, а не скопирована в каждый файл
 * экрана — разойтись двум копиям `sendJson` было бы легко и незаметно.
 */

/** Потолок тела запроса: витрина принимает настройки и списки адресов, а не файлы. */
export const MAX_BODY_BYTES = 64 * 1024;

export function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    // Витрина отдаёт живые данные: закешированный обзор хуже, чем никакого.
    'cache-control': 'no-store',
  });
  res.end(text);
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

export const INVALID = Symbol('invalid');

/** Параметр запроса как неотрицательное целое; `undefined` — параметра не было. */
export function readNonNegativeInt(url: URL, param: string): number | undefined | typeof INVALID {
  const raw = url.searchParams.get(param);
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : INVALID;
}
