import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { run, type CliIo } from '../src/cli/main.js';
import { ExitCode, type ExitCodeValue } from '../src/core/errors.js';

/**
 * `stepcast backlog` не требует ни `stepcast.yml`, ни `.stepcast/`, ни
 * конфигурации — проверки идут `run(argv, io)` в обычном временном каталоге,
 * без каркаса `makeProject`, который заводит их специально для команд,
 * зависящих от проекта.
 */

interface Result {
  readonly code: ExitCodeValue;
  readonly stdout: string;
  readonly stderr: string;
}

async function backlog(cwd: string, argv: readonly string[]): Promise<Result> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    cwd,
  };
  const code = await run(['backlog', ...argv], io);
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

function item(slug: string, fields: Readonly<Record<string, string>>): string {
  const body = Object.entries(fields)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');
  return `## ${slug}\n\n${body}\n`;
}

const COMPLETE = { status: 'pending', title: 'т', why: 'з', done_when: 'к' } as const;

function bed(...items: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'stepcast-backlog-cli-'));
  writeFileSync(join(dir, 'backlog.md'), `# Очередь\n\n${items.join('\n')}`);
  return dir;
}

function fieldOf(text: string, slug: string, name: string): string | undefined {
  const section = text.split(`## ${slug}\n`)[1]?.split('\n## ')[0] ?? '';
  return new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(section)?.[1];
}

describe('CLI: stepcast backlog list', () => {
  it('печатает пункты и не правит файл', async () => {
    const dir = bed(item('an-item', COMPLETE));
    const before = readFileSync(join(dir, 'backlog.md'), 'utf8');

    const result = await backlog(dir, ['list']);

    assert.equal(result.code, ExitCode.ok);
    const parsed = JSON.parse(result.stdout) as readonly { slug: string }[];
    assert.deepEqual(parsed.map((entry) => entry.slug), ['an-item']);
    assert.equal(readFileSync(join(dir, 'backlog.md'), 'utf8'), before);
  });

  it('отказывает ошибкой конфигурации, если файла нет', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stepcast-backlog-cli-'));
    const result = await backlog(dir, ['list']);

    assert.equal(result.code, ExitCode.configError);
    assert.match(result.stderr, /backlog\.md/);
  });

  it('в каталоге без stepcast.yml и .stepcast/ отрабатывает штатно', async () => {
    const dir = bed(item('an-item', COMPLETE));
    assert.equal(existsSync(join(dir, 'stepcast.yml')), false);
    assert.equal(existsSync(join(dir, '.stepcast')), false);

    const result = await backlog(dir, ['list']);
    assert.equal(result.code, ExitCode.ok);
  });
});

