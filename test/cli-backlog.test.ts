import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { describe, it } from 'node:test';

import { run, type CliIo } from '../src/cli/main.js';
import { ExitCode, type ExitCodeValue } from '../src/core/errors.js';
import { shortRunId } from '../src/core/journal/paths.js';
import { gitCommit, gitInit } from './helpers.js';
import { tempDir } from './tmp.js';

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

const COMPLETE = { status: 'todo', title: 'т', why: 'з', done_when: 'к' } as const;

function bed(...items: readonly string[]): string {
  const dir = tempDir('backlog-cli-');
  writeFileSync(join(dir, 'backlog.md'), `# Очередь\n\n${items.join('\n')}`);
  return dir;
}

/** Тот же bed, но репозиторий git с закоммиченной очередью — для проверок settle-коммита. */
function gitBed(...items: readonly string[]): string {
  const dir = bed(...items);
  gitInit(dir);
  gitCommit(dir, 'начальный');
  return dir;
}

function headMessageAt(dir: string): string {
  return execFileSync('git', ['-C', dir, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim();
}

function headFiles(dir: string): string[] {
  return execFileSync('git', ['-C', dir, 'show', '--name-only', '--format=', 'HEAD'], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter((line) => line !== '');
}

function commitCountAt(dir: string): number {
  return Number(execFileSync('git', ['-C', dir, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim());
}

function porcelainAt(dir: string): string {
  return execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
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
    const dir = tempDir('backlog-cli-');
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
    const runDir = tempDir('backlog-rundir-');

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

  it('вес пункта доезжает до дорожки плоским полем и до файла дорожки', async () => {
    // Плоским полем — потому что условие `if` пайплайна читает его прямо у
    // дорожки, не заходя внутрь item; у незаполненной — пусто, как слаг.
    const dir = bed(item('a', { ...COMPLETE, track: 'express' }));
    const runDir = tempDir('backlog-rundir-');

    const result = await backlog(dir, ['pick', '--lanes', 'a-lane,b-lane', '--run-dir', runDir]);

    assert.equal(result.code, ExitCode.ok);
    const parsed = JSON.parse(result.stdout) as {
      lanes: Record<string, { track: string; item: { track?: string } | null }>;
    };
    assert.equal(parsed.lanes['a-lane']?.track, 'express');
    assert.equal(parsed.lanes['a-lane']?.item?.track, 'express');
    assert.equal(parsed.lanes['b-lane']?.track, '');

    const written = JSON.parse(readFileSync(join(runDir, 'item-a-lane.json'), 'utf8')) as { track: string };
    assert.equal(written.track, 'express');
  });

  it('пункт без поля track доезжает до дорожки с пустой меткой', async () => {
    const dir = bed(item('a', COMPLETE));

    const result = await backlog(dir, ['pick', '--lanes', 'a-lane']);

    assert.equal(result.code, ExitCode.ok);
    const parsed = JSON.parse(result.stdout) as { lanes: Record<string, { track: string }> };
    assert.equal(parsed.lanes['a-lane']?.track, '');
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
    const dir = tempDir('backlog-cli-');
    const elsewhere = tempDir('backlog-elsewhere-');
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

describe('CLI: stepcast backlog pick --only', () => {
  it('берёт названный пункт, а не первый свободный', async () => {
    const dir = bed(item('first-item', COMPLETE), item('named-item', COMPLETE));

    const result = await backlog(dir, ['pick', '--only', 'named-item']);

    assert.equal(result.code, ExitCode.ok);
    const [entry] = JSON.parse(result.stdout) as readonly { slug: string }[];
    assert.equal(entry?.slug, 'named-item');

    const text = readFileSync(join(dir, 'backlog.md'), 'utf8');
    assert.equal(fieldOf(text, 'named-item', 'status'), 'in_progress');
    assert.equal(fieldOf(text, 'first-item', 'status'), 'todo');
  });

  it('заполняет названным пунктом первую дорожку, остальные остаются пустыми', async () => {
    const dir = bed(item('first-item', COMPLETE), item('named-item', COMPLETE));

    const result = await backlog(dir, ['pick', '--lanes', 'a,b', '--only', 'named-item']);

    assert.equal(result.code, ExitCode.ok);
    const parsed = JSON.parse(result.stdout) as { lanes: Record<string, { filled: boolean; slug: string }> };
    assert.equal(parsed.lanes.a?.slug, 'named-item');
    assert.equal(parsed.lanes.b?.filled, false);
  });

  it('неизвестный слаг — отказ, а не пустая выдача', async () => {
    const dir = bed(item('an-item', COMPLETE));

    const result = await backlog(dir, ['pick', '--only', 'no-such-item']);

    assert.equal(result.code, ExitCode.configError);
    assert.match(result.stderr, /no-such-item/);
    assert.equal(fieldOf(readFileSync(join(dir, 'backlog.md'), 'utf8'), 'an-item', 'status'), 'todo');
  });

  it('несвободный пункт — отказ с названным статусом', async () => {
    const dir = bed(item('an-item', { ...COMPLETE, status: 'done' }));

    const result = await backlog(dir, ['pick', '--only', 'an-item']);

    assert.equal(result.code, ExitCode.configError);
    assert.match(result.stderr, /done/);
  });

  it('пункт занятой группы не берётся даже по имени', async () => {
    const dir = bed(
      item('busy-item', {
        ...COMPLETE,
        status: 'in_progress',
        started_at: new Date().toISOString(),
        group: 'shared',
      }),
      item('named-item', { ...COMPLETE, group: 'shared' }),
    );

    const result = await backlog(dir, ['pick', '--only', 'named-item']);

    assert.equal(result.code, ExitCode.ok);
    assert.deepEqual(JSON.parse(result.stdout), []);
    assert.equal(fieldOf(readFileSync(join(dir, 'backlog.md'), 'utf8'), 'named-item', 'status'), 'todo');
  });
});

describe('CLI: stepcast backlog pick публикует данные работы', () => {
  /** Каталог работы с объявлением — тот же вид, что заводит движок до первого шага. */
  function jobDirWithDeclaration(declared: readonly string[]): string {
    const dir = tempDir('backlog-jobdir-');
    writeFileSync(join(dir, 'resolved.json'), JSON.stringify({ id: 'slots', data: declared }));
    return dir;
  }

  /** Позвать backlog с заданным (или отсутствующим) `STEPCAST_JOB_DIR`, восстановив окружение после. */
  async function backlogAsStep(
    cwd: string,
    argv: readonly string[],
    jobDir: string | undefined,
  ): Promise<Result> {
    const previous = process.env.STEPCAST_JOB_DIR;
    if (jobDir === undefined) delete process.env.STEPCAST_JOB_DIR;
    else process.env.STEPCAST_JOB_DIR = jobDir;
    try {
      return await backlog(cwd, argv);
    } finally {
      if (previous === undefined) delete process.env.STEPCAST_JOB_DIR;
      else process.env.STEPCAST_JOB_DIR = previous;
    }
  }

  // Сценарий: «Выбор публикуется работой slots»
  it('внутри работы, объявившей ключи выбора, публикует title, title-<дорожка> и slug-<дорожка>', async () => {
    const dir = bed(item('a', { ...COMPLETE, group: 'a' }));
    const jobDir = jobDirWithDeclaration(['title', 'title-a-lane', 'slug-a-lane']);

    const result = await backlogAsStep(dir, ['pick', '--lanes', 'a-lane'], jobDir);

    assert.equal(result.code, ExitCode.ok);
    assert.equal(result.stderr, '');
    const data = JSON.parse(readFileSync(join(jobDir, 'data.json'), 'utf8')) as Record<string, string>;
    assert.equal(data['slug-a-lane'], 'a');
    assert.ok(data['title-a-lane']);
    assert.ok(data['title']);
  });

  // Сценарий: «Публикация отклонена объявлением»
  it('внутри работы без объявления — выбор состоялся, код 0, а stderr называет работу и ключ', async () => {
    const dir = bed(item('a', { ...COMPLETE, group: 'a' }));
    const jobDir = jobDirWithDeclaration([]);

    const result = await backlogAsStep(dir, ['pick', '--lanes', 'a-lane'], jobDir);

    assert.equal(result.code, ExitCode.ok);
    assert.match(result.stderr, /подпись выбора не опубликована/);
    assert.match(result.stderr, /slots/);
    assert.equal(existsSync(join(jobDir, 'data.json')), false);
    assert.equal(fieldOf(readFileSync(join(dir, 'backlog.md'), 'utf8'), 'a', 'status'), 'in_progress');
  });

  // Сценарий: «Вызов вне прогона»
  it('вне шага прогона ничего не публикует и ни о чём не сообщает', async () => {
    const dir = bed(item('a', { ...COMPLETE, group: 'a' }));

    const result = await backlogAsStep(dir, ['pick', '--lanes', 'a-lane'], undefined);

    assert.equal(result.code, ExitCode.ok);
    assert.equal(result.stderr, '');
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

    // Ровно то, что собирает reasonWithOutput (src/core/lanes/merge.ts) из
    // stderr красной проверки.
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

describe('CLI: stepcast backlog settle', () => {
  function itemFile(runDir: string, lane: string, slug: string): void {
    writeFileSync(join(runDir, `item-${lane}.json`), JSON.stringify({ slug, title: `Улучшение ${slug}` }));
  }

  it('незакрытый пункт помечается failed с причиной', async () => {
    const dir = bed(item('a-item', { ...COMPLETE, status: 'in_progress' }));
    const runDir = tempDir('backlog-rundir-');
    itemFile(runDir, 'a', 'a-item');

    const result = await backlog(dir, ['settle', '--run-dir', runDir]);

    assert.equal(result.code, ExitCode.ok, result.stderr);
    const text = readFileSync(join(dir, 'backlog.md'), 'utf8');
    assert.equal(fieldOf(text, 'a-item', 'status'), 'failed');
    assert.match(fieldOf(text, 'a-item', 'reason') ?? '', /не дошёл/);
    assert.match(result.stdout, /a-item/);
  });

  it('уже закрытый пункт остаётся нетронутым', async () => {
    const dir = bed(item('a-item', { ...COMPLETE, status: 'done' }));
    const before = readFileSync(join(dir, 'backlog.md'), 'utf8');
    const runDir = tempDir('backlog-rundir-');
    itemFile(runDir, 'a', 'a-item');

    const result = await backlog(dir, ['settle', '--run-dir', runDir]);

    assert.equal(result.code, ExitCode.ok, result.stderr);
    assert.equal(readFileSync(join(dir, 'backlog.md'), 'utf8'), before);
  });

  it('пустой каталог прогона (без item-*.json) даёт код 0 и не правит очередь', async () => {
    const dir = bed(item('a-item', { ...COMPLETE, status: 'in_progress' }));
    const before = readFileSync(join(dir, 'backlog.md'), 'utf8');
    const runDir = tempDir('backlog-rundir-');

    const result = await backlog(dir, ['settle', '--run-dir', runDir]);

    assert.equal(result.code, ExitCode.ok, result.stderr);
    assert.match(result.stdout, /проставлять нечего/);
    assert.equal(readFileSync(join(dir, 'backlog.md'), 'utf8'), before);
  });

  it('отсутствующий каталог прогона отказывает кодом 2', async () => {
    const dir = bed(item('a-item', { ...COMPLETE, status: 'in_progress' }));
    const result = await backlog(dir, ['settle', '--run-dir', join(dir, 'нет-такого')]);
    assert.equal(result.code, ExitCode.configError);
  });

  it('--run-dir не задан отказывает кодом 2', async () => {
    const dir = bed(item('a-item', { ...COMPLETE, status: 'in_progress' }));
    const result = await backlog(dir, ['settle']);
    assert.equal(result.code, ExitCode.configError);
  });

  it('файл дорожки без слага отказывает кодом 2', async () => {
    const dir = bed(item('a-item', { ...COMPLETE, status: 'in_progress' }));
    const runDir = tempDir('backlog-rundir-');
    writeFileSync(join(runDir, 'item-a.json'), JSON.stringify({ title: 'без слага' }));

    const result = await backlog(dir, ['settle', '--run-dir', runDir]);

    assert.equal(result.code, ExitCode.configError);
  });

  it('две дорожки: одна done остаётся нетронутой, другая in_progress становится failed', async () => {
    const dir = bed(
      item('a-item', { ...COMPLETE, status: 'done' }),
      item('b-item', { ...COMPLETE, status: 'in_progress' }),
    );
    const runDir = tempDir('backlog-rundir-');
    itemFile(runDir, 'a', 'a-item');
    itemFile(runDir, 'b', 'b-item');

    const result = await backlog(dir, ['settle', '--run-dir', runDir]);

    assert.equal(result.code, ExitCode.ok, result.stderr);
    const text = readFileSync(join(dir, 'backlog.md'), 'utf8');
    assert.equal(fieldOf(text, 'a-item', 'status'), 'done');
    assert.equal(fieldOf(text, 'a-item', 'reason'), undefined);
    assert.equal(fieldOf(text, 'b-item', 'status'), 'failed');
  });

  it('коммитит адресно только файл очереди, сообщением с коротким id прогона', async () => {
    const dir = gitBed(item('a-item', { ...COMPLETE, status: 'in_progress' }));
    const runDir = tempDir('backlog-rundir-42abcd');
    itemFile(runDir, 'a', 'a-item');
    const before = commitCountAt(dir);

    const result = await backlog(dir, ['settle', '--run-dir', runDir]);

    assert.equal(result.code, ExitCode.ok, result.stderr);
    assert.equal(commitCountAt(dir), before + 1);
    assert.deepEqual(headFiles(dir), ['backlog.md']);
    assert.equal(headMessageAt(dir), `backlog: исходы дорожек прогона ${shortRunId(basename(runDir))}`);
    assert.equal(porcelainAt(dir), '', 'дерево чисто после коммита');
    assert.match(result.stdout, /закоммичена/);
  });

  it('без правок коммита нет: уже закрытый пункт ничего не меняет', async () => {
    const dir = gitBed(item('a-item', { ...COMPLETE, status: 'done' }));
    const runDir = tempDir('backlog-rundir-');
    itemFile(runDir, 'a', 'a-item');
    const before = commitCountAt(dir);

    const result = await backlog(dir, ['settle', '--run-dir', runDir]);

    assert.equal(result.code, ExitCode.ok, result.stderr);
    assert.equal(commitCountAt(dir), before, 'коммита нет — settle ничего в очередь не проставил');
  });

  it('файл очереди вне git-репозитория — коммита нет, вывод это называет', async () => {
    const dir = bed(item('a-item', { ...COMPLETE, status: 'in_progress' }));
    const runDir = tempDir('backlog-rundir-');
    itemFile(runDir, 'a', 'a-item');

    const result = await backlog(dir, ['settle', '--run-dir', runDir]);

    assert.equal(result.code, ExitCode.ok, result.stderr);
    assert.match(result.stdout, /не закоммичена/);
  });

  it('посторонняя правка рабочего дерева в коммит не попадает', async () => {
    const dir = gitBed(item('a-item', { ...COMPLETE, status: 'in_progress' }));
    const runDir = tempDir('backlog-rundir-');
    itemFile(runDir, 'a', 'a-item');
    writeFileSync(join(dir, 'stray.txt'), 'чужая правка\n');

    const result = await backlog(dir, ['settle', '--run-dir', runDir]);

    assert.equal(result.code, ExitCode.ok, result.stderr);
    assert.deepEqual(headFiles(dir), ['backlog.md']);
    assert.match(porcelainAt(dir), /stray\.txt/, 'посторонний файл остаётся незакоммиченным');
  });
});
