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

  it('возвращает объявленную группу пункта', () => {
    const path = fixture(item('backlog-groups', { ...COMPLETE, group: 'backlog-queue' }));
    const result = backlog(['list', '--file', path]);

    assert.equal(result.code, 0);
    const [entry] = JSON.parse(result.stdout) as readonly { group: string }[];
    assert.equal(entry?.group, 'backlog-queue');
  });

  it('действующая группа равна слагу, если group не объявлен', () => {
    const path = fixture(item('backlog-groups', COMPLETE));
    const result = backlog(['list', '--file', path]);

    assert.equal(result.code, 0);
    const [entry] = JSON.parse(result.stdout) as readonly { group: string }[];
    assert.equal(entry?.group, 'backlog-groups');
  });

  it('отказывает на группе не в kebab-case', () => {
    const path = fixture(item('some-item', { ...COMPLETE, group: 'Backlog Queue' }));
    const result = backlog(['list', '--file', path]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /some-item/);
    assert.match(result.stderr, /Backlog Queue/);
  });

  it('отказывает на пустой группе', () => {
    const path = fixture(item('some-item', { ...COMPLETE, group: '' }));
    const result = backlog(['list', '--file', path]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /some-item/);
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
    assert.equal(readFileSync(out, 'utf8'), result.stdout);
  });

  it('выдача одного пункта называет его действующую группу', () => {
    const path = fixture(item('free-item', { ...COMPLETE, group: 'queue' }));
    const result = backlog(['pick', '--file', path, '--now', NOW]);

    assert.equal(result.code, 0);
    assert.equal((JSON.parse(result.stdout) as { group: string }).group, 'queue');
  });
});

describe('занятость группы при выборе одного пункта', () => {
  const NOW = '2026-08-23T12:00:00.000Z';

  it('пропускает свободный пункт занятой группы в пользу пункта ниже', () => {
    const path = fixture(
      item('alpha', {
        ...COMPLETE,
        status: 'in_progress',
        started_at: '2026-08-23T11:50:00.000Z',
        group: 'queue',
      }),
      item('beta', { ...COMPLETE, group: 'queue' }),
      item('gamma', COMPLETE),
    );
    const result = backlog(['pick', '--file', path, '--now', NOW]);

    assert.equal(result.code, 0);
    assert.equal((JSON.parse(result.stdout) as { slug: string }).slug, 'gamma');
    assert.equal(statusOf(path, 'beta'), 'pending');
  });

  it('отказывает, когда свободны только пункты занятой группы', () => {
    const path = fixture(
      item('alpha', {
        ...COMPLETE,
        status: 'in_progress',
        started_at: '2026-08-23T11:50:00.000Z',
        group: 'queue',
      }),
      item('beta', { ...COMPLETE, group: 'queue' }),
    );
    const before = readFileSync(path, 'utf8');
    const result = backlog(['pick', '--file', path, '--now', NOW]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /свободных пунктов/);
    assert.equal(readFileSync(path, 'utf8'), before);
  });

  it('завершённый пункт свою группу не держит', () => {
    for (const status of ['done', 'failed']) {
      const path = fixture(
        item('alpha', { ...COMPLETE, status, reason: 'п', group: 'queue' }),
        item('beta', { ...COMPLETE, group: 'queue' }),
      );
      const result = backlog(['pick', '--file', path, '--now', NOW]);

      assert.equal(result.code, 0, `status=${status}: ${result.stderr}`);
      assert.equal((JSON.parse(result.stdout) as { slug: string }).slug, 'beta');
    }
  });

  it('протухший пункт освобождает свою группу', () => {
    const path = fixture(
      item('alpha', {
        ...COMPLETE,
        status: 'in_progress',
        started_at: '2026-08-23T00:00:00.000Z',
        group: 'queue',
      }),
      item('beta', { ...COMPLETE, group: 'queue' }),
    );
    const result = backlog(['pick', '--file', path, '--now', NOW]);

    assert.equal(result.code, 0);
    assert.equal((JSON.parse(result.stdout) as { slug: string }).slug, 'alpha');
  });

  it('пропуск не меняет приоритет: пункт выбирается первым после освобождения группы', () => {
    const path = fixture(
      item('alpha', {
        ...COMPLETE,
        status: 'in_progress',
        started_at: '2026-08-23T11:50:00.000Z',
        group: 'queue',
      }),
      item('beta', { ...COMPLETE, group: 'queue' }),
      item('gamma', COMPLETE),
    );
    backlog(['pick', '--file', path, '--now', NOW]);
    backlog(['finish', 'alpha', '--file', path, '--status', 'done']);

    const result = backlog(['pick', '--file', path, '--now', NOW]);
    assert.equal(result.code, 0);
    assert.equal((JSON.parse(result.stdout) as { slug: string }).slug, 'beta');
  });
});

