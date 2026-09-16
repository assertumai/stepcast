import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createGitAnchorer } from '../anchor/git.js';
import { StepcastError } from '../../../../kernel/errors.js';
import { addWorktree, removeWorktree } from '../../run/worktrees.js';

/** Подготовленный перенос локального слоя поверх коммита результата. */
export interface PreparedPublication {
  readonly base: string;
  readonly target: string;
  /** Итоговый индекс после переноса staged-слоя на target. */
  readonly indexTree: string;
  /** Итоговое видимое дерево после переноса staged и unstaged слоёв. */
  readonly worktreeTree: string;
  readonly changedPaths: readonly string[];
  readonly fingerprint: string;
  /** Исходное состояние нужно для повторной проверки и аварийного возврата. */
  readonly sourceHead: string;
  readonly sourceIndexTree: string;
  readonly sourceWorktreeTree: string;
}

interface GitOptions {
  readonly indexFile?: string;
  readonly input?: string;
}

function git(dir: string, args: readonly string[], options: GitOptions = {}): string {
  return execFileSync('git', ['-C', dir, '-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    ...(options.input === undefined ? {} : { input: options.input }),
    env: {
      ...process.env,
      ...(options.indexFile === undefined ? {} : { GIT_INDEX_FILE: options.indexFile }),
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'Stepcast',
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'stepcast@localhost',
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? 'Stepcast',
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? 'stepcast@localhost',
    },
  });
}

function oid(dir: string, expression: string): string {
  return git(dir, ['rev-parse', expression]).trim();
}

function pathsBetween(dir: string, from: string, to: string): string[] {
  if (from === to) return [];
  return git(dir, ['diff-tree', '-r', '--name-only', '--no-commit-id', '-z', from, to])
    .split('\0')
    .filter((path) => path !== '');
}

function fingerprint(state: { readonly head: string; readonly indexTree: string; readonly worktreeTree: string }): string {
  return createHash('sha256')
    .update(state.head)
    .update('\0')
    .update(state.indexTree)
    .update('\0')
    .update(state.worktreeTree)
    .digest('hex');
}

function captureCurrent(repoDir: string, stateDir: string): {
  readonly head: string;
  readonly indexTree: string;
  readonly worktreeTree: string;
  readonly fingerprint: string;
} {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const head = oid(repoDir, 'HEAD');
  const indexTree = git(repoDir, ['write-tree']).trim();
  const indexFile = join(stateDir, `capture-${randomUUID()}.index`);
  const anchorer = createGitAnchorer({ dir: repoDir, indexFile });
  try {
    const captured = anchorer.capture();
    if (captured.kind !== 'git') throw new StepcastError('Внутренняя ошибка: git-якорь вернул чужой вид состояния');
    const worktreeTree = captured.id;
    return { head, indexTree, worktreeTree, fingerprint: fingerprint({ head, indexTree, worktreeTree }) };
  } finally {
    anchorer.dispose();
  }
}

/** Заменить объявленные live-пути их версиями из базового коммита. */
function withoutPaths(
  repoDir: string,
  tree: string,
  base: string,
  exclude: readonly string[],
  stateDir: string,
): string {
  if (exclude.length === 0) return tree;
  const indexFile = join(stateDir, `exclude-${randomUUID()}.index`);
  try {
    git(repoDir, ['read-tree', tree], { indexFile });
    git(repoDir, ['reset', '-q', base, '--', ...exclude], { indexFile });
    return git(repoDir, ['write-tree'], { indexFile }).trim();
  } finally {
    rmSync(indexFile, { force: true });
  }
}

function syntheticCommit(repoDir: string, tree: string, parent: string, message: string): string {
  return git(repoDir, ['commit-tree', tree, '-p', parent, '-m', message]).trim();
}

function conflictPaths(dir: string): string[] {
  return git(dir, ['diff', '--name-only', '--diff-filter=U', '-z'])
    .split('\0')
    .filter((path) => path !== '');
}

function errorText(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('stderr' in error)) return String(error);
  const stderr = (error as { stderr?: unknown }).stderr;
  return typeof stderr === 'string' ? stderr.trim() : String(error);
}

/**
 * Проверить в одноразовом worktree, что локальные staged/unstaged изменения
 * переносятся поверх результата. Исходный checkout не меняется.
 */
