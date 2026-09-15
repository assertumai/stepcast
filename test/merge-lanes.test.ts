import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { run as runCli, type CliIo } from '../src/cli/main.js';
import { REASON_LIMIT } from '../src/core/backlog/index.js';
import type { Config } from '../src/core/config/resolve.js';
import { ExitCode, StepcastError, type ExitCodeValue } from '../src/core/errors.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { runPaths } from '../src/core/journal/paths.js';
import { mergeLanes } from '../src/core/lanes/merge.js';
import { readLaneMerge } from '../src/core/lanes/mergeRecord.js';
import { applyRun } from '../src/core/run/apply.js';
import { runPipeline, type RunResult } from '../src/core/run/runner.js';
import { gitCommit, gitInit as gitInitDir, makeProject, withHome, type Project } from './helpers.js';
import { tempDir } from './tmp.js';

/**
 * Сведение дорожек на настоящих прогонах: временный репозиторий, пайплайн с
 * двумя дорожками в режиме `worktree`, настоящий прогон, настоящий
 * `applyRun`, настоящий файл очереди. Фальшивого `stepcast` здесь нет —
 * `merge.ts` зовётся внутрипроцессно, как и в жизни.
 *
 * Работы дорожек названы `work-<дорожка>` / `confirm-<дорожка>` — ни одна не
 * называется `verify` и не несёт суффикса, склеенного из имени дорожки:
 * решение о годности проверяется на именах, которых склейка `verify-${lane}`
 * не найдёт (см. `src/core/lanes/lanes.ts`).
 */

// Переходники к общим помощникам (`test/helpers.ts`): здесь репозиторий
// всегда корень проекта, и звать их проектом короче, чем путём.
function gitInit(project: Project): void {
  gitInitDir(project.root);
}

function commit(project: Project, message: string): void {
  gitCommit(project.root, message);
}

/** workspace-anchor, «Наложение не сошлось»/«Наложение сошлось»: `stateDir` наложения не переживает вызова. */
function leakedApplyDirs(): string[] {
  return readdirSync(process.env['TMPDIR']!).filter((name) => name.startsWith('stepcast-apply-'));
}

