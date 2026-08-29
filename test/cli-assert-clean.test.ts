import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, it } from 'node:test';

import { run as runCli, type CliIo } from '../src/cli/main.js';
import { ExitCode, type ExitCodeValue } from '../src/core/errors.js';
import { gitCommit, gitInit, withHome } from './helpers.js';

/**
 * `stepcast assert-clean` не зависит от каталога прогона и ничего не
 * коммитит — проверки идут `run(argv, io)` на настоящем git-дереве, с
 * фальшивым `HOME` (`withHome`), чтобы не подхватить настоящий
 * `~/.stepcast/config.yml` гоняющей машины.
 */

interface Result {
  readonly code: ExitCodeValue;
  readonly stdout: string;
  readonly stderr: string;
}

async function assertClean(cwd: string, home: string, argv: readonly string[] = []): Promise<Result> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    cwd,
  };
  const code = await withHome(home, () => runCli(['assert-clean', ...argv], io));
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'stepcast-assert-clean-home-'));
  mkdirSync(join(home, '.stepcast'), { recursive: true });
  return home;
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stepcast-assert-clean-'));
  gitInit(dir);
  writeFileSync(join(dir, 'seed.txt'), 'затравка\n');
  gitCommit(dir, 'первый');
  return dir;
}

/**
 * Многорепный проект: корень с закоммиченными `.gitignore`, `.stepcast/config.yml`
 * (объявляющим состав) и отслеживаемым каталогом `docs/`, плюс вложенный
 * репозиторий `backend`, который корень игнорирует. Корень и вложенный чисты —
 * грязь наводит каждый тест свою, и она не смешивается с шумом стенда.
 */
function makeNestedProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stepcast-assert-clean-nested-'));
  gitInit(dir);
  writeFileSync(join(dir, '.gitignore'), 'backend/\n');
  writeFileSync(join(dir, 'seed.txt'), 'затравка\n');
  mkdirSync(join(dir, '.stepcast'), { recursive: true });
  writeFileSync(join(dir, '.stepcast', 'config.yml'), 'project:\n  nested_repos: [backend]\n');
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'guide.md'), 'документ\n');
  gitCommit(dir, 'первый');

  const nestedDir = join(dir, 'backend');
  mkdirSync(nestedDir);
  gitInit(nestedDir);
  writeFileSync(join(nestedDir, 'seed.txt'), 'затравка backend\n');
  gitCommit(nestedDir, 'первый backend');

  return dir;
}

function headOf(dir: string): string {
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

describe('CLI: stepcast assert-clean', () => {
  it('чистое дерево — код 0', async () => {
    const dir = makeRepo();
    const out = await assertClean(dir, makeHome());
    assert.equal(out.code, ExitCode.ok, out.stderr);
  });

  it('грязное дерево — код 2, называя дерево', async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'seed.txt'), 'правка\n');

    const out = await assertClean(dir, makeHome());
    assert.equal(out.code, ExitCode.configError);
    assert.match(out.stderr, /не чисто/);
    // Состав не объявлен, деревьев ровно одно — его называет строка «где».
    assert.match(out.stderr, new RegExp(`где:.*${basename(dir)}`));
  });

  it('чистый многорепный проект — код 0', async () => {
    const out = await assertClean(makeNestedProject(), makeHome());
    assert.equal(out.code, ExitCode.ok, out.stderr);
  });

  it('грязный вложенный репозиторий при чистом корне — код 2, называя каталог', async () => {
    const dir = makeNestedProject();
    writeFileSync(join(dir, 'backend', 'seed.txt'), 'правка backend\n');

    const out = await assertClean(dir, makeHome());
    assert.equal(out.code, ExitCode.configError);
    assert.match(out.stderr, /backend/);
  });

  it('при объявленном составе грязный корень назван словом «корень»', async () => {
    const dir = makeNestedProject();
    writeFileSync(join(dir, 'seed.txt'), 'правка корня\n');

    const out = await assertClean(dir, makeHome());
    assert.equal(out.code, ExitCode.configError);
    assert.match(out.stderr, /корень/);
  });

  /**
   * Проектный конфиг ищется ровно в переданном каталоге, а пути состава
   * объявлены от корня дерева: считай команда каталог запуска корнем — из
   * подкаталога она не прочла бы состав вовсе и ответила бы «чисто» на
   * грязный вложенный. Тишина здесь неотличима от чистоты.
   */
  it('вызов из подкаталога отвечает то же, что из корня', async () => {
    const dir = makeNestedProject();
    writeFileSync(join(dir, 'backend', 'seed.txt'), 'правка backend\n');
    const subdir = join(dir, 'docs');
    mkdirSync(subdir, { recursive: true });

    const out = await assertClean(subdir, makeHome());
    assert.equal(out.code, ExitCode.configError);
    assert.match(out.stderr, /backend/);
  });

  it('--allow из подкаталога считается от каталога запуска', async () => {
    const dir = makeNestedProject();
    const subdir = join(dir, 'docs');
    mkdirSync(subdir, { recursive: true });
    writeFileSync(join(subdir, 'backlog.md'), 'очередь\n');

    const forgiven = await assertClean(subdir, makeHome(), ['--allow', 'backlog.md']);
    assert.equal(forgiven.code, ExitCode.ok, forgiven.stderr);

    const strict = await assertClean(subdir, makeHome());
    assert.equal(strict.code, ExitCode.configError, 'без --allow тот же файл чистоту нарушает');
  });

  it('--allow прощает названный файл в его дереве', async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'backlog.md'), 'очередь\n');
    gitCommit(dir, 'очередь');
    writeFileSync(join(dir, 'backlog.md'), 'очередь: in_progress\n');

    const out = await assertClean(dir, makeHome(), ['--allow', 'backlog.md']);
    assert.equal(out.code, ExitCode.ok, out.stderr);
  });

  it('проверка ничего не изменила: файлы на месте, HEAD не двинулся', async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'seed.txt'), 'правка\n');
    writeFileSync(join(dir, 'новый.txt'), 'новое\n');
    const before = headOf(dir);

    await assertClean(dir, makeHome());

    assert.equal(headOf(dir), before);
    assert.equal(readFileSync(join(dir, 'seed.txt'), 'utf8'), 'правка\n');
    assert.equal(readFileSync(join(dir, 'новый.txt'), 'utf8'), 'новое\n');
  });

  it('вне репозитория git — код 2, называя причину', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stepcast-assert-clean-notgit-'));
    const out = await assertClean(dir, makeHome());
    assert.equal(out.code, ExitCode.configError);
    assert.match(out.stderr, /не является репозиторием git/);
  });
});
