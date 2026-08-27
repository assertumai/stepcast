import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { createAnchorer, detectAnchorKind } from '../anchor/index.js';
import type { AnchorKind, TreeAnchorer } from '../anchor/index.js';
import { loadIgnoreRules } from '../anchor/ignore.js';
import { isGitWorktree } from '../anchor/git.js';
import { StepcastError } from '../errors.js';
import { buildGraph } from '../graph.js';
import type { Job, Pipeline, Workspace } from '../pipeline/model.js';
import {
  potentialSeedSource,
  workspaceInheritanceDiagnostics,
  type InheritSource,
} from './inherit.js';

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
  /** Работа, чьё дерево унаследовано. Отсутствует у работы без наследования. */
  readonly inheritedFrom?: string;
  /** Каталог продолжен, а не заведён заново, — работа была в цепочке. */
  readonly continued?: boolean;
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
  /** Источник наследования, уже разрешённый (`resolveInheritSource`). */
  readonly source?: InheritSource;
  /** Способ фиксации якорей на этот прогон — нужен, чтобы засеять развилку. */
  readonly anchorKind?: AnchorKind;
  /** Каталог служебных файлов якорей прогона. */
  readonly anchorsDir?: string;
  /** Подмена якоря: тесты подставляют поддельный, как и в `runner.ts`. */
  readonly anchorerFor?: (options: {
    readonly dir: string;
    readonly stateDir: string;
    readonly kind: AnchorKind;
    readonly scope: string;
    readonly repoDir?: string;
  }) => TreeAnchorer;
}

export function prepareWorkspace(options: PrepareOptions): PreparedWorkspace {
  const { job, cwd, runDir, source } = options;
  // Режим у работы уже разрешён при раскрытии: она либо объявила свой, либо
  // унаследовала пайплайновый.
  const workspace = job.workspace;

  if (workspace.mode === 'cwd') return { mode: 'cwd', dir: cwd };

  // Цепочка: каталог предшественника продолжается как есть — ничего не
  // готовится и не восстанавливается, а неотслеживаемое содержимое (кеши
  // сборки, зависимости) переходит дальше само.
  if (source?.kind === 'continue') {
    return { mode: workspace.mode, dir: source.dir, inheritedFrom: source.job, continued: true };
  }

  const base = workspace.path ?? join(runDir, 'workspace');
  const dir = join(base, job.id);

  if (workspace.mode === 'worktree') {
    mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
    // Отделённый worktree от текущего HEAD: незакоммиченные изменения в него
    // не попадают, а ветка проекта остаётся свободной.
    git(cwd, ['worktree', 'add', '--detach', '--quiet', dir, 'HEAD']);
  } else {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const relativePath of visibleFiles(cwd)) {
      const from = join(cwd, relativePath);
      const to = join(dir, relativePath);
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      cpSync(from, to, { preserveTimestamps: true });
    }
  }

  // Развилка: каталог заведён как обычно, но приведён к якорю источника — тем
  // же `restore`, что и возобновление. Отказ здесь добирается до вызывающей
  // стороны как отказ подготовки директории — тем же путём, что и отказ
  // `git worktree add` строкой выше, — и не оставляет за собой ни наполовину
  // приведённого дерева (гарантия `restore`), ни заведённого под него
  // каталога: он убирается здесь же.
  if (source?.kind === 'seed') {
    if (options.anchorKind === undefined || options.anchorsDir === undefined) {
      throw new StepcastError('Внутренняя ошибка: для засева развилки не передан способ фиксации якорей');
    }
    try {
      const anchorer = (options.anchorerFor ?? createAnchorer)({
        dir,
        stateDir: options.anchorsDir,
        kind: options.anchorKind,
        scope: job.id,
        repoDir: cwd,
      });
      try {
        anchorer.restore(source.anchor);
      } finally {
        anchorer.dispose();
      }
    } catch (error) {
      discardWorkspaceDir(dir, cwd, workspace.mode);
      throw error;
    }
    return { mode: workspace.mode, dir, inheritedFrom: source.job };
  }

  return { mode: workspace.mode, dir };
}

