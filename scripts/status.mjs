#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Сборка `docs/status.md` из базы `docs/status.base.md` и фрагментов
 * изменений `status.md` внутри `openspec/changes`.
 *
 * Обычный Node без сборки и без зависимостей — пересборка входит в
 * `npm run check` и не должна требовать `npm run build`.
 *
 *   node scripts/status.mjs --write [--root каталог]
 *   node scripts/status.mjs --check [--root каталог]
 */

class StatusError extends Error {}

const BASE_HEADINGS = new Set(['Работает', 'Пока нет', 'Известные ограничения', 'Примечания']);
const FRAGMENT_HEADINGS = new Set([
  'Работает',
  'Пока нет',
  'Пока нет: снято',
  'Известные ограничения',
  'Известные ограничения: снято',
]);

const HEADING = /^##\s+(.+?)\s*$/;
/**
 * Ключ пункта пишется жирным лидом — как лид блока ограничений.
 *
 * Отделение ключа первым `: ` разбирало бы ключ с двоеточием внутри
 * (`Триггеры: расписание, GitHub`) молча и неверно, а отличить такой ключ от
 * ключа с двоеточием в тексте разбору неоткуда. Жирный лид границу называет
 * явно, а его отсутствие — отказ, а не догадка.
 */
const KEYED_BULLET = /^- \*\*(.+?)\*\*: (.+)$/;
const KEY_ONLY_BULLET = /^- \*\*(.+?)\*\*\s*$/;
const LEAD = /^\*\*([\s\S]+?)\*\*/;
const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-(.+)$/;

function preview(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
}

/** Лид может быть разбит переносом строки — сравнивается он по плоской форме. */
function flatten(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Разбить текст на вводную часть и разделы второго уровня.
 *
 * Заголовок вне допустимого перечня — отказ: и база, и фрагмент несут ровно
 * фиксированный набор разделов, а не произвольную разметку.
 */
function splitSections(text, path, allowed) {
  const sections = new Map();
  const introLines = [];
  let current = null;

  for (const line of text.split('\n')) {
    const heading = HEADING.exec(line);
    if (heading !== null) {
      const name = heading[1];
      if (!allowed.has(name)) {
        throw new StatusError(`${path}: неизвестный заголовок «${name}»`);
      }
      if (sections.has(name)) {
        throw new StatusError(`${path}: заголовок «${name}» встречается дважды`);
      }
      sections.set(name, []);
      current = name;
      continue;
    }
    if (current === null) introLines.push(line);
    else sections.get(current).push(line);
  }

  return { intro: introLines.join('\n'), sections };
}

function splitParagraphs(lines) {
  return lines
    .join('\n')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '');
}

/** Пункты вида `- **<ключ>**: <текст>`. */
function parseKeyedList(lines, path, heading) {
  const items = [];
  const seen = new Set();

  for (const raw of lines) {
    if (raw.trim() === '') continue;
    const bullet = KEYED_BULLET.exec(raw);
    if (bullet === null) {
      throw new StatusError(
        `${path}: раздел «${heading}»: пункт «${preview(raw)}» без ключа: ` +
          'ключ пишется жирным лидом — «- **<ключ>**: <текст>»',
      );
    }
    const key = flatten(bullet[1]);
    if (seen.has(key)) {
      throw new StatusError(`${path}: раздел «${heading}»: ключ «${key}» повторяется`);
    }
    seen.add(key);
    items.push({ key, text: bullet[2].trim() });
  }

  return items;
}

/** Пункты вида `- **<ключ>**` — снятие по ключу строки либо по лиду блока. */
function parseKeyOnlyList(lines, path, heading) {
  const keys = [];
  for (const raw of lines) {
    if (raw.trim() === '') continue;
    const bullet = KEY_ONLY_BULLET.exec(raw);
    if (bullet === null) {
      throw new StatusError(
        `${path}: раздел «${heading}»: пункт «${preview(raw)}» без ключа: ` +
          'снимаемый ключ пишется жирным лидом — «- **<ключ>**»',
      );
    }
    keys.push(flatten(bullet[1]));
  }
  return keys;
}

/**
 * Блоки ограничений базы: абзац без лида продолжает предыдущий блок.
 *
 * Накопленное до фрагментов содержимое переносилось из документа, где одно
 * ограничение нередко занимает несколько абзацев (например, оговорка о
 * несимметричном откате журнала) — это нужно сохранить при сборке.
 */
function parseLimitationBlocksBase(lines, path) {
  const blocks = [];
  for (const paragraph of splitParagraphs(lines)) {
    const lead = LEAD.exec(paragraph);
    if (lead !== null) {
      blocks.push({ lead: flatten(lead[1]), text: paragraph });
      continue;
    }
    if (blocks.length === 0) {
      throw new StatusError(
        `${path}: раздел «Известные ограничения»: абзац без жирного лида: «${preview(paragraph)}»`,
      );
    }
    blocks[blocks.length - 1].text += `\n\n${paragraph}`;
  }
  return blocks;
}

