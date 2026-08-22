import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/**
 * Скрипт очереди — обычный `.mjs` без сборки, поэтому тест зовёт его так же,
 * как это делает пайплайн: отдельным процессом, по коду возврата и stdout.
 * Путь считается от собранного файла теста (`dist/test/`), а не от рабочего
 * каталога: иначе тест зависел бы от того, откуда его запустили.
 */
const SCRIPT = fileURLToPath(new URL('../../scripts/backlog.mjs', import.meta.url));

interface Result {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function backlog(args: readonly string[]): Result {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function item(slug: string, fields: Readonly<Record<string, string>>): string {
  const body = Object.entries(fields)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');
  return `## ${slug}\n\n${body}\n`;
}

const COMPLETE = { status: 'pending', title: 'т', why: 'з', done_when: 'к' } as const;

/** Записать очередь во временный файл и вернуть путь к ней. */
function fixture(...items: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'stepcast-backlog-'));
  const path = join(dir, 'backlog.md');
  writeFileSync(path, `# Очередь\n\nПреамбула: не разбирается.\n\n${items.join('\n')}`);
  return path;
}

function statusOf(path: string, slug: string): string | undefined {
  const section = readFileSync(path, 'utf8').split(`## ${slug}\n`)[1]?.split('\n## ')[0] ?? '';
  return /^status:\s*(.*)$/m.exec(section)?.[1];
}

function fieldOf(path: string, slug: string, name: string): string | undefined {
  const section = readFileSync(path, 'utf8').split(`## ${slug}\n`)[1]?.split('\n## ')[0] ?? '';
  return new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(section)?.[1];
}

describe('разбор очереди улучшений', () => {
  it('возвращает пункты со всеми полями', () => {
    const path = fixture(item('first-item', COMPLETE), item('second-item', COMPLETE));
    const result = backlog(['list', '--file', path]);

    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout) as readonly { slug: string; title: string }[];
    assert.deepEqual(
      parsed.map((entry) => entry.slug),
      ['first-item', 'second-item'],
    );
    assert.equal(parsed[0]?.title, 'т');
  });

  it('преамбула до первого пункта не разбирается', () => {
    const path = fixture(item('only-item', COMPLETE));
    const result = backlog(['list', '--file', path]);

    assert.equal(result.code, 0);
    assert.equal((JSON.parse(result.stdout) as readonly unknown[]).length, 1);
  });

  it('отказывает при отсутствии обязательного поля', () => {
    const path = fixture(item('broken-item', { status: 'pending', title: 'т', why: 'з' }));
    const result = backlog(['list', '--file', path]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /broken-item/);
    assert.match(result.stderr, /done_when/);
  });

  it('отказывает при неизвестном статусе', () => {
    const path = fixture(item('broken-item', { ...COMPLETE, status: 'выполняется' }));
    const result = backlog(['list', '--file', path]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /status/);
    assert.match(result.stderr, /выполняется/);
  });

  it('отказывает на заголовке, не являющемся слагом', () => {
    const path = fixture(item('Формат записи', COMPLETE));
    const result = backlog(['list', '--file', path]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /kebab-case/);
  });

  it('отказывает на повторяющемся слаге', () => {
    const path = fixture(item('same-item', COMPLETE), item('same-item', COMPLETE));
    const result = backlog(['list', '--file', path]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /дважды/);
  });

  it('отказывает на строке, не являющейся полем', () => {
    const path = fixture(`${item('broken-item', COMPLETE)}просто текст\n`);
    const result = backlog(['list', '--file', path]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /ключ: значение/);
  });
});

