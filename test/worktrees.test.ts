import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { StepcastError } from '../src/core/errors.js';
import { addWorktree, removeWorktree } from '../src/core/run/worktrees.js';

/**
 * Стенд: репозиторий с одним коммитом и каталог прогона рядом с ним — вне
 * репозитория, как того требует правило «директория прогона лежит вне
 * рабочего дерева». Рабочие деревья заводятся внутрь этого каталога.
 */
function bed(): { readonly repoDir: string; readonly runDir: string } {
  const base = mkdtempSync(join(tmpdir(), 'stepcast-worktrees-'));
  const repoDir = join(base, 'repo');
  const runDir = join(base, 'run');
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(runDir, { recursive: true });

  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', repoDir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  };
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Тест');
  writeFileSync(join(repoDir, 'a.txt'), 'начало\n');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'первый');

  return { repoDir, runDir };
}

function worktreeNames(repoDir: string): string[] {
  try {
    return readdirSync(join(repoDir, '.git', 'worktrees'));
  } catch {
    return [];
  }
}

describe('run-worktrees: заведение', () => {
  it('заводит каталог и делает его рабочим деревом репозитория, отделённым от HEAD', () => {
    const { repoDir, runDir } = bed();
    const path = join(runDir, 'work');

    addWorktree({ repoDir, path });

    assert.ok(existsSync(join(path, 'a.txt')));
    const toplevel = execFileSync('git', ['-C', path, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
    assert.equal(realpathSync(toplevel), realpathSync(path));
    // `symbolic-ref` отказывает (статус 1) на отделённом HEAD — само отклонение и есть проверка.
    assert.throws(() =>
      execFileSync('git', ['-C', path, 'symbolic-ref', '-q', 'HEAD'], { stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  });

  it('заводит родительский каталог, которого ещё не было', () => {
    const { repoDir, runDir } = bed();
    const path = join(runDir, 'workspace', 'job-1');

    addWorktree({ repoDir, path });

    assert.ok(existsSync(join(path, 'a.txt')));
  });
});

describe('run-worktrees: адресное снятие', () => {
  it('снимает и каталог, и учётную запись', () => {
    const { repoDir, runDir } = bed();
    const path = join(runDir, 'work');
    addWorktree({ repoDir, path });
    assert.equal(worktreeNames(repoDir).length, 1);

    const outcome = removeWorktree({ repoDir, path, runDir });

    assert.equal(outcome.kind, 'removed');
    assert.equal(existsSync(path), false);
    assert.equal(worktreeNames(repoDir).length, 0);
  });

  // Резервный путь: `git worktree remove` отказывает (запись заблокирована),
  // каталог сносится средствами файловой системы, а запись находится в самом
  // репозитории по пути дерева, которое она называет.
  it('при отказе git worktree remove снимает запись, найденную в репозитории по пути', () => {
    const { repoDir, runDir } = bed();
    const path = join(runDir, 'work');
    addWorktree({ repoDir, path });
    execFileSync('git', ['-C', repoDir, 'worktree', 'lock', path], { stdio: ['ignore', 'pipe', 'pipe'] });

    const outcome = removeWorktree({ repoDir, path, runDir });

    assert.equal(outcome.kind, 'removed');
    assert.equal(existsSync(path), false);
    assert.equal(worktreeNames(repoDir).length, 0);
  });

  it('снятие уже снесённого мимо движка каталога тоже убирает его запись', () => {
    const { repoDir, runDir } = bed();
    const path = join(runDir, 'work');
    addWorktree({ repoDir, path });

    // Каталог снесён напрямую, как если бы это сделал человек, а не движок.
    execFileSync('rm', ['-rf', path]);

    const outcome = removeWorktree({ repoDir, path, runDir });

    assert.equal(outcome.kind, 'removed');
    assert.equal(worktreeNames(repoDir).length, 0);
  });

  // Повторная уборка того же прогона (`gc --older-than` вторым заходом, а
  // следом удаление того же прогона витриной) приходит сюда, когда снимать
  // уже нечего: `git worktree remove` отказывает «is not a working tree».
  // Несуществующая запись — не утечка, и называть её неснятой нельзя: канал
  // «неснятая запись» перестал бы быть сигналом.
  it('повторное снятие уже снятого дерева не выдаёт неснятую запись', () => {
    const { repoDir, runDir } = bed();
    const path = join(runDir, 'work');
    addWorktree({ repoDir, path });
    assert.equal(removeWorktree({ repoDir, path, runDir }).kind, 'removed');

    const outcome = removeWorktree({ repoDir, path, runDir });

    assert.equal(outcome.kind, 'removed');
    assert.equal(worktreeNames(repoDir).length, 0);
  });

  // Запись репозитория, у которого не спросить (репозиторий части исчез
  // вместе с ней), — единственный случай, когда снятие честно не знает, что
  // осталось, и говорит об этом.
  it('репозиторий, которого нет, даёт неснятую запись с названной причиной', () => {
    const { runDir } = bed();
    const path = join(runDir, 'work');
    mkdirSync(path, { recursive: true });

    const outcome = removeWorktree({ repoDir: join(runDir, 'нет-такого'), path, runDir });

    assert.equal(outcome.kind, 'record_kept');
    assert.match(outcome.kind === 'record_kept' ? outcome.reason : '', /не отвечает/);
    assert.equal(existsSync(path), false, 'каталог всё равно снят');
  });

  // Дерево, снесённое с диска вместе с объемлющим каталогом (снятие
  // объемлющего рабочего дерева уносит и вложенное), — запись всё равно
  // находится в репозитории по пути.
  it('снимает запись дерева, каталог которого унесён вместе с объемлющим', () => {
    const { repoDir, runDir } = bed();
    const outer = join(runDir, 'work');
    const inner = join(outer, 'часть');
    const innerRepo = bed().repoDir;
    addWorktree({ repoDir, path: outer });
    addWorktree({ repoDir: innerRepo, path: inner });
    assert.equal(worktreeNames(innerRepo).length, 1);

    // Объемлющее снято первым — каталог вложенного ушёл вместе с ним.
    assert.equal(removeWorktree({ repoDir, path: outer, runDir }).kind, 'removed');
    assert.equal(existsSync(inner), false);

    const outcome = removeWorktree({ repoDir: innerRepo, path: inner, runDir });

    assert.equal(outcome.kind, 'removed');
    assert.equal(worktreeNames(innerRepo).length, 0, 'запись вложенного дерева не должна остаться');
  });

  it('отказывает StepcastError на пути вне директории прогона и не трогает каталог', () => {
    const { repoDir, runDir } = bed();
    // Путь — само рабочее дерево проекта, а не что-то внутри runDir.
    const outsidePath = repoDir;

    assert.throws(
      () => removeWorktree({ repoDir, path: outsidePath, runDir }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /вне директории прогона/);
        return true;
      },
    );
    assert.ok(existsSync(join(outsidePath, 'a.txt')), 'репозиторий должен остаться нетронутым');
  });

  it('чужая запись того же репозитория переживает снятие названной', () => {
    const { repoDir, runDir } = bed();
    const first = join(runDir, 'first');
    const second = join(runDir, 'second');
    addWorktree({ repoDir, path: first });
    addWorktree({ repoDir, path: second });
    assert.equal(worktreeNames(repoDir).length, 2);

    const outcome = removeWorktree({ repoDir, path: first, runDir });

    assert.equal(outcome.kind, 'removed');
    assert.equal(existsSync(first), false);
    assert.ok(existsSync(second), 'соседнее дерево должно остаться на месте');
    assert.equal(worktreeNames(repoDir).length, 1);
  });
});
