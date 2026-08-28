import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { evaluateLane, knownLanes } from '../src/core/lanes/lanes.js';
import { assertCleanTree, commitAll, currentCommit, resetToCommit } from '../src/core/lanes/tree.js';
import { runCheck } from '../src/core/lanes/check.js';
import { hasLaneItem, readLaneItem, takenLanes } from '../src/core/lanes/item.js';
import { StepcastError } from '../src/core/errors.js';
import type { JobRecord } from '../src/core/journal/schema.js';
import { gitCommit, gitInit } from './helpers.js';

/**
 * Юнит-тесты примитивов `src/core/lanes/`: годность дорожки (`lanes.ts`),
 * операции над деревом (`tree.ts`), исполнение проверки (`check.ts`) и чтение
 * файла пункта (`item.ts`). Обход целиком (`merge.ts`) проверяется на
 * настоящих прогонах в `test/merge-lanes.test.ts`.
 */

function job(id: string, lane: string, status: JobRecord['status']): JobRecord {
  return { id, lane, status, steps: [] };
}

describe('lanes: evaluateLane', () => {
  it('годна, когда все работы дорожки success — независимо от их имён', () => {
    const jobs = [job('шаг-раз', 'a', 'success'), job('произвольное-имя', 'a', 'success')];
    assert.deepEqual(evaluateLane(jobs, 'a'), { kind: 'ready' });
  });

  it('негодна по одной провалившейся работе, называя её и статус', () => {
    const jobs = [job('propose', 'a', 'success'), job('verify', 'a', 'failed')];
    const outcome = evaluateLane(jobs, 'a');
    assert.equal(outcome.kind, 'unfit');
    if (outcome.kind === 'unfit') {
      assert.deepEqual(outcome.jobs, [{ id: 'verify', status: 'failed' }]);
    }
  });

  it('смешанные success и skipped — негодна, а не незаполненный слот', () => {
    const jobs = [job('propose', 'a', 'success'), job('verify', 'a', 'skipped')];
    const outcome = evaluateLane(jobs, 'a');
    assert.equal(outcome.kind, 'unfit');
    if (outcome.kind === 'unfit') {
      assert.deepEqual(outcome.jobs, [{ id: 'verify', status: 'skipped' }]);
    }
  });

  it('все работы дорожки skipped — незаполненный слот', () => {
    const jobs = [job('propose', 'a', 'skipped'), job('verify', 'a', 'skipped')];
    assert.deepEqual(evaluateLane(jobs, 'a'), { kind: 'empty' });
  });

  it('неизвестная дорожка отказывает перечнем известных', () => {
    const jobs = [job('propose', 'a', 'success'), job('propose', 'b', 'success')];
    const outcome = evaluateLane(jobs, 'нет-такой');
    assert.equal(outcome.kind, 'unknown');
    if (outcome.kind === 'unknown') {
      assert.deepEqual([...outcome.known].sort(), ['a', 'b']);
    }
  });

  it('knownLanes перечисляет метки без повторов', () => {
    const jobs = [job('p1', 'a', 'success'), job('p2', 'a', 'success'), job('p3', 'b', 'success')];
    assert.deepEqual([...knownLanes(jobs)].sort(), ['a', 'b']);
  });
});

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stepcast-lanes-tree-'));
  gitInit(dir);
  writeFileSync(join(dir, 'seed.txt'), 'затравка\n');
  gitCommit(dir, 'первый');
  return dir;
}

