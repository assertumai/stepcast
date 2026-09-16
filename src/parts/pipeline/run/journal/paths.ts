import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, parse as parsePath, sep } from 'node:path';

/**
 * Раскладка журнала прогона.
 *
 * Журнал всегда лежит вне проекта, независимо от режима рабочей директории:
 * состояние прогона и рабочее дерево не должны смешиваться.
 */

/**
 * Основной каталог `.git` для линкованного worktree — по файлу `<root>/.git`
 * (`gitdir: <common>/.git/worktrees/<name>`) находит `<root>` основного
 * репозитория. `git worktree add` — то, чем сама stepcast заводит параллельные
 * дорожки (`lanes`, `merge-lanes`): без этого разбора каждая дорожка со своим
 * файлом `.git` регистрировалась бы отдельным проектом (заход
 * 9169657a1513 — рабочее дерево дорожки `propose-a` осело в `projects.json`
 * как самостоятельный проект-призрак).
 */
function mainRootOfWorktree(gitFile: string): string | undefined {
  const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitFile, 'utf8'));
  const gitDir = match?.[1]?.trim();
  if (gitDir === undefined) return undefined;
  const marker = `${sep}.git${sep}worktrees${sep}`;
  const index = gitDir.indexOf(marker);
  return index === -1 ? undefined : gitDir.slice(0, index);
}

/**
 * Корень проекта: явный маркер `.stepcast/config.yml` (заведённый `stepcast
 * init --knowledge fs` или вручную) либо ближайший каталог с настоящим `.git`
 * — директорией основного репозитория, а не файлом линкованного worktree.
 * Маркер и `.git`-директория проверяются на каждом уровне вместе: у
 * worktree дорожки маркер тоже есть (файл отслежен и потому вычитан
 * `checkout`), но он не должен перебивать разбор `.git`, иначе рабочее дерево
 * дорожки продолжало бы регистрироваться как отдельный проект.
 */
export function findProjectRoot(from: string): string {
  let current = realpathSync(from);
  for (;;) {
    const gitPath = join(current, '.git');
    if (existsSync(gitPath)) {
      if (statSync(gitPath).isDirectory()) return current;
      const mainRoot = mainRootOfWorktree(gitPath);
      if (mainRoot !== undefined && existsSync(mainRoot)) return realpathSync(mainRoot);
      return current;
    }
    if (existsSync(join(current, '.stepcast', 'config.yml'))) return current;

    const parent = dirname(current);
    if (parent === current || parent === parsePath(current).root) return realpathSync(from);
    current = parent;
  }
}

/**
 * Ключ проекта от реального пути. Без него прогоны разных проектов
 * смешиваются в одну кучу и `resume` ищет не там.
 */
export function projectKey(root: string): string {
  return createHash('sha256').update(realpathSync(root)).digest('hex').slice(0, 12);
}

/** Идентификатор прогона: отметка времени плюс короткий случайный хвост. */
export function makeRunId(now: Date, random: string): string {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
  return `${stamp}-${random}`;
}

/** Короткий идентификатор из идентификатора прогона: последний сегмент. */
export function shortRunId(runId: string): string {
  return runId.slice(runId.lastIndexOf('-') + 1);
}

export interface RunPaths {
  readonly runId: string;
  readonly dir: string;
  readonly projectDir: string;
  readonly manifest: string;
  readonly lock: string;
  readonly status: string;
  readonly events: string;
  readonly usage: string;
  readonly artifacts: string;
  readonly jobs: string;
  readonly workspace: string;
  /** Служебные файлы якоря: индекс git, тела манифестов. Вне рабочего дерева. */
  readonly anchors: string;
  /**
   * Записи решений (`user-decision-steps`, design.md решение 5): по одному
   * файлу `<wait_id>.json` на ожидание, пишет только `stepcast decide`.
   * Каталог заводится лениво, при первой записи, — большинство прогонов
   * решения не ждут вовсе.
   */
  readonly decisions: string;
  /**
   * Снимок движка, снятый из правимого дерева (`run/engine.ts`). Существует,
   * только когда движок был правимым, — но путь называется всегда, единым
   * местом для того, кто снимает снимок, и для уборки прогона, которая стирает
   * его наравне со всем прочим содержимым директории, кроме объявленного
   * минимума.
   */
  readonly engine: string;
}