function commitCountAt(dir: string): number {
  return Number(execFileSync('git', ['-C', dir, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim());
}

function commitCount(project: Project): number {
  return commitCountAt(project.root);
}

function commitMessages(project: Project, count: number): string[] {
  return execFileSync('git', ['-C', project.root, 'log', `-${count}`, '--format=%s'], { encoding: 'utf8' })
    .trim()
    .split('\n');
}

function headMessageAt(dir: string): string {
  return execFileSync('git', ['-C', dir, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim();
}

function headShaAt(dir: string): string {
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

/** Пути, которые несёт коммит `ref` — проверить, что отметка отката уехала именно в него. */
function committedPaths(dir: string, ref = 'HEAD'): string[] {
  return execFileSync('git', ['-C', dir, 'show', '--name-only', '--format=', ref], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter((line) => line !== '');
}

/** Незакоммиченное и неотслеживаемое дерева — то, на чём упрётся головное предусловие следующего захода. */
function porcelainAt(dir: string): string {
  return execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
}

/** Тот же проект, но с объявленным составом `project.nested_repos`. */
function withNestedRepos(project: Project, nestedRepos: readonly string[]): Config {
  return { ...project.config, project: { ...project.config.project, nestedRepos } };
}

/** То же, что `runLanes`, но с переданной конфигурацией — для составного прогона. */
async function runLanesWithConfig(project: Project, runsRoot: string, config: Config): Promise<RunResult> {
  const expanded = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config });
  return runPipeline({
    expanded,
    config: { ...config, runs: { ...config.runs, root: runsRoot } },
    projectRoot: project.root,
    cwd: project.root,
  });
}

/**
 * Корень плюс объявленные вложенные репозитории (`backend` и, по запросу,
 * ещё названные), у каждого — начальный коммит. Backend отслеживается корнем
 * гитлинком (тот же приём, что и в фикстурах составного якоря): `.gitkeep`
 * заведён файлом до `git init` части, а начальный корневой коммит подхватывает
 * получившийся гитлинк.
 */
function makeCompositeProject(pipeline: string, extraRepos: readonly string[] = []): Project {
  const files: Record<string, string> = { 'stepcast.yml': pipeline, 'backend/.gitkeep': '' };
  for (const repo of extraRepos) files[`${repo}/.gitkeep`] = '';

  const project = makeProject(files);
  gitInit(project);
  gitInitDir(project.path('backend'));
  gitCommit(project.path('backend'), 'начало backend');
  for (const repo of extraRepos) {
    gitInitDir(project.path(repo));
    gitCommit(project.path(repo), `начало ${repo}`);
  }
  commit(project, 'начальный');
  return project;
}

/** Дорожка `a`: один шаг пишет и в корень, и в объявленный вложенный репозиторий `backend`. */
const COMPOSITE_LANE_PIPELINE = `
version: 1
kind: pipeline
name: составная-дорожка
workspace: { mode: worktree }
jobs:
  work-a:
    lane: a
    steps:
      - id: шаг
        run: [sh, -c, 'printf "root от a\\n" > root-a.txt; printf "backend от a\\n" > backend/backend-a.txt']
        expect: [{ exit_code: 0 }]
`;

/**
 * Дорожки `a` и `b`: `a` правит корень и `backend` (как `COMPOSITE_LANE_PIPELINE`),
 * `b` правит только корень своим файлом — не задевая `backend` вовсе, чтобы её
 * собственный `affectedRepos` не включал часть, откаченную дорожкой `a`.
 */
const TWO_LANE_COMPOSITE_PIPELINE = `
version: 1
kind: pipeline
name: две-составные-дорожки
workspace: { mode: worktree }
concurrency: 2
fail_fast: false
jobs:
  work-a:
    lane: a
    steps:
      - id: шаг
        run: [sh, -c, 'printf "root от a\\n" > root-a.txt; printf "backend от a\\n" > backend/backend-a.txt']
        expect: [{ exit_code: 0 }]
  work-b:
    lane: b
    steps:
      - id: шаг
        run: [sh, -c, 'printf "root от b\\n" > root-b.txt']
        expect: [{ exit_code: 0 }]
`;

/** Дорожка `a`: правит только объявленный вложенный репозиторий `backend`, корень не трогает. */
const BACKEND_ONLY_LANE_PIPELINE = `
version: 1
kind: pipeline
name: дорожка-только-backend
workspace: { mode: worktree }
jobs:
  work-a:
    lane: a
    steps:
      - id: шаг
        run: [sh, -c, 'printf "backend от a\\n" > backend/backend-a.txt']
        expect: [{ exit_code: 0 }]
`;

/**
 * Три дорожки: `a` правит только корень и сводится; `b` правит `backend` и
 * заканчивается неуспешной работой; `c` правит `backend` успешно, но пункта
 * очереди ей не достаётся. Ни `b`, ни `c` не сведутся ни при какой
 * конфигурации — недостающая команда проверки `backend` не вправе ронять
 * из-за них обход целиком.
 */
const MIXED_LANES_PIPELINE = `
version: 1
kind: pipeline
name: годная-и-негодные-дорожки
workspace: { mode: worktree }
concurrency: 1
fail_fast: false
jobs:
  work-a:
    lane: a
    steps:
      - id: шаг
        run: [sh, -c, 'printf "root от a\\n" > root-a.txt']
        expect: [{ exit_code: 0 }]
  work-b:
    lane: b
    steps:
      - id: шаг
        run: [sh, -c, 'printf "backend от b\\n" > backend/backend-b.txt; exit 1']
        expect: [{ exit_code: 0 }]
  work-c:
    lane: c
    steps:
      - id: шаг
        run: [sh, -c, 'printf "backend от c\\n" > backend/backend-c.txt']
        expect: [{ exit_code: 0 }]
`;

/**
 * Дорожка `a`: коммитит внутри `backend` — сама изоляция дорожки не мешает
 * этому (это её собственный worktree её же репозитория), а движок такого
 * коммита никогда не делает сам. Двигает запись gitlink `backend` в корне,
 * не меняя содержимого части, — состояние, которого движок не порождает
 * (design.md, решение 5).
 */
const GITLINK_LANE_PIPELINE = `
version: 1
kind: pipeline
name: дорожка-двигает-gitlink
workspace: { mode: worktree }
jobs:
  work-a:
    lane: a
    steps:
      - id: шаг
        run: [sh, -c, 'cd backend && git commit --allow-empty -m "коммит части (тест)"']
        expect: [{ exit_code: 0 }]
`;

async function runLanes(project: Project, runsRoot: string): Promise<RunResult> {
  const expanded = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config });
  return runPipeline({
    expanded,
    config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
    projectRoot: project.root,
    cwd: project.root,
  });
}

function writeItem(runDir: string, lane: string, slug: string, title: string): void {
  writeFileSync(join(runDir, `item-${lane}.json`), JSON.stringify({ slug, title }));
}

function backlogItem(slug: string, status = 'in_progress'): string {
  return `## ${slug}\n\nstatus: ${status}\ntitle: Улучшение ${slug}\nwhy: з\ndone_when: к\n`;
}

function statusOf(text: string, slug: string): string | undefined {
  const section = text.split(`## ${slug}\n`)[1]?.split('\n## ')[0] ?? '';
  return /^status:\s*(.*)$/m.exec(section)?.[1];
}

function fieldOf(text: string, slug: string, name: string): string | undefined {
  const section = text.split(`## ${slug}\n`)[1]?.split('\n## ')[0] ?? '';
  return new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(section)?.[1];
}

/** Пайплайн с единственной дорожкой `a`. */
function oneLanePipeline(aCommand: string): string {
  return `
version: 1
kind: pipeline
name: одна-дорожка
workspace: { mode: worktree }
jobs:
  work-a:
    lane: a
    steps: [{ id: шаг, run: [sh, -c, '${aCommand}'], expect: [{ exit_code: 0 }] }]
`;
}

/** Та же дорожка с публикацией поверх локальных правок и явно живой очередью. */
function dirtyTreeLanePipeline(aCommand: string): string {
  return `
version: 1
kind: pipeline
name: дорожка-поверх-грязного-дерева
workspace:
  mode: worktree
  source: commit
  preserve_local_changes: true
  live_files:
    - path: backlog.md
      writeback: always
      commit_on_success: true
jobs:
  work-a:
    lane: a
    steps: [{ id: шаг, run: [sh, -c, '${aCommand}'], expect: [{ exit_code: 0 }] }]
`;
}

function dirtyTreeLanePipelineWithNotes(aCommand: string): string {
  return `
version: 1
kind: pipeline
name: дорожка-с-некоммитным-live-файлом
workspace:
  mode: worktree
  source: commit
  preserve_local_changes: true
  live_files:
    - { path: backlog.md, writeback: always, commit_on_success: true }
    - { path: notes.md, writeback: always, commit_on_success: false }
jobs:
  work-a:
    lane: a
    steps: [{ id: шаг, run: [sh, -c, '${aCommand}'], expect: [{ exit_code: 0 }] }]
`;
}

/** Пайплайн с двумя однорабочими дорожками — по умолчанию обе завершаются успешно. */
function twoLanePipeline(aCommand: string, bCommand: string): string {
  return `
version: 1
kind: pipeline
name: две-дорожки
workspace: { mode: worktree }
concurrency: 2
fail_fast: false
jobs:
  work-a:
    lane: a
    steps: [{ id: шаг, run: [sh, -c, '${aCommand}'], expect: [{ exit_code: 0 }] }]
  work-b:
    lane: b
    steps: [{ id: шаг, run: [sh, -c, '${bCommand}'], expect: [{ exit_code: 0 }] }]
`;
}

/** Пайплайн с тремя однорабочими дорожками — по умолчанию все завершаются успешно. */
function threeLanePipeline(aCommand: string, bCommand: string, cCommand: string): string {
  return `
version: 1
kind: pipeline
name: три-дорожки
workspace: { mode: worktree }
concurrency: 3
fail_fast: false
jobs:
  work-a:
    lane: a
    steps: [{ id: шаг, run: [sh, -c, '${aCommand}'], expect: [{ exit_code: 0 }] }]
  work-b:
    lane: b
    steps: [{ id: шаг, run: [sh, -c, '${bCommand}'], expect: [{ exit_code: 0 }] }]
  work-c:
    lane: c
    steps: [{ id: шаг, run: [sh, -c, '${cCommand}'], expect: [{ exit_code: 0 }] }]
`;
}

const SUCCESS_A = 'printf "от a\\n" > a.txt';
const SUCCESS_B = 'printf "от b\\n" > b.txt';
const SUCCESS_C = 'printf "от c\\n" > c.txt';

describe('core: mergeLanes — публикация поверх нечистого дерева', () => {
  it('не перезаписывает live-очередь, изменённую во время интеграционной проверки', async () => {
    const project = makeProject({
      'stepcast.yml': dirtyTreeLanePipeline(SUCCESS_A),
      'backlog.md': backlogItem('a-item'),
    });
    gitInit(project);
    commit(project, 'начальный');
    const baseHead = headShaAt(project.root);
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a'],
      check: `printf concurrent > "${project.path('backlog.md')}"`,
      file: project.path('backlog.md'),
    });

    assert.equal(outcomes[0]?.kind, 'publication_conflict');
    assert.equal(headShaAt(project.root), baseHead);
    assert.equal(readFileSync(project.path('backlog.md'), 'utf8'), 'concurrent');
  });

  it('возвращает commit_on_success: false в checkout, но не включает его в коммит', async () => {
    const project = makeProject({
      'stepcast.yml': dirtyTreeLanePipelineWithNotes('printf "от a\\n" > a.txt; printf "lane\\n" > notes.md'),
      'backlog.md': backlogItem('a-item'),
      'notes.md': 'base\n',
    });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);
    assert.equal(readFileSync(project.path('notes.md'), 'utf8'), 'lane\n');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a'],
      check: 'exit 0',
      file: project.path('backlog.md'),
    });

    assert.equal(outcomes[0]?.kind, 'merged');
    assert.equal(readFileSync(project.path('notes.md'), 'utf8'), 'lane\n');
    assert.match(porcelainAt(project.root), /^M notes\.md$/m);
    assert.equal(
      execFileSync('git', ['-C', project.root, 'diff', '--cached', '--name-only', '--', 'notes.md'], {
        encoding: 'utf8',
      }),
      '',
    );
    assert.deepEqual(committedPaths(project.root), ['a.txt', 'backlog.md']);
  });

  it('коммитит результат и live-очередь, оставляя unrelated staged, unstaged и untracked локальными', async () => {
    const project = makeProject({
      'stepcast.yml': dirtyTreeLanePipeline(SUCCESS_A),
      'backlog.md': backlogItem('a-item'),
      'tracked.txt': 'base\n',
    });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');

    writeFileSync(project.path('tracked.txt'), 'staged\n');
    execFileSync('git', ['-C', project.root, 'add', 'tracked.txt']);
    writeFileSync(project.path('tracked.txt'), 'staged и unstaged\n');
    writeFileSync(project.path('draft.txt'), 'untracked\n');

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a'],
      check: 'exit 0',
      file: project.path('backlog.md'),
    });

    assert.equal(outcomes[0]?.kind, 'merged');
    assert.equal(readFileSync(project.path('a.txt'), 'utf8'), 'от a\n');
    assert.equal(readFileSync(project.path('tracked.txt'), 'utf8'), 'staged и unstaged\n');
    assert.equal(readFileSync(project.path('draft.txt'), 'utf8'), 'untracked\n');
    assert.equal(statusOf(readFileSync(project.path('backlog.md'), 'utf8'), 'a-item'), 'done');
    assert.match(porcelainAt(project.root), /^MM tracked\.txt$/m);
    assert.match(porcelainAt(project.root), /^\?\? draft\.txt$/m);
    assert.deepEqual(committedPaths(project.root), ['a.txt', 'backlog.md']);
    assert.equal(execFileSync('git', ['-C', project.root, 'stash', 'list'], { encoding: 'utf8' }), '');
    assert.equal(existsSync(join(result.journal.paths.dir, 'publication-recovery.json')), false);
  });

  it('объединяет далёкие правки одного файла, сохраняя staged и unstaged границу', async () => {
    const base = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n';
    const project = makeProject({
      'stepcast.yml': dirtyTreeLanePipeline(
        'sed -i.bak "s/^ten$/pipeline/" shared.txt && rm shared.txt.bak',
      ),
      'backlog.md': backlogItem('a-item'),
      'shared.txt': base,
    });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');

    writeFileSync(project.path('shared.txt'), base.replace('one', 'staged'));
    execFileSync('git', ['-C', project.root, 'add', 'shared.txt']);
    writeFileSync(project.path('shared.txt'), base.replace('one', 'staged').replace('two', 'unstaged'));

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a'],
      check: 'exit 0',
      file: project.path('backlog.md'),
    });

    assert.equal(outcomes[0]?.kind, 'merged');
    assert.equal(
      readFileSync(project.path('shared.txt'), 'utf8'),
      base.replace('one', 'staged').replace('two', 'unstaged').replace('ten', 'pipeline'),
    );
    assert.match(porcelainAt(project.root), /^MM shared\.txt$/m);
  });

  it('на настоящем конфликте не меняет HEAD и локальные байты, оставляя интеграционный результат', async () => {
    const project = makeProject({
      'stepcast.yml': dirtyTreeLanePipeline('printf "pipeline\\n" > shared.txt'),
      'backlog.md': backlogItem('a-item'),
      'shared.txt': 'base\n',
    });
    gitInit(project);
    commit(project, 'начальный');
    const baseHead = headShaAt(project.root);
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    writeFileSync(project.path('shared.txt'), 'local\n');

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a'],
      check: 'exit 0',
      file: project.path('backlog.md'),
    });

    assert.equal((outcomes[0] as { kind: string } | undefined)?.kind, 'publication_conflict');
    assert.equal(headShaAt(project.root), baseHead);
    assert.equal(readFileSync(project.path('shared.txt'), 'utf8'), 'local\n');
    assert.equal(existsSync(join(result.journal.paths.dir, 'integration')), true);
    assert.equal(execFileSync('git', ['-C', project.root, 'stash', 'list'], { encoding: 'utf8' }), '');
  });

  it('красная проверка портит только одноразовое интеграционное дерево', async () => {
    const project = makeProject({
      'stepcast.yml': dirtyTreeLanePipeline(SUCCESS_A),
      'backlog.md': backlogItem('a-item'),
    });
    gitInit(project);
    commit(project, 'начальный');
    const baseHead = headShaAt(project.root);
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    writeFileSync(project.path('local-draft.txt'), 'keep\n');

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a'],
      check: 'printf "check debris\\n" > check-debris.txt; exit 1',
      file: project.path('backlog.md'),
    });

    assert.equal(outcomes[0]?.kind, 'check_failed');
    assert.equal(headShaAt(project.root), baseHead);
    assert.equal(existsSync(project.path('a.txt')), false);
    assert.equal(existsSync(project.path('check-debris.txt')), false);
    assert.equal(readFileSync(project.path('local-draft.txt'), 'utf8'), 'keep\n');
    assert.equal(statusOf(readFileSync(project.path('backlog.md'), 'utf8'), 'a-item'), 'failed');
  });

  it('публикует составной результат в корень и вложенный репозиторий поверх их локальных правок', async () => {
    const pipeline = dirtyTreeLanePipeline(
      'printf "root pipeline\\n" > root-a.txt; printf "backend pipeline\\n" > backend/backend-a.txt',
    );
    const project = makeCompositeProject(pipeline);
    writeFileSync(project.path('backlog.md'), backlogItem('a-item'));
    writeFileSync(project.path('root-local.txt'), 'base\n');
    writeFileSync(project.path('backend/backend-local.txt'), 'base\n');
    gitCommit(project.path('backend'), 'backend fixtures');
    commit(project, 'очередь и fixtures');
    const runsRoot = tempDir('lanes-runs-');
    const config = withNestedRepos(project, ['backend']);
    const result = await runLanesWithConfig(project, runsRoot, config);
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');

    writeFileSync(project.path('root-local.txt'), 'root local\n');
    writeFileSync(project.path('backend/backend-local.txt'), 'backend local\n');

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a'],
      check: 'exit 0',
      file: project.path('backlog.md'),
      nestedRepos: ['backend'],
      repoChecks: new Map([['backend', 'exit 0']]),
    });

    assert.equal(outcomes[0]?.kind, 'merged');
    assert.equal(readFileSync(project.path('root-a.txt'), 'utf8'), 'root pipeline\n');
    assert.equal(readFileSync(project.path('backend/backend-a.txt'), 'utf8'), 'backend pipeline\n');
    assert.equal(readFileSync(project.path('root-local.txt'), 'utf8'), 'root local\n');
    assert.equal(readFileSync(project.path('backend/backend-local.txt'), 'utf8'), 'backend local\n');
    assert.match(porcelainAt(project.root), /^M backend$/m, 'грязь вложенного дерева видна корню как прежде');
    assert.match(porcelainAt(project.root), /^ M root-local\.txt$/m);
    assert.equal(porcelainAt(project.path('backend')), 'M backend-local.txt');
  });

  it('не начинает новый обход поверх журнала прерванной публикации', async () => {
    const project = makeProject({
      'stepcast.yml': dirtyTreeLanePipeline(SUCCESS_A),
      'backlog.md': backlogItem('a-item'),
    });
    gitInit(project);
    commit(project, 'начальный');
    const baseHead = headShaAt(project.root);
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    const recovery = join(result.journal.paths.dir, 'publication-recovery.json');
    writeFileSync(recovery, JSON.stringify({ version: 1, published: ['.'] }));

    await assert.rejects(
      () =>
        mergeLanes({
          paths: result.journal.paths,
          cwd: project.root,
          lanes: ['a'],
          check: 'exit 0',
          file: project.path('backlog.md'),
        }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /публикация прервалась/);
        assert.equal(error.file, recovery);
        return true;
      },
    );
    assert.equal(headShaAt(project.root), baseHead);
    assert.equal(existsSync(project.path('a.txt')), false);
  });
});

describe('core: mergeLanes — наложение и порядок', () => {
  it('обе годные дорожки сводятся в порядке перечня, каждая своим коммитом', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, `${backlogItem('a-item')}\n${backlogItem('b-item')}`);
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'Заголовок A');
    writeItem(result.journal.paths.dir, 'b', 'b-item', 'Заголовок B');

    const before = commitCount(project);
    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a', 'b'],
      check: 'exit 0',
      file: backlogFile,
    });

    assert.deepEqual(
      outcomes.map((o) => o.kind),
      ['merged', 'merged'],
    );
    assert.equal(commitCount(project), before + 2);
    assert.deepEqual(commitMessages(project, 2).reverse(), [
      'a-item: Заголовок A',
      'b-item: Заголовок B',
    ]);
    assert.equal(readFileSync(project.path('a.txt'), 'utf8'), 'от a\n');
    assert.equal(readFileSync(project.path('b.txt'), 'utf8'), 'от b\n');

    const text = readFileSync(backlogFile, 'utf8');
    assert.equal(statusOf(text, 'a-item'), 'done');
    assert.equal(statusOf(text, 'b-item'), 'done');
  });

  it('вторая дорожка ложится на дерево, уже несущее первую', async () => {
    const project = makeProject({
      'stepcast.yml': twoLanePipeline(
        'printf "общий файл, правка a\\n" > общий.txt',
        'printf "от b\\n" > b.txt',
      ),
    });
    gitInit(project);
    writeFileSync(project.path('общий.txt'), 'исходное\n');
    commit(project, 'начальный');
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, `${backlogItem('a-item')}\n${backlogItem('b-item')}`);
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    writeItem(result.journal.paths.dir, 'b', 'b-item', 'B');

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a', 'b'],
      check: 'exit 0',
      file: backlogFile,
    });

    assert.deepEqual(outcomes.map((o) => o.kind), ['merged', 'merged']);
    assert.equal(readFileSync(project.path('общий.txt'), 'utf8'), 'общий файл, правка a\n');
    assert.equal(readFileSync(project.path('b.txt'), 'utf8'), 'от b\n');
  });
});

