#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Завершение захода петли: проставить исход пункту очереди и — только при
 * успехе — закоммитить рабочее дерево.
 *
 * Слаг берётся из файла, записанного шагом выбора в каталог прогона, а не из
 * выхода работы `propose`. Работа `finalize` объявлена с `needs: all` и
 * `on: always`, то есть выполняется и когда `propose` не дошла до публикации
 * выхода: отказ на грязном дереве, отмена по сигналу, исчерпание бюджета.
 * Отсутствие файла означает, что пункт не брался, и проставлять нечего.
 *
 *   node scripts/finalize.mjs --verify-status <status> [--item …] [--file …]
 */

const DEFAULT_FILE = 'backlog.md';

class FinalizeError extends Error {}

function option(argv, name, fallback) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (value === undefined) throw new FinalizeError(`ключ --${name} требует значения`);
  return value;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) {
    throw new FinalizeError(
      `${command} ${args.join(' ')} завершилась кодом ${result.status}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

function main(argv) {
  const status = option(argv, 'verify-status', undefined);
  if (status === undefined) throw new FinalizeError('ключ --verify-status обязателен');

  const runDir = process.env.STEPCAST_RUN_DIR;
  const item = option(argv, 'item', runDir === undefined ? undefined : join(runDir, 'item.json'));
  if (item === undefined) {
    throw new FinalizeError('не задан ни --item, ни переменная STEPCAST_RUN_DIR');
  }

  if (!existsSync(item)) {
    process.stdout.write('пункт очереди не брался — проставлять нечего\n');
    return;
  }

  const { slug, title } = JSON.parse(readFileSync(item, 'utf8'));
  if (typeof slug !== 'string' || slug === '') {
    throw new FinalizeError(`файл ${item} не содержит слага пункта`);
  }

  const file = option(argv, 'file', DEFAULT_FILE);
  const backlog = new URL('backlog.mjs', import.meta.url).pathname;

  if (status !== 'success') {
    run(process.execPath, [
      backlog,
      'finish',
      slug,
      '--file',
      file,
      '--status',
      'failed',
      '--reason',
      `работа verify завершилась статусом ${status}`,
    ]);
    process.stdout.write(`пункт «${slug}» помечен как failed; коммит не создаётся\n`);
    return;
  }

  // Отметка исхода идёт до коммита, чтобы попасть в него же: улучшение и его
  // бухгалтерия — одно событие, и git revert снимает их вместе.
  run(process.execPath, [backlog, 'finish', slug, '--file', file, '--status', 'done']);
  run('git', ['add', '-A']);
  run('git', ['commit', '-m', `${slug}: ${title ?? 'улучшение из очереди'}`]);

  process.stdout.write(`пункт «${slug}» помечен как done и закоммичен\n`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  if (error instanceof FinalizeError) {
    process.stderr.write(`finalize: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