describe('CLI: stepcast backlog pick', () => {
  it('берёт пункт и проставляет status и started_at', async () => {
    const dir = bed(item('an-item', COMPLETE));

    const result = await backlog(dir, ['pick']);

    assert.equal(result.code, ExitCode.ok);
    const [entry] = JSON.parse(result.stdout) as readonly { slug: string }[];
    assert.equal(entry?.slug, 'an-item');

    const text = readFileSync(join(dir, 'backlog.md'), 'utf8');
    assert.equal(fieldOf(text, 'an-item', 'status'), 'in_progress');
    assert.ok(fieldOf(text, 'an-item', 'started_at'));
  });

  it('--slots 2 берёт два пункта разных групп одной меткой started_at', async () => {
    const dir = bed(item('a', { ...COMPLETE, group: 'a' }), item('b', { ...COMPLETE, group: 'b' }));

    const result = await backlog(dir, ['pick', '--slots', '2']);

    assert.equal(result.code, ExitCode.ok);
    const parsed = JSON.parse(result.stdout) as readonly { slug: string }[];
    assert.deepEqual(parsed.map((entry) => entry.slug), ['a', 'b']);

    const text = readFileSync(join(dir, 'backlog.md'), 'utf8');
    const startedA = fieldOf(text, 'a', 'started_at');
    const startedB = fieldOf(text, 'b', 'started_at');
    assert.ok(startedA);
    assert.equal(startedA, startedB);
  });

  it('--lanes раздаёт дорожки, незаполненная присутствует с filled: false', async () => {
    const dir = bed(item('a', { ...COMPLETE, group: 'a' }));
    const runDir = mkdtempSync(join(tmpdir(), 'stepcast-backlog-rundir-'));

    const result = await backlog(dir, ['pick', '--lanes', 'a-lane,b-lane', '--run-dir', runDir]);

    assert.equal(result.code, ExitCode.ok);
    const parsed = JSON.parse(result.stdout) as {
      lanes: Record<string, { filled: boolean; slug: string; item: unknown }>;
    };
    assert.equal(parsed.lanes['a-lane']?.filled, true);
    assert.equal(parsed.lanes['a-lane']?.slug, 'a');
    assert.equal(parsed.lanes['b-lane']?.filled, false);
    assert.equal(parsed.lanes['b-lane']?.item, null);

    assert.ok(existsSync(join(runDir, 'item-a-lane.json')));
    assert.equal(existsSync(join(runDir, 'item-b-lane.json')), false);
  });

  it('пустая очередь: код 0, пустая выдача, файл не изменён', async () => {
    const dir = bed(item('done-item', { ...COMPLETE, status: 'done' }));
    const before = readFileSync(join(dir, 'backlog.md'), 'utf8');

    const result = await backlog(dir, ['pick']);

    assert.equal(result.code, ExitCode.ok);
    assert.deepEqual(JSON.parse(result.stdout), []);
    assert.equal(readFileSync(join(dir, 'backlog.md'), 'utf8'), before);
  });

  it('пустая очередь по дорожкам: обе дорожки filled: false, файл не изменён', async () => {
    const dir = bed(item('done-item', { ...COMPLETE, status: 'done' }));
    const before = readFileSync(join(dir, 'backlog.md'), 'utf8');

    const result = await backlog(dir, ['pick', '--lanes', 'a,b']);

    assert.equal(result.code, ExitCode.ok);
    const parsed = JSON.parse(result.stdout) as { lanes: Record<string, { filled: boolean }> };
    assert.equal(parsed.lanes['a']?.filled, false);
    assert.equal(parsed.lanes['b']?.filled, false);
    assert.equal(readFileSync(join(dir, 'backlog.md'), 'utf8'), before);
  });

  it('--file вне текущего каталога правит именно этот файл', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stepcast-backlog-cli-'));
    const elsewhere = mkdtempSync(join(tmpdir(), 'stepcast-backlog-elsewhere-'));
    const file = join(elsewhere, 'queue.md');
    writeFileSync(file, `# Очередь\n\n${item('an-item', COMPLETE)}`);

    const result = await backlog(dir, ['pick', '--file', file]);

    assert.equal(result.code, ExitCode.ok);
    assert.equal(fieldOf(readFileSync(file, 'utf8'), 'an-item', 'status'), 'in_progress');
  });

  it('ошибочный перечень дорожек отказывает ошибкой конфигурации', async () => {
    const dir = bed(item('an-item', COMPLETE));

    for (const lanes of ['', 'a,a', 'Дорожка A']) {
      const result = await backlog(dir, ['pick', '--lanes', lanes]);
      assert.equal(result.code, ExitCode.configError, `lanes=${lanes}`);
    }
  });

  it('--lanes вместе с --slots отклоняется, а не выбирает форму молча', async () => {
    const dir = bed(item('an-item', COMPLETE));
    const before = readFileSync(join(dir, 'backlog.md'), 'utf8');

    const result = await backlog(dir, ['pick', '--lanes', 'a-lane', '--slots', '2']);

    assert.equal(result.code, ExitCode.configError);
    assert.match(result.stderr, /--lanes/);
    assert.equal(readFileSync(join(dir, 'backlog.md'), 'utf8'), before);
  });

  it('относительный --run-dir разрешается от рабочего каталога вызова, а не процесса', async () => {
    const dir = bed(item('an-item', COMPLETE));

    const result = await backlog(dir, ['pick', '--lanes', 'a-lane', '--run-dir', 'lanes']);

    assert.equal(result.code, ExitCode.ok, result.stderr);
    assert.ok(existsSync(join(dir, 'lanes', 'item-a-lane.json')));
  });

  it('недоступный --run-dir отказывает до правки очереди', async () => {
    const dir = bed(item('an-item', COMPLETE));
    // Не каталог, а обычный файл: подготовить каталог дорожек по этому пути
    // нечем, и отказ обязан случиться раньше, чем пункт помечен взятым.
    const occupied = join(dir, 'occupied');
    writeFileSync(occupied, 'не каталог');
    const before = readFileSync(join(dir, 'backlog.md'), 'utf8');

    const result = await backlog(dir, ['pick', '--lanes', 'a-lane', '--run-dir', occupied]);

    assert.equal(result.code, ExitCode.configError);
    assert.equal(readFileSync(join(dir, 'backlog.md'), 'utf8'), before);
  });
});

