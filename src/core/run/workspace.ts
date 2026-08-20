import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { loadIgnoreRules } from '../anchor/ignore.js';
import { isGitWorktree } from '../anchor/git.js';
import { StepcastError } from '../errors.js';
import type { Job, Pipeline, Workspace } from '../pipeline/model.js';

/**
 * Рабочая директория работы.
 *
 * Раньше это было одно значение на прогон; теперь — значение на работу, потому
 * что режим объявляется на пайплайне и переопределяется работой. Рабочий
 * каталог передаётся дочерним процессам явным параметром: `process.chdir` в
 * движке с несколькими работами — источник трудноуловимых ошибок.
 *
 * Журнал прогона в любом режиме лежит вне рабочего дерева. В режиме `copy`
 * копия живёт в `<run_dir>/workspace/<job>/`, а якорь снимается именно с неё,
 * а не с директории прогона целиком, — иначе запись журнала меняла бы `tree_id`.
 */
export interface PreparedWorkspace {
  readonly mode: Workspace['mode'];
  readonly dir: string;
}

function git(dir: string, args: readonly string[]): string {
  // `core.quotePath=false`: иначе git экранирует не-ASCII пути в выводе
  // C-последовательностями, и предикат границ, объяснение инвалидации и
  // сравнение прогонов начинают показывать «\321\201...» вместо имени файла.
  return execFileSync('git', ['-C', dir, '-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Файлы, которые считаются содержимым дерева: отслеживаемые и новые, но не
 * игнорируемые. Под git список берётся у самого git — он единственный
 * толкует правила игнорирования полностью.
 */
function visibleFiles(root: string): string[] {
  if (isGitWorktree(root)) {
    return git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
      .split('\0')
      .filter((path) => path !== '');
  }

  const rules = loadIgnoreRules(root);
  const found: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(root, full).split('\\').join('/');
      if (rules.ignores(rel, entry.isDirectory())) continue;
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) found.push(rel);
    }
  };
  visit(root);
  return found;
}

export interface PrepareOptions {
  readonly job: Job;
  /** Каталог запуска: он же рабочая директория в режиме `cwd`. */
  readonly cwd: string;
  /** Директория прогона: место по умолчанию для рабочих копий. */
  readonly runDir: string;
}

export function prepareWorkspace(options: PrepareOptions): PreparedWorkspace {
  const { job, cwd, runDir } = options;
  // Режим у работы уже разрешён при раскрытии: она либо объявила свой, либо
  // унаследовала пайплайновый.
  const workspace = job.workspace;

  if (workspace.mode === 'cwd') return { mode: 'cwd', dir: cwd };

  const base = workspace.path ?? join(runDir, 'workspace');
  const dir = join(base, job.id);

  if (workspace.mode === 'worktree') {
    mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
    // Отделённый worktree от текущего HEAD: незакоммиченные изменения в него
    // не попадают, а ветка проекта остаётся свободной.
    git(cwd, ['worktree', 'add', '--detach', '--quiet', dir, 'HEAD']);
    return { mode: 'worktree', dir };
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const relativePath of visibleFiles(cwd)) {
    const from = join(cwd, relativePath);
    const to = join(dir, relativePath);
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    cpSync(from, to, { preserveTimestamps: true });
  }
  return { mode: 'copy', dir };
}

/**
 * Пригодность режима в этом окружении. Проверяется один раз до запуска первой
 * работы: отказ на пятой работе из семи после сорока минут работы агента
 * недопустим, если то же самое было видно на нулевой секунде.
 */
/** Путь размещения копии, объявленный при режиме, для которого он бессмыслен. */
export function workspacePathNeedsCopy(workspace: Workspace): boolean {
  return workspace.path !== undefined && workspace.mode !== 'copy';
}

export function checkWorkspaceAvailability(options: {
  readonly pipeline: Pipeline;
  readonly cwd: string;
}): void {
  const { pipeline, cwd } = options;
  const workspaces = pipeline.jobs.map((job) => job.workspace);

  if (workspaces.some((workspace) => workspace.mode === 'worktree') && !isGitWorktree(cwd)) {
    throw new StepcastError('Режим worktree требует репозитория git', {
      file: pipeline.file,
      at: 'workspace.mode',
      hint: 'Вне репозитория доступен режим copy — он работает с незакоммиченными изменениями и без git',
    });
  }

  for (const workspace of workspaces) {
    if (workspace.path === undefined) continue;
    if (workspacePathNeedsCopy(workspace)) {
      throw new StepcastError('Путь размещения рабочей копии допустим только при режиме copy', {
        file: pipeline.file,
        at: 'workspace.path',
      });
    }
    try {
      mkdirSync(workspace.path, { recursive: true, mode: 0o700 });
      statSync(workspace.path);
    } catch (error) {
      throw new StepcastError(`Место размещения рабочих копий недоступно: ${workspace.path}`, {
        file: pipeline.file,
        at: 'workspace.path',
        cause: error,
      });
    }
  }
}