/** Блоки ограничений фрагмента: каждый абзац несёт собственный лид. */
function parseLimitationBlocksFragment(lines, path) {
  return splitParagraphs(lines).map((paragraph) => {
    const lead = LEAD.exec(paragraph);
    if (lead === null) {
      throw new StatusError(
        `${path}: раздел «Известные ограничения»: абзац без жирного лида: «${preview(paragraph)}»`,
      );
    }
    return { lead: flatten(lead[1]), text: paragraph };
  });
}

function parseBase(path) {
  const { intro, sections } = splitSections(readFileSync(path, 'utf8'), path, BASE_HEADINGS);
  return {
    path,
    intro: intro.trim(),
    works: parseKeyedList(sections.get('Работает') ?? [], path, 'Работает'),
    missing: parseKeyedList(sections.get('Пока нет') ?? [], path, 'Пока нет'),
    limitations: parseLimitationBlocksBase(sections.get('Известные ограничения') ?? [], path),
    notes: splitParagraphs(sections.get('Примечания') ?? []).join('\n\n'),
  };
}

function parseFragment(path, slug) {
  const { intro, sections } = splitSections(readFileSync(path, 'utf8'), path, FRAGMENT_HEADINGS);
  if (intro.trim() !== '') {
    // Проза до первого заголовка — не раздел фрагмента: молча отброшенная,
    // она означала бы потерянную клаузу, о которой автор не узнает.
    throw new StatusError(
      `${path}: текст вне разделов: «${preview(intro)}»; ` +
        'фрагмент состоит только из разделов второго уровня',
    );
  }
  return {
    path,
    slug,
    works: parseKeyedList(sections.get('Работает') ?? [], path, 'Работает'),
    missing: parseKeyedList(sections.get('Пока нет') ?? [], path, 'Пока нет'),
    missingRevoked: parseKeyOnlyList(sections.get('Пока нет: снято') ?? [], path, 'Пока нет: снято'),
    limitations: parseLimitationBlocksFragment(sections.get('Известные ограничения') ?? [], path),
    limitationsRevoked: parseKeyOnlyList(
      sections.get('Известные ограничения: снято') ?? [],
      path,
      'Известные ограничения: снято',
    ),
  };
}