describe('CLI: stepcast backlog finish', () => {
  it('finish done проставляет исход', async () => {
    const dir = bed(item('an-item', { ...COMPLETE, status: 'in_progress' }));

    const result = await backlog(dir, ['finish', 'an-item', '--status', 'done']);

    assert.equal(result.code, ExitCode.ok);
    assert.equal(fieldOf(readFileSync(join(dir, 'backlog.md'), 'utf8'), 'an-item', 'status'), 'done');
  });

  it('finish failed --reason проставляет исход и причину', async () => {
    const dir = bed(item('an-item', { ...COMPLETE, status: 'in_progress' }));

    const result = await backlog(dir, ['finish', 'an-item', '--status', 'failed', '--reason', 'проверка красная']);

    assert.equal(result.code, ExitCode.ok);
    const text = readFileSync(join(dir, 'backlog.md'), 'utf8');
    assert.equal(fieldOf(text, 'an-item', 'status'), 'failed');
    assert.equal(fieldOf(text, 'an-item', 'reason'), 'проверка красная');
  });

  it('многострочная причина сводится в одну строку, очередь остаётся разбираемой', async () => {
    const dir = bed(item('an-item', { ...COMPLETE, status: 'in_progress' }));

    // Ровно то, что собирает scripts/finalize.mjs из stderr красной проверки.
    const result = await backlog(dir, [
      'finish',
      'an-item',
      '--status',
      'failed',
      '--reason',
      'проверка после наложения не прошла:\n  test/backlog.test.ts:12\n  1 failing',
    ]);

    assert.equal(result.code, ExitCode.ok, result.stderr);
    const text = readFileSync(join(dir, 'backlog.md'), 'utf8');
    assert.equal(
      fieldOf(text, 'an-item', 'reason'),
      'проверка после наложения не прошла: test/backlog.test.ts:12 1 failing',
    );

    // Следующее чтение очереди обязано пройти: многострочное значение сделало
    // бы неразбираемым весь файл, а не один пункт.
    const listed = await backlog(dir, ['list']);
    assert.equal(listed.code, ExitCode.ok, listed.stderr);
  });

  it('длинная причина урезается: очередь читает человек', async () => {
    const dir = bed(item('an-item', { ...COMPLETE, status: 'in_progress' }));

    const result = await backlog(dir, [
      'finish',
      'an-item',
      '--status',
      'failed',
      '--reason',
      'ш'.repeat(5000),
    ]);

    assert.equal(result.code, ExitCode.ok, result.stderr);
    const reason = fieldOf(readFileSync(join(dir, 'backlog.md'), 'utf8'), 'an-item', 'reason') ?? '';
    assert.ok(reason.length < 600, `причина длиной ${reason.length} осталась неурезанной`);
    assert.match(reason, /…$/);
  });

  it('повторный finish не меняет файл и завершается кодом 0', async () => {
    const dir = bed(item('an-item', { ...COMPLETE, status: 'done' }));
    const before = readFileSync(join(dir, 'backlog.md'), 'utf8');

    const result = await backlog(dir, ['finish', 'an-item', '--status', 'failed', '--reason', 'поздно']);

    assert.equal(result.code, ExitCode.ok);
    assert.equal(readFileSync(join(dir, 'backlog.md'), 'utf8'), before);
  });

  it('failed без --reason отказывает ошибкой конфигурации', async () => {
    const dir = bed(item('an-item', COMPLETE));
    const result = await backlog(dir, ['finish', 'an-item', '--status', 'failed']);
    assert.equal(result.code, ExitCode.configError);
  });

  it('отсутствующий слаг отказывает ошибкой конфигурации', async () => {
    const dir = bed(item('an-item', COMPLETE));
    const result = await backlog(dir, ['finish', 'missing-item', '--status', 'done']);

    assert.equal(result.code, ExitCode.configError);
    assert.match(result.stderr, /missing-item/);
  });
});
