#!/usr/bin/env node
import { run } from './cli/main.js';

/**
 * Прочитать стандартный ввод целиком. Интерактивный терминал (нет ни файла,
 * ни конвейера на входе) не блокируется — TTY не пришлёт `end` до Ctrl+D, и
 * команда, которой ввод не подан вовсе, обязана отказать разбором пустого
 * значения, а не зависнуть в ожидании.
 */
function readStdin(): Promise<string> {
  if (process.stdin.isTTY === true) return Promise.resolve('');
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

process.exitCode = await run(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  cwd: process.cwd(),
  readStdin,
});
