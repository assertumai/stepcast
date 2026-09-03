import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { createAnchorer, detectAnchorKind } from '../anchor/index.js';
import type { AnchorKind, TreeAnchorer } from '../anchor/index.js';
import { loadIgnoreRules } from '../anchor/ignore.js';
import { isGitWorktree } from '../anchor/git.js';
import { StepcastError } from '../errors.js';
import { buildGraph } from '../graph.js';
import type { Job, Pipeline, Workspace } from '../pipeline/model.js';
import type { BookkeepingScope } from './bookkeeping.js';
import {
  potentialSeedSource,
  workspaceInheritanceDiagnostics,
  type InheritSource,
} from './inherit.js';
import { createScope } from './scope.js';
import { addWorktree, removeWorktree } from './worktrees.js';

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
  /**
   * Материализованные части дерева — объявленный каталог и репозиторий,
   * которому он принадлежит, в каноническом порядке состава. Заполняется
   * только в режиме `worktree`, только для работы, которая сама заводила
   * дерево (не для продолжения цепочки: части предшественника уже на месте,
   * и заводить их заново нечего).
   */
  readonly nested?: readonly { readonly dir: string; readonly repo: string }[];
  /** Прогон, у которого перенят этот каталог для продолжения оборванной сессии. */
  readonly adoptedFrom?: string;
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

