import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { run, type CliIo } from '../src/cli/main.js';
import { ExitCode, type ExitCodeValue } from '../src/core/errors.js';
import { gitInit, withHome } from './helpers.js';
import { tempDir } from './tmp.js';

/**
 * Команда работает в любом каталоге репозитория, объявившего источник, и
 * прогона не требует: половина ценности памяти — именно гейт и чтение вне
 * пайплайна.
 */

interface Result {
  readonly code: ExitCodeValue;
  readonly stdout: string;
  readonly stderr: string;
}

const CONFIG = 'project:\n  knowledge:\n    provider: fs\n    dir: knowledge\n';

function sandbox(files: Readonly<Record<string, string>> = {}): { root: string; home: string } {
  const base = tempDir('cli-knowledge-');
  const root = join(base, 'work');
  const home = join(base, 'home');
  mkdirSync(join(home, '.stepcast'), { recursive: true });
  mkdirSync(root, { recursive: true });
  gitInit(root);

  for (const [name, content] of Object.entries({ '.stepcast/config.yml': CONFIG, ...files })) {
    const full = join(root, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  return { root, home };
}

async function knowledge(
  box: { root: string; home: string },
  argv: readonly string[],
): Promise<Result> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    cwd: box.root,
  };
  const code = await withHome(box.home, () => run(['knowledge', ...argv], io));
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

function unit(id: string, title: string, extra = ''): string {
  return `---\nid: ${id}\ntitle: ${title}\nscope:\n  - src/**\n${extra}status: active\n---\n\nТело ${id}.\n`;
}

describe('CLI: stepcast knowledge', () => {
  // Задача 5.3 / Сценарий: «Оглавление в терминале»
  it('index печатает заголовки без тел', async () => {
    const box = sandbox({ 'knowledge/a.md': unit('a', 'Первая') });

    const result = await knowledge(box, ['index']);

    assert.equal(result.code, ExitCode.ok);
    assert.match(result.stdout, /a — Первая/);
    assert.doesNotMatch(result.stdout, /Тело a/);
  });

  it('index --json отдаёт ответ источника как есть', async () => {
    const box = sandbox({ 'knowledge/a.md': unit('a', 'Первая') });

    const result = await knowledge(box, ['index', '--json']);

    assert.equal(result.code, ExitCode.ok);
    assert.deepEqual(JSON.parse(result.stdout).entries[0].id, 'a');
  });

  it('select --scope печатает тела отобранного', async () => {
    const box = sandbox({ 'knowledge/a.md': unit('a', 'Первая') });

    const result = await knowledge(box, ['select', '--scope', 'src/**']);

    assert.equal(result.code, ExitCode.ok);
    assert.match(result.stdout, /Тело a/);
  });

  it('select требует ровно одного из --scope и --id', async () => {
    const box = sandbox({ 'knowledge/a.md': unit('a', 'Первая') });

    assert.equal((await knowledge(box, ['select'])).code, ExitCode.configError);
    assert.equal(
      (await knowledge(box, ['select', '--scope', 'src/**', '--id', 'a'])).code,
      ExitCode.configError,
    );
  });

  // Задача 5.3 / Сценарий: «Проверка гейтом репозитория»
  it('check возвращает ноль на целой памяти', async () => {
    const box = sandbox({ 'knowledge/a.md': unit('a', 'Первая') });

    const result = await knowledge(box, ['check']);

    assert.equal(result.code, ExitCode.ok);
    assert.match(result.stdout, /Память цела/);
  });

  it('check возвращает ненулевой код на красном нарушении и перечисляет его', async () => {
    const box = sandbox({
      'knowledge/a.md': unit('a', 'Первая', 'anchors:\n  - path: src/нет.ts\n    rev: abc1234\n'),
    });

    const result = await knowledge(box, ['check']);

    assert.notEqual(result.code, ExitCode.ok);
    assert.match(result.stdout, /красное/);
    assert.match(result.stdout, /missing-anchor/);
  });

  it('жёлтое нарушение кода возврата не меняет', async () => {
    const box = sandbox({
      'knowledge/a.md': unit('a', 'Одно и то же', ''),
      'knowledge/b.md': unit('b', 'Одно и то же', ''),
    });

    const result = await knowledge(box, ['check']);

    assert.equal(result.code, ExitCode.ok);
    assert.match(result.stdout, /жёлтое/);
  });

  it('write создаёт единицу из описания на стандартном вводе', async () => {
    const box = sandbox();
    const request = join(box.root, 'unit.json');
    writeFileSync(
      request,
      JSON.stringify({ id: 'a', title: 'Первая', scope: ['src/**'], anchors: [], body: 'Тело.' }),
    );

    const result = await knowledge(box, ['write', '--file', request]);

    assert.equal(result.code, ExitCode.ok);
    assert.match(result.stdout, /knowledge\/a\.md/);
    assert.match((await knowledge(box, ['index'])).stdout, /a — Первая/);
  });

  // Ревью: `--file -` отказывал бы разбором аргументов (значение с ведущим
  // дефисом принимается только слитной формой), поэтому чтение ввода — свой
  // ключ, а не соглашение о дефисе.
  it('write требует ровно одного из --file и --stdin', async () => {
    const box = sandbox();

    assert.equal((await knowledge(box, ['write'])).code, ExitCode.configError);
    assert.equal(
      (await knowledge(box, ['write', '--file', 'unit.json', '--stdin'])).code,
      ExitCode.configError,
    );
  });

  // Ревью: отмена единицы — две записи разом, и без списка вторая могла бы
  // не случиться.
  it('write принимает список описаний и пишет их все', async () => {
    const box = sandbox();
    const request = join(box.root, 'units.json');
    writeFileSync(
      request,
      JSON.stringify([
        { id: 'one', title: 'Первая', scope: ['src/**'], anchors: [], body: 'Т.' },
        { id: 'two', title: 'Вторая', scope: ['src/**'], anchors: [], body: 'Т.' },
      ]),
    );

    const result = await knowledge(box, ['write', '--file', request]);

    assert.equal(result.code, ExitCode.ok);
    const index = (await knowledge(box, ['index'])).stdout;
    assert.match(index, /one — Первая/);
    assert.match(index, /two — Вторая/);
  });

  it('write отклоняет идентификатор, который является путём', async () => {
    const box = sandbox();
    const request = join(box.root, 'unit.json');
    writeFileSync(
      request,
      JSON.stringify({ id: '../../x', title: 'т', scope: [], anchors: [], body: 'т' }),
    );

    const result = await knowledge(box, ['write', '--file', request]);

    assert.equal(result.code, ExitCode.configError);
    assert.match(result.stderr, /Идентификатор состоит из/);
  });

  // Задача 5.3: практика не объявлена — внятный отказ, а не пустой вывод.
  it('отказывает, когда практика памяти не объявлена', async () => {
    const base = tempDir('cli-knowledge-none-');
    const root = join(base, 'work');
    const home = join(base, 'home');
    mkdirSync(join(home, '.stepcast'), { recursive: true });
    mkdirSync(root, { recursive: true });

    const result = await knowledge({ root, home }, ['index']);

    assert.equal(result.code, ExitCode.configError);
    assert.match(result.stderr, /Практика памяти не объявлена/);
  });

  it('отклоняет неизвестную подкоманду', async () => {
    const box = sandbox();
    const result = await knowledge(box, ['refresh']);
    assert.equal(result.code, ExitCode.configError);
  });
});

describe('CLI: stepcast knowledge check --publish', () => {
  const OVERFLOWING_CONFIG =
    'project:\n  knowledge:\n    provider: fs\n    dir: knowledge\n    index_max_tokens: 10\n';

  /** Каталог работы с объявлением — тот же вид, что заводит движок до первого шага. */
  function jobDirWithDeclaration(declared: readonly string[]): string {
    const dir = tempDir('knowledge-jobdir-');
    writeFileSync(join(dir, 'resolved.json'), JSON.stringify({ id: 'knowledge-room', data: declared }));
    return dir;
  }

  /** Позвать knowledge с заданным (или отсутствующим) STEPCAST_JOB_DIR, восстановив окружение после. */
  async function knowledgeAsStep(
    box: { root: string; home: string },
    argv: readonly string[],
    jobDir: string | undefined,
  ): Promise<Result> {
    const previous = process.env['STEPCAST_JOB_DIR'];
    if (jobDir === undefined) delete process.env['STEPCAST_JOB_DIR'];
    else process.env['STEPCAST_JOB_DIR'] = jobDir;
    try {
      return await knowledge(box, argv);
    } finally {
      if (previous === undefined) delete process.env['STEPCAST_JOB_DIR'];
      else process.env['STEPCAST_JOB_DIR'] = previous;
    }
  }

  // Задача 5.4 / Сценарий: «Переполнение публикуется истиной»
  it('публикует true на переполненном оглавлении', async () => {
    const box = sandbox({
      'knowledge/a.md': unit('a', 'Очень длинный заголовок'.repeat(20)),
      '.stepcast/config.yml': OVERFLOWING_CONFIG,
    });
    const jobDir = jobDirWithDeclaration(['index_full']);

    const result = await knowledgeAsStep(box, ['check', '--publish', 'index_full'], jobDir);

    assert.equal(result.code, ExitCode.ok);
    const data = JSON.parse(readFileSync(join(jobDir, 'data.json'), 'utf8')) as Record<string, string>;
    assert.equal(data['index_full'], 'true');
  });

  it('публикует false на укладывающемся оглавлении', async () => {
    const box = sandbox({ 'knowledge/a.md': unit('a', 'Первая') });
    const jobDir = jobDirWithDeclaration(['index_full']);

    const result = await knowledgeAsStep(box, ['check', '--publish', 'index_full'], jobDir);

    assert.equal(result.code, ExitCode.ok);
    const data = JSON.parse(readFileSync(join(jobDir, 'data.json'), 'utf8')) as Record<string, string>;
    assert.equal(data['index_full'], 'false');
  });

  // Задача 5.4 / Сценарий: «Необъявленный ключ — отказ команды»
  it('необъявленный ключ отказывает командой, называя работу и ключ', async () => {
    const box = sandbox({ 'knowledge/a.md': unit('a', 'Первая') });
    const jobDir = jobDirWithDeclaration([]);

    const result = await knowledgeAsStep(box, ['check', '--publish', 'index_full'], jobDir);

    assert.notEqual(result.code, ExitCode.ok);
    assert.match(result.stderr, /knowledge-room/);
    assert.match(result.stderr, /index_full/);
    assert.equal(existsSync(join(jobDir, 'data.json')), false);
  });

  // Задача 5.4 / Сценарий: «Вне шага прогона»
  it('вне шага прогона отказывает до вызова check', async () => {
    const box = sandbox({ 'knowledge/a.md': unit('a', 'Первая') });

    const result = await knowledgeAsStep(box, ['check', '--publish', 'index_full'], undefined);

    assert.notEqual(result.code, ExitCode.ok);
    assert.match(result.stderr, /шага прогона/);
  });

  it('код возврата check без --publish не меняется на переполненном оглавлении', async () => {
    const box = sandbox({
      'knowledge/a.md': unit('a', 'Очень длинный заголовок'.repeat(20)),
      '.stepcast/config.yml': OVERFLOWING_CONFIG,
    });

    const result = await knowledge(box, ['check']);

    assert.equal(result.code, ExitCode.ok);
    assert.match(result.stdout, /жёлтое/);
  });
});