/**
 * Спека lane-merge: «Перечень дорожек сведения выводится из прогона» и
 * «Дорожка, известная прогону и не названная перечнем, — отказ» (design.md,
 * решение 3). `--lanes all` берёт `knownLanes(status.jobs)` целиком, а
 * укороченный явный перечень становится отказом, наступающим до первого
 * наложения.
 */
describe('core: mergeLanes — --lanes all и отказ на укороченном перечне', () => {
  it('all сводит обе дорожки прогона', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, `${backlogItem('a-item')}\n${backlogItem('b-item')}`);
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    writeItem(result.journal.paths.dir, 'b', 'b-item', 'B');

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: 'all',
      check: 'exit 0',
      file: backlogFile,
    });

    assert.deepEqual(outcomes.map((o) => o.kind), ['merged', 'merged']);
    assert.equal(readFileSync(project.path('a.txt'), 'utf8'), 'от a\n');
    assert.equal(readFileSync(project.path('b.txt'), 'utf8'), 'от b\n');
  });

  it('all на прогоне без единой метки lane отказывает, называя это, не трогая дерева', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: без-дорожек
workspace: { mode: worktree }
jobs:
  work:
    steps: [{ id: шаг, run: [sh, -c, '${SUCCESS_A}'], expect: [{ exit_code: 0 }] }]
`,
    });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, '# Очередь\n');
    commit(project, 'добавлена очередь');
    const before = commitCount(project);

    await assert.rejects(
      () =>
        mergeLanes({
          paths: result.journal.paths,
          cwd: project.root,
          lanes: 'all',
          check: 'exit 0',
          file: backlogFile,
        }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.exitCode, ExitCode.configError);
        assert.match(error.message, /нет ни одной работы с меткой lane/);
        return true;
      },
    );
    assert.equal(commitCount(project), before);
    assert.equal(existsSync(project.path('a.txt')), false);
  });

  it('укороченный явный перечень отказывает, называя недостающую дорожку и оба способа выразить намерение, дерево не тронуто', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, `${backlogItem('a-item')}\n${backlogItem('b-item')}`);
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    writeItem(result.journal.paths.dir, 'b', 'b-item', 'B');
    const before = commitCount(project);

    await assert.rejects(
      () =>
        mergeLanes({
          paths: result.journal.paths,
          cwd: project.root,
          lanes: ['a'],
          check: 'exit 0',
          file: backlogFile,
        }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.exitCode, ExitCode.configError);
        assert.match(error.message, /b/);
        assert.match(error.hint ?? '', /all/);
        assert.match(error.hint ?? '', /lane/);
        return true;
      },
    );
    assert.equal(commitCount(project), before, 'дерево не тронуто');
    assert.equal(existsSync(project.path('a.txt')), false, 'наложения не было вовсе');
    assert.equal(statusOf(readFileSync(backlogFile, 'utf8'), 'a-item'), 'in_progress', 'очередь не правлена');
  });

  it('полный явный перечень работает как прежде', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, `${backlogItem('a-item')}\n${backlogItem('b-item')}`);
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    writeItem(result.journal.paths.dir, 'b', 'b-item', 'B');

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a', 'b'],
      check: 'exit 0',
      file: backlogFile,
    });

    assert.deepEqual(outcomes.map((o) => o.kind), ['merged', 'merged']);
  });

  it('цепочка без метки lane упоминания в all не требует', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: две-дорожки-и-без-метки
workspace: { mode: worktree }
concurrency: 3
fail_fast: false
jobs:
  work-a:
    lane: a
    steps: [{ id: шаг, run: [sh, -c, '${SUCCESS_A}'], expect: [{ exit_code: 0 }] }]
  work-b:
    lane: b
    steps: [{ id: шаг, run: [sh, -c, '${SUCCESS_B}'], expect: [{ exit_code: 0 }] }]
  outside:
    steps: [{ id: шаг, run: [echo, вне-дорожек], expect: [{ exit_code: 0 }] }]
`,
    });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, `${backlogItem('a-item')}\n${backlogItem('b-item')}`);
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    writeItem(result.journal.paths.dir, 'b', 'b-item', 'B');

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: 'all',
      check: 'exit 0',
      file: backlogFile,
    });

    assert.deepEqual(outcomes.map((o) => o.kind), ['merged', 'merged']);
  });
});