describe('выдача нескольких слотов', () => {
  const NOW = '2026-08-23T12:00:00.000Z';

  it('без --slots поведение прежнее: объект и один пункт', () => {
    const path = fixture(item('first-free', COMPLETE), item('second-free', COMPLETE));
    const result = backlog(['pick', '--file', path, '--now', NOW]);

    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout) as { slug: string };
    assert.equal(parsed.slug, 'first-free');
    assert.equal(statusOf(path, 'second-free'), 'pending');
  });

  it('трёх слотов на четырёх пунктах разных групп хватает на первые три', () => {
    const path = fixture(
      item('a', { ...COMPLETE, group: 'a' }),
      item('b', { ...COMPLETE, group: 'b' }),
      item('c', { ...COMPLETE, group: 'c' }),
      item('d', { ...COMPLETE, group: 'd' }),
    );
    const result = backlog(['pick', '--file', path, '--now', NOW, '--slots', '3']);

    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout) as readonly { slug: string }[];
    assert.deepEqual(
      parsed.map((entry) => entry.slug),
      ['a', 'b', 'c'],
    );
    assert.equal(statusOf(path, 'd'), 'pending');
  });

  it('смежные пункты одной группы не выдаются вместе', () => {
    const path = fixture(
      item('a', { ...COMPLETE, group: 'queue' }),
      item('b', { ...COMPLETE, group: 'queue' }),
      item('c', { ...COMPLETE, group: 'queue' }),
      item('d', { ...COMPLETE, group: 'other' }),
    );
    const result = backlog(['pick', '--file', path, '--now', NOW, '--slots', '3']);

    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout) as readonly { slug: string }[];
    assert.deepEqual(
      parsed.map((entry) => entry.slug),
      ['a', 'd'],
    );
  });

  it('частичная выдача завершается успешно', () => {
    const path = fixture(item('a', { ...COMPLETE, group: 'a' }), item('b', { ...COMPLETE, group: 'b' }));
    const result = backlog(['pick', '--file', path, '--now', NOW, '--slots', '3']);

    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout) as readonly { slug: string }[];
    assert.equal(parsed.length, 2);
  });

  it('пустая выдача отказывает и не меняет файл', () => {
    const path = fixture(item('done-item', { ...COMPLETE, status: 'done' }));
    const before = readFileSync(path, 'utf8');
    const result = backlog(['pick', '--file', path, '--now', NOW, '--slots', '3']);

    assert.equal(result.code, 1);
    assert.equal(readFileSync(path, 'utf8'), before);
  });

  it('--slots 1 даёт массив из одной записи', () => {
    const path = fixture(item('only-item', COMPLETE));
    const result = backlog(['pick', '--file', path, '--now', NOW, '--slots', '1']);

    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout) as readonly { slug: string }[];
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.slug, 'only-item');
  });

  it('некорректное число слотов отказывает без правки файла', () => {
    const path = fixture(item('only-item', COMPLETE));
    const before = readFileSync(path, 'utf8');

    for (const slots of ['0', '-1', '1.5', 'abc']) {
      const result = backlog(['pick', '--file', path, '--now', NOW, '--slots', slots]);
      assert.equal(result.code, 1, `slots=${slots}`);
    }
    assert.equal(readFileSync(path, 'utf8'), before);
  });

  it('каждая запись массива называет действующую группу пункта', () => {
    const path = fixture(
      item('a', { ...COMPLETE, group: 'queue' }),
      item('b', COMPLETE),
    );
    const result = backlog(['pick', '--file', path, '--now', NOW, '--slots', '2']);

    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout) as readonly { group: string }[];
    assert.deepEqual(
      parsed.map((entry) => entry.group),
      ['queue', 'b'],
    );
  });

  it('--out пишет тот же текст, что и stdout, в массивной форме', () => {
    const path = fixture(
      item('a', { ...COMPLETE, group: 'a' }),
      item('b', { ...COMPLETE, group: 'b' }),
    );
    const out = join(mkdtempSync(join(tmpdir(), 'stepcast-out-')), 'item.json');
    const result = backlog(['pick', '--file', path, '--now', NOW, '--slots', '2', '--out', out]);

    assert.equal(result.code, 0);
    assert.equal(readFileSync(out, 'utf8'), result.stdout);
  });

  it('всем выданным пунктам проставляется одна метка started_at', () => {
    const path = fixture(
      item('a', { ...COMPLETE, group: 'a' }),
      item('b', { ...COMPLETE, group: 'b' }),
    );
    const result = backlog(['pick', '--file', path, '--now', NOW, '--slots', '2']);

    assert.equal(result.code, 0);
    assert.equal(fieldOf(path, 'a', 'started_at'), NOW);
    assert.equal(fieldOf(path, 'b', 'started_at'), NOW);
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

  // Спека pipeline-lanes: «Защита проставленного исхода»
  it('finish на уже done ничего не перезаписывает и завершается кодом 0', () => {
    const path = fixture(item('some-item', { ...COMPLETE, status: 'done' }));
    const before = readFileSync(path, 'utf8');
    const result = backlog(['finish', 'some-item', '--file', path, '--status', 'failed', '--reason', 'поздно']);

    assert.equal(result.code, 0);
    assert.equal(readFileSync(path, 'utf8'), before);
  });

  it('finish на уже failed ничего не перезаписывает и завершается кодом 0', () => {
    const path = fixture(item('some-item', { ...COMPLETE, status: 'failed', reason: 'прежняя причина' }));
    const before = readFileSync(path, 'utf8');
    const result = backlog(['finish', 'some-item', '--file', path, '--status', 'done']);

    assert.equal(result.code, 0);
    assert.equal(readFileSync(path, 'utf8'), before);
  });
});

