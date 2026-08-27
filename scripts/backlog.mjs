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
 *   node scripts/backlog.mjs pick   [--file …] [--stale-hours 6] [--now ISO] [--out path] [--slots N]
 *   node scripts/backlog.mjs pick   [--file …] [--stale-hours 6] [--now ISO] --lanes a,b [--run-dir путь]
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
    const group = item.fields.get('group')?.value;
    if (group !== undefined && !SLUG.test(group)) {
      throw new BacklogError(
        `пункт «${item.slug}»: группа «${group}» не является слагом в kebab-case`,
      );
    }
  }

  return items;
}

function field(item, name) {
  return item.fields.get(name)?.value;
}

/** Действующая группа пункта: объявленное значение `group` либо слаг пункта. */
function effectiveGroup(item) {
  return field(item, 'group') ?? item.slug;
}

function record(item) {
  return {
    slug: item.slug,
    title: field(item, 'title'),
    why: field(item, 'why'),
    done_when: field(item, 'done_when'),
    group: effectiveGroup(item),
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
 * Держит ли пункт свою группу занятой: только `in_progress` и не протухший.
 *
 * `done` и `failed` не свободны для взятия (см. `isFree`), но это состояния
 * терминальные — они не должны запирать группу от других её пунктов.
 */
function isBusy(item, nowMs, staleMs) {
  return field(item, 'status') === 'in_progress' && !isFree(item, nowMs, staleMs);
}

/**
 * Отобрать до `slots` пунктов сверху вниз, по одному на действующую группу.
 *
 * Занятые группы собираются заранее по всей очереди (занятый пункт держит
 * свою группу, даже если сам он ниже места отбора), а затем пополняются по
 * ходу отбора — так пункт одной группы с уже выбранным не берётся в том же
 * проходе.
 */
function selectItems(items, slots, nowMs, staleMs) {
  const busyGroups = new Set(
    items.filter((item) => isBusy(item, nowMs, staleMs)).map(effectiveGroup),
  );

  const chosen = [];
  for (const item of items) {
    if (chosen.length >= slots) break;
    if (!isFree(item, nowMs, staleMs)) continue;
    const group = effectiveGroup(item);
    if (busyGroups.has(group)) continue;
    chosen.push(item);
    busyGroups.add(group);
  }
  return chosen;
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
  const staleMs = staleHours * 3600_000;

  const lanesOption = option(argv, 'lanes', undefined);
  if (lanesOption !== undefined) {
    commandPickLanes(argv, file, now, nowMs, staleMs, lanesOption);
    return;
  }

  const slotsOption = option(argv, 'slots', undefined);
  const slots = slotsOption === undefined ? 1 : Number(slotsOption);
  if (!Number.isInteger(slots) || slots <= 0) {
    throw new BacklogError('ключ --slots требует целого положительного числа');
  }

  const text = readFileSync(file, 'utf8');
  const chosen = selectItems(parse(text), slots, nowMs, staleMs);
  if (chosen.length === 0) {
    throw new BacklogError('свободных пунктов в очереди нет: все завершены либо взяты в работу');
  }

  let updated = text;
  for (const item of chosen) {
    updated = withFields(updated, item.slug, { status: 'in_progress', started_at: now });
  }
  writeFileSync(file, updated);

  const payload =
    slotsOption === undefined
      ? `${JSON.stringify(record(chosen[0]), null, 2)}\n`
      : `${JSON.stringify(chosen.map(record), null, 2)}\n`;
  const out = option(argv, 'out', undefined);
  if (out !== undefined) writeFileSync(out, payload);
  process.stdout.write(payload);
}

/**
 * Раздать по одному пункту на дорожку: `--lanes a,b` отбирает ровно
 * `lanes.length` пунктов теми же правилами, что и `--slots`, одной записью
 * файла и общей меткой `started_at`. Пустая дорожка получает пустые значения
 * полей, а не отсутствующую запись, — витрина петли не должна гадать, чего
 * не хватает.
 */
function commandPickLanes(argv, file, now, nowMs, staleMs, lanesOption) {
  const lanes = lanesOption.split(',').map((entry) => entry.trim());
  if (lanes.length === 0 || lanes.some((lane) => lane === '')) {
    throw new BacklogError('ключ --lanes требует непустого перечня имён через запятую');
  }
  for (const lane of lanes) {
    if (!SLUG.test(lane)) {
      throw new BacklogError(`имя дорожки «${lane}» не является слагом в kebab-case`);
    }
  }
  if (new Set(lanes).size !== lanes.length) {
    throw new BacklogError('имена дорожек должны быть попарно различны');
  }

  const text = readFileSync(file, 'utf8');
  const chosen = selectItems(parse(text), lanes.length, nowMs, staleMs);

  if (chosen.length > 0) {
    let updated = text;
    for (const item of chosen) {
      updated = withFields(updated, item.slug, { status: 'in_progress', started_at: now });
    }
    writeFileSync(file, updated);
  }

  const runDir = option(argv, 'run-dir', undefined);
  const result = { lanes: {} };

  lanes.forEach((lane, index) => {
    const item = chosen[index];
    if (item === undefined) {
      result.lanes[lane] = { filled: false, slug: '', title: '', group: '', item: null };
      return;
    }
    const rec = record(item);
    result.lanes[lane] = { filled: true, slug: rec.slug, title: rec.title, group: rec.group, item: rec };
    if (runDir !== undefined) {
      writeFileSync(`${runDir}/item-${lane}.json`, `${JSON.stringify(rec, null, 2)}\n`);
    }
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
  const items = parse(text);
  const item = items.find((candidate) => candidate.slug === slug);
  if (item === undefined) throw new BacklogError(`пункт «${slug}» в очереди не найден`);

  // Исход, уже проставленный, не переписывается: два finish на одном пункте
  // (например, повторный вызов после отказа сети) не должны состязаться за
  // последнее слово — первый проставленный исход и есть окончательный.
  const currentStatus = field(item, 'status');
  if (currentStatus === 'done' || currentStatus === 'failed') return;

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