describe('core: mergeLanes — отбор годности', () => {
  it('дорожка с провалившейся работой пропускается, не мешая следующей', async () => {
    const project = makeProject({
      'stepcast.yml': twoLanePipeline('exit 1', SUCCESS_B),
    });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, `${backlogItem('a-item')}\n${backlogItem('b-item')}`);
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    writeItem(result.journal.paths.dir, 'b', 'b-item', 'B');

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a', 'b'],
      check: 'exit 0',
      file: backlogFile,
    });

    assert.equal(outcomes[0]?.kind, 'unfit');
    assert.equal(outcomes[1]?.kind, 'merged');
    assert.equal(existsSync(project.path('a.txt')), false);
    assert.equal(existsSync(project.path('b.txt')), true);

    const text = readFileSync(backlogFile, 'utf8');
    assert.equal(statusOf(text, 'a-item'), 'failed');
    assert.match(fieldOf(text, 'a-item', 'reason') ?? '', /work-a=failed/);
    assert.equal(statusOf(text, 'b-item'), 'done');
  });

  it('работа, пропущенная условием, сведению не мешает', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: смешанная-дорожка
workspace: { mode: worktree }
jobs:
  work-a:
    lane: a
    steps: [{ id: шаг, run: [sh, -c, '${SUCCESS_A}'], expect: [{ exit_code: 0 }] }]
  confirm-a:
    lane: a
    needs: [work-a]
    if: "false"
    steps: [{ id: шаг, run: [sh, -c, 'printf "confirm\\n" > confirm-a.txt'], expect: [{ exit_code: 0 }] }]
`,
    });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, backlogItem('a-item'));
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a'],
      check: 'exit 0',
      file: backlogFile,
    });

    // Пропуск по решению графа — норма разведённых веток дорожки
    // (`track: express` в очереди петли), а не недоделанная работа: сведение
    // судит по тем работам, которые дорожка обязана была пройти.
    assert.equal(outcomes[0]?.kind, 'merged');
    assert.equal(existsSync(project.path('a.txt')), true);
    assert.equal(existsSync(project.path('confirm-a.txt')), false);
    assert.equal(statusOf(readFileSync(backlogFile, 'utf8'), 'a-item'), 'done');
  });

  it('дорожка, все работы которой skipped, пропускается без отказа и без правки очереди', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: пустой-слот
workspace: { mode: worktree }
jobs:
  work-a:
    lane: a
    if: "false"
    steps: [{ id: шаг, run: [sh, -c, '${SUCCESS_A}'], expect: [{ exit_code: 0 }] }]
`,
    });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, '# Очередь\n');
    commit(project, 'добавлена очередь');
    const before = commitCount(project);

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a'],
      check: 'exit 0',
      file: backlogFile,
    });

    assert.deepEqual(outcomes, [{ lane: 'a', kind: 'empty' }]);
    assert.equal(commitCount(project), before);
    assert.equal(readFileSync(backlogFile, 'utf8'), '# Очередь\n');
  });

  it('неизвестная дорожка отказывает кодом 2 (StepcastError), перечисляя известные, ничего не накладывая', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);
    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, '# Очередь\n');
    commit(project, 'добавлена очередь');
    const before = commitCount(project);

    await assert.rejects(
      () =>
        mergeLanes({
          paths: result.journal.paths,
          cwd: project.root,
          lanes: ['нет-такой'],
          check: 'exit 0',
          file: backlogFile,
        }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.exitCode, ExitCode.configError);
        assert.match(error.message, /нет-такой/);
        assert.match(error.hint ?? '', /a/);
        assert.match(error.hint ?? '', /b/);
        return true;
      },
    );
    assert.equal(commitCount(project), before);
    assert.equal(existsSync(project.path('a.txt')), false);
  });

  it('решение о годности не сравнивает имя работы со строкой verify', async () => {
    // Работы дорожки называются нарочно иначе, чем «verify»/«verify-a»: тест
    // падает, если evaluateLane вернётся к склейке имени со строкой.
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: имена-не-по-шаблону
workspace: { mode: worktree }
jobs:
  придумай-название:
    lane: a
    steps: [{ id: шаг, run: [sh, -c, '${SUCCESS_A}'], expect: [{ exit_code: 0 }] }]
`,
    });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, backlogItem('a-item'));
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a'],
      check: 'exit 0',
      file: backlogFile,
    });

    assert.equal(outcomes[0]?.kind, 'merged');
    assert.equal(readFileSync(project.path('a.txt'), 'utf8'), 'от a\n');
  });
});

describe('core: mergeLanes — красная проверка', () => {
  it('откатывает дерево к коммиту до наложения, дорожка получает failed, код 1 на уровне CLI', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, `${backlogItem('a-item')}\n${backlogItem('b-item')}`);
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    writeItem(result.journal.paths.dir, 'b', 'b-item', 'B');

    const beforeCount = commitCount(project);
    // Проверка красная ровно тогда, когда в дереве уже лежит b.txt — то есть
    // после наложения второй дорожки: первая сходит зелёной и коммитится.
    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a', 'b'],
      check: 'test ! -f b.txt',
      file: backlogFile,
    });

    assert.equal(outcomes[0]?.kind, 'merged');
    assert.equal(outcomes[1]?.kind, 'check_failed');
    assert.equal(existsSync(project.path('a.txt')), true, 'дорожка a уже сведена и остаётся на месте');
    assert.equal(existsSync(project.path('b.txt')), false, 'откат снял файлы дорожки b');
    assert.equal(commitCount(project), beforeCount + 1, 'коммит получила только дорожка a');

    const text = readFileSync(backlogFile, 'utf8');
    assert.equal(statusOf(text, 'a-item'), 'done');
    assert.equal(statusOf(text, 'b-item'), 'failed');
    assert.match(fieldOf(text, 'b-item', 'reason') ?? '', /красная/);
  });

  it('красная проверка первой дорожки не мешает второй свестись', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, `${backlogItem('a-item')}\n${backlogItem('b-item')}`);
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    writeItem(result.journal.paths.dir, 'b', 'b-item', 'B');

    const beforeCount = commitCount(project);
    // Проверка красная ровно тогда, когда в дереве лежит a.txt — то есть
    // сразу после наложения первой дорожки. Обе работы дорожек зелёные:
    // красной оказывается только объединённое дерево, а не сама дорожка a.
    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a', 'b'],
      check: 'test ! -f a.txt',
      file: backlogFile,
    });

    assert.equal(outcomes[0]?.kind, 'check_failed');
    assert.equal(outcomes[1]?.kind, 'merged');
    assert.equal(existsSync(project.path('a.txt')), false, 'откат снял файлы дорожки a');
    assert.equal(existsSync(project.path('b.txt')), true, 'дорожка b сведена и остаётся на месте');
    assert.equal(commitCount(project), beforeCount + 1, 'коммит получила только дорожка b');

    const text = readFileSync(backlogFile, 'utf8');
    assert.equal(statusOf(text, 'a-item'), 'failed');
    assert.match(fieldOf(text, 'a-item', 'reason') ?? '', /красная/);
    assert.equal(statusOf(text, 'b-item'), 'done');
  });

  it('игнорируемый путь переживает откат красной проверки', async () => {
    const project = makeProject({
      'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B),
      '.gitignore': 'сборка/\n',
    });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, backlogItem('a-item'));
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');

    // Побочный файл красной проверки — в игнорируемом каталоге, как кеш сборки.
    const check =
      'mkdir -p сборка && printf "кеш\\n" > сборка/кеш.txt && exit 1';

    await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      // all, а не ['a']: пайплайн двухдорожечный, а перечень обязан называть
      // каждую известную прогону дорожку. Дорожка b без item-файла резолвится
      // no_item и обходу не мешает.
      lanes: 'all',
      check,
      file: backlogFile,
    });

    assert.ok(existsSync(project.path('сборка/кеш.txt')), 'игнорируемый путь обязан пережить откат');
  });

  it('откат не стирает исходы, проставленные более ранним дорожкам того же обхода', async () => {
    // Дорожка a негодна (её работа провалилась), поэтому её `failed` пишется
    // в очередь, но никаким коммитом не закрепляется. Дальше красная проверка
    // дорожки b откатывает дерево — вместе с отслеживаемым `backlog.md`.
    // Отметка дорожки a обязана уцелеть: иначе её пункт остался бы
    // `in_progress` с потерянной различимой причиной.
    const project = makeProject({ 'stepcast.yml': twoLanePipeline('exit 1', SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, `${backlogItem('a-item')}\n${backlogItem('b-item')}`);
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    writeItem(result.journal.paths.dir, 'b', 'b-item', 'B');
    const beforeCount = commitCount(project);

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a', 'b'],
      check: 'test ! -f b.txt',
      file: backlogFile,
    });

    assert.equal(outcomes[0]?.kind, 'unfit');
    assert.equal(outcomes[1]?.kind, 'check_failed');
    assert.equal(commitCount(project), beforeCount, 'ни одна дорожка не сведена');
    assert.equal(existsSync(project.path('b.txt')), false, 'откат снял файлы дорожки b');

    const text = readFileSync(backlogFile, 'utf8');
    assert.equal(statusOf(text, 'a-item'), 'failed', 'отметка дорожки a пережила откат');
    assert.match(fieldOf(text, 'a-item', 'reason') ?? '', /work-a=failed/);
    assert.equal(statusOf(text, 'b-item'), 'failed');
    assert.match(fieldOf(text, 'b-item', 'reason') ?? '', /красная/);
  });

  it('обход продолжается после отката: игнорируемое цело, HEAD не сдвинут лишним коммитом, исход дорожки без вклада уцелел, отметка отката уехала в коммит следующей', async () => {
    const project = makeProject({
      'stepcast.yml': threeLanePipeline('exit 1', SUCCESS_B, SUCCESS_C),
      '.gitignore': 'сборка/\n',
    });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, `${backlogItem('a-item')}\n${backlogItem('b-item')}\n${backlogItem('c-item')}`);
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    writeItem(result.journal.paths.dir, 'b', 'b-item', 'B');
    writeItem(result.journal.paths.dir, 'c', 'c-item', 'C');

    const beforeCount = commitCount(project);
    const baseSha = headShaAt(project.root);
    // Побочный файл проверки — в игнорируемом каталоге, как кеш сборки; сама
    // проверка красная ровно при наличии b.txt, то есть после наложения b.
    const check = 'mkdir -p сборка && printf "кеш\\n" > сборка/кеш.txt && test ! -f b.txt';

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a', 'b', 'c'],
      check,
      file: backlogFile,
    });

    assert.equal(outcomes[0]?.kind, 'unfit');
    assert.equal(outcomes[1]?.kind, 'check_failed');
    assert.equal(outcomes[2]?.kind, 'merged');

    assert.ok(existsSync(project.path('сборка/кеш.txt')), 'игнорируемый путь должен пережить откат');
    assert.equal(existsSync(project.path('b.txt')), false, 'откат снял файлы дорожки b');
    assert.equal(existsSync(project.path('c.txt')), true, 'дорожка c сведена и остаётся на месте');

    // Единственный новый коммит — коммит c, лёгший прямо на состояние до
    // захода: ни негодность a, ни откат b лишнего коммита не оставили.
    assert.equal(commitCount(project), beforeCount + 1);
    assert.equal(headShaAt(project.root).length, 40);
    assert.equal(
      execFileSync('git', ['-C', project.root, 'rev-parse', 'HEAD~1'], { encoding: 'utf8' }).trim(),
      baseSha,
    );

    const text = readFileSync(backlogFile, 'utf8');
    assert.equal(statusOf(text, 'a-item'), 'failed', 'исход дорожки без вклада пережил откат b');
    assert.match(fieldOf(text, 'a-item', 'reason') ?? '', /work-a=failed/);
    assert.equal(statusOf(text, 'b-item'), 'failed');
    assert.match(fieldOf(text, 'b-item', 'reason') ?? '', /красная/);
    assert.equal(statusOf(text, 'c-item'), 'done');

    // Отметка `failed` откачённой b уезжает в тот же коммит, что и вклад c:
    // `git add -A` коммита c забирает весь файл очереди целиком.
    assert.ok(committedPaths(project.root).includes('backlog.md'));
  });
});

describe('core: mergeLanes — дорожка без взятого пункта', () => {
  it('годная дорожка без item-файла пропускается до наложения, не мешая следующей', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, backlogItem('b-item'));
    commit(project, 'добавлена очередь');
    // Пункт достался только дорожке b: у a файла пункта нет вовсе.
    writeItem(result.journal.paths.dir, 'b', 'b-item', 'B');
    const before = commitCount(project);

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a', 'b'],
      check: 'exit 0',
      file: backlogFile,
    });

    assert.deepEqual(outcomes[0], { lane: 'a', kind: 'no_item' });
    assert.equal(outcomes[1]?.kind, 'merged');
    assert.equal(existsSync(project.path('a.txt')), false, 'дорожка без пункта не накладывается вовсе');
    assert.equal(commitCount(project), before + 1, 'коммит только у дорожки b');
    assert.equal(statusOf(readFileSync(backlogFile, 'utf8'), 'b-item'), 'done');
  });

  it('файл пункта без слага отказывает до наложения, не оставляя дифф в дереве', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, backlogItem('a-item'));
    commit(project, 'добавлена очередь');
    writeFileSync(join(result.journal.paths.dir, 'item-a.json'), JSON.stringify({ title: 'без слага' }));
    const before = commitCount(project);

    await assert.rejects(
      () =>
        mergeLanes({
          paths: result.journal.paths,
          cwd: project.root,
          // all: b без item-файла не мешает — assertNoBrokenMerge доходит до
          // a первой (порядок появления) и там же падает на слаге.
          lanes: 'all',
          check: 'exit 0',
          file: backlogFile,
        }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.exitCode, ExitCode.configError);
        assert.match(error.file ?? '', /item-a\.json$/);
        return true;
      },
    );

    assert.equal(existsSync(project.path('a.txt')), false, 'дерево не тронуто отказом');
    assert.equal(commitCount(project), before);
  });
});

describe('core: mergeLanes — режим файла очереди', () => {
  it('сведение не сужает права backlog.md', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, backlogItem('a-item'));
    commit(project, 'добавлена очередь');
    chmodSync(backlogFile, 0o664);
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');

    await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: 'all',
      check: 'exit 0',
      file: backlogFile,
    });

    assert.equal(statSync(backlogFile).mode & 0o777, 0o664);
  });
});

describe('core: mergeLanes — конфликт наложения', () => {
  it('дерево не тронуто, обход прекращён, причина называет дорожку и её рабочее дерево', async () => {
    const project = makeProject({
      'спорный.txt': 'строка один\nстрока два\nстрока три\n',
      'stepcast.yml': `
version: 1
kind: pipeline
name: конфликт-дорожки
workspace: { mode: worktree }
concurrency: 2
fail_fast: false
jobs:
  work-a:
    lane: a
    steps:
      - id: шаг
        run: [sh, -c, 'printf "строка один\\nправка прогона\\nстрока три\\n" > спорный.txt']
        expect: [{ exit_code: 0 }]
  work-b:
    lane: b
    steps: [{ id: шаг, run: [sh, -c, '${SUCCESS_B}'], expect: [{ exit_code: 0 }] }]
`,
    });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);

    // Дерево остаётся чистым (предусловие сведения): расхождение вносится
    // отдельным коммитом поверх того же файла, а не незакоммиченной правкой.
    writeFileSync(project.path('спорный.txt'), 'строка один\nправка человека\nстрока три\n');
    commit(project, 'человек поправил спорный.txt пока шёл прогон');
    const beforeConflict = readFileSync(project.path('спорный.txt'), 'utf8');

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, `${backlogItem('a-item')}\n${backlogItem('b-item')}`);
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    writeItem(result.journal.paths.dir, 'b', 'b-item', 'B');
    const beforeCount = commitCount(project);

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a', 'b'],
      check: 'exit 0',
      file: backlogFile,
    });

    assert.equal(outcomes[0]?.kind, 'conflict');
    assert.match((outcomes[0] as { reason: string }).reason, /a/);
    assert.match((outcomes[0] as { reason: string }).reason, /worktree|workspace|work-a/);
    assert.equal(outcomes[1]?.kind, 'not_reached');
    // Причина недостигнутой дорожки называет конфликт как основание остановки —
    // второе основание (неподтверждённый откат) здесь ни при чём.
    assert.match((outcomes[1] as { reason: string }).reason, /конфликт наложения/);

    assert.equal(readFileSync(project.path('спорный.txt'), 'utf8'), beforeConflict);
    assert.equal(commitCount(project), beforeCount);
    assert.equal(existsSync(project.path('b.txt')), false, 'вторая дорожка не накладывается вовсе');
    assert.deepEqual(leakedApplyDirs(), [], 'несошедшееся наложение не должно оставлять stateDir');
  });
});

describe('core: mergeLanes — составной прогон', () => {
  const repoChecks = new Map([['backend', 'exit 0']]);

  it('дорожка правит корень и часть: по коммиту в каждом, одно сообщение, очередь коммитится последней', async () => {
    const project = makeCompositeProject(COMPOSITE_LANE_PIPELINE);
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanesWithConfig(project, runsRoot, withNestedRepos(project, ['backend']));
    assert.equal(result.status, 'success');

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, backlogItem('a-item'));
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'Заголовок A');

    const rootBefore = commitCount(project);
    const backendBefore = commitCountAt(project.path('backend'));

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a'],
      check: 'exit 0',
      file: backlogFile,
      nestedRepos: ['backend'],
      repoChecks,
    });

    assert.equal(outcomes[0]?.kind, 'merged');
    if (outcomes[0]?.kind === 'merged') assert.deepEqual([...outcomes[0].repos].sort(), ['.', 'backend']);

    // Корень (держит очередь) и backend — каждый ровно на один коммит вперёд.
    assert.equal(commitCount(project), rootBefore + 1);
    assert.equal(commitCountAt(project.path('backend')), backendBefore + 1);

    const message = 'a-item: Заголовок A';
    assert.equal(headMessageAt(project.root), message);
    assert.equal(headMessageAt(project.path('backend')), message);

    assert.equal(readFileSync(project.path('root-a.txt'), 'utf8'), 'root от a\n');
    assert.equal(readFileSync(join(project.path('backend'), 'backend-a.txt'), 'utf8'), 'backend от a\n');
    // Отметка `done` лежит в корневом коммите — том же, что несёт вклад корня.
    assert.equal(statusOf(readFileSync(backlogFile, 'utf8'), 'a-item'), 'done');
    // Корень ведёт `backend` гитлинком и коммитится после него — сдвинутая
    // запись подхвачена, дерево чисто: иначе головное предусловие следующего
    // захода упёрлось бы в неё.
    assert.equal(porcelainAt(project.root), '', 'корень чист после сведения');
  });

  it('дорожка правит только часть, очередь в корне: только backend получает коммит вклада', async () => {
    const project = makeCompositeProject(BACKEND_ONLY_LANE_PIPELINE);
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanesWithConfig(project, runsRoot, withNestedRepos(project, ['backend']));

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, backlogItem('a-item'));
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    const rootBefore = commitCount(project);
    const backendBefore = commitCountAt(project.path('backend'));

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a'],
      check: 'exit 0',
      file: backlogFile,
      nestedRepos: ['backend'],
      repoChecks,
    });

    assert.equal(outcomes[0]?.kind, 'merged');
    assert.equal(commitCountAt(project.path('backend')), backendBefore + 1, 'backend несёт вклад дорожки');
    assert.equal(commitCount(project), rootBefore + 1, 'корень несёт только коммит очереди');
    assert.equal(headMessageAt(project.root), 'a-item: A');
    assert.equal(porcelainAt(project.root), '', 'корень чист после сведения');
  });

  it('проверка вложенного репозитория исполняется в его каталоге, а не в корне', async () => {
    const project = makeCompositeProject(COMPOSITE_LANE_PIPELINE);
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanesWithConfig(project, runsRoot, withNestedRepos(project, ['backend']));

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, backlogItem('a-item'));
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');

    // Каждая команда зелена только в своём каталоге: вклад дорожки в корень
    // лежит по `root-a.txt`, вклад в часть — по `backend-a.txt` от корня
    // самой части. Исполни любую не там — она покраснеет.
    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a'],
      check: 'test -f root-a.txt && test ! -f backend-a.txt',
      file: backlogFile,
      nestedRepos: ['backend'],
      repoChecks: new Map([['backend', 'test -f backend-a.txt && test ! -f root-a.txt']]),
    });

    assert.equal(outcomes[0]?.kind, 'merged', JSON.stringify(outcomes[0]));
  });

  it('красная проверка второго затронутого репозитория откатывает оба, третий объявленный не тронут, игнорируемое переживает откат', async () => {
    const project = makeCompositeProject(COMPOSITE_LANE_PIPELINE, ['other']);
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanesWithConfig(project, runsRoot, withNestedRepos(project, ['backend', 'other']));
    assert.equal(result.status, 'success');

    // Игнорируемый путь внутри backend: откат не имеет права его стереть.
    writeFileSync(join(project.path('backend'), '.gitignore'), 'игнорируемое/\n');
    gitCommit(project.path('backend'), 'добавлен .gitignore backend');

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, backlogItem('a-item'));
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');

    const rootBefore = commitCount(project);
    const backendBefore = commitCountAt(project.path('backend'));
    const otherBefore = commitCountAt(project.path('other'));

    mkdirSync(join(project.path('backend'), 'игнорируемое'));
    writeFileSync(join(project.path('backend'), 'игнорируемое', 'кеш.txt'), 'сборочный кеш\n');

    // Проверка корня зелёная, backend — красная: корень проверяется первым
    // (детерминированный порядок), и его откат обязан снять и его коммит.
    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a'],
      check: 'exit 0',
      file: backlogFile,
      nestedRepos: ['backend', 'other'],
      repoChecks: new Map([['backend', 'exit 1']]),
    });

    assert.equal(outcomes[0]?.kind, 'check_failed');
    assert.match((outcomes[0] as { reason: string }).reason, /backend/);

    assert.equal(commitCount(project), rootBefore, 'корень откатан к коммиту до наложения');
    assert.equal(commitCountAt(project.path('backend')), backendBefore, 'backend откатан к коммиту до наложения');
    assert.equal(commitCountAt(project.path('other')), otherBefore, 'необъявленный вклад other не тронут откатом');

    assert.equal(existsSync(project.path('root-a.txt')), false);
    assert.equal(existsSync(join(project.path('backend'), 'backend-a.txt')), false);
    assert.ok(
      existsSync(join(project.path('backend'), 'игнорируемое', 'кеш.txt')),
      'игнорируемый путь должен пережить откат',
    );
    assert.equal(statusOf(readFileSync(backlogFile, 'utf8'), 'a-item'), 'failed');
  });

  it('дорожка, откачённая красной проверкой во вложенном репозитории, не мешает следующей свестись по своим репозиториям', async () => {
    const project = makeCompositeProject(TWO_LANE_COMPOSITE_PIPELINE);
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanesWithConfig(project, runsRoot, withNestedRepos(project, ['backend']));
    assert.equal(result.status, 'success');

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, `${backlogItem('a-item')}\n${backlogItem('b-item')}`);
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    writeItem(result.journal.paths.dir, 'b', 'b-item', 'B');

    const rootBefore = commitCount(project);
    const backendBefore = commitCountAt(project.path('backend'));

    // backend красная ровно при наличии вклада a — после её отката вторая
    // дорожка (правит только корень) ложится на дерево, от которого
    // отпочковывалась, и её собственная проверка backend не касается вовсе.
    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a', 'b'],
      check: 'exit 0',
      file: backlogFile,
      nestedRepos: ['backend'],
      repoChecks: new Map([['backend', 'test ! -f backend-a.txt']]),
    });

    assert.equal(outcomes[0]?.kind, 'check_failed');
    assert.match((outcomes[0] as { reason: string }).reason, /backend/);
    assert.equal(outcomes[1]?.kind, 'merged');

    assert.equal(existsSync(project.path('root-a.txt')), false, 'откат снял вклад a в корень');
    assert.equal(existsSync(join(project.path('backend'), 'backend-a.txt')), false, 'откат снял вклад a в backend');
    assert.equal(existsSync(project.path('root-b.txt')), true, 'дорожка b сведена и остаётся на месте');

    assert.equal(commitCountAt(project.path('backend')), backendBefore, 'backend не тронут: b его не затрагивает');
    assert.equal(commitCount(project), rootBefore + 1, 'единственный новый коммит — вклад b в корень');

    const text = readFileSync(backlogFile, 'utf8');
    assert.equal(statusOf(text, 'a-item'), 'failed');
    assert.equal(statusOf(text, 'b-item'), 'done');
  });

  it('затронутый репозиторий без объявленной команды проверки отказывает до первого наложения', async () => {
    const project = makeCompositeProject(COMPOSITE_LANE_PIPELINE);
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanesWithConfig(project, runsRoot, withNestedRepos(project, ['backend']));

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, backlogItem('a-item'));
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    const rootBefore = commitCount(project);

    await assert.rejects(
      () =>
        mergeLanes({
          paths: result.journal.paths,
          cwd: project.root,
          lanes: ['a'],
          check: 'exit 0',
          file: backlogFile,
          nestedRepos: ['backend'],
          // repoChecks не объявлен вовсе — у backend нет команды проверки.
        }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.exitCode, ExitCode.configError);
        assert.match(error.message, /backend/);
        assert.match(error.message, /a/);
        return true;
      },
    );

    assert.equal(commitCount(project), rootBefore, 'дерево не тронуто');
    assert.equal(existsSync(project.path('root-a.txt')), false, 'дорожка не накладывалась');
    assert.equal(statusOf(readFileSync(backlogFile, 'utf8'), 'a-item'), 'in_progress', 'очередь не правлена');
  });

  it('расхождение состава между прогоном и сведением отказывает, называя расхождение', async () => {
    const project = makeCompositeProject(COMPOSITE_LANE_PIPELINE, ['other']);
    const runsRoot = tempDir('lanes-runs-');
    // Прогон снят на составе из одного backend.
    const result = await runLanesWithConfig(project, runsRoot, withNestedRepos(project, ['backend']));

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, backlogItem('a-item'));
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');

    await assert.rejects(
      () =>
        mergeLanes({
          paths: result.journal.paths,
          cwd: project.root,
          lanes: ['a'],
          check: 'exit 0',
          file: backlogFile,
          // Сведение идёт при другом составе — backend и other.
          nestedRepos: ['backend', 'other'],
          repoChecks: new Map([
            ['backend', 'exit 0'],
            ['other', 'exit 0'],
          ]),
        }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /не совпадает с действующим/);
        return true;
      },
    );
  });

  it('патч дорожки, двигающий gitlink объявленного каталога, отказывает названной причиной', async () => {
    const project = makeCompositeProject(GITLINK_LANE_PIPELINE);
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanesWithConfig(project, runsRoot, withNestedRepos(project, ['backend']));
    assert.equal(result.status, 'success');

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, backlogItem('a-item'));
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    const rootBefore = commitCount(project);
    const backendBefore = commitCountAt(project.path('backend'));

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a'],
      check: 'exit 0',
      file: backlogFile,
      nestedRepos: ['backend'],
      repoChecks,
    });

    assert.equal(outcomes[0]?.kind, 'conflict');
    assert.match((outcomes[0] as { reason: string }).reason, /gitlink/);
    assert.match((outcomes[0] as { reason: string }).reason, /backend/);

    assert.equal(commitCount(project), rootBefore, 'дерево не тронуто');
    assert.equal(commitCountAt(project.path('backend')), backendBefore, 'часть не тронута');
    assert.equal(statusOf(readFileSync(backlogFile, 'utf8'), 'a-item'), 'failed');
  });

  it('обрыв между коммитами отказывает, называя репозитории с коммитом и без', async () => {
    const project = makeCompositeProject(COMPOSITE_LANE_PIPELINE, ['other']);
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanesWithConfig(project, runsRoot, withNestedRepos(project, ['backend', 'other']));

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, backlogItem('a-item'));
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');

    // Симулирует прошлое сведение, оборвавшееся между коммитами: код уже
    // закоммичен в backend сообщением дорожки, а очередь исхода не несёт.
    writeFileSync(join(project.path('backend'), 'partial.txt'), 'частично\n');
    gitCommit(project.path('backend'), 'a-item: A');

    await assert.rejects(
      () =>
        mergeLanes({
          paths: result.journal.paths,
          cwd: project.root,
          lanes: ['a'],
          check: 'exit 0',
          file: backlogFile,
          nestedRepos: ['backend', 'other'],
          repoChecks: new Map([
            ['backend', 'exit 0'],
            ['other', 'exit 0'],
          ]),
        }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.exitCode, ExitCode.configError);
        assert.match(error.message, /backend/);
        assert.match(error.message, /a-item/);
        // «Без коммита» называет только тех, кому коммит полагался: дорожка
        // `other` не касалась вовсе, и звать читателя искать недостающий
        // коммит там отказ не вправе.
        assert.doesNotMatch(error.message, /other/);
        return true;
      },
    );

    assert.equal(statusOf(readFileSync(backlogFile, 'utf8'), 'a-item'), 'in_progress', 'очередь не тронута отказом');
  });

  it('пункт со статусом done не даёт ложного срабатывания диагностики обрыва', async () => {
    const project = makeCompositeProject(COMPOSITE_LANE_PIPELINE);
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanesWithConfig(project, runsRoot, withNestedRepos(project, ['backend']));

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, backlogItem('a-item'));
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'Заголовок A');

    // Настоящее успешное сведение оставляет ровно то же сочетание — коммит
    // `a-item: …` в backend, — но с проставленным в очереди исходом.
    const first = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a'],
      check: 'exit 0',
      file: backlogFile,
      nestedRepos: ['backend'],
      repoChecks,
    });
    assert.equal(first[0]?.kind, 'merged');
    assert.equal(statusOf(readFileSync(backlogFile, 'utf8'), 'a-item'), 'done');

    // Повторный заход по той же дорожке не имеет права упасть на диагностике
    // обрыва — пункт уже done, ложного срабатывания здесь нет по определению.
    let brokenMergeDetected = false;
    try {
      await mergeLanes({
        paths: result.journal.paths,
        cwd: project.root,
        lanes: ['a'],
        check: 'exit 0',
        file: backlogFile,
        nestedRepos: ['backend'],
        repoChecks,
      });
    } catch (error) {
      if (error instanceof StepcastError && /оборвал/.test(error.message)) brokenMergeDetected = true;
      else throw error;
    }
    assert.equal(brokenMergeDetected, false);
  });

  it('очередь игнорируется репозиторием очереди: его коммит пропускается без отказа', async () => {
    // Гитлинки асимметричны: коммит в `backend` неизбежно двигает запись
    // корня о нём, поэтому «нечего коммитить» честно проверяется на
    // репозитории, который дорожка не затрагивает и который не является
    // корнем, — только там нет никакого чужого повода стать «грязным».
    const project = makeCompositeProject(BACKEND_ONLY_LANE_PIPELINE, ['queue-repo']);
    writeFileSync(join(project.path('queue-repo'), '.gitignore'), 'backlog.md\n');
    gitCommit(project.path('queue-repo'), 'добавлен .gitignore');
    // Гитлинк корня на `queue-repo` сдвинулся вместе с этим коммитом — синхронизировать
    // его коммитом в корне, иначе дерево запуска само окажется нечистым.
    commit(project, 'подхвачен новый коммит queue-repo');

    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanesWithConfig(project, runsRoot, withNestedRepos(project, ['backend', 'queue-repo']));

    const backlogFile = join(project.path('queue-repo'), 'backlog.md');
    writeFileSync(backlogFile, backlogItem('a-item'));
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');

    const backendBefore = commitCountAt(project.path('backend'));
    const queueRepoBefore = commitCountAt(project.path('queue-repo'));

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a'],
      check: 'exit 0',
      file: backlogFile,
      nestedRepos: ['backend', 'queue-repo'],
      repoChecks,
    });

    assert.equal(outcomes[0]?.kind, 'merged');
    assert.equal(statusOf(readFileSync(backlogFile, 'utf8'), 'a-item'), 'done');
    assert.equal(commitCountAt(project.path('backend')), backendBefore + 1, 'backend несёт вклад дорожки');
    assert.equal(
      commitCountAt(project.path('queue-repo')),
      queueRepoBefore,
      'коммитить в репозитории очереди было нечего — файл игнорируется',
    );
    // Корень ведёт `backend` гитлинком: коммит в части сдвинул его запись, и
    // корневой коммит обязан её подхватить — иначе дерево запуска остаётся
    // грязным, и головное предусловие следующего захода упирается в него.
    assert.equal(porcelainAt(project.root), '', 'корень чист после сведения');
    assert.equal(headMessageAt(project.root), 'a-item: A');
    // Перечень исхода называет только те репозитории, где коммит возник:
    // репозиторий очереди, где коммитить было нечего, в него не попадает.
    if (outcomes[0]?.kind === 'merged') assert.deepEqual([...outcomes[0].repos], ['backend', '.']);
  });

  it('негодная дорожка и дорожка без пункта не роняют обход из-за неназванной проверки', async () => {
    const project = makeCompositeProject(MIXED_LANES_PIPELINE);
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanesWithConfig(project, runsRoot, withNestedRepos(project, ['backend']));

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, `${backlogItem('a-item')}\n${backlogItem('b-item')}`);
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    writeItem(result.journal.paths.dir, 'b', 'b-item', 'B');
    // Дорожке `c` пункт не доставался — файла `item-c.json` нет вовсе.

    // Команда проверки объявлена только у корня: `backend` затрагивают лишь
    // дорожки, которые до наложения не дойдут ни при какой конфигурации.
    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a', 'b', 'c'],
      check: 'exit 0',
      file: backlogFile,
      nestedRepos: ['backend'],
    });

    assert.equal(outcomes[0]?.kind, 'merged', JSON.stringify(outcomes[0]));
    assert.equal(outcomes[1]?.kind, 'unfit');
    assert.equal(outcomes[2]?.kind, 'no_item');
    assert.equal(statusOf(readFileSync(backlogFile, 'utf8'), 'a-item'), 'done');
  });
});

describe('core: mergeLanes — откат не подтверждён', () => {
  it('проверка оставляет неотслеживаемый файл в необъявленном к затрагиванию репозитории — обход прекращается', async () => {
    const project = makeCompositeProject(TWO_LANE_COMPOSITE_PIPELINE, ['other']);
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanesWithConfig(project, runsRoot, withNestedRepos(project, ['backend', 'other']));
    assert.equal(result.status, 'success');

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, `${backlogItem('a-item')}\n${backlogItem('b-item')}`);
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    writeItem(result.journal.paths.dir, 'b', 'b-item', 'B');

    // Команда проверки backend — произвольная строка проекта: здесь она
    // роняет проверку и заодно оставляет неотслеживаемый файл в `other`,
    // объявленном, но дорожкой `a` не затронутом, — адресный откат по
    // затронутым репозиториям (корень, backend) до `other` не достаёт.
    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a', 'b'],
      check: 'exit 0',
      file: backlogFile,
      nestedRepos: ['backend', 'other'],
      repoChecks: new Map([['backend', 'printf "утечка\\n" > ../other/утечка.txt && exit 1']]),
    });

    assert.equal(outcomes[0]?.kind, 'check_failed');
    assert.equal(outcomes[1]?.kind, 'not_reached');
    assert.match((outcomes[1] as { reason: string }).reason, /неподтверждённый откат/);
    assert.match((outcomes[1] as { reason: string }).reason, /a/);

    assert.ok(existsSync(project.path('other/утечка.txt')), 'утечка проверки остаётся — откат её не снимает');

    const text = readFileSync(backlogFile, 'utf8');
    assert.equal(statusOf(text, 'a-item'), 'failed');
    assert.equal(statusOf(text, 'b-item'), 'failed');
    assert.match(fieldOf(text, 'b-item', 'reason') ?? '', /неподтверждённый откат/);
  });

  it('красная последней дорожки перечня: неподтверждённый откат назван в её же причине', async () => {
    const project = makeCompositeProject(TWO_LANE_COMPOSITE_PIPELINE, ['other']);
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanesWithConfig(project, runsRoot, withNestedRepos(project, ['backend', 'other']));
    assert.equal(result.status, 'success');

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, `${backlogItem('a-item')}\n${backlogItem('b-item')}`);
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    writeItem(result.journal.paths.dir, 'b', 'b-item', 'B');

    // Красной проверка становится только при вкладе последней дорожки перечня
    // (`root-b.txt` кладёт `b`), и та же строка проекта оставляет по себе файл
    // в объявленном, но дорожкой `b` не затронутом `other` — адресный откат до
    // него не достаёт. Недостигнутых дорожек за `b` нет вовсе: если бы
    // остановку несли только их причины, запись о грязном дереве пропала бы.
    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a', 'b'],
      check: 'test ! -f root-b.txt || { printf "утечка\\n" > other/утечка.txt; exit 1; }',
      file: backlogFile,
      nestedRepos: ['backend', 'other'],
      repoChecks: new Map([['backend', 'exit 0']]),
    });

    assert.equal(outcomes.length, 2);
    assert.equal(outcomes[0]?.kind, 'merged');
    assert.equal(outcomes[1]?.kind, 'check_failed');
    const rolled = (outcomes[1] as { reason: string }).reason;
    assert.match(rolled, /проверка после наложения красная/);
    assert.match(rolled, /откат дорожки «b» не подтверждён/);
    assert.ok(rolled.length <= REASON_LIMIT, `причина не умещается в предел поля: ${rolled.length}`);

    assert.ok(existsSync(project.path('other/утечка.txt')), 'утечка проверки остаётся — откат её не снимает');

    const text = readFileSync(backlogFile, 'utf8');
    assert.equal(statusOf(text, 'a-item'), 'done');
    assert.equal(statusOf(text, 'b-item'), 'failed');
    const stored = fieldOf(text, 'b-item', 'reason') ?? '';
    assert.match(stored, /красная/);
    assert.match(stored, /не подтверждён/, 'грязное дерево названо в очереди, а не только в отчёте');
  });

  it('причина недостигнутой дорожки укладывается в предел поля, не срезаясь записью в очередь', async () => {
    // Имя объявленного репозитория растягивает сообщение о грязном дереве до
    // предела поля причины: сложить готовую причину остановки с приставкой
    // недостигнутой дорожки, не ужимая, значило бы выйти за него.
    const long = `${'x'.repeat(200)}/${'y'.repeat(200)}`;
    const project = makeCompositeProject(TWO_LANE_COMPOSITE_PIPELINE, [long]);
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanesWithConfig(project, runsRoot, withNestedRepos(project, ['backend', long]));
    assert.equal(result.status, 'success');

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, `${backlogItem('a-item')}\n${backlogItem('b-item')}`);
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    writeItem(result.journal.paths.dir, 'b', 'b-item', 'B');

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a', 'b'],
      check: `printf "утечка\\n" > ${long}/утечка.txt && exit 1`,
      file: backlogFile,
      nestedRepos: ['backend', long],
      repoChecks: new Map([['backend', 'exit 0']]),
    });

    assert.equal(outcomes[0]?.kind, 'check_failed');
    // Причина откачённой дорожки сама упирается в предел — значит и причина
    // остановки, из которой собирается причина недостигнутой, полна.
    assert.equal((outcomes[0] as { reason: string }).reason.length, REASON_LIMIT);

    assert.equal(outcomes[1]?.kind, 'not_reached');
    const notReached = (outcomes[1] as { reason: string }).reason;
    assert.match(notReached, /неподтверждённый откат/);
    assert.ok(notReached.length <= REASON_LIMIT, `причина не умещается в предел поля: ${notReached.length}`);

    const text = readFileSync(backlogFile, 'utf8');
    assert.equal(
      fieldOf(text, 'b-item', 'reason'),
      notReached,
      'причина доехала в очередь целиком — записи её урезать не пришлось',
    );
  });
});

describe('core: mergeLanes — предусловие чистого дерева', () => {
  function bogusPaths(dir: string) {
    return runPaths(join(dir, 'runs'), 'проект', 'r1');
  }

  it('незакоммиченная правка отказывает до первого наложения', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    writeFileSync(project.path('stepcast.yml'), `${twoLanePipeline(SUCCESS_A, SUCCESS_B)}\n# правка\n`);

    await assert.rejects(
      () =>
        mergeLanes({
          paths: bogusPaths(project.root),
          cwd: project.root,
          lanes: ['a'],
          check: 'exit 0',
          file: project.path('backlog.md'),
        }),
      StepcastError,
    );
  });

  it('неотслеживаемый файл отказывает тем же образом', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    writeFileSync(project.path('новый.txt'), 'новое\n');

    await assert.rejects(
      () =>
        mergeLanes({
          paths: bogusPaths(project.root),
          cwd: project.root,
          lanes: ['a'],
          check: 'exit 0',
          file: project.path('backlog.md'),
        }),
      StepcastError,
    );
  });

  it('незакоммиченная отметка очереди сведению не мешает', async () => {
    // Голова петли ставит пункту `in_progress` в начале прогона, а сведение
    // идёт в конце того же прогона: к этому мигу файл очереди закономерно
    // расходится с последним коммитом, и отказывать из-за него нельзя.
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, backlogItem('a-item', 'queued'));
    commit(project, 'добавлена очередь');
    // Правка после коммита — та самая, что делает петля перед прогоном.
    writeFileSync(backlogFile, `${backlogItem('a-item')}started_at: 2026-08-28T00:00:00Z\n`);
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: 'all',
      check: 'exit 0',
      file: backlogFile,
    });

    assert.equal(outcomes[0]?.kind, 'merged');
    assert.equal(statusOf(readFileSync(backlogFile, 'utf8'), 'a-item'), 'done');
  });

  it('правка вне файла очереди отказывает и при исключённой очереди', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, backlogItem('a-item'));
    writeFileSync(project.path('stepcast.yml'), `${twoLanePipeline(SUCCESS_A, SUCCESS_B)}\n# правка\n`);

    await assert.rejects(
      () =>
        mergeLanes({
          paths: bogusPaths(project.root),
          cwd: project.root,
          lanes: ['a'],
          check: 'exit 0',
          file: backlogFile,
        }),
      StepcastError,
    );
  });

  it('откат красной проверки возвращает незакоммиченную отметку очереди', async () => {
    // `reset --hard` снёс бы `started_at`, проставленный головой петли и
    // никаким коммитом не закреплённый: снимок очереди до наложения обязан
    // вернуть его на место, а исход дорожки лечь уже поверх.
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, backlogItem('a-item', 'queued'));
    commit(project, 'добавлена очередь');
    writeFileSync(backlogFile, `${backlogItem('a-item')}started_at: 2026-08-28T00:00:00Z\n`);
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: 'all',
      check: 'exit 1',
      file: backlogFile,
    });

    assert.equal(outcomes[0]?.kind, 'check_failed');
    const text = readFileSync(backlogFile, 'utf8');
    assert.equal(statusOf(text, 'a-item'), 'failed');
    assert.equal(fieldOf(text, 'a-item', 'started_at'), '2026-08-28T00:00:00Z');
  });

  it('каталог вне git отказывает, называя причину', async () => {
    const dir = tempDir('lanes-notgit-');

    await assert.rejects(
      () =>
        mergeLanes({
          paths: bogusPaths(dir),
          cwd: dir,
          lanes: ['a'],
          check: 'exit 0',
          file: join(dir, 'backlog.md'),
        }),
      StepcastError,
    );
  });

  it('грязный вложенный репозиторий при чистом корне отказывает до первого наложения', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    writeFileSync(project.path('.gitignore'), 'backend/\n');
    commit(project, 'начальный');
    // Настоящий прогон, а не bogusPaths: перечень дорожек разрешается по
    // status.json раньше проверки чистоты дерева, и без него команда упала бы
    // на «прогон не найден» вместо дорожки, которую здесь проверяют.
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);

    const nestedDir = project.path('backend');
    mkdirSync(nestedDir);
    gitInitDir(nestedDir);
    writeFileSync(join(nestedDir, 'seed.txt'), 'затравка backend\n');
    gitCommit(nestedDir, 'первый backend');
    writeFileSync(join(nestedDir, 'seed.txt'), 'незакоммиченная правка backend\n');

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, backlogItem('a-item'));
    const before = commitCount(project);

    await assert.rejects(
      () =>
        mergeLanes({
          paths: result.journal.paths,
          cwd: project.root,
          lanes: 'all',
          check: 'exit 0',
          file: backlogFile,
          nestedRepos: ['backend'],
        }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /backend/);
        return true;
      },
    );

    assert.equal(commitCount(project), before, 'дерево не тронуто');
    assert.equal(readFileSync(backlogFile, 'utf8'), backlogItem('a-item'), 'очередь не правлена');
  });

  // Задача 5.5 / t9 (merge-lanes-per-repo): отказ «очередь внутри вложенного
  // репозитория» снят — репозиторий, в чьём дереве лежит файл очереди,
  // коммитится последним, неся отметку `done`; корневой вклад дорожки ложится
  // отдельным, более ранним коммитом.
  it('очередь внутри вложенного репозитория коммитится последней, неся отметку done', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    writeFileSync(project.path('.gitignore'), 'backend/\n');
    commit(project, 'начальный');

    const nestedDir = project.path('backend');
    mkdirSync(nestedDir);
    gitInitDir(nestedDir);
    writeFileSync(join(nestedDir, 'seed.txt'), 'затравка backend\n');
    gitCommit(nestedDir, 'первый backend');

    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);

    const backlogFile = join(nestedDir, 'backlog.md');
    writeFileSync(backlogFile, backlogItem('a-item'));
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    const rootBefore = commitCount(project);
    const backendBefore = commitCountAt(nestedDir);

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: 'all',
      check: 'exit 0',
      file: backlogFile,
      nestedRepos: ['backend'],
    });

    assert.equal(outcomes[0]?.kind, 'merged');
    assert.equal(commitCount(project), rootBefore + 1, 'корень несёт вклад дорожки — файл a.txt');
    assert.equal(commitCountAt(nestedDir), backendBefore + 1, 'вложенный репозиторий коммитит отметку done');
    assert.equal(headMessageAt(nestedDir), 'a-item: A');
    assert.equal(existsSync(project.path('a.txt')), true, 'дорожка наложена в корень');
    assert.equal(statusOf(readFileSync(backlogFile, 'utf8'), 'a-item'), 'done');
  });

  it('очередь в корне многорепного дерева сведению не мешает', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    writeFileSync(project.path('.gitignore'), 'backend/\n');
    commit(project, 'начальный');

    const nestedDir = project.path('backend');
    mkdirSync(nestedDir);
    gitInitDir(nestedDir);
    writeFileSync(join(nestedDir, 'seed.txt'), 'затравка backend\n');
    gitCommit(nestedDir, 'первый backend');

    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);

    // Очередь в корне, вложенный чист: исключение `--file` относится к корню
    // и на объявленный состав не влияет — сведение идёт как в однорепном.
    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, backlogItem('a-item', 'queued'));
    commit(project, 'добавлена очередь');
    writeFileSync(backlogFile, `${backlogItem('a-item')}started_at: 2026-08-28T00:00:00Z\n`);
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: 'all',
      check: 'exit 0',
      file: backlogFile,
      nestedRepos: ['backend'],
    });

    assert.equal(outcomes[0]?.kind, 'merged');
    assert.equal(statusOf(readFileSync(backlogFile, 'utf8'), 'a-item'), 'done');
  });
});