/**
 * Убрать каталог, заведённый под работу, которой он не достался.
 *
 * Своя ошибка здесь проглатывается сознательно: наружу должна уйти причина
 * отказа подготовки, а не жалоба уборки за ней. Незарегистрированный worktree
 * оставил бы за собой запись в `.git/worktrees` и мешал бы следующему прогону
 * занять то же имя.
 *
 * Уборка идёт в три приёма и не полагается на успех первого: `git worktree
 * remove` — это команда в общем на весь прогон репозитории, и параллельные
 * работы зовут её одновременно. Отказ одной из них (а `--force` спасает от
 * грязного дерева, но не от занятого чужой командой репозитория) оставлял бы
 * каталог на диске — то самое, чего эта функция обязана не допустить. Поэтому
 * каталог сносится средствами файловой системы в любом случае, а запись в
 * `.git/worktrees`, осиротевшую после сноса, убирает `worktree prune`.
 */
function discardWorkspaceDir(dir: string, cwd: string, mode: Workspace['mode']): void {
  if (mode === 'worktree') {
    try {
      git(cwd, ['worktree', 'remove', '--force', dir]);
    } catch {
      // Ниже каталог снимается напрямую, а учёт git приводит в порядок prune.
    }
  }

  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Каталог останется в директории прогона: сказать об этом уже нечем.
  }

  if (mode !== 'worktree') return;
  try {
    // Безопасно для соседних работ: `worktree add` держит свою запись
    // помеченной как заводимую, и prune такую запись не трогает.
    git(cwd, ['worktree', 'prune']);
  } catch {
    // Запись останется указывать на снесённый каталог — её снимет любой
    // следующий prune, свой или чужой.
  }
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

  // Те же четыре отказа, что и `stepcast lint`: пайплайн, минующий линт,
  // обязан отказать до первой работы, а не посреди прогона.
  const { graph } = buildGraph(pipeline);
  const inheritanceProblem = workspaceInheritanceDiagnostics(pipeline, graph).find(
    (diagnostic) => diagnostic.severity === 'error',
  );
  if (inheritanceProblem !== undefined) {
    throw new StepcastError(inheritanceProblem.message, {
      file: inheritanceProblem.file ?? pipeline.file,
      ...(inheritanceProblem.at === undefined ? {} : { at: inheritanceProblem.at }),
      ...(inheritanceProblem.hint === undefined ? {} : { hint: inheritanceProblem.hint }),
    });
  }

  if (workspaces.some((workspace) => workspace.mode === 'worktree') && !isGitWorktree(cwd)) {
    throw new StepcastError('Режим worktree требует репозитория git', {
      file: pipeline.file,
      at: 'workspace.mode',
      hint: 'Вне репозитория доступен режим copy — он работает с незакоммиченными изменениями и без git',
    });
  }

  // Засев развилки требует якоря, хранящего содержимое дерева. Вне git состояние
  // фиксируется хеш-манифестом, который содержимого не хранит и `restore` не
  // умеет: работа, которой граф обещает чужое дерево, его не получит. Это видно
  // до запуска — значит и отказывать надо здесь, а не отказом подготовки
  // директории посреди прогона.
  if (detectAnchorKind(cwd) === 'manifest') {
    const seeding = pipeline.jobs.find((job) => potentialSeedSource(graph, job) !== undefined);
    if (seeding !== undefined) {
      throw new StepcastError(
        `Работа ${seeding.id} наследует дерево работы, каталог которой не продолжает, а вне репозитория git это невозможно`,
        {
          file: seeding.source,
          at: `jobs.${seeding.id}.workspace.inherit`,
          hint: 'Вне git состояние фиксируется хеш-манифестом: он отвечает, изменилось ли дерево, но содержимого не хранит. Оставьте работе одну зависимость (тогда она продолжит её каталог) или объявите workspace.inherit: none',
        },
      );
    }
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
