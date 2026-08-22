#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Разбор и правка очереди улучшений `backlog.md`.
 *
 * Обычный Node без сборки и без зависимостей — сознательно, в отличие от
 * остальных скриптов репозитория. Этим скриптом работа `finalize` проставляет
 * исход, и делает она это ровно тогда, когда проверки не прошли, то есть когда
 * сборка проекта может быть сломана. Бухгалтерия очереди, зависящая от
 * `dist/`, отказала бы именно в том случае, ради которого она и нужна.
 *
 *   node scripts/backlog.mjs list   [--file backlog.md]
 *   node scripts/backlog.mjs pick   [--file …] [--stale-hours 6] [--now ISO] [--out path]
 *   node scripts/backlog.mjs finish <slug> --status done|failed [--reason …]
 */

const STATUSES = ['pending', 'in_progress', 'done', 'failed'];
const REQUIRED = ['status', 'title', 'why', 'done_when'];
const DEFAULT_FILE = 'backlog.md';
const DEFAULT_STALE_HOURS = 6;

const HEADING = /^##\s+(.+?)\s*$/;
const FIELD = /^([a-z][a-z0-9_]*):\s*(.*)$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

class BacklogError extends Error {}

/**
 * Разобрать файл в список пунктов.
 *
 * Пункт — заголовок второго уровня со слагом и плоские поля под ним. Всё до
 * первого заголовка второго уровня — преамбула и разбору не подлежит.
 */
function parse(text) {
  const lines = text.split('\n');
  const items = [];
  let current;

  for (const [index, line] of lines.entries()) {
    const heading = HEADING.exec(line);
    if (heading !== null) {
      const slug = heading[1];
      if (!SLUG.test(slug)) {
        throw new BacklogError(
          `заголовок «${slug}» не является слагом в kebab-case: очередь состоит только из пунктов`,
        );
      }
      if (items.some((item) => item.slug === slug)) {
        throw new BacklogError(`пункт «${slug}» встречается дважды`);
      }
      current = { slug, fields: new Map(), headingLine: index, lastFieldLine: index };
      items.push(current);
      continue;
    }

    if (current === undefined || line.trim() === '') continue;

    const field = FIELD.exec(line);
    if (field === null) {
      throw new BacklogError(
        `пункт «${current.slug}», строка ${index + 1}: ожидалось поле вида «ключ: значение»`,
      );
    }
    current.fields.set(field[1], { line: index, value: field[2].trim() });
    current.lastFieldLine = index;
  }

  for (const item of items) {
    for (const name of REQUIRED) {
      if (!item.fields.has(name)) {
        throw new BacklogError(`пункт «${item.slug}»: отсутствует обязательное поле «${name}»`);
      }
    }
    const status = item.fields.get('status').value;
    if (!STATUSES.includes(status)) {
      throw new BacklogError(
        `пункт «${item.slug}»: неизвестный status «${status}», ожидался один из ${STATUSES.join(', ')}`,
      );
    }
  }

  return items;
}

function field(item, name) {
  return item.fields.get(name)?.value;
}

function record(item) {
  return {
    slug: item.slug,
    title: field(item, 'title'),
    why: field(item, 'why'),
    done_when: field(item, 'done_when'),
  };
}

/**
 * Свободен ли пункт для взятия в работу.
 *
 * Пункт `in_progress` старше порога считается зависшим и снова свободен:
 * прогон, оборванный по сигналу, крашу или бюджету, иначе заблокировал бы его
 * навсегда. Отсутствие `started_at` у `in_progress` толкуется так же — момент
 * взятия неизвестен, и ждать нечего.
 */
function isFree(item, nowMs, staleMs) {
  const status = field(item, 'status');
  if (status === 'pending') return true;
  if (status !== 'in_progress') return false;

  const startedAt = field(item, 'started_at');
  if (startedAt === undefined || startedAt === '') return true;

  const startedMs = Date.parse(startedAt);
  if (Number.isNaN(startedMs)) return true;
  return nowMs - startedMs >= staleMs;
}

/**
 * Проставить поля пункту и вернуть новый текст файла.
 *
 * Существующее поле переписывается на месте, новое дописывается за последним
 * полем пункта. Разбор повторяется на каждом поле: вставка строки сдвигает
 * все последующие позиции, а файл заведомо мал.
 */
function withFields(text, slug, values) {
  let result = text;

  for (const [name, value] of Object.entries(values)) {
    const lines = result.split('\n');
    const item = parse(result).find((candidate) => candidate.slug === slug);
    if (item === undefined) throw new BacklogError(`пункт «${slug}» в очереди не найден`);

    const existing = item.fields.get(name);
    if (existing === undefined) lines.splice(item.lastFieldLine + 1, 0, `${name}: ${value}`);
    else lines[existing.line] = `${name}: ${value}`;

    result = lines.join('\n');
  }

  return result;
}

function option(argv, name, fallback) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (value === undefined) throw new BacklogError(`ключ --${name} требует значения`);
  return value;
}

function commandList(argv) {
  const file = option(argv, 'file', DEFAULT_FILE);
  const items = parse(readFileSync(file, 'utf8'));
  process.stdout.write(`${JSON.stringify(items.map(record), null, 2)}\n`);
}

function commandPick(argv) {
  const file = option(argv, 'file', DEFAULT_FILE);
  const now = option(argv, 'now', new Date().toISOString());
  const staleHours = Number(option(argv, 'stale-hours', String(DEFAULT_STALE_HOURS)));
  if (!Number.isFinite(staleHours) || staleHours <= 0) {
    throw new BacklogError('ключ --stale-hours требует положительного числа');
  }

  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) throw new BacklogError(`ключ --now: «${now}» не разбирается как дата`);

  const text = readFileSync(file, 'utf8');
  const chosen = parse(text).find((item) => isFree(item, nowMs, staleHours * 3600_000));
  if (chosen === undefined) {
    throw new BacklogError('свободных пунктов в очереди нет: все завершены либо взяты в работу');
  }

  writeFileSync(file, withFields(text, chosen.slug, { status: 'in_progress', started_at: now }));

  const payload = `${JSON.stringify(record(chosen), null, 2)}\n`;
  const out = option(argv, 'out', undefined);
  if (out !== undefined) writeFileSync(out, payload);
  process.stdout.write(payload);
}

function commandFinish(argv) {
  const slug = argv[0];
  if (slug === undefined || slug.startsWith('--')) {
    throw new BacklogError('finish требует слаг пункта первым аргументом');
  }

  const file = option(argv, 'file', DEFAULT_FILE);
  const status = option(argv, 'status', undefined);
  if (status !== 'done' && status !== 'failed') {
    throw new BacklogError('ключ --status требует значения done либо failed');
  }

  const reason = option(argv, 'reason', undefined);
  if (status === 'failed' && (reason === undefined || reason.trim() === '')) {
    throw new BacklogError('исход failed требует ключа --reason с причиной');
  }

  const text = readFileSync(file, 'utf8');
  const values = status === 'failed' ? { status, reason } : { status };
  writeFileSync(file, withFields(text, slug, values));
}

const [command, ...argv] = process.argv.slice(2);
const commands = { list: commandList, pick: commandPick, finish: commandFinish };

try {
  const handler = commands[command];
  if (handler === undefined) {
    throw new BacklogError(
      `неизвестная команда «${command ?? ''}», ожидалась одна из ${Object.keys(commands).join(', ')}`,
    );
  }
  handler(argv);
} catch (error) {
  if (error instanceof BacklogError) {
    process.stderr.write(`backlog: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