describe('core: mergeLanes — дорожка без вклада', () => {
  it('годная дорожка, не изменившая дерево, не даёт коммита, помечается failed, обход продолжается', async () => {
    const project = makeProject({
      // work-a ничего не пишет в дерево — applyRun вернёт nothing-to-apply.
      'stepcast.yml': twoLanePipeline(':', SUCCESS_B),
    });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, `${backlogItem('a-item')}\n${backlogItem('b-item')}`);
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    writeItem(result.journal.paths.dir, 'b', 'b-item', 'B');
    const before = commitCount(project);

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a', 'b'],
      check: 'exit 0',
      file: backlogFile,
    });

    assert.equal(outcomes[0]?.kind, 'no_contribution');
    assert.match((outcomes[0] as { reason: string }).reason, /не изменила дерево/);
    assert.equal(outcomes[1]?.kind, 'merged');
    assert.equal(commitCount(project), before + 1, 'коммит только у дорожки b');

    const text = readFileSync(backlogFile, 'utf8');
    assert.equal(statusOf(text, 'a-item'), 'failed');
    assert.equal(statusOf(text, 'b-item'), 'done');
  });
});

describe('core: mergeLanes — запись исхода дорожки в каталог прогона', () => {
  it('сведённая дорожка: запись merged с коммитами', async () => {
    const project = makeProject({ 'stepcast.yml': oneLanePipeline(SUCCESS_A) });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, backlogItem('a-item'));
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'Заголовок A');

    await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a'],
      check: 'exit 0',
      file: backlogFile,
    });

    const record = readLaneMerge(result.journal.paths.dir, 'a');
    assert.equal(record?.kind, 'merged');
    assert.equal(record?.slug, 'a-item');
    assert.equal(record?.commits?.['.'], headShaAt(project.root));
  });

  it('откачённая дорожка: запись check_failed с причиной', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, `${backlogItem('a-item')}\n${backlogItem('b-item')}`);
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    writeItem(result.journal.paths.dir, 'b', 'b-item', 'B');

    await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a', 'b'],
      check: 'test ! -f b.txt',
      file: backlogFile,
    });

    const recordA = readLaneMerge(result.journal.paths.dir, 'a');
    assert.equal(recordA?.kind, 'merged');
    const recordB = readLaneMerge(result.journal.paths.dir, 'b');
    assert.equal(recordB?.kind, 'check_failed');
    assert.match(recordB?.reason ?? '', /красная/);
  });

  it('дорожка, до которой обход не дошёл: запись not_reached, отличимая от отсутствия записи', async () => {
    const project = makeProject({
      'stepcast.yml': twoLanePipeline(
        'printf "общий файл, правка a\\n" > конфликт.txt',
        SUCCESS_B,
      ),
    });
    gitInit(project);
    writeFileSync(project.path('конфликт.txt'), 'исходное\n');
    commit(project, 'начальный');
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, `${backlogItem('a-item')}\n${backlogItem('b-item')}`);
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    writeItem(result.journal.paths.dir, 'b', 'b-item', 'B');

    // Правка дерева до сведения — тот же файл, что и work-a — конфликт наложения.
    writeFileSync(project.path('конфликт.txt'), 'несовместимая правка\n');
    commit(project, 'несовместимая правка');

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a', 'b'],
      check: 'exit 0',
      file: backlogFile,
    });

    assert.equal(outcomes[0]?.kind, 'conflict');
    assert.equal(outcomes[1]?.kind, 'not_reached');
    assert.equal(readLaneMerge(result.journal.paths.dir, 'b')?.kind, 'not_reached');
  });
});