describe('выбор пункта очереди', () => {
  const NOW = '2026-08-23T12:00:00.000Z';

  it('берёт первый свободный сверху и помечает его в работе', () => {
    const path = fixture(
      item('done-item', { ...COMPLETE, status: 'done' }),
      item('first-free', COMPLETE),
      item('second-free', COMPLETE),
    );
    const result = backlog(['pick', '--file', path, '--now', NOW]);

    assert.equal(result.code, 0);
    assert.equal((JSON.parse(result.stdout) as { slug: string }).slug, 'first-free');
    assert.equal(statusOf(path, 'first-free'), 'in_progress');
    assert.equal(fieldOf(path, 'first-free', 'started_at'), NOW);
    assert.equal(statusOf(path, 'second-free'), 'pending');
  });

  it('отказывает, когда свободных пунктов нет', () => {
    const path = fixture(
      item('done-item', { ...COMPLETE, status: 'done' }),
      item('failed-item', { ...COMPLETE, status: 'failed' }),
    );
    const result = backlog(['pick', '--file', path, '--now', NOW]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /свободных пунктов/);
  });

  it('пропускает пункт, взятый в работу недавно', () => {
    const path = fixture(
      item('busy-item', {
        ...COMPLETE,
        status: 'in_progress',
        started_at: '2026-08-23T11:50:00.000Z',
      }),
      item('free-item', COMPLETE),
    );
    const result = backlog(['pick', '--file', path, '--now', NOW]);

    assert.equal(result.code, 0);
    assert.equal((JSON.parse(result.stdout) as { slug: string }).slug, 'free-item');
    assert.equal(fieldOf(path, 'busy-item', 'started_at'), '2026-08-23T11:50:00.000Z');
  });

  it('берёт зависший пункт заново и обновляет отметку времени', () => {
    const path = fixture(
      item('stale-item', {
        ...COMPLETE,
        status: 'in_progress',
        started_at: '2026-08-23T03:00:00.000Z',
      }),
    );
    const result = backlog(['pick', '--file', path, '--now', NOW]);

    assert.equal(result.code, 0);
    assert.equal((JSON.parse(result.stdout) as { slug: string }).slug, 'stale-item');
    assert.equal(fieldOf(path, 'stale-item', 'started_at'), NOW);
  });

  it('отказывает, когда единственный незавершённый пункт занят', () => {
    const path = fixture(
      item('busy-item', {
        ...COMPLETE,
        status: 'in_progress',
        started_at: '2026-08-23T11:50:00.000Z',
      }),
      item('done-item', { ...COMPLETE, status: 'done' }),
    );
    const result = backlog(['pick', '--file', path, '--now', NOW]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /свободных пунктов/);
  });

  it('порог протухания задаётся ключом', () => {
    const path = fixture(
      item('busy-item', {
        ...COMPLETE,
        status: 'in_progress',
        started_at: '2026-08-23T11:00:00.000Z',
      }),
    );

    assert.equal(backlog(['pick', '--file', path, '--now', NOW]).code, 1);
    assert.equal(
      backlog(['pick', '--file', path, '--now', NOW, '--stale-hours', '0.5']).code,
      0,
    );
  });

  it('записывает выбранный пункт в файл при --out', () => {
    const path = fixture(item('free-item', COMPLETE));
    const out = join(mkdtempSync(join(tmpdir(), 'stepcast-out-')), 'item.json');
    const result = backlog(['pick', '--file', path, '--now', NOW, '--out', out]);

    assert.equal(result.code, 0);
    assert.equal((JSON.parse(readFileSync(out, 'utf8')) as { slug: string }).slug, 'free-item');
  });
});

describe('проставление исхода', () => {
  it('переводит пункт в done', () => {
    const path = fixture(item('some-item', { ...COMPLETE, status: 'in_progress' }));
    const result = backlog(['finish', 'some-item', '--file', path, '--status', 'done']);

    assert.equal(result.code, 0);
    assert.equal(statusOf(path, 'some-item'), 'done');
  });

  it('переводит пункт в failed с причиной', () => {
    const path = fixture(item('some-item', { ...COMPLETE, status: 'in_progress' }));
    const result = backlog([
      'finish',
      'some-item',
      '--file',
      path,
      '--status',
      'failed',
      '--reason',
      'сборка не сошлась',
    ]);

    assert.equal(result.code, 0);
    assert.equal(statusOf(path, 'some-item'), 'failed');
    assert.equal(fieldOf(path, 'some-item', 'reason'), 'сборка не сошлась');
  });

  it('отказывает при неизвестном слаге', () => {
    const path = fixture(item('some-item', COMPLETE));
    const result = backlog(['finish', 'other-item', '--file', path, '--status', 'done']);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /other-item/);
    assert.equal(statusOf(path, 'some-item'), 'pending');
  });

  it('отказывает на failed без причины', () => {
    const path = fixture(item('some-item', COMPLETE));
    const result = backlog(['finish', 'some-item', '--file', path, '--status', 'failed']);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /reason/);
  });

  it('отказывает на неизвестном исходе', () => {
    const path = fixture(item('some-item', COMPLETE));
    const result = backlog(['finish', 'some-item', '--file', path, '--status', 'canceled']);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /done/);
  });
});