/** Есть ли в репозитории хотя бы один коммит: `HEAD` разрешается в объект. */
export function hasCommit(dir: string): boolean {
  try {
    git(dir, ['rev-parse', '--verify', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

/** Игнорирует ли репозиторий `root` путь `relDir` своими правилами. */
function ignoredByRoot(root: string, relDir: string): boolean {
  try {
    git(root, ['check-ignore', '-q', '--', relDir]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Отслеживает ли репозиторий `root` обычные файлы внутри каталога `relDir` —
 * не сам каталог гитлинком: пathspec `relDir/` совпадает и с записью
 * гитлинка (git считает её каталогоподобной), поэтому запись фильтруется по
 * режиму — `160000` исключается, остальное считается файлом, зашедшим в
 * индекс раньше, чем каталог стал репозиторием. Выкладка корня в режиме
 * `worktree` заняла бы такой каталог, и `worktree add` части отказал бы
 * посреди подготовки (design.md, решение 3).
 */
export function rootTracksPart(root: string, relDir: string): boolean {
  try {
    return git(root, ['ls-files', '-s', '--', `${relDir}/`])
      .split('\n')
      .filter((line) => line !== '')
      .some((line) => !line.startsWith('160000 '));
  } catch {
    return false;
  }
}

interface WorkspaceDiagnosticText {
  readonly message: string;
  readonly hint: string;
}

/**
 * Формулировки трёх отказов состава, действующих только при объявленной
 * работе в режиме `worktree` (плюс безусловный отказ `copy`) — общие для
 * предстартовой проверки прогона (`checkWorkspaceAvailability`) и `stepcast
 * lint`: диагностика, минующая один путь, обязана звучать так же, как та,
 * что минует другой.
 */
export function describeCopyRejection(jobId: string): WorkspaceDiagnosticText {
  return {
    message: `Работа ${jobId} объявляет режим copy, а вложенные репозитории объявлены составом дерева (project.nested_repos)`,
    hint: 'Копия не содержит .git, и объявленная часть в ней была бы каталогом без репозитория. Уберите nested_repos или переведите работу в режим cwd либо worktree',
  };
}

export function describeNoCommitForWorktree(relDir: string): WorkspaceDiagnosticText {
  return {
    message: `Объявленный вложенный репозиторий ${relDir} не имеет ни одного коммита, а режим worktree заводит его дерево из HEAD`,
    hint: `git worktree add … HEAD невозможен в репозитории без коммита. Сделайте в ${relDir} первый коммит либо переведите работы в режим cwd`,
  };
}

export function describeTrackedByRoot(relDir: string): WorkspaceDiagnosticText {
  return {
    message: `Корневой репозиторий отслеживает файлы по пути объявленного вложенного репозитория ${relDir}`,
    hint: 'Выкладка корня в режиме worktree займёт этот каталог, и git worktree add части откажет посреди подготовки. Уберите файлы части из индекса корня либо переведите работы в режим cwd',
  };
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
  /**
   * Куда писать отказ уборки за неудавшейся подготовкой. Обязателен: откат
   * снимает чужие рабочие деревья и учётные записи репозиториев, и отказ
   * такого снятия обязан быть виден — раньше он проглатывался молча.
   */
  readonly bookkeeping: BookkeepingScope;
  /** Источник наследования, уже разрешённый (`resolveInheritSource`). */
  readonly source?: InheritSource;
  /** Способ фиксации якорей на этот прогон — нужен, чтобы засеять развилку. */
  readonly anchorKind?: AnchorKind;
  /** Каталог служебных файлов якорей прогона. */
  readonly anchorsDir?: string;
  /** Объявленный состав вложенных репозиториев (`project.nested_repos`), в каноническом порядке. */
  readonly nestedRepos?: readonly string[];
  /**
   * Каталог, перенятый у исходного прогона для продолжения оборванной сессии
   * — назван планом возобновления (`ResumePlan.adoptWorkspace`). Перенимается
   * вместо заведения своего каталога, только в режимах `worktree` и `copy` и
   * только когда работа не наследует чужой каталог и не продолжает цепочку:
   * в этих случаях каталог решает наследование, а не эта работа.
   */
  readonly adoptFrom?: {
    readonly path: string;
    readonly runId: string;
    /**
     * Части составного дерева, лежащие в перенимаемом каталоге. Переходят в
     * запись перенявшей работы вместе с каталогом: перечень читает уборка
     * (`collectRunWorktrees` в `run/cleanup.ts`), и без него учётные записи
     * частей не снял бы никто — исходный прогон каталог бережёт, а
     * перенявший о частях не знал бы.
     */
    readonly nested?: readonly { readonly dir: string; readonly repo: string }[];
  };
  /** Подмена якоря: тесты подставляют поддельный, как и в `runner.ts`. */
  readonly anchorerFor?: (options: {
    readonly dir: string;
    readonly stateDir: string;
    readonly kind: AnchorKind;
    readonly scope: string;
    readonly repoDir?: string;
    readonly nested?: readonly string[];
  }) => TreeAnchorer;
}

export async function prepareWorkspace(options: PrepareOptions): Promise<PreparedWorkspace> {
  const { job, cwd, runDir, source } = options;
  // Режим у работы уже разрешён при раскрытии: она либо объявила свой, либо
  // унаследовала пайплайновый.
  const workspace = job.workspace;

  if (workspace.mode === 'cwd') return { mode: 'cwd', dir: cwd };

  // Продолжение оборванной сессии: каталог исходного прогона перенимается
  // как есть, а не заводится заново, — диалог помнит абсолютные пути именно
  // этого дерева (design.md, решение 4), и дерево в нём не восстанавливается
  // вовсе: перенятый каталог и есть то состояние, которое диалог оставил.
  // Наследующая либо продолжающая чужую цепочку работа сюда не попадает: её
  // каталог решает наследование, а не эта работа.
  if (options.adoptFrom !== undefined && (source === undefined || source.kind === 'none')) {
    return {
      mode: workspace.mode,
      dir: options.adoptFrom.path,
      adoptedFrom: options.adoptFrom.runId,
      ...(options.adoptFrom.nested === undefined
        ? {}
        : { nested: options.adoptFrom.nested.map((part) => ({ ...part })) }),
    };
  }

  // Цепочка: каталог предшественника продолжается как есть — ничего не
  // готовится и не восстанавливается, а неотслеживаемое содержимое (кеши
  // сборки, зависимости) переходит дальше само.
  if (source?.kind === 'continue') {
    return { mode: workspace.mode, dir: source.dir, inheritedFrom: source.job, continued: true };
  }

  const base = workspace.path ?? join(runDir, 'workspace');
  const dir = join(base, job.id);
  // Канонический порядок состава — отсортированный, тот же, что у составного
  // якоря (`anchor/composite.ts`). Он приводится здесь, а не берётся на веру у
  // вызывающего: для вложенных друг в друга объявленных каталогов порядок
  // значим — `worktree add` объемлющего (`a`) отказал бы «not an empty
  // directory», заведись раньше вложенный (`a/b`).
  const nestedRepos = [...(options.nestedRepos ?? [])].sort();
  const nested: { dir: string; repo: string }[] = [];

  /**
   * Область подготовки: каждый заведённый каталог регистрирует своё снятие
   * сразу после заведения. Отказ на любом шаге снимает область — и обратный
   * порядок сам даёт правило «части в обратном порядке, затем корень»
   * (design.md, решение 4): снять корень раньше частей означало бы убирать
   * из-под них каталог, в котором они ещё числятся рабочими деревьями.
   *
   * При успехе область **отпускается**, а не снимается: изолированное дерево
   * обязано пережить прогон (`workspace-modes`), и снять его вправе только
   * `stepcast gc`.
   */
  const preparation = createScope(options.bookkeeping);

  try {
    if (workspace.mode === 'worktree') {
      // Отделённый worktree от текущего HEAD: незакоммиченные изменения в него
      // не попадают, а ветка проекта остаётся свободной.
      addWorktree({ repoDir: cwd, path: dir });
      preparation.defer('снятие рабочего дерева работы', () => {
        removeWorktree({ repoDir: cwd, path: dir, runDir });
      });

      for (const relDir of nestedRepos) {
        const repo = join(cwd, relDir);
        // Часть выкладывается из HEAD своего репозитория — не гитлинка корня
        // и не рабочего дерева части: gitlink говорит о том, что корень
        // помнит о части, а не о том, где она сейчас (design.md, решение 2).
        // Родительский каталог мог не существовать (часть, которую корень
        // игнорирует) или уже существовать пустым (часть под gitlink'ом) —
        // `addWorktree` заводит его и принимает оба случая.
        addWorktree({ repoDir: repo, path: join(dir, relDir) });
        preparation.defer(`снятие части ${relDir} рабочего дерева работы`, () => {
          removeWorktree({ repoDir: repo, path: join(dir, relDir), runDir });
        });
        nested.push({ dir: relDir, repo });
      }
    } else {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      preparation.defer('снятие рабочей копии работы', () => {
        rmSync(dir, { recursive: true, force: true });
      });
      for (const relativePath of visibleFiles(cwd)) {
        const from = join(cwd, relativePath);
        const to = join(dir, relativePath);
        mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
        cpSync(from, to, { preserveTimestamps: true });
      }
    }
  } catch (error) {
    // Исходная причина уходит наружу как есть: работа отказывает прежним
    // spawn_failed, новой причины остановки не заводится. Отказ самой уборки
    // не подменяет её, а уходит в журнал событием `bookkeeping.failed`.
    await preparation.dispose();
    throw error;
  }

  const nestedField = nested.length === 0 ? {} : { nested };

  // Развилка: каталог заведён как обычно (корень и части), но приведён к
  // якорю источника — тем же `restore`, что и возобновление. Отказ здесь
  // добирается до вызывающей стороны как отказ подготовки директории и не
  // оставляет за собой ни наполовину приведённого дерева (гарантия
  // `restore`), ни заведённого под него каталога: он убирается здесь же.
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
        ...(nestedRepos.length === 0 ? {} : { nested: nestedRepos }),
      });
      // Своя область, а не область подготовки: служебные файлы якоря живут
      // ровно на время засева и снимаются при любом его исходе, а область
      // подготовки при успехе отпускается — регистрация в ней означала бы
      // индексный файл, переживший засев.
      const seeding = createScope(options.bookkeeping);
      seeding.defer('снятие служебных файлов якоря засева', () => {
        anchorer.dispose();
      });
      try {
        anchorer.restore(source.anchor);
      } finally {
        await seeding.dispose();
      }
    } catch (error) {
      await preparation.dispose();
      throw error;
    }
    preparation.release();
    return { mode: workspace.mode, dir, inheritedFrom: source.job, ...nestedField };
  }

  preparation.release();
  return { mode: workspace.mode, dir, ...nestedField };
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
  /** Объявленный состав вложенных репозиториев (`project.nested_repos`). */
  readonly nestedRepos?: readonly string[];
}): void {
  const { pipeline, cwd, nestedRepos } = options;
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

  if (nestedRepos === undefined || nestedRepos.length === 0) return;

  // Копия `.git` не содержит, и объявленная часть в ней была бы каталогом
  // без репозитория — снимать с неё составное состояние нечем (design.md,
  // Non-Goals «Поддержка режима copy»). `worktree` при пригодном составе
  // ниже уже не отказывает: часть материализуется собственным рабочим
  // деревом, и якорь остаётся составным.
  const copyJob = pipeline.jobs.find((job) => job.workspace.mode === 'copy');
  if (copyJob !== undefined) {
    const { message, hint } = describeCopyRejection(copyJob.id);
    throw new StepcastError(message, { file: copyJob.source, at: `jobs.${copyJob.id}.workspace.mode`, hint });
  }

  if (!isGitWorktree(cwd)) {
    throw new StepcastError(
      'Корень рабочего дерева не является репозиторием git, а вложенные репозитории объявлены составом (project.nested_repos)',
      { file: pipeline.file, at: 'project.nested_repos' },
    );
  }

  // Обе следующие проверки — только для работ в режиме worktree: в cwd (и
  // при отклонённом выше copy) до `git worktree add` части дело не доходит.
  const usesWorktree = pipeline.jobs.some((job) => job.workspace.mode === 'worktree');

  for (const relDir of nestedRepos) {
    const full = join(cwd, relDir);
    let isDirectory: boolean;
    try {
      isDirectory = statSync(full).isDirectory();
    } catch (error) {
      throw new StepcastError(`Объявленный вложенный репозиторий не существует: ${relDir}`, {
        file: pipeline.file,
        at: 'project.nested_repos',
        hint: 'Проверьте путь в project.nested_repos — опечатку или несклонированный подмодуль',
        cause: error,
      });
    }
    if (!isDirectory || !isGitWorktree(full)) {
      throw new StepcastError(`Объявленный вложенный репозиторий не является рабочим деревом git: ${relDir}`, {
        file: pipeline.file,
        at: 'project.nested_repos',
        hint: 'project.nested_repos называет каталог, который сам является отдельным git-репозиторием',
      });
    }

    // Вложенный репозиторий без единого коммита корневой `add -A` встроить
    // не умеет: он отказывает целиком («does not have a commit checked out»),
    // и снятие первого же якоря провалилось бы отказом бухгалтерии посреди
    // прогона — тихим, после которого границы правок просто не оцениваются.
    // Отказ здесь узкий: часть, которую корень игнорирует, в его `add -A` не
    // попадает вовсе и своим репозиторием снимается без коммита прекрасно.
    if (!hasCommit(full) && !ignoredByRoot(cwd, relDir)) {
      throw new StepcastError(
        `Объявленный вложенный репозиторий ${relDir} не имеет ни одного коммита, а корневой репозиторий его не игнорирует`,
        {
          file: pipeline.file,
          at: 'project.nested_repos',
          hint: `Корневой git не умеет встроить такой каталог ссылкой на коммит и отказывает целиком. Сделайте в ${relDir} первый коммит или добавьте его в .gitignore корня`,
        },
      );
    }

    const toplevel = git(full, ['rev-parse', '--show-toplevel']).trim();
    if (realpathSync(toplevel) !== realpathSync(full)) {
      throw new StepcastError(
        `Объявленный вложенный репозиторий ${relDir} принадлежит репозиторию ${toplevel}, а не собственному`,
        {
          file: pipeline.file,
          at: 'project.nested_repos',
          hint: 'project.nested_repos называет каталог собственного репозитория, а не подкаталог корневого',
        },
      );
    }

    if (!usesWorktree) continue;

    // `git worktree add … HEAD` в репозитории без коммитов невозможен —
    // сегодняшнее послабление `!ignoredByRoot` выше относится к корневому
    // `add -A` и части, которую корень игнорирует, а не к выкладке части
    // собственным `worktree add` (design.md, решение 11).
    if (!hasCommit(full)) {
      const { message, hint } = describeNoCommitForWorktree(relDir);
      throw new StepcastError(message, { file: pipeline.file, at: 'project.nested_repos', hint });
    }

    if (rootTracksPart(cwd, relDir)) {
      const { message, hint } = describeTrackedByRoot(relDir);
      throw new StepcastError(message, { file: pipeline.file, at: 'project.nested_repos', hint });
    }
  }
}