describe('core: mergeLanes — already_merged', () => {
  it('повторный merge-lanes даёт already_merged сведённым дорожкам, остальные обходит как обычно', async () => {
    // Дорожка c негодна (работа падает) — она не сведётся ни при каком
    // обходе, и второй вызов должен вычислить её исход заново, не путая с
    // already_merged.
    const project = makeProject({ 'stepcast.yml': threeLanePipeline(SUCCESS_A, SUCCESS_B, 'exit 1') });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, `${backlogItem('a-item')}\n${backlogItem('b-item')}`);
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    writeItem(result.journal.paths.dir, 'b', 'b-item', 'B');

    const first = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: 'all',
      check: 'exit 0',
      file: backlogFile,
    });
    assert.deepEqual(
      first.map((o) => o.kind),
      ['merged', 'merged', 'unfit'],
    );

    const second = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: 'all',
      check: 'exit 0',
      file: backlogFile,
    });

    assert.deepEqual(
      second.map((o) => o.kind),
      ['already_merged', 'already_merged', 'unfit'],
    );
  });
});

/**
 * Задача 3.7 (`knowledge-anchors-after-merge`): единица, записанная в рабочем
 * дереве дорожки по содержимому, которое сама и создала, обязана оставаться
 * сошедшейся сразу после сведения — сведение накладывает диф, дающий на
 * дереве проекта то же содержимое байт в байт, а закрепление зависит только
 * от содержимого, не от истории (design.md, решение 1). До этого изменения
 * якорь нёс ревизию последнего коммита пути, и коммит сведения делал его
 * расходящимся в момент возникновения — тест падает на сегодняшнем коде
 * жёлтым `stale-anchor`.
 */