export function preparePublication(options: {
  readonly repoDir: string;
  readonly base: string;
  readonly target: string;
  readonly stateDir: string;
  readonly exclude: readonly string[];
}): PreparedPublication {
  const { repoDir, base, target, stateDir, exclude } = options;
  const source = captureCurrent(repoDir, stateDir);
  if (source.head !== base) {
    throw new StepcastError('Ветка сдвинулась после начала прогона', {
      file: repoDir,
      hint: `Ожидался ${base}, сейчас ${source.head}; результат сохранён в ${target}`,
    });
  }

  const stagedTree = withoutPaths(repoDir, source.indexTree, base, exclude, stateDir);
  const visibleTree = withoutPaths(repoDir, source.worktreeTree, base, exclude, stateDir);
  const stagedCommit = syntheticCommit(repoDir, stagedTree, base, 'stepcast local staged overlay');
  const visibleCommit = syntheticCommit(repoDir, visibleTree, stagedCommit, 'stepcast local unstaged overlay');
  const worktree = join(stateDir, `preflight-${randomUUID()}`);
  addWorktree({ repoDir, path: worktree, ref: target });

  try {
    if (stagedTree !== oid(repoDir, `${base}^{tree}`)) {
      try {
        git(worktree, ['cherry-pick', '--quiet', stagedCommit]);
      } catch (error) {
        const conflicts = conflictPaths(worktree);
        throw new StepcastError(
          `Конфликт локальных staged-изменений с результатом${conflicts.length === 0 ? '' : `: ${conflicts.join(', ')}`}`,
          { file: repoDir, cause: error },
        );
      }
    }
    const indexTree = oid(worktree, 'HEAD^{tree}');

    if (visibleTree !== stagedTree) {
      try {
        git(worktree, ['cherry-pick', '--quiet', visibleCommit]);
      } catch (error) {
        const conflicts = conflictPaths(worktree);
        throw new StepcastError(
          `Конфликт локальных unstaged-изменений с результатом${conflicts.length === 0 ? '' : `: ${conflicts.join(', ')}`}`,
          { file: repoDir, cause: error },
        );
      }
    }
    const worktreeTree = oid(worktree, 'HEAD^{tree}');
    return {
      base,
      target,
      indexTree,
      worktreeTree,
      changedPaths: pathsBetween(repoDir, source.worktreeTree, worktreeTree),
      fingerprint: source.fingerprint,
      sourceHead: source.head,
      sourceIndexTree: source.indexTree,
      sourceWorktreeTree: source.worktreeTree,
    };
  } finally {
    removeWorktree({ repoDir, path: worktree, runDir: stateDir });
  }
}

function materialize(
  repoDir: string,
  tree: string,
  paths: readonly string[],
  stateDir: string,
): void {
  if (paths.length === 0) return;
  const present = new Set(
    git(repoDir, ['ls-tree', '-r', '--name-only', '-z', tree])
      .split('\0')
      .filter((path) => path !== ''),
  );
  const indexFile = join(stateDir, `materialize-${randomUUID()}.index`);
  try {
    git(repoDir, ['read-tree', tree], { indexFile });
    for (const path of paths) {
      if (!present.has(path)) rmSync(join(repoDir, path), { recursive: true, force: true });
    }
    const restore = paths.filter((path) => present.has(path));
    if (restore.length > 0) git(repoDir, ['checkout-index', '--force', '--', ...restore], { indexFile });
  } finally {
    rmSync(indexFile, { force: true });
  }
}

/** Опубликовать уже проверенный результат, сохранив локальные слои индекса и дерева. */
export function publishPrepared(options: {
  readonly repoDir: string;
  readonly prepared: PreparedPublication;
  readonly stateDir: string;
}): void {
  const { repoDir, prepared, stateDir } = options;
  const current = captureCurrent(repoDir, stateDir);
  if (current.fingerprint !== prepared.fingerprint) {
    throw new StepcastError('Рабочее дерево изменилось после проверки публикации', {
      file: repoDir,
      hint: `Результат сохранён в коммите ${prepared.target}; повторите публикацию после завершения параллельных правок`,
    });
  }

  const recovery = join(stateDir, 'publication-recovery.json');
  writeFileSync(recovery, `${JSON.stringify({ repoDir, ...prepared }, null, 2)}\n`, { mode: 0o600 });
  let refUpdated = false;
  try {
    git(repoDir, ['update-ref', 'HEAD', prepared.target, prepared.base]);
    refUpdated = true;
    git(repoDir, ['read-tree', prepared.indexTree]);
    materialize(repoDir, prepared.worktreeTree, prepared.changedPaths, stateDir);
    rmSync(recovery, { force: true });
  } catch (error) {
    try {
      if (refUpdated) git(repoDir, ['update-ref', 'HEAD', prepared.sourceHead, prepared.target]);
      git(repoDir, ['read-tree', prepared.sourceIndexTree]);
      const rollbackPaths = pathsBetween(repoDir, prepared.worktreeTree, prepared.sourceWorktreeTree);
      materialize(repoDir, prepared.sourceWorktreeTree, rollbackPaths, stateDir);
    } catch (rollbackError) {
      throw new StepcastError('Публикация прервалась, автоматический возврат не завершён', {
        file: recovery,
        hint: `Данные восстановления сохранены; исходная ошибка: ${errorText(error)}; ошибка возврата: ${errorText(rollbackError)}`,
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * Обратить уже завершённую публикацию одного репозитория. Вызывается только
 * агрегатором составной публикации, если следующий репозиторий не смог
 * опубликоваться; CAS не позволяет стереть правку, случившуюся после неё.
 */
export function rollbackPrepared(options: {
  readonly repoDir: string;
  readonly prepared: PreparedPublication;
  readonly stateDir: string;
}): void {
  const { repoDir, prepared, stateDir } = options;
  const current = captureCurrent(repoDir, stateDir);
  const publishedFingerprint = fingerprint({
    head: prepared.target,
    indexTree: prepared.indexTree,
    worktreeTree: prepared.worktreeTree,
  });
  if (current.fingerprint !== publishedFingerprint) {
    throw new StepcastError('Опубликованное дерево изменилось до составного возврата', {
      file: repoDir,
      hint: `Ожидался коммит ${prepared.target}; данные восстановления оставлены на диске`,
    });
  }
  git(repoDir, ['update-ref', 'HEAD', prepared.sourceHead, prepared.target]);
  git(repoDir, ['read-tree', prepared.sourceIndexTree]);
  const rollbackPaths = pathsBetween(repoDir, prepared.worktreeTree, prepared.sourceWorktreeTree);
  materialize(repoDir, prepared.sourceWorktreeTree, rollbackPaths, stateDir);
}
