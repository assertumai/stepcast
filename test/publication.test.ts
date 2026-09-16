import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import {
  preparePublication,
  publishPrepared,
  rollbackPrepared,
} from '../src/parts/pipeline/domain/lanes/publication.js';
import { gitCommit, gitInit } from './helpers.js';
import { tempDir } from './tmp.js';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function repository(files: Readonly<Record<string, string>>): string {
  const dir = tempDir('publication-repo-');
  gitInit(dir);
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  gitCommit(dir, 'base');
  return dir;
}

function targetCommit(
  repoDir: string,
  edit: (worktree: string) => void,
): string {
  const worktree = tempDir('publication-target-');
  execFileSync('git', ['-C', repoDir, 'worktree', 'add', '--detach', '--quiet', worktree, 'HEAD']);
  try {
    edit(worktree);
    gitCommit(worktree, 'pipeline');
    return git(worktree, 'rev-parse', 'HEAD');
  } finally {
    execFileSync('git', ['-C', repoDir, 'worktree', 'remove', '--force', worktree]);
  }
}

describe('publication: результат поверх нечистого дерева без stash', () => {
  it('сохраняет staged, unstaged и untracked, объединяя непересекающиеся правки одного файла', () => {
    const repo = repository({
      'code.txt': 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n',
    });
    const base = git(repo, 'rev-parse', 'HEAD');
    const target = targetCommit(repo, (dir) => {
      writeFileSync(
        join(dir, 'code.txt'),
        'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\npipeline\n',
      );
      writeFileSync(join(dir, 'added-by-pipeline.txt'), 'pipeline\n');
    });

    writeFileSync(
      join(repo, 'code.txt'),
      'staged\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n',
    );
    git(repo, 'add', 'code.txt');
    writeFileSync(
      join(repo, 'code.txt'),
      'staged\nunstaged\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n',
    );
    writeFileSync(join(repo, 'draft.txt'), 'untracked\n');

    const stateDir = tempDir('publication-state-');
    const prepared = preparePublication({ repoDir: repo, base, target, stateDir, exclude: [] });
    publishPrepared({ repoDir: repo, prepared, stateDir });

    assert.equal(git(repo, 'rev-parse', 'HEAD'), target);
    assert.equal(
      readFileSync(join(repo, 'code.txt'), 'utf8'),
      'staged\nunstaged\nthree\nfour\nfive\nsix\nseven\neight\nnine\npipeline\n',
    );
    assert.equal(readFileSync(join(repo, 'added-by-pipeline.txt'), 'utf8'), 'pipeline\n');
    assert.equal(readFileSync(join(repo, 'draft.txt'), 'utf8'), 'untracked\n');
    assert.match(git(repo, 'status', '--porcelain'), /^MM code\.txt$/m);
    assert.match(git(repo, 'status', '--porcelain'), /^\?\? draft\.txt$/m);
    assert.match(git(repo, 'diff', '--cached', '--', 'code.txt'), /staged/);
    assert.match(git(repo, 'diff', '--', 'code.txt'), /unstaged/);
    assert.equal(git(repo, 'stash', 'list'), '');
  });

  it('при настоящем конфликте не меняет HEAD, индекс и байты рабочего дерева', () => {
    const repo = repository({ 'code.txt': 'base\n' });
    const base = git(repo, 'rev-parse', 'HEAD');
    const target = targetCommit(repo, (dir) => writeFileSync(join(dir, 'code.txt'), 'pipeline\n'));
    writeFileSync(join(repo, 'code.txt'), 'local\n');
    git(repo, 'add', 'code.txt');
    const beforeStatus = git(repo, 'status', '--porcelain');

    assert.throws(
      () => preparePublication({
        repoDir: repo,
        base,
        target,
        stateDir: tempDir('publication-state-'),
        exclude: [],
      }),
      /конфликт.*code\.txt/i,
    );

    assert.equal(git(repo, 'rev-parse', 'HEAD'), base);
    assert.equal(git(repo, 'status', '--porcelain'), beforeStatus);
    assert.equal(readFileSync(join(repo, 'code.txt'), 'utf8'), 'local\n');
    assert.equal(git(repo, 'stash', 'list'), '');
  });

  it('берёт объявленный live-файл из результата, не поглощая остальную локальную грязь', () => {
    const repo = repository({ 'backlog.md': 'todo\n', 'notes.txt': 'clean\n' });
    const base = git(repo, 'rev-parse', 'HEAD');
    const target = targetCommit(repo, (dir) => writeFileSync(join(dir, 'backlog.md'), 'done\n'));
    writeFileSync(join(repo, 'backlog.md'), 'in_progress\n');
    writeFileSync(join(repo, 'notes.txt'), 'local\n');

    const stateDir = tempDir('publication-state-');
    const prepared = preparePublication({
      repoDir: repo,
      base,
      target,
      stateDir,
      exclude: ['backlog.md'],
    });
    publishPrepared({ repoDir: repo, prepared, stateDir });

    assert.equal(readFileSync(join(repo, 'backlog.md'), 'utf8'), 'done\n');
    assert.equal(readFileSync(join(repo, 'notes.txt'), 'utf8'), 'local\n');
    assert.equal(git(repo, 'status', '--porcelain'), 'M notes.txt');
  });

  it('сохраняет удаление, исполняемый бит и изменение символической ссылки', () => {
    const repo = repository({ 'delete-me.txt': 'remove\n', 'script.sh': '#!/bin/sh\nexit 0\n', a: 'a\n', b: 'b\n' });
    symlinkSync('a', join(repo, 'pointer'));
    gitCommit(repo, 'symlink');
    const base = git(repo, 'rev-parse', 'HEAD');
    const target = targetCommit(repo, (dir) => writeFileSync(join(dir, 'pipeline.txt'), 'pipeline\n'));

    unlinkSync(join(repo, 'delete-me.txt'));
    git(repo, 'add', 'delete-me.txt');
    chmodSync(join(repo, 'script.sh'), 0o755);
    unlinkSync(join(repo, 'pointer'));
    symlinkSync('b', join(repo, 'pointer'));

    const stateDir = tempDir('publication-state-');
    const prepared = preparePublication({ repoDir: repo, base, target, stateDir, exclude: [] });
    publishPrepared({ repoDir: repo, prepared, stateDir });

    assert.equal(git(repo, 'status', '--porcelain').includes('D  delete-me.txt'), true);
    assert.equal(statSync(join(repo, 'script.sh')).mode & 0o111, 0o111);
    assert.equal(readlinkSync(join(repo, 'pointer')), 'b');
    assert.equal(readFileSync(join(repo, 'pipeline.txt'), 'utf8'), 'pipeline\n');
  });

  it('отказывает при гонке после preflight, не сдвигая ветку', () => {
    const repo = repository({ 'code.txt': 'base\n' });
    const base = git(repo, 'rev-parse', 'HEAD');
    const target = targetCommit(repo, (dir) => writeFileSync(join(dir, 'pipeline.txt'), 'pipeline\n'));
    const stateDir = tempDir('publication-state-');
    const prepared = preparePublication({ repoDir: repo, base, target, stateDir, exclude: [] });
    writeFileSync(join(repo, 'late.txt'), 'concurrent\n');

    assert.throws(
      () => publishPrepared({ repoDir: repo, prepared, stateDir }),
      /изменилось после проверки публикации/,
    );
    assert.equal(git(repo, 'rev-parse', 'HEAD'), base);
    assert.equal(readFileSync(join(repo, 'late.txt'), 'utf8'), 'concurrent\n');
  });

  it('обращает завершённую публикацию побайтово при отказе следующего репозитория', () => {
    const repo = repository({ 'code.txt': 'base\n', 'local.txt': 'base\n' });
    const base = git(repo, 'rev-parse', 'HEAD');
    const target = targetCommit(repo, (dir) => writeFileSync(join(dir, 'code.txt'), 'pipeline\n'));
    writeFileSync(join(repo, 'local.txt'), 'staged\n');
    git(repo, 'add', 'local.txt');
    writeFileSync(join(repo, 'local.txt'), 'staged and unstaged\n');
    writeFileSync(join(repo, 'draft.txt'), 'untracked\n');
    const beforeStatus = git(repo, 'status', '--porcelain');

    const stateDir = tempDir('publication-state-');
    const prepared = preparePublication({ repoDir: repo, base, target, stateDir, exclude: [] });
    publishPrepared({ repoDir: repo, prepared, stateDir });
    rollbackPrepared({ repoDir: repo, prepared, stateDir });

    assert.equal(git(repo, 'rev-parse', 'HEAD'), base);
    assert.equal(git(repo, 'status', '--porcelain'), beforeStatus);
    assert.equal(readFileSync(join(repo, 'code.txt'), 'utf8'), 'base\n');
    assert.equal(readFileSync(join(repo, 'local.txt'), 'utf8'), 'staged and unstaged\n');
    assert.equal(readFileSync(join(repo, 'draft.txt'), 'utf8'), 'untracked\n');
  });
});