describe('core: mergeLanes — записанная дорожкой память не стареет от сведения', () => {
  const RECORDING_LANE_PIPELINE = `
version: 1
kind: pipeline
name: дорожка-пишет-память
workspace: { mode: worktree }
jobs:
  work-a:
    lane: a
    steps:
      - id: шаг
        run: [sh, -c, 'printf "export const a = 2;\\n" > src/a.ts && printf "%s" "{\\"id\\": \\"a-note\\", \\"title\\": \\"Заметка о правке\\", \\"scope\\": [\\"src/**\\"], \\"anchors\\": [\\"src/a.ts\\"], \\"body\\": \\"Заметка.\\"}" > note.json && node "$STEPCAST_BIN" knowledge write --file note.json']
        expect: [{ exit_code: 0 }]
`;

  async function checkKnowledge(project: Project): Promise<{ code: ExitCodeValue; stdout: string }> {
    const stdout: string[] = [];
    const io: CliIo = { out: (line) => stdout.push(line), err: () => {}, cwd: project.root };
    const code = await withHome(project.home, () => runCli(['knowledge', 'check'], io));
    return { code, stdout: stdout.join('\n') };
  }

  it('единица, записанная дорожкой, остаётся зелёной на дереве проекта после сведения', async () => {
    const project = makeProject({
      '.stepcast/config.yml': 'project:\n  knowledge:\n    provider: fs\n    dir: knowledge\n',
      'src/a.ts': 'export const a = 1;\n',
      'stepcast.yml': RECORDING_LANE_PIPELINE,
    });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);
    assert.equal(result.status, 'success');

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, backlogItem('a-item'));
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'Заголовок A');

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a'],
      check: 'exit 0',
      file: backlogFile,
    });
    assert.deepEqual(outcomes.map((outcome) => outcome.kind), ['merged']);
    assert.equal(readFileSync(project.path('src/a.ts'), 'utf8'), 'export const a = 2;\n');
    assert.ok(existsSync(project.path('knowledge/a-note.md')));

    const verdict = await checkKnowledge(project);
    assert.equal(verdict.code, ExitCode.ok, verdict.stdout);
    assert.doesNotMatch(verdict.stdout, /stale-anchor/);
  });
});