function listDirs(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function addFragment(bySlug, slug, path) {
  const existing = bySlug.get(slug);
  if (existing !== undefined) {
    throw new StatusError(
      `слаг «${slug}» найден и в активном, и в архивном изменении: ${existing} и ${path}`,
    );
  }
  bySlug.set(slug, path);
}

/**
 * Найти фрагменты активных и заархивированных изменений.
 *
 * Каталог `archive` на уровне активных изменений — не изменение, а место для
 * архива, и в перечень слагов не попадает. Изменение без `status.md`
 * пропускается молча: не всякое изменение трогает состояние реализации.
 */
function discoverFragments(root) {
  const changesDir = join(root, 'openspec', 'changes');
  const archiveDir = join(changesDir, 'archive');
  const bySlug = new Map();

  for (const name of listDirs(changesDir)) {
    if (name === 'archive') continue;
    const statusPath = join(changesDir, name, 'status.md');
    if (existsSync(statusPath)) addFragment(bySlug, name, statusPath);
  }

  for (const name of listDirs(archiveDir)) {
    const statusPath = join(archiveDir, name, 'status.md');
    if (!existsSync(statusPath)) continue;
    const match = DATE_PREFIX.exec(name);
    if (match === null) {
      throw new StatusError(
        `${join(archiveDir, name)}: имя архивного каталога изменения не имеет префикса ГГГГ-ММ-ДД-`,
      );
    }
    addFragment(bySlug, match[1], statusPath);
  }

  return [...bySlug.entries()]
    .map(([slug, path]) => parseFragment(path, slug))
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

/** Ячейка «Работает» — склейка клауз базы и фрагментов через `; ` по ключу. */
function mergeWorks(base, fragments) {
  const order = base.works.map((item) => item.key);
  const cells = new Map(base.works.map((item) => [item.key, [item.text]]));

  for (const fragment of fragments) {
    for (const item of fragment.works) {
      if (!cells.has(item.key)) {
        cells.set(item.key, []);
        order.push(item.key);
      }
      cells.get(item.key).push(item.text);
    }
  }

  return order.map((key) => ({ key, text: cells.get(key).join('; ') }));
}

/** Строку «Пока нет» заводит ровно один источник — база либо один фрагмент. */
function mergeMissing(base, fragments) {
  const order = base.missing.map((item) => item.key);
  const owners = new Map(
    base.missing.map((item) => [item.key, { source: base.path, text: item.text }]),
  );

  // Фрагмент, снимающий чужую строку и заводящий её заново под тем же ключом,
  // не конфликтует с прежним источником: он строку заменяет, а не дублирует.
  for (const fragment of fragments) {
    const revokes = new Set(fragment.missingRevoked);
    for (const item of fragment.missing) {
      const owner = owners.get(item.key);
      if (owner !== undefined && !revokes.has(item.key)) {
        throw new StatusError(
          `ключ «Пока нет» «${item.key}» занят источником ${owner.source} и фрагментом ` +
            `${fragment.path} (${fragment.slug})`,
        );
      }
      if (owner === undefined) order.push(item.key);
      owners.set(item.key, {
        source: `${fragment.path} (${fragment.slug})`,
        text: item.text,
        redeclared: revokes.has(item.key),
      });
    }
  }

  const revoked = new Set();
  for (const fragment of fragments) {
    for (const key of fragment.missingRevoked) {
      if (!owners.has(key)) {
        throw new StatusError(
          `${fragment.path}: снятие несуществующей строки «Пока нет» с ключом «${key}»`,
        );
      }
      revoked.add(key);
    }
  }

  return order
    .filter((key) => !revoked.has(key) || owners.get(key).redeclared === true)
    .map((key) => ({ key, text: owners.get(key).text }));
}

/** Блоки ограничений: база, затем фрагменты по слагу; снятие — после сборки. */
function mergeLimitations(base, fragments) {
  const blocks = base.limitations.map((block) => ({ lead: block.lead, text: block.text }));

  for (const fragment of fragments) {
    for (const block of fragment.limitations) {
      blocks.push({
        lead: block.lead,
        text: `${block.text}\n\n*Заведено изменением \`${fragment.slug}\`.*`,
      });
    }
  }

  const revoked = new Set();
  for (const fragment of fragments) {
    for (const lead of fragment.limitationsRevoked) {
      if (!blocks.some((block) => block.lead === lead)) {
        throw new StatusError(
          `${fragment.path}: снятие несуществующего блока «Известные ограничения» с лидом «${lead}»`,
        );
      }
      revoked.add(lead);
    }
  }

  return blocks.filter((block) => !revoked.has(block.lead));
}

function render(intro, works, missing, limitations, notes) {
  const lines = ['# Что реализовано', '', intro, '', '## Работает', '', '| | |', '|---|---|'];
  for (const row of works) lines.push(`| ${row.key} | ${row.text} |`);

  lines.push('', '## Пока нет', '', '| Возможность | Что происходит при попытке |', '|---|---|');
  for (const row of missing) lines.push(`| ${row.key} | ${row.text} |`);

  if (limitations.length > 0) {
    lines.push(
      '',
      '## Известные ограничения',
      '',
      limitations.map((block) => block.text).join('\n\n'),
    );
  }

  if (notes.trim() !== '') lines.push('', '## Примечания', '', notes.trim());

  return `${lines.join('\n')}\n`;
}

function build(root) {
  const basePath = join(root, 'docs', 'status.base.md');
  if (!existsSync(basePath)) throw new StatusError(`${basePath}: файл базы не найден`);

  const base = parseBase(basePath);
  const fragments = discoverFragments(root);

  return render(
    base.intro,
    mergeWorks(base, fragments),
    mergeMissing(base, fragments),
    mergeLimitations(base, fragments),
    base.notes,
  );
}

function commandWrite(root) {
  writeFileSync(join(root, 'docs', 'status.md'), build(root));
}

function commandCheck(root) {
  const expected = build(root);
  const outputPath = join(root, 'docs', 'status.md');

  let actual;
  try {
    actual = readFileSync(outputPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new StatusError(`${outputPath} не найден; выполните «npm run status:build»`);
  }
  if (actual === expected) return;

  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  let line = 0;
  while (
    line < expectedLines.length &&
    line < actualLines.length &&
    expectedLines[line] === actualLines[line]
  ) {
    line += 1;
  }

  throw new StatusError(
    `${outputPath}: расхождение со сборкой начиная со строки ${line + 1}; ` +
      'выполните «npm run status:build»',
  );
}

/**
 * Значение ключа: пропущенное значение — отказ, а не молчаливое умолчание.
 * `--root` без каталога иначе проверял бы рабочий каталог вместо названного.
 */
function option(argv, name) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new StatusError(`ключ --${name} требует значения`);
  }
  return value;
}

const argv = process.argv.slice(2);
const write = argv.includes('--write');
const check = argv.includes('--check');

try {
  if (write === check) {
    throw new StatusError('нужен ровно один из ключей --write или --check');
  }
  const unknown = argv.find(
    (arg) => arg.startsWith('--') && !['--write', '--check', '--root'].includes(arg),
  );
  if (unknown !== undefined) throw new StatusError(`неизвестный ключ ${unknown}`);
  const root = option(argv, 'root') ?? process.cwd();
  if (write) commandWrite(root);
  else commandCheck(root);
} catch (error) {
  if (error instanceof StatusError) {
    process.stderr.write(`status: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