describe('lanes: tree', () => {
  it('assertCleanTree принимает чистое дерево', () => {
    const dir = makeRepo();
    assert.doesNotThrow(() => assertCleanTree(dir));
  });

  it('assertCleanTree отказывает на незакоммиченной правке отслеживаемого файла', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'seed.txt'), 'правка\n');
    assert.throws(() => assertCleanTree(dir), StepcastError);
  });

  it('assertCleanTree отказывает на неотслеживаемом файле', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'новый.txt'), 'новое\n');
    assert.throws(() => assertCleanTree(dir), StepcastError);
  });

  it('assertCleanTree прощает правку названного учётного файла', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'backlog.md'), 'очередь\n');
    gitCommit(dir, 'очередь');
    writeFileSync(join(dir, 'backlog.md'), 'очередь: in_progress\n');

    assert.doesNotThrow(() => assertCleanTree(dir, { allow: ['backlog.md'] }));
    assert.doesNotThrow(() => assertCleanTree(dir, { allow: [join(dir, 'backlog.md')] }));
    assert.throws(() => assertCleanTree(dir), StepcastError, 'без allow правка по-прежнему отказывает');
  });

  it('assertCleanTree прощает неотслеживаемый учётный файл', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'backlog.md'), 'очередь\n');
    assert.doesNotThrow(() => assertCleanTree(dir, { allow: ['backlog.md'] }));
  });

  it('assertCleanTree прощает только названное, а не остальное дерево', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'backlog.md'), 'очередь\n');
    writeFileSync(join(dir, 'seed.txt'), 'правка агента\n');
    assert.throws(() => assertCleanTree(dir, { allow: ['backlog.md'] }), StepcastError);
  });

  it('assertCleanTree отказывает вне репозитория git', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stepcast-lanes-notgit-'));
    assert.throws(() => assertCleanTree(dir), StepcastError);
  });

  it('resetToCommit возвращает дерево к записанному коммиту и снимает неотслеживаемое', () => {
    const dir = makeRepo();
    const before = currentCommit(dir);

    writeFileSync(join(dir, 'seed.txt'), 'изменено дорожкой\n');
    writeFileSync(join(dir, 'новый-от-дорожки.txt'), 'от дорожки\n');
    commitAll(dir, 'дорожка a: пробный коммит');

    resetToCommit(dir, before);

    assert.equal(currentCommit(dir), before);
    assert.equal(existsSync(join(dir, 'новый-от-дорожки.txt')), false);
  });

  it('resetToCommit не трогает игнорируемые пути', () => {
    const dir = makeRepo();
    writeFileSync(join(dir, '.gitignore'), 'игнорируемое/\n');
    gitCommit(dir, 'добавлен .gitignore');
    const before = currentCommit(dir);

    mkdirSync(join(dir, 'игнорируемое'));
    writeFileSync(join(dir, 'игнорируемое', 'кеш.txt'), 'сборочный кеш\n');
    writeFileSync(join(dir, 'seed.txt'), 'изменено\n');
    commitAll(dir, 'дорожка a: пробный коммит');

    resetToCommit(dir, before);

    assert.ok(existsSync(join(dir, 'игнорируемое', 'кеш.txt')), 'игнорируемый путь должен пережить откат');
  });

  it('commitAll фиксирует одним коммитом всё дерево', () => {
    const dir = makeRepo();
    const before = Number(
      execFileSync('git', ['-C', dir, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim(),
    );
    writeFileSync(join(dir, 'a.txt'), 'от a\n');
    commitAll(dir, 'a-item: заголовок');
    const after = Number(
      execFileSync('git', ['-C', dir, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim(),
    );
    assert.equal(after, before + 1);
    const message = execFileSync('git', ['-C', dir, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim();
    assert.equal(message, 'a-item: заголовок');
  });
});

describe('lanes: check', () => {
  it('зелёная команда: exitCode 0, вывод захвачен', async () => {
    const result = await runCheck({ command: 'echo проверка-ок', cwd: process.cwd() });
    assert.equal(result.outcome, 'exited');
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /проверка-ок/);
  });

  it('красная команда: ненулевой код, stderr захвачен целиком', async () => {
    const result = await runCheck({ command: 'echo упало >&2; exit 3', cwd: process.cwd() });
    assert.equal(result.outcome, 'exited');
    assert.equal(result.exitCode, 3);
    assert.match(result.stderr, /упало/);
  });
});

describe('lanes: item', () => {
  it('readLaneItem читает слаг и заголовок', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stepcast-lanes-item-'));
    writeFileSync(join(dir, 'item-a.json'), JSON.stringify({ slug: 'a-item', title: 'Заголовок' }));
    assert.deepEqual(readLaneItem(dir, 'a'), { lane: 'a', slug: 'a-item', title: 'Заголовок' });
  });

  it('файл без слага — StepcastError с кодом ошибки конфигурации, называющий файл', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stepcast-lanes-item-'));
    const path = join(dir, 'item-a.json');
    writeFileSync(path, JSON.stringify({ title: 'без слага' }));
    assert.throws(() => readLaneItem(dir, 'a'), (error: unknown) => {
      assert.ok(error instanceof StepcastError);
      assert.equal(error.exitCode, 2);
      assert.equal(error.file, path);
      return true;
    });
  });

  it('hasLaneItem и takenLanes отражают реально существующие файлы', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stepcast-lanes-item-'));
    writeFileSync(join(dir, 'item-a.json'), JSON.stringify({ slug: 'a-item' }));
    assert.equal(hasLaneItem(dir, 'a'), true);
    assert.equal(hasLaneItem(dir, 'b'), false);
    assert.deepEqual([...takenLanes(dir)].sort(), ['a']);
  });

  it('takenLanes на несуществующем каталоге — пустой перечень', () => {
    assert.deepEqual(takenLanes(join(tmpdir(), 'stepcast-lanes-item-нет-такого')), []);
  });
});