describe('core: applyRun --lane — отказ повторного наложения сведённой дорожки', () => {
  it('отказывает, называя коммиты сведения, дерева не тронув', async () => {
    const project = makeProject({ 'stepcast.yml': oneLanePipeline(SUCCESS_A) });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, backlogItem('a-item'));
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');

    await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a'],
      check: 'exit 0',
      file: backlogFile,
    });

    const before = commitCount(project);
    assert.throws(
      () => applyRun({ paths: result.journal.paths, cwd: project.root, lane: 'a' }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /уже сведена/);
        return true;
      },
    );
    assert.equal(commitCount(project), before, 'отказ не тронул дерево');
  });

  it('--force снимает отказ и накладывает дорожку', async () => {
    const project = makeProject({ 'stepcast.yml': oneLanePipeline(SUCCESS_A) });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, backlogItem('a-item'));
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');

    await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a'],
      check: 'exit 0',
      file: backlogFile,
    });

    // --force снимает отказ: наложение идёт как обычно, а не молчаливым
    // пропуском.
    const outcome = applyRun({ paths: result.journal.paths, cwd: project.root, lane: 'a', force: true });
    assert.equal(outcome.kind, 'applied');
    assert.deepEqual(leakedApplyDirs(), [], 'сошедшееся наложение не должно оставлять stateDir');
  });

  it('дорожка с исходом, отличным от merged, накладывается свободно', async () => {
    const project = makeProject({ 'stepcast.yml': oneLanePipeline(SUCCESS_A) });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = tempDir('lanes-runs-');
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, backlogItem('a-item'));
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');

    // Проверка красная сразу — дорожка a откатывается, запись check_failed.
    await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a'],
      check: 'exit 1',
      file: backlogFile,
    });
    assert.equal(readLaneMerge(result.journal.paths.dir, 'a')?.kind, 'check_failed');

    const outcome = applyRun({ paths: result.journal.paths, cwd: project.root, lane: 'a' });
    assert.equal(outcome.kind, 'applied');
  });
});

describe('CLI: stepcast merge-lanes', () => {
  async function cli(cwd: string, home: string, argv: readonly string[]): Promise<{
    code: ExitCodeValue;
    stdout: string;
    stderr: string;
  }> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io: CliIo = { out: (line) => stdout.push(line), err: (line) => stderr.push(line), cwd };
    const code = await withHome(home, () => runCli(['merge-lanes', ...argv], io));
    return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  }

  /** Прогон, чей runsRoot виден команде через глобальный конфиг в project.home. */
  async function preparedRun(project: Project): Promise<{ result: RunResult; runsRoot: string }> {
    const runsRoot = tempDir('lanes-runs-');
    writeFileSync(join(project.home, '.stepcast', 'config.yml'), `runs:\n  root: ${runsRoot}\n`);
    const result = await runLanes(project, runsRoot);
    return { result, runsRoot };
  }

  it('обе дорожки зелёные: код 0, отчёт по каждой и итог', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    const { result } = await preparedRun(project);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, `${backlogItem('a-item')}\n${backlogItem('b-item')}`);
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    writeItem(result.journal.paths.dir, 'b', 'b-item', 'B');

    const out = await cli(project.root, project.home, [
      result.journal.paths.runId,
      '--lanes',
      'a,b',
      '--check',
      'exit 0',
      '--file',
      backlogFile,
    ]);

    assert.equal(out.code, ExitCode.ok, out.stderr);
    assert.match(out.stdout, /дорожка a:.*сведена/);
    assert.match(out.stdout, /дорожка b:.*сведена/);
    assert.match(out.stdout, /итог: сведено 2, не сведено 0/);
  });

  it('повторный обход: итог не числит уже сведённые дорожки несведёнными', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    const { result } = await preparedRun(project);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, `${backlogItem('a-item')}\n${backlogItem('b-item')}`);
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    writeItem(result.journal.paths.dir, 'b', 'b-item', 'B');

    const args = [
      result.journal.paths.runId,
      '--lanes',
      'a,b',
      '--check',
      'exit 0',
      '--file',
      backlogFile,
    ];
    await cli(project.root, project.home, args);
    const out = await cli(project.root, project.home, args);

    assert.equal(out.code, ExitCode.ok, out.stderr);
    assert.match(out.stdout, /дорожка a:.*уже сведена ранее/);
    // «Не сведено 2» здесь было бы ровно тем ложным сигналом «дорожки
    // потеряны», против которого изменение и заведено: обе лежат в дереве.
    assert.match(out.stdout, /итог: сведено 0, уже было сведено 2, не сведено 0/);
  });

  it('красная проверка одной дорожки не мешает следующей: код 1, отчёт различает сведённую и откачённую', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    const { result } = await preparedRun(project);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, `${backlogItem('a-item')}\n${backlogItem('b-item')}`);
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    writeItem(result.journal.paths.dir, 'b', 'b-item', 'B');

    const out = await cli(project.root, project.home, [
      result.journal.paths.runId,
      '--lanes',
      'a,b',
      '--check',
      'test ! -f a.txt',
      '--file',
      backlogFile,
    ]);

    assert.equal(out.code, ExitCode.jobFailed);
    assert.match(out.stdout, /дорожка a:.*откачена/);
    assert.match(out.stdout, /дорожка b:.*сведена/);
    assert.match(out.stdout, /итог: сведено 1, не сведено 1/);
  });

  it('перечень из одних негодных дорожек по-прежнему даёт код 0', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline('exit 1', 'exit 1') });
    gitInit(project);
    commit(project, 'начальный');
    const { result } = await preparedRun(project);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, `${backlogItem('a-item')}\n${backlogItem('b-item')}`);
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    writeItem(result.journal.paths.dir, 'b', 'b-item', 'B');

    const out = await cli(project.root, project.home, [
      result.journal.paths.runId,
      '--lanes',
      'a,b',
      '--check',
      'exit 0',
      '--file',
      backlogFile,
    ]);

    assert.equal(out.code, ExitCode.ok, out.stderr);
    assert.match(out.stdout, /итог: сведено 0, не сведено 2/);
  });

  it('отчёт различает откачённую, непробованную и несведённую строки', async () => {
    // a откачена красной проверкой (продолжение обхода), b конфликтует
    // (обход прекращается), c до наложения не доходит вовсе.
    const project = makeProject({
      'спорный.txt': 'строка один\nстрока два\nстрока три\n',
      'stepcast.yml': threeLanePipeline(
        SUCCESS_A,
        'printf "строка один\\nправка прогона\\nстрока три\\n" > спорный.txt',
        SUCCESS_C,
      ),
    });
    gitInit(project);
    commit(project, 'начальный');
    const { result } = await preparedRun(project);

    // Дерево остаётся чистым (предусловие сведения): расхождение вносится
    // отдельным коммитом поверх того же файла, как и в тесте конфликта.
    writeFileSync(project.path('спорный.txt'), 'строка один\nправка человека\nстрока три\n');
    commit(project, 'человек поправил спорный.txt пока шёл прогон');

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, `${backlogItem('a-item')}\n${backlogItem('b-item')}\n${backlogItem('c-item')}`);
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    writeItem(result.journal.paths.dir, 'b', 'b-item', 'B');
    writeItem(result.journal.paths.dir, 'c', 'c-item', 'C');

    const out = await cli(project.root, project.home, [
      result.journal.paths.runId,
      '--lanes',
      'a,b,c',
      '--check',
      'test ! -f a.txt',
      '--file',
      backlogFile,
    ]);

    assert.equal(out.code, ExitCode.jobFailed);
    assert.match(out.stdout, /дорожка a:.*откачена/);
    assert.match(out.stdout, /дорожка b:.*не сведена/);
    assert.doesNotMatch(out.stdout.split('\n').find((line) => line.startsWith('дорожка b:')) ?? '', /откачена|не пробована/);
    assert.match(out.stdout, /дорожка c:.*не пробована/);
    assert.match(out.stdout, /итог: сведено 0, не сведено 3/);
  });

  it('неизвестная дорожка: код 2, дерево и очередь не тронуты', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    const { result } = await preparedRun(project);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, '# Очередь\n');
    commit(project, 'добавлена очередь');
    const beforeCount = commitCount(project);

    const out = await cli(project.root, project.home, [
      result.journal.paths.runId,
      '--lanes',
      'нет-такой',
      '--check',
      'exit 0',
      '--file',
      backlogFile,
    ]);

    assert.equal(out.code, ExitCode.configError);
    assert.equal(commitCount(project), beforeCount);
    assert.equal(readFileSync(backlogFile, 'utf8'), '# Очередь\n');
  });

  it('пустой перечень дорожек, повтор имени и пустой --check — отказ кодом 2 до правки дерева', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    const { result } = await preparedRun(project);
    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, '# Очередь\n');
    commit(project, 'добавлена очередь');

    const empty = await cli(project.root, project.home, [
      result.journal.paths.runId,
      '--lanes',
      '',
      '--check',
      'exit 0',
      '--file',
      backlogFile,
    ]);
    assert.equal(empty.code, ExitCode.configError);

    const duplicate = await cli(project.root, project.home, [
      result.journal.paths.runId,
      '--lanes',
      'a,a',
      '--check',
      'exit 0',
      '--file',
      backlogFile,
    ]);
    assert.equal(duplicate.code, ExitCode.configError);

    const noCheck = await cli(project.root, project.home, [
      result.journal.paths.runId,
      '--lanes',
      'a,b',
      '--file',
      backlogFile,
    ]);
    assert.equal(noCheck.code, ExitCode.configError);
  });

  /**
   * Состав вложенных репозиториев команда берёт из конфигурации сама — этой
   * связки («прочитан `project.nested_repos`» → «проверка обошла часть») в
   * ядре не видно: туда состав приходит параметром. Конфиг с составом
   * пишется после прогона: с ним предстартовая проверка отклонила бы
   * worktree-пайплайн (изолированное дерево объявленных частей не содержит).
   */
  it('состав из конфигурации доходит до предусловия: грязный вложенный — код 2', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    writeFileSync(project.path('.gitignore'), '.stepcast/\nbackend/\n');
    commit(project, 'начальный');

    const nestedDir = project.path('backend');
    mkdirSync(nestedDir);
    gitInitDir(nestedDir);
    writeFileSync(join(nestedDir, 'seed.txt'), 'затравка backend\n');
    gitCommit(nestedDir, 'первый backend');

    const { result } = await preparedRun(project);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, backlogItem('a-item'));
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');

    mkdirSync(project.path('.stepcast'), { recursive: true });
    writeFileSync(project.path('.stepcast/config.yml'), 'project:\n  nested_repos: [backend]\n');
    writeFileSync(join(nestedDir, 'seed.txt'), 'незакоммиченная правка backend\n');
    const before = commitCount(project);

    const out = await cli(project.root, project.home, [
      result.journal.paths.runId,
      '--lanes',
      'all',
      '--check',
      'exit 0',
      '--file',
      backlogFile,
    ]);

    assert.equal(out.code, ExitCode.configError);
    assert.match(out.stderr, /backend/);
    assert.equal(commitCount(project), before, 'дерево не тронуто');
    assert.equal(existsSync(project.path('a.txt')), false, 'дорожка не накладывалась');
  });

  it('прогон не назван вовсе — отказ кодом 2, ничего не тронуто', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    await preparedRun(project);
    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, '# Очередь\n');
    commit(project, 'добавлена очередь');

    // Переменную обязательно снять: под самим stepcast (петля саморазвития
    // гоняет `npm run check` внутри шага) она задана, и без очистки команда
    // ушла бы по ветке резолва прогона — отказ был бы тот же кодом, но не
    // тем, который проверяет этот сценарий.
    const previous = process.env.STEPCAST_RUN_ID;
    delete process.env.STEPCAST_RUN_ID;
    try {
      const out = await cli(project.root, project.home, [
        '--lanes',
        'a,b',
        '--check',
        'exit 0',
        '--file',
        backlogFile,
      ]);
      assert.equal(out.code, ExitCode.configError);
      assert.match(out.stderr, /не назван прогон/);
    } finally {
      if (previous !== undefined) process.env.STEPCAST_RUN_ID = previous;
    }
    assert.equal(readFileSync(backlogFile, 'utf8'), '# Очередь\n');
  });

  it('прогон из STEPCAST_RUN_ID: позиционный аргумент не задан', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    const { result } = await preparedRun(project);
    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, backlogItem('a-item'));
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');

    const previous = process.env.STEPCAST_RUN_ID;
    process.env.STEPCAST_RUN_ID = result.journal.paths.runId;
    try {
      const out = await cli(project.root, project.home, ['--lanes', 'all', '--check', 'exit 0', '--file', backlogFile]);
      assert.equal(out.code, ExitCode.ok, out.stderr);
    } finally {
      if (previous === undefined) delete process.env.STEPCAST_RUN_ID;
      else process.env.STEPCAST_RUN_ID = previous;
    }
  });
});