describe('выдача слотов по дорожкам', () => {
  const NOW = '2026-08-23T12:00:00.000Z';

  it('раздаёт по одному пункту на дорожку в порядке дорожек', () => {
    const path = fixture(
      item('a', { ...COMPLETE, group: 'a' }),
      item('b', { ...COMPLETE, group: 'b' }),
    );
    const result = backlog(['pick', '--file', path, '--now', NOW, '--lanes', 'a-lane,b-lane']);

    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout) as {
      lanes: Record<string, { filled: boolean; slug: string }>;
    };
    assert.equal(parsed.lanes['a-lane']?.filled, true);
    assert.equal(parsed.lanes['a-lane']?.slug, 'a');
    assert.equal(parsed.lanes['b-lane']?.filled, true);
    assert.equal(parsed.lanes['b-lane']?.slug, 'b');
    assert.equal(statusOf(path, 'a'), 'in_progress');
    assert.equal(statusOf(path, 'b'), 'in_progress');
  });

  it('дорожка без подходящего пункта получает пустые значения полей', () => {
    const path = fixture(item('a', { ...COMPLETE, group: 'a' }));
    const result = backlog(['pick', '--file', path, '--now', NOW, '--lanes', 'a-lane,b-lane']);

    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout) as {
      lanes: Record<string, { filled: boolean; slug: string; title: string; group: string; item: unknown }>;
    };
    assert.equal(parsed.lanes['a-lane']?.filled, true);
    assert.equal(parsed.lanes['b-lane']?.filled, false);
    assert.equal(parsed.lanes['b-lane']?.slug, '');
    assert.equal(parsed.lanes['b-lane']?.title, '');
    assert.equal(parsed.lanes['b-lane']?.group, '');
    assert.equal(parsed.lanes['b-lane']?.item, null);
  });

  it('отсутствие подходящих пунктов не отказывает: все дорожки пустые', () => {
    const path = fixture(item('a', { ...COMPLETE, status: 'done' }));
    const before = readFileSync(path, 'utf8');
    const result = backlog(['pick', '--file', path, '--now', NOW, '--lanes', 'a-lane,b-lane']);

    assert.equal(result.code, 0);
    assert.equal(readFileSync(path, 'utf8'), before);
    const parsed = JSON.parse(result.stdout) as { lanes: Record<string, { filled: boolean }> };
    assert.equal(parsed.lanes['a-lane']?.filled, false);
    assert.equal(parsed.lanes['b-lane']?.filled, false);
  });

  it('отказывает на некорректном перечне дорожек и не трогает файл', () => {
    const path = fixture(item('a', COMPLETE));
    const before = readFileSync(path, 'utf8');

    for (const lanes of ['', 'a-lane,a-lane', 'Дорожка A', 'a-lane,']) {
      const result = backlog(['pick', '--file', path, '--now', NOW, '--lanes', lanes]);
      assert.equal(result.code, 1, `lanes=${lanes}`);
    }
    assert.equal(readFileSync(path, 'utf8'), before);
  });

  it('пишет пункт каждой занятой дорожки файлом item-<дорожка>.json в каталог прогона', () => {
    const path = fixture(
      item('a', { ...COMPLETE, group: 'a' }),
      item('b', { ...COMPLETE, group: 'b' }),
    );
    const runDir = mkdtempSync(join(tmpdir(), 'stepcast-rundir-'));
    const result = backlog(['pick', '--file', path, '--now', NOW, '--lanes', 'a-lane,b-lane', '--run-dir', runDir]);

    assert.equal(result.code, 0);
    const itemA = JSON.parse(readFileSync(join(runDir, 'item-a-lane.json'), 'utf8')) as { slug: string };
    const itemB = JSON.parse(readFileSync(join(runDir, 'item-b-lane.json'), 'utf8')) as { slug: string };
    assert.equal(itemA.slug, 'a');
    assert.equal(itemB.slug, 'b');
  });

  it('общая метка started_at у всех занятых дорожек', () => {
    const path = fixture(
      item('a', { ...COMPLETE, group: 'a' }),
      item('b', { ...COMPLETE, group: 'b' }),
    );
    const result = backlog(['pick', '--file', path, '--now', NOW, '--lanes', 'a-lane,b-lane']);

    assert.equal(result.code, 0);
    assert.equal(fieldOf(path, 'a', 'started_at'), NOW);
    assert.equal(fieldOf(path, 'b', 'started_at'), NOW);
  });
});