export function runPaths(runsRoot: string, key: string, runId: string): RunPaths {
  const projectDir = join(runsRoot, key);
  const dir = join(projectDir, runId);
  return {
    runId,
    dir,
    projectDir,
    manifest: join(dir, 'run.json'),
    lock: join(dir, 'pipeline.lock.yml'),
    status: join(dir, 'status.json'),
    events: join(dir, 'events.ndjson'),
    usage: join(dir, 'usage.json'),
    artifacts: join(dir, 'artifacts'),
    jobs: join(dir, 'jobs'),
    workspace: join(dir, 'workspace'),
    anchors: join(dir, 'anchors'),
    engine: join(dir, 'engine'),
    decisions: join(dir, 'decisions'),
  };
}

/** Путь файла записи решения по идентификатору ожидания. */
export function decisionRecordPath(paths: RunPaths, waitId: string): string {
  return join(paths.decisions, `${waitId}.json`);
}

/**
 * Хранилище расхода: построчный журнал в корне прогонов, а не в каталоге
 * прогона, — сводка обязана пережить удаление своего каталога
 * (run-stats-retention, Решение 1).
 */
export function usageStorePath(runsRoot: string): string {
  return join(runsRoot, 'usage.ndjson');
}

export function jobDir(paths: RunPaths, jobId: string): string {
  return join(paths.jobs, jobId);
}

/**
 * Каталог черновиков работы: общее место на всю работу, а не на шаг, — агент
 * пишет туда, не задумываясь, доживёт ли файл до следующего шага. Лежит под
 * `paths.jobs`, а значит вне рабочего дерева при любом режиме `workspace`:
 * черновик агента не обязан становиться изменением, которое ловит
 * `changed_only` (заход 616c1b — сорок временных файлов внутри дерева
 * завалили границу правок).
 */
export function jobScratchDir(paths: RunPaths, jobId: string): string {
  return join(jobDir(paths, jobId), 'scratch');
}

/**
 * Каталог шага: числовой префикс задаёт порядок при просмотре, адресация в
 * командах и состоянии идёт по идентификатору.
 */
export function stepDirName(index: number, stepId: string): string {
  return `${String(index).padStart(2, '0')}-${stepId}`;
}

/**
 * Каталог шага. Уровень итерации появляется только у работ с циклом: добавлять
 * его всем единообразнее, но раскладку читает человек, и её краткость стоит
 * дороже единообразия. Точка порождения пути при этом одна — здесь.
 */
export function stepDir(
  paths: RunPaths,
  jobId: string,
  index: number,
  stepId: string,
  iteration?: number,
): string {
  const base = join(jobDir(paths, jobId), 'steps');
  return iteration === undefined
    ? join(base, stepDirName(index, stepId))
    : join(base, iterationDirName(iteration), stepDirName(index, stepId));
}

/**
 * Каталог вызова судьи внутри каталога шага. Номер сквозной для шага — растёт
 * через попытки и предикаты, а не начинается заново на каждой попытке.
 */
export function judgeCallDir(stepDirPath: string, n: number): string {
  return join(stepDirPath, `judge-${n}`);
}

/**
 * Каталог вызова предиката `script` внутри каталога шага — тем же образом,
 * что `judgeCallDir`: номер сквозной, растёт через попытки и через несколько
 * предикатов `script` одного шага.
 */
export function scriptCallDir(stepDirPath: string, n: number): string {
  return join(stepDirPath, `script-${n}`);
}

/** Имя каталога итерации: `iter-1`, `iter-2`, … */
export function iterationDirName(iteration: number): string {
  return `iter-${iteration}`;
}

export function parseIterationDirName(name: string): number | undefined {
  const match = /^iter-(\d+)$/.exec(name);
  return match === null ? undefined : Number(match[1]);
}

/** Разобрать имя каталога шага обратно в номер и идентификатор. */
export function parseStepDirName(name: string): { index: number; stepId: string } | undefined {
  const match = /^(\d+)-(.+)$/.exec(name);
  if (match === null) return undefined;
  return { index: Number(match[1]), stepId: match[2] as string };
}
