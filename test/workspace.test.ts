import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, it } from 'node:test';

import { createAnchorer } from '../src/core/anchor/index.js';
import { buildGraph } from '../src/core/graph.js';
import type { Config } from '../src/core/config/resolve.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { readEvents, readStatus, resolveRun } from '../src/core/journal/reader.js';
import { resolveInheritSource, type CompletedJob } from '../src/core/run/inherit.js';
import { runPipeline, type RunResult } from '../src/core/run/runner.js';
import { StepcastError } from '../src/core/errors.js';
import { applyRun } from '../src/core/run/apply.js';
import { HaltCause } from '../src/core/run/halt.js';
import { prepareWorkspace } from '../src/core/run/workspace.js';
import { RunJournal } from '../src/core/journal/writer.js';
import { gitCommit, gitInit as gitInitDir, makeProject, type Project } from './helpers.js';

// Переходники к общим помощникам (`test/helpers.ts`): здесь репозиторий
// всегда корень проекта, и звать их проектом короче, чем путём.
function gitInit(project: Project): void {
  gitInitDir(project.root);
}

function commit(project: Project, message: string): void {
  gitCommit(project.root, message);
}

async function run(project: Project): Promise<RunResult> {
  return runWithConfig(project, project.config);
}

/** То же, что `run`, но с конфигурацией, объявляющей состав вложенных репозиториев. */
async function runWithConfig(project: Project, config: Config): Promise<RunResult> {
  const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
  const expanded = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config });
  return runPipeline({
    expanded,
    config: { ...config, runs: { ...config.runs, root: runsRoot } },
    projectRoot: project.root,
    cwd: project.root,
  });
}

/** Тот же проект, но с объявленным составом `project.nested_repos`, будто он объявлен в `.stepcast/config.yml`. */
function withNestedRepos(project: Project, nestedRepos: readonly string[]): Config {
  return { ...project.config, project: { ...project.config.project, nestedRepos } };
}

/** Работа, которая пишет файл в свою рабочую директорию и читает соседний. */
function pipelineWriting(mode: string, extra = ''): string {
  return `
version: 1
kind: pipeline
name: режимы
workspace: { mode: ${mode}${extra} }
jobs:
  build:
    steps:
      - id: touch
        run: [sh, -c, 'echo произведено > результат.txt; pwd > где.txt']
        expect: [{ exit_code: 0 }]
`;
}

function workspaceOfJob(result: RunResult, jobId: string): { mode: string; path: string } {
  const job = readStatus(result.journal.paths).jobs.find((item) => item.id === jobId);
  assert.ok(job?.workspace !== undefined, `у работы ${jobId} должна быть рабочая директория`);
  return job.workspace;
}

/**
 * Каталог рабочих директорий прогона в той же форме, в какой пути печатает
 * `git worktree list`: ссылки разрешены (каталог временных файлов на macOS —
 * символическая ссылка), иначе сравнение путей не совпадало бы никогда.
 */
function workspacesDir(result: RunResult): string {
  return realpathSync(join(workspaceOfJob(result, 'a').path, '..'));
}

function graphOf(yaml: string) {
  const project = makeProject({ 'stepcast.yml': yaml });
  const { pipeline } = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config });
  return buildGraph(pipeline).graph;
}

/**
 * Дождаться, пока идущий прогон запишет исход названной работы. Опрос состояния
 * вместо сна на глазок: ожидание кончается тогда, когда наступило проверяемое
 * событие, а не когда истекла угаданная пауза.
 */
async function waitForJobOutcome(
  runsRoot: string,
  projectRoot: string,
  jobId: string,
  timeoutMs = 30_000,
): Promise<ReturnType<typeof resolveRun>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const paths = resolveRun(runsRoot, projectRoot);
      const record = readStatus(paths).jobs.find((job) => job.id === jobId);
      if (record !== undefined && record.finished_at !== undefined) return paths;
    } catch {
      // Прогон ещё не завёл журнала — подождём и попробуем снова.
    }
    if (Date.now() > deadline) {
      throw new Error(`работа ${jobId} не записала исход за ${timeoutMs} мс`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const DONE = (dir: string): CompletedJob => ({ dir, anchor: { kind: 'git', id: dir } });
const NOT_STARTED = (dir: string): CompletedJob => ({ dir });

describe('dependent-job-workspace: разрешение источника наследования', () => {
  it('единственная зависимость выбирается сама', () => {
    const graph = graphOf(`
kind: pipeline
workspace: { mode: worktree }
jobs:
  a: { steps: [{ id: c, run: [echo, a] }] }
  b: { needs: [a], steps: [{ id: c, run: [echo, b] }] }
`);
    const source = resolveInheritSource(graph, graph.byId.get('b')!, new Map([['a', DONE('/a')]]));
    assert.deepEqual(source, { kind: 'continue', job: 'a', dir: '/a' });
  });

  it('объявленный inherit уважается среди нескольких зависимостей', () => {
    const graph = graphOf(`
kind: pipeline
workspace: { mode: worktree }
jobs:
  a: { steps: [{ id: c, run: [echo, a] }] }
  b: { steps: [{ id: c, run: [echo, b] }] }
  c: { needs: [a, b], workspace: { inherit: b }, steps: [{ id: c, run: [echo, c] }] }
`);
    const completed = new Map([
      ['a', DONE('/a')],
      ['b', DONE('/b')],
    ]);
    const source = resolveInheritSource(graph, graph.byId.get('c')!, completed);
    assert.deepEqual(source, { kind: 'seed', job: 'b', anchor: { kind: 'git', id: '/b' } });
  });

  it('inherit: none даёт отсутствие источника', () => {
    const graph = graphOf(`
kind: pipeline
workspace: { mode: worktree }
jobs:
  a: { steps: [{ id: c, run: [echo, a] }] }
  b: { steps: [{ id: c, run: [echo, b] }] }
  c: { needs: [a, b], workspace: { inherit: none }, steps: [{ id: c, run: [echo, c] }] }
`);
    const completed = new Map([
      ['a', DONE('/a')],
      ['b', DONE('/b')],
    ]);
    assert.deepEqual(resolveInheritSource(graph, graph.byId.get('c')!, completed), { kind: 'none' });
  });

  it('источник без якоря заменяется своим источником транзитивно', () => {
    const graph = graphOf(`
kind: pipeline
workspace: { mode: worktree }
jobs:
  a: { steps: [{ id: c, run: [echo, a] }] }
  b: { needs: [a], steps: [{ id: c, run: [echo, b] }] }
  c: { needs: [b], steps: [{ id: c, run: [echo, c] }] }
`);
    // b пропущена по условию: каталога у неё нет вовсе, продолжать нечего — и
    // c ищет дерево дальше по цепочке, у a.
    const completed = new Map([['a', DONE('/a')]]);
    const source = resolveInheritSource(graph, graph.byId.get('c')!, completed);
    assert.deepEqual(source, { kind: 'seed', job: 'a', anchor: { kind: 'git', id: '/a' } });
  });

  it('исчерпание цепочки даёт отсутствие источника', () => {
    const graph = graphOf(`
kind: pipeline
workspace: { mode: worktree }
jobs:
  a: { steps: [{ id: c, run: [echo, a] }] }
  b: { needs: [a], steps: [{ id: c, run: [echo, b] }] }
`);
    // a не исполнялась вовсе — каталога у неё нет, продолжать нечего.
    assert.deepEqual(resolveInheritSource(graph, graph.byId.get('b')!, new Map()), { kind: 'none' });
  });

  // Раскладка каталогов держится на объявленном графе, а не на исходах работ:
  // продолжение чужого каталога якоря не требует — файлы уже лежат на месте.
  // Иначе отказ бухгалтерии у предшественника молча уводил бы наследника в
  // свежий каталог, теряя весь результат предшественника.
  it('продолжает каталог предшественника, даже если якорь у того снять не удалось', () => {
    const graph = graphOf(`
kind: pipeline
workspace: { mode: worktree }
jobs:
  a: { steps: [{ id: c, run: [echo, a] }] }
  b: { needs: [a], steps: [{ id: c, run: [echo, b] }] }
`);
    const completed = new Map([['a', NOT_STARTED('/a')]]);
    assert.deepEqual(resolveInheritSource(graph, graph.byId.get('b')!, completed), {
      kind: 'continue',
      job: 'a',
      dir: '/a',
    });
  });

  // Хеш-манифест содержимого дерева не хранит, и `restore` у него отказывает:
  // засеять им развилку нельзя. Наследование пропускает такой якорь, как
  // отсутствующий, вместо отказа посреди прогона.
  it('не засевает развилку якорем, не хранящим содержимого', () => {
    const graph = graphOf(`
kind: pipeline
workspace: { mode: copy }
jobs:
  a: { steps: [{ id: c, run: [echo, a] }] }
  b: { needs: [a], steps: [{ id: c, run: [echo, b] }] }
  c: { needs: [a], steps: [{ id: c, run: [echo, c] }] }
`);
    const completed = new Map<string, CompletedJob>([
      ['a', { dir: '/a', anchor: { kind: 'manifest', id: 'хеш' } }],
    ]);
    assert.deepEqual(resolveInheritSource(graph, graph.byId.get('b')!, completed), { kind: 'none' });
  });

  it('различает продолжение каталога и собственный каталог развилки', () => {
    const graph = graphOf(`
kind: pipeline
workspace: { mode: worktree }
jobs:
  a: { steps: [{ id: c, run: [echo, a] }] }
  b: { needs: [a], steps: [{ id: c, run: [echo, b] }] }
  c: { needs: [a], steps: [{ id: c, run: [echo, c] }] }
`);
    const completed = new Map([['a', DONE('/a')]]);
    // a — предшественник и b, и c: у него два потомка, значит развилка, а не цепочка.
    assert.deepEqual(resolveInheritSource(graph, graph.byId.get('b')!, completed), {
      kind: 'seed',
      job: 'a',
      anchor: { kind: 'git', id: '/a' },
    });
    assert.deepEqual(resolveInheritSource(graph, graph.byId.get('c')!, completed), {
      kind: 'seed',
      job: 'a',
      anchor: { kind: 'git', id: '/a' },
    });
  });
});

describe('workspace-modes: режим объявляется и переопределяется', () => {
  // Сценарий: «Умолчание»
  it('исполняет работы в каталоге запуска, когда режим не объявлен', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: умолчание
jobs:
  build:
    steps:
      - id: touch
        run: [sh, -c, 'echo произведено > результат.txt']
        expect: [{ exit_code: 0 }]
`,
    });

    const result = await run(project);
    assert.equal(result.status, 'success');
    assert.equal(workspaceOfJob(result, 'build').mode, 'cwd');
    assert.ok(existsSync(project.path('результат.txt')), 'результат сразу на месте');
  });

  // Сценарий: «Переопределение работой» / «Режим виден в состоянии»
  it('позволяет работе переопределить режим пайплайна', async () => {
    const project = makeProject({
      'исходный.txt': 'содержимое',
      'stepcast.yml': `
version: 1
kind: pipeline
name: переопределение
workspace: { mode: cwd }
jobs:
  прямо:
    steps:
      - id: a
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
  в-стороне:
    needs: [прямо]
    workspace: { mode: copy }
    steps:
      - id: b
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
`,
    });

    const result = await run(project);
    assert.equal(result.status, 'success');
    assert.equal(workspaceOfJob(result, 'прямо').mode, 'cwd');
    assert.equal(workspaceOfJob(result, 'в-стороне').mode, 'copy');
    assert.notEqual(workspaceOfJob(result, 'в-стороне').path, project.root);
  });
});

describe('workspace-modes: режим copy', () => {
  // Сценарий: «Незакоммиченные изменения попадают в копию»
  it('переносит незакоммиченные изменения в копию', async () => {
    const project = makeProject({
      'исходный.txt': 'изменено, но не закоммичено',
      'stepcast.yml': pipelineWriting('copy'),
    });
    gitInit(project);
    project.write('исходный.txt', 'изменено, но не закоммичено');

    const result = await run(project);
    const dir = workspaceOfJob(result, 'build').path;

    assert.equal(
      readFileSync(join(dir, 'исходный.txt'), 'utf8'),
      'изменено, но не закоммичено',
    );
  });

  // Сценарий: «Игнорируемые пути не копируются»
  it('пропускает игнорируемые пути', async () => {
    const project = makeProject({
      '.gitignore': 'мусор/\n',
      'мусор/файл.txt': 'не нужен',
      'нужный.txt': 'нужен',
      'stepcast.yml': pipelineWriting('copy'),
    });
    gitInit(project);

    const result = await run(project);
    const dir = workspaceOfJob(result, 'build').path;

    assert.ok(existsSync(join(dir, 'нужный.txt')));
    assert.equal(existsSync(join(dir, 'мусор')), false, 'игнорируемый каталог не копируется');
  });

  // Сценарий: «Копия вне git»
  it('работает вне репозитория git', async () => {
    const project = makeProject({ 'нужный.txt': 'а', 'stepcast.yml': pipelineWriting('copy') });

    const result = await run(project);
    assert.equal(result.status, 'success');
    assert.ok(existsSync(join(workspaceOfJob(result, 'build').path, 'нужный.txt')));
  });

  // Сценарий: «Результат остаётся в стороне»
  it('оставляет исходное дерево нетронутым', async () => {
    const project = makeProject({ 'stepcast.yml': pipelineWriting('copy') });

    const result = await run(project);
    assert.equal(
      existsSync(project.path('результат.txt')),
      false,
      'изоляция: результат не появляется в дереве проекта',
    );
    assert.ok(existsSync(join(workspaceOfJob(result, 'build').path, 'результат.txt')));
  });

  // Сценарий: «Явный путь размещения копий»
  it('размещает копии по объявленному пути', async () => {
    const base = mkdtempSync(join(tmpdir(), 'stepcast-копии-'));
    const project = makeProject({ 'stepcast.yml': pipelineWriting('copy', `, path: ${base}`) });

    const result = await run(project);
    assert.equal(workspaceOfJob(result, 'build').path, join(base, 'build'));
  });

  // Сценарий: «Журнал не попадает в дерево»
  it('не включает журнал прогона в состояние рабочего дерева', async () => {
    const project = makeProject({ 'stepcast.yml': pipelineWriting('copy') });
    const result = await run(project);

    const dir = workspaceOfJob(result, 'build').path;
    assert.equal(existsSync(join(dir, 'run.json')), false);
    assert.equal(existsSync(join(dir, 'events.ndjson')), false);
  });
});

describe('workspace-modes: режим worktree', () => {
  // Сценарий: «Ответвление от HEAD» и «Незакоммиченные изменения не переносятся»
  it('ответвляется от HEAD без незакоммиченных изменений', async () => {
    const project = makeProject({
      'исходный.txt': 'закоммичено',
      'stepcast.yml': pipelineWriting('worktree'),
    });
    gitInit(project);
    commit(project, 'первый');
    project.write('исходный.txt', 'правка, которая не должна уехать');

    const result = await run(project);
    assert.equal(result.status, 'success');

    const dir = workspaceOfJob(result, 'build').path;
    assert.equal(readFileSync(join(dir, 'исходный.txt'), 'utf8'), 'закоммичено');
    assert.equal(
      readFileSync(project.path('исходный.txt'), 'utf8'),
      'правка, которая не должна уехать',
      'дерево проекта не тронуто',
    );
  });

  // Сценарий: «Изоляция независимых работ друг от друга»
  //
  // Без needs изоляция безусловна и наследование её не задевает: оно
  // распространяется по рёбрам needs, а не на любые две работы прогона. Здесь
  // сознательно нет needs — с ним вторая работа стала бы зависимой и, по
  // этому же изменению, обязанной видеть чужую правку, то есть проверяла бы
  // обратное тому, что называет сценарий. Порядок объявления и
  // concurrency: 1 по умолчанию дают тот же детерминированный порядок и без
  // needs.
  it('не показывает работам изменения друг друга', async () => {
    const project = makeProject({
      'общий.txt': 'начало',
      'stepcast.yml': `
version: 1
kind: pipeline
name: изоляция
workspace: { mode: worktree }
jobs:
  первая:
    steps:
      - id: меняет
        run: [sh, -c, 'echo изменено-первой > общий.txt']
        expect: [{ exit_code: 0 }]
  вторая:
    steps:
      - id: читает
        run: [sh, -c, 'cat общий.txt > увиденное.txt']
        expect: [{ exit_code: 0 }]
`,
    });
    gitInit(project);
    commit(project, 'первый');

    const result = await run(project);
    assert.equal(result.status, 'success');

    const second = workspaceOfJob(result, 'вторая').path;
    assert.equal(
      readFileSync(join(second, 'увиденное.txt'), 'utf8').trim(),
      'начало',
      'вторая работа не видит изменений первой',
    );
  });

  // Сценарий: «Проект не под git»
  it('отклоняется вне репозитория git до запуска работ и предлагает copy', async () => {
    const project = makeProject({ 'stepcast.yml': pipelineWriting('worktree') });

    await assert.rejects(
      () => run(project),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /worktree требует репозитория git/);
        assert.match(error.hint ?? '', /copy/);
        return true;
      },
    );

    assert.equal(existsSync(project.path('результат.txt')), false, 'ни один шаг не исполнен');
  });
});

/** Статус --porcelain репозитория: пусто, если дерево чисто. */
function gitStatus(dir: string): string {
  return execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });
}

function gitHead(dir: string): string {
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
}

describe('workspace-modes: материализация объявленных частей', () => {
  it('часть материализована и является рабочим деревом собственного репозитория', async () => {
    const project = makeProject({
      'stepcast.yml': pipelineWriting('worktree'),
      'public-site/.gitkeep': '',
    });
    gitInit(project);
    gitInitDir(project.path('public-site'));
    gitCommit(project.path('public-site'), 'начало части');
    commit(project, 'первый');

    const result = await runWithConfig(project, withNestedRepos(project, ['public-site']));
    assert.equal(result.status, 'success');

    const dir = workspaceOfJob(result, 'build').path;
    const partDir = join(dir, 'public-site');
    const toplevel = execFileSync('git', ['-C', partDir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
    assert.equal(realpathSync(toplevel), realpathSync(partDir));
    // Своя база объектов: HEAD части не совпадает буквально с HEAD корня.
    assert.notEqual(gitHead(partDir), gitHead(dir));
  });

  it('незакоммиченная правка части в дерево дорожки не попадает', async () => {
    const project = makeProject({
      'stepcast.yml': pipelineWriting('worktree'),
      'public-site/.gitkeep': '',
    });
    gitInit(project);
    gitInitDir(project.path('public-site'));
    project.write('public-site/черновик.txt', 'не закоммичено');
    gitCommit(project.path('public-site'), 'начало части');
    // Правка после коммита — не должна попасть в отделённый worktree части.
    project.write('public-site/после-коммита.txt', 'правка после коммита части');
    commit(project, 'первый');

    const result = await runWithConfig(project, withNestedRepos(project, ['public-site']));
    assert.equal(result.status, 'success');

    const partDir = join(workspaceOfJob(result, 'build').path, 'public-site');
    assert.ok(existsSync(join(partDir, 'черновик.txt')), 'закоммиченный файл должен быть на месте');
    assert.equal(
      existsSync(join(partDir, 'после-коммита.txt')),
      false,
      'незакоммиченная правка части не должна попасть в дерево дорожки',
    );
  });

  it('рабочее дерево части в проекте и корневое дерево проекта не изменяются подготовкой', async () => {
    const project = makeProject({
      'stepcast.yml': pipelineWriting('worktree'),
      'public-site/.gitkeep': '',
    });
    gitInit(project);
    gitInitDir(project.path('public-site'));
    gitCommit(project.path('public-site'), 'начало части');
    commit(project, 'первый');

    const rootHeadBefore = gitHead(project.root);
    const partHeadBefore = gitHead(project.path('public-site'));
    const rootStatusBefore = gitStatus(project.root);
    const partStatusBefore = gitStatus(project.path('public-site'));

    const result = await runWithConfig(project, withNestedRepos(project, ['public-site']));
    assert.equal(result.status, 'success');

    assert.equal(gitHead(project.root), rootHeadBefore);
    assert.equal(gitHead(project.path('public-site')), partHeadBefore);
    assert.equal(gitStatus(project.root), rootStatusBefore);
    assert.equal(gitStatus(project.path('public-site')), partStatusBefore);
  });

  // Задача 2.3: отказ на любой части снимает всё, что подготовка успела
  // завести, — части в обратном порядке, затем корень. Вызывается
  // `prepareWorkspace` напрямую: составленный сценарий (репозиторий части без
  // единого коммита) отклонён бы `checkWorkspaceAvailability` до первой
  // работы, а здесь нужен именно отказ самой подготовки.
  it('отказ на второй части не оставляет ни каталогов, ни учётных записей', async () => {
    const project = makeProject({
      'stepcast.yml': pipelineWriting('worktree'),
      // part-b игнорируется корнем: иначе его же add -A отказал бы на
      // «does not have a commit checked out» ещё до подготовки дерева.
      '.gitignore': 'part-b/\n',
      'part-a/.gitkeep': '',
      'part-b/.gitkeep': '',
    });
    gitInit(project);
    gitInitDir(project.path('part-a'));
    gitCommit(project.path('part-a'), 'начало части a');
    // part-b — репозиторий без единого коммита: worktree add … HEAD в нём невозможен.
    gitInitDir(project.path('part-b'));
    commit(project, 'первый');

    const { pipeline } = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config });
    const job = pipeline.jobs.find((item) => item.id === 'build')!;
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));

    const journal = RunJournal.create({ runsRoot, projectRoot: project.root });

    await assert.rejects(() =>
      prepareWorkspace({
        job,
        cwd: project.root,
        runDir: runsRoot,
        bookkeeping: { journal, job: job.id },
        nestedRepos: ['part-a', 'part-b'],
      }),
    );

    /** Пусто, если `.git/worktrees` вовсе нет — как до заведения. */
    const worktreeRecords = (repoDir: string): string[] =>
      existsSync(join(repoDir, '.git', 'worktrees')) ? readdirSync(join(repoDir, '.git', 'worktrees')) : [];

    const workspaceDir = join(runsRoot, 'workspace', job.id);
    assert.equal(existsSync(workspaceDir), false, 'каталог дорожки не должен остаться на диске');
    assert.deepEqual(worktreeRecords(project.root), [], 'корневая учётная запись не должна остаться');
    assert.deepEqual(worktreeRecords(project.path('part-a')), [], 'учётная запись части a не должна остаться');
  });

  // Части, объявленные друг в друге (`a` и `a/b`), заводятся в каноническом
  // порядке — объемлющая раньше вложенной, — а не в том, в каком их
  // перечислили: `worktree add` объемлющей отказал бы «not an empty
  // directory», заведись раньше вложенная.
  it('порядок объявления состава не влияет на заведение вложенных друг в друга частей', async () => {
    const project = makeProject({
      'stepcast.yml': pipelineWriting('worktree'),
      '.gitignore': 'a/\n',
      'a/.gitkeep': '',
      'a/b/.gitkeep': '',
    });
    gitInit(project);
    gitInitDir(project.path('a'));
    gitInitDir(project.path('a/b'));
    gitCommit(project.path('a/b'), 'начало вложенной части');
    gitCommit(project.path('a'), 'начало объемлющей части');
    commit(project, 'первый');

    const { pipeline } = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config });
    const job = pipeline.jobs.find((item) => item.id === 'build')!;
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));

    // Перечень намеренно перевёрнут: вложенная часть названа первой.
    const prepared = await prepareWorkspace({
      job,
      cwd: project.root,
      runDir: runsRoot,
      bookkeeping: { journal: RunJournal.create({ runsRoot, projectRoot: project.root }), job: job.id },
      nestedRepos: ['a/b', 'a'],
    });

    assert.deepEqual(
      (prepared.nested ?? []).map((part) => part.dir),
      ['a', 'a/b'],
      'перечень материализованного идёт в каноническом порядке',
    );
    for (const relDir of ['a', 'a/b']) {
      const partDir = join(prepared.dir, relDir);
      const toplevel = execFileSync('git', ['-C', partDir, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
      }).trim();
      assert.equal(realpathSync(toplevel), realpathSync(partDir), `${relDir} должна быть своим рабочим деревом`);
    }
  });

  it('режим cwd при том же составе ведёт себя как прежде — части не заводятся', async () => {
    const project = makeProject({
      'stepcast.yml': pipelineWriting('cwd'),
      'public-site/.gitkeep': '',
    });
    gitInit(project);
    gitInitDir(project.path('public-site'));
    gitCommit(project.path('public-site'), 'начало части');
    commit(project, 'первый');

    const result = await runWithConfig(project, withNestedRepos(project, ['public-site']));
    assert.equal(result.status, 'success');
    assert.equal(workspaceOfJob(result, 'build').path, project.root);
    // Часть остаётся частью проекта — не отдельным рабочим деревом дорожки.
    assert.equal(readStatus(result.journal.paths).jobs[0]?.workspace?.nested, undefined);
  });
});

describe('dependent-job-workspace: наследование под тестом прогона', () => {
  // Сценарий: «Файл предшественника виден» / «Изменение видно» / «Удаление перенесено»
  it('цепочка в worktree видит создание, изменение и удаление файла предшественником', async () => {
    const project = makeProject({
      'изменяемый.txt': 'старое',
      'удаляемый.txt': 'есть',
      'stepcast.yml': `
version: 1
kind: pipeline
workspace: { mode: worktree }
jobs:
  a:
    steps:
      - id: c
        run: [sh, -c, 'echo новое > изменяемый.txt; rm удаляемый.txt; echo создано > новый.txt']
        expect: [{ exit_code: 0 }]
  b:
    needs: [a]
    steps:
      - id: c
        run: [sh, -c, 'echo ok']
        expect: [{ exit_code: 0 }]
`,
    });
    gitInit(project);
    commit(project, 'первый');

    const result = await run(project);
    assert.equal(result.status, 'success');

    const dirB = workspaceOfJob(result, 'b').path;
    assert.equal(readFileSync(join(dirB, 'изменяемый.txt'), 'utf8').trim(), 'новое');
    assert.equal(existsSync(join(dirB, 'удаляемый.txt')), false);
    assert.equal(readFileSync(join(dirB, 'новый.txt'), 'utf8').trim(), 'создано');
  });

  // То же для copy, плюс незакоммиченные изменения в голове цепочки.
  it('цепочка в copy видит те же изменения, включая незакоммиченные в голове цепочки', async () => {
    const project = makeProject({
      'изменяемый.txt': 'старое',
      'удаляемый.txt': 'есть',
      'stepcast.yml': `
version: 1
kind: pipeline
workspace: { mode: copy }
jobs:
  a:
    steps:
      - id: c
        run: [sh, -c, 'echo новое > изменяемый.txt; rm удаляемый.txt; echo создано > новый.txt']
        expect: [{ exit_code: 0 }]
  b:
    needs: [a]
    steps:
      - id: c
        run: [sh, -c, 'echo ok']
        expect: [{ exit_code: 0 }]
`,
    });
    // Без git: якорь копии снимается хеш-манифестом (design.md, «Ограничение
    // среды»), и «незакоммиченное в голове цепочки» здесь означает буквально
    // не под контролем версий вовсе. Продолжению каталога якорь и не нужен:
    // файлы предшественника уже лежат на месте. Случай копии внутри
    // репозитория — в двух тестах ниже.
    project.write('незакоммиченный.txt', 'не в git');

    const result = await run(project);
    assert.equal(result.status, 'success');

    const dirB = workspaceOfJob(result, 'b').path;
    assert.equal(readFileSync(join(dirB, 'изменяемый.txt'), 'utf8').trim(), 'новое');
    assert.equal(existsSync(join(dirB, 'удаляемый.txt')), false);
    assert.equal(readFileSync(join(dirB, 'новый.txt'), 'utf8').trim(), 'создано');
    assert.equal(readFileSync(join(dirB, 'незакоммиченный.txt'), 'utf8').trim(), 'не в git');
  });

  // Сценарий: «Изменение предшественника видно зависимой работе» для копии
  // внутри репозитория. Копия `.git` не содержит, поэтому её состояние
  // фиксируется git-якорем с базой объектов проекта: без этого якоря копии не
  // снимались бы вовсе и развилка в режиме copy осталась бы без источника.
  it('копия внутри репозитория фиксируется якорями, и развилка получает дерево источника', async () => {
    const project = makeProject({
      'изменяемый.txt': 'старое',
      'stepcast.yml': `
version: 1
kind: pipeline
workspace: { mode: copy }
jobs:
  a:
    steps:
      - id: c
        run: [sh, -c, 'echo новое > изменяемый.txt; echo создано > новый.txt']
        expect: [{ exit_code: 0 }]
  b:
    needs: [a]
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
  c:
    needs: [a]
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
`,
    });
    gitInit(project);
    commit(project, 'первый');

    const result = await run(project);
    assert.equal(result.status, 'success');

    const status = readStatus(result.journal.paths);
    const stepOfA = status.jobs.find((job) => job.id === 'a')?.steps.at(-1);
    assert.equal(stepOfA?.anchor_kind, 'git', 'якорь копии внутри репозитория снят средствами git');
    assert.ok(stepOfA?.tree_id !== undefined, 'состояние копии зафиксировано');

    // a — предшественник двоих: обе получают собственные каталоги, засеянные
    // деревом a.
    for (const id of ['b', 'c']) {
      const dir = workspaceOfJob(result, id).path;
      assert.notEqual(dir, workspaceOfJob(result, 'a').path);
      assert.equal(readFileSync(join(dir, 'изменяемый.txt'), 'utf8').trim(), 'новое');
      assert.equal(readFileSync(join(dir, 'новый.txt'), 'utf8').trim(), 'создано');
    }
  });

  // Сценарий: «Приведение невозможно заранее» — вне репозитория состояние
  // фиксируется хеш-манифестом, который содержимого не хранит, и засеять им
  // каталог развилки нечем. Это видно до запуска — значит и отказ должен быть
  // до первого шага, а не подготовкой директории посреди прогона.
  it('отклоняет развилку в режиме copy вне репозитория git до первой работы', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
workspace: { mode: copy }
jobs:
  a:
    steps: [{ id: c, run: [sh, -c, 'echo из-a > результат.txt'], expect: [{ exit_code: 0 }] }]
  b:
    needs: [a]
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
  c:
    needs: [a]
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
`,
    });

    await assert.rejects(
      () => run(project),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /вне репозитория git это невозможно/);
        assert.match(error.hint ?? '', /inherit: none/);
        return true;
      },
    );

    assert.equal(existsSync(project.path('результат.txt')), false, 'ни один шаг не исполнен');
  });

  // Сценарий: «Приведение не удалось» — отказ приведения каталога к якорю
  // источника проходит тем же путём, что и отказ подготовки директории, и не
  // оставляет за собой ни исполненных шагов, ни заведённого каталога.
  it('отказ приведения к якорю источника даёт spawn_failed без единого шага', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
workspace: { mode: worktree }
fail_fast: false
jobs:
  a:
    steps: [{ id: c, run: [sh, -c, 'echo из-a > от-a.txt'], expect: [{ exit_code: 0 }] }]
  b:
    needs: [a]
    steps: [{ id: c, run: [sh, -c, 'echo из-b > от-b.txt'], expect: [{ exit_code: 0 }] }]
  c:
    needs: [a]
    steps: [{ id: c, run: [sh, -c, 'echo из-c > от-c.txt'], expect: [{ exit_code: 0 }] }]
`,
    });
    gitInit(project);
    commit(project, 'первый');

    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
    const expanded = expandPipeline({
      pipelinePath: project.path('stepcast.yml'),
      config: project.config,
    });
    const result = await runPipeline({
      expanded,
      config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
      // Якоря снимаются по-настоящему, а приведение к чужому состоянию
      // отказывает — так ведёт себя недоступный объект дерева.
      anchorerFor: (options) => {
        const real = createAnchorer(options);
        return {
          ...real,
          restore: () => {
            throw new StepcastError('объекты состояния недоступны');
          },
        };
      },
    });

    assert.equal(result.status, 'failed');
    const status = readStatus(result.journal.paths);
    for (const id of ['b', 'c']) {
      const record = status.jobs.find((job) => job.id === id);
      assert.equal(record?.status, 'failed');
      assert.equal(record?.cause, HaltCause.spawnFailed);
      assert.match(record?.reason ?? '', /объекты состояния недоступны/);
      assert.deepEqual(record?.steps, [], 'ни один шаг не исполнен');
      assert.equal(record?.workspace, undefined, 'рабочая директория не записана');
    }

    // Каталог, заведённый под неудавшийся засев, не остаётся ни на диске, ни в
    // учёте git: иначе следующий прогон споткнётся о занятое имя worktree.
    const dirs = execFileSync('git', ['-C', project.root, 'worktree', 'list'], {
      encoding: 'utf8',
    });
    const workspaces = workspacesDir(result);
    // Учёт проверяется по настоящему пути worktree, а не по `runsRoot/<работа>`:
    // между корнем прогонов и рабочими каталогами лежат ключ проекта и
    // идентификатор прогона, и ключ — двенадцать шестнадцатеричных цифр, которые
    // с заметной вероятностью начинаются на `b` или `c`. Такое сравнение по
    // вхождению строки срабатывало на самом ключе и роняло тест случайным
    // образом. Строка каталога работы `a` подтверждает форму сравнения: без неё
    // проверка отсутствия `b` и `c` проходила бы вхолостую.
    assert.ok(dirs.includes(join(workspaces, 'a')), 'worktree работы a в учёте git есть');
    for (const id of ['b', 'c']) {
      assert.equal(dirs.includes(join(workspaces, id)), false, `worktree ${id} снят с учёта`);
      assert.equal(existsSync(join(workspaces, id)), false, `каталог ${id} убран`);
    }
  });

  // Сценарий: «Приведение не удалось» при недоступном учёте git. Работы,
  // засеваемые от одного предшественника, идут параллельно и зовут `git
  // worktree remove` в одном общем репозитории; отказ этой команды — не
  // повод оставить каталог на диске. Здесь учётная запись worktree исчезает
  // ровно перед уборкой (так выглядит чужой prune, успевший первым), и
  // `worktree remove` отказывает — каталог всё равно обязан уйти.
  it('убирает каталог развилки, даже когда git worktree remove отказал', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
workspace: { mode: worktree }
fail_fast: false
jobs:
  a:
    steps: [{ id: c, run: [sh, -c, 'echo из-a > от-a.txt'], expect: [{ exit_code: 0 }] }]
  b:
    needs: [a]
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
  c:
    needs: [a]
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
`,
    });
    gitInit(project);
    commit(project, 'первый');

    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
    const expanded = expandPipeline({
      pipelinePath: project.path('stepcast.yml'),
      config: project.config,
    });
    const result = await runPipeline({
      expanded,
      config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
      anchorerFor: (options) => {
        const real = createAnchorer(options);
        return {
          ...real,
          restore: () => {
            rmSync(join(project.root, '.git', 'worktrees', basename(options.dir)), {
              recursive: true,
              force: true,
            });
            throw new StepcastError('объекты состояния недоступны');
          },
        };
      },
    });

    assert.equal(result.status, 'failed');
    const workspaces = workspacesDir(result);
    for (const id of ['b', 'c']) {
      assert.equal(existsSync(join(workspaces, id)), false, `каталог ${id} убран и без git`);
    }
    const dirs = execFileSync('git', ['-C', project.root, 'worktree', 'list'], {
      encoding: 'utf8',
    });
    assert.ok(dirs.includes(join(workspaces, 'a')), 'worktree работы a в учёте git есть');
    for (const id of ['b', 'c']) {
      assert.equal(dirs.includes(join(workspaces, id)), false, `worktree ${id} снят с учёта`);
    }
  });

  // Сценарий: «Каталог цепочки один» / «Неотслеживаемое содержимое переходит по цепочке»
  it('цепочка из трёх работ делит один каталог, и игнорируемый файл переходит по ней', async () => {
    const project = makeProject({
      '.gitignore': 'игнор.txt\n',
      'stepcast.yml': `
version: 1
kind: pipeline
workspace: { mode: worktree }
jobs:
  a:
    steps: [{ id: c, run: [sh, -c, 'echo мимо-git > игнор.txt'], expect: [{ exit_code: 0 }] }]
  b:
    needs: [a]
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
  c:
    needs: [b]
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
`,
    });
    gitInit(project);
    commit(project, 'первый');

    const result = await run(project);
    assert.equal(result.status, 'success');

    const dirA = workspaceOfJob(result, 'a').path;
    const dirB = workspaceOfJob(result, 'b').path;
    const dirC = workspaceOfJob(result, 'c').path;
    assert.equal(dirA, dirB);
    assert.equal(dirB, dirC);
    assert.equal(readFileSync(join(dirC, 'игнор.txt'), 'utf8').trim(), 'мимо-git');
  });

  // Сценарий: «Развилка каталог не продолжает» / «Игнорируемое содержимое источника не переносится»
  it('развилка даёт по каталогу на потомка, и игнорируемый файл источника в них не попадает', async () => {
    const project = makeProject({
      '.gitignore': 'игнор.txt\n',
      'stepcast.yml': `
version: 1
kind: pipeline
workspace: { mode: worktree }
jobs:
  a:
    steps:
      - id: c
        run: [sh, -c, 'echo из-a > отслеживаемый.txt; echo мимо-git > игнор.txt']
        expect: [{ exit_code: 0 }]
  b:
    needs: [a]
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
  c:
    needs: [a]
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
`,
    });
    gitInit(project);
    commit(project, 'первый');

    const result = await run(project);
    assert.equal(result.status, 'success');

    const dirA = workspaceOfJob(result, 'a').path;
    const dirB = workspaceOfJob(result, 'b').path;
    const dirC = workspaceOfJob(result, 'c').path;
    assert.notEqual(dirA, dirB);
    assert.notEqual(dirA, dirC);
    assert.notEqual(dirB, dirC);

    // Отслеживаемый файл, зафиксированный якорем, приходит в оба каталога.
    assert.equal(readFileSync(join(dirB, 'отслеживаемый.txt'), 'utf8').trim(), 'из-a');
    assert.equal(readFileSync(join(dirC, 'отслеживаемый.txt'), 'utf8').trim(), 'из-a');
    // Игнорируемый файл якорем не зафиксирован — развилка его не получает.
    assert.equal(existsSync(join(dirB, 'игнор.txt')), false);
    assert.equal(existsSync(join(dirC, 'игнор.txt')), false);
  });

  // Сценарий: «Пропуск потомка цепочку не открывает»
  it('пропуск одного из двух потомков не открывает цепочку исполненному', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
workspace: { mode: worktree }
jobs:
  a:
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
  b:
    needs: [a]
    if: "false"
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
  c:
    needs: [a]
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
`,
    });
    gitInit(project);
    commit(project, 'первый');

    const result = await run(project);
    assert.equal(result.status, 'success');

    const dirA = workspaceOfJob(result, 'a').path;
    const dirC = workspaceOfJob(result, 'c').path;
    // a — предшественник у двух потомков в графе: развилка, даже если один из
    // них пропущен. c не занимает каталог a, будто цепочка ему открылась.
    assert.notEqual(dirA, dirC);
  });

  // Сценарий: «Явно выбранный источник» / «Отказ от наследования»
  it('явный inherit выбирает дерево названной работы, а none — исходное состояние', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
workspace: { mode: worktree }
jobs:
  a:
    steps: [{ id: c, run: [sh, -c, 'echo из-a > от-a.txt'], expect: [{ exit_code: 0 }] }]
  b:
    steps: [{ id: c, run: [sh, -c, 'echo из-b > от-b.txt'], expect: [{ exit_code: 0 }] }]
  c:
    needs: [a, b]
    workspace: { inherit: a }
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
  d:
    needs: [a, b]
    workspace: { inherit: none }
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
`,
    });
    gitInit(project);
    commit(project, 'первый');

    const result = await run(project);
    assert.equal(result.status, 'success');

    const dirC = workspaceOfJob(result, 'c').path;
    assert.ok(existsSync(join(dirC, 'от-a.txt')), 'c унаследовала дерево a');
    assert.equal(existsSync(join(dirC, 'от-b.txt')), false, 'дерево b в c не попало');

    const dirD = workspaceOfJob(result, 'd').path;
    assert.equal(existsSync(join(dirD, 'от-a.txt')), false, 'inherit: none — исходное состояние');
    assert.equal(existsSync(join(dirD, 'от-b.txt')), false);
  });

  // Сценарий: «Пропущенный источник»
  //
  // Планировщик пропускает работу целиком, если пропущены все её зависимости
  // (test/scheduler.test.ts: «пропускает работу, у которой пропущены все
  // зависимости») — значит цепочка a → b → c с единственной зависимостью на
  // каждом звене и пропущенной b пропустила бы и c тоже, ещё до того, как
  // наследование вообще заговорило бы. Дополнительная работа x — вторая,
  // непропущенная зависимость c — держит c исполняемой, а выбор источника
  // среди двух зависимостей называется явно.
  it('пропущенный источник переходит к своему источнику', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
workspace: { mode: worktree }
jobs:
  a:
    steps: [{ id: c, run: [sh, -c, 'echo из-a > от-a.txt'], expect: [{ exit_code: 0 }] }]
  b:
    needs: [a]
    if: "false"
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
  x:
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
  c:
    needs: [b, x]
    workspace: { inherit: b }
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
`,
    });
    gitInit(project);
    commit(project, 'первый');

    const result = await run(project);
    assert.equal(result.status, 'success');

    const dirC = workspaceOfJob(result, 'c').path;
    assert.ok(
      existsSync(join(dirC, 'от-a.txt')),
      'b пропущена — источником становится её собственный источник, a',
    );
  });

  // Сценарий: «Цепочка исчерпана» — по той же причине источник b (сам без
  // зависимостей и пропущенный) не даёт исполняемой b дойти до этого места:
  // здесь исчерпание проверяется на явном inherit, указывающем на
  // пропущенную работу без собственного источника, а не на цепочке needs.
  it('исчерпанная цепочка источников даёт исходное состояние, работа исполняется', async () => {
    const project = makeProject({
      'исходный.txt': 'из проекта',
      'stepcast.yml': `
version: 1
kind: pipeline
workspace: { mode: worktree }
jobs:
  a:
    if: "false"
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
  x:
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
  b:
    needs: [a, x]
    workspace: { inherit: a }
    steps: [{ id: c, run: [cat, исходный.txt], expect: [{ exit_code: 0 }] }]
`,
    });
    gitInit(project);
    commit(project, 'первый');

    const result = await run(project);
    assert.equal(result.status, 'success');
    assert.equal(
      readFileSync(join(workspaceOfJob(result, 'b').path, 'исходный.txt'), 'utf8'),
      'из проекта',
    );
  });

  // Сценарий: «Стыковка якорей»
  it('tree_before первого шага зависимой работы равен tree_id последнего шага источника', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
workspace: { mode: worktree }
jobs:
  a:
    steps:
      - id: один
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
      - id: два
        run: [sh, -c, 'echo из-a > файл.txt']
        expect: [{ exit_code: 0 }]
  b:
    needs: [a]
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
`,
    });
    gitInit(project);
    commit(project, 'первый');

    const result = await run(project);
    assert.equal(result.status, 'success');

    const status = readStatus(result.journal.paths);
    const lastStepOfA = status.jobs.find((job) => job.id === 'a')?.steps.at(-1);
    const firstStepOfB = status.jobs.find((job) => job.id === 'b')?.steps.at(0);
    assert.ok(lastStepOfA?.tree_id !== undefined);
    assert.equal(firstStepOfB?.tree_before, lastStepOfA?.tree_id);
  });
});

describe('workspace-modes: пригодность проверяется заранее', () => {
  // Сценарий: «Путь копии при неподходящем режиме»
  it('отклоняет путь размещения копии при режиме, отличном от copy', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: путь-не-туда
workspace: { mode: cwd, path: ./куда-то }
jobs:
  build:
    steps:
      - id: a
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
`,
    });

    await assert.rejects(
      () => run(project),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /допустим только при режиме copy/);
        return true;
      },
    );
  });
});

describe('workspace-modes: отказ подготовки не вводит новой причины', () => {
  // Подготовка рабочей директории — не новая причина остановки: шаги негде
  // запустить, а это `spawn_failed` из закрытого перечня.
  it('даёт работе отказ с причиной из перечня, называя режим', async () => {
    const project = makeProject({
      'stepcast.yml': pipelineWriting('copy', ', path: /несуществующий-корень/куда-нельзя'),
    });

    // Предстартовая проверка ловит это раньше исполнения — что и требуется.
    await assert.rejects(
      () => run(project),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /недоступно/);
        return true;
      },
    );

    assert.ok(HaltCause.spawnFailed === 'spawn_failed');
  });
});

describe('runner-disposers: откат подготовки рабочей директории', () => {
  // Отказ самой уборки за неудавшейся подготовкой раньше проглатывался: он
  // не доходил ни до журнала, ни до пользователя. Теперь это учётная
  // операция — событие с именем операции, — а наружу по-прежнему уходит
  // причина отказа подготовки, а не жалоба уборки.
  it('отказ снятия заведённого записывается в журнал, а наружу уходит причина заведения', async () => {
    const project = makeProject({
      'stepcast.yml': pipelineWriting('worktree'),
      '.gitignore': 'part-b/\n',
      'part-a/.gitkeep': '',
      'part-b/.gitkeep': '',
    });
    gitInit(project);
    gitInitDir(project.path('part-a'));
    gitCommit(project.path('part-a'), 'начало части a');
    // part-b — репозиторий без коммита: worktree add … HEAD в нём невозможен.
    gitInitDir(project.path('part-b'));
    commit(project, 'первый');

    const { pipeline } = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config });
    const job = pipeline.jobs.find((item) => item.id === 'build')!;
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
    const journal = RunJournal.create({ runsRoot, projectRoot: project.root });
    // Каталог дерева намеренно уводится за пределы директории прогона:
    // `removeWorktree` отказывает на таком пути своим инвариантом, и обе
    // обратные операции отката гарантированно падают.
    const outside = mkdtempSync(join(tmpdir(), 'stepcast-outside-'));

    await assert.rejects(
      () =>
        prepareWorkspace({
          job: { ...job, workspace: { ...job.workspace, path: outside } },
          cwd: project.root,
          runDir: journal.paths.dir,
          bookkeeping: { journal, job: job.id },
          nestedRepos: ['part-a', 'part-b'],
        }),
      // Наружу — причина заведения части b, а не отказ уборки за ней.
      (error: unknown) => /worktree|HEAD|part-b/i.test(String((error as Error).message)),
    );

    const failures = readEvents(journal.paths).filter((event) => event.kind === 'bookkeeping.failed') as {
      operation: string;
      job?: string;
    }[];
    // Снятие идёт в обратном порядке: часть a, затем корень.
    assert.deepEqual(
      failures.map((event) => event.operation),
      ['снятие части part-a рабочего дерева работы', 'снятие рабочего дерева работы'],
    );
    assert.deepEqual(new Set(failures.map((event) => event.job)), new Set([job.id]));
  });

  // Область подготовки при успехе отпускается, а не снимается: изолированное
  // дерево обязано пережить прогон, включая прогон, окончившийся отказом.
  it('успешная подготовка оставляет дерево на месте после отказа работы', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: отказ
workspace: { mode: worktree }
jobs:
  build:
    steps:
      - id: fail
        run: [sh, -c, 'echo след > след.txt; exit 7']
        expect: [{ exit_code: 0 }]
`,
    });
    gitInit(project);
    commit(project, 'первый');

    const result = await run(project);
    assert.equal(result.status, 'failed');

    const workspacePath = workspaceOfJob(result, 'build').path as string;
    assert.equal(existsSync(join(workspacePath, 'след.txt')), true, 'дерево отказавшей работы остаётся на месте');
  });
});

describe('workspace-modes: возврат результата', () => {
  // Сценарий: «Наложение результата прогона»
  it('переносит изменения изолированного прогона в текущее дерево', async () => {
    const project = makeProject({
      'исходный.txt': 'начало\n',
      'stepcast.yml': `
version: 1
kind: pipeline
name: возврат
workspace: { mode: worktree }
jobs:
  build:
    steps:
      - id: touch
        run: [sh, -c, 'printf "изменено\\n" > исходный.txt; printf "новый\\n" > добавленный.txt']
        expect: [{ exit_code: 0 }]
`,
    });
    gitInit(project);
    commit(project, 'первый');

    const result = await run(project);
    assert.equal(result.status, 'success');
    assert.equal(readFileSync(project.path('исходный.txt'), 'utf8'), 'начало\n');

    const outcome = applyRun({ paths: result.journal.paths, cwd: project.root });
    assert.equal(outcome.kind, 'applied');

    assert.equal(readFileSync(project.path('исходный.txt'), 'utf8'), 'изменено\n');
    assert.equal(readFileSync(project.path('добавленный.txt'), 'utf8'), 'новый\n');
  });

  // Сценарий: «Наложение одной работы»
  it('накладывает только указанную работу', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: выборочно
workspace: { mode: worktree }
jobs:
  первая:
    steps:
      - id: a
        run: [sh, -c, 'printf "от первой\\n" > от-первой.txt']
        expect: [{ exit_code: 0 }]
  вторая:
    needs: [первая]
    steps:
      - id: b
        run: [sh, -c, 'printf "от второй\\n" > от-второй.txt']
        expect: [{ exit_code: 0 }]
`,
    });
    gitInit(project);
    project.write('затравка.txt', 'нужен хотя бы один коммит\n');
    commit(project, 'первый');

    const result = await run(project);
    applyRun({ paths: result.journal.paths, cwd: project.root, job: 'первая' });

    assert.ok(existsSync(project.path('от-первой.txt')));
    assert.equal(existsSync(project.path('от-второй.txt')), false);
  });

  // Сценарий: «Конфликт»
  it('оставляет дерево нетронутым при конфликте и называет пути', async () => {
    const project = makeProject({
      'спорный.txt': 'строка один\nстрока два\nстрока три\n',
      'stepcast.yml': `
version: 1
kind: pipeline
name: конфликт
workspace: { mode: worktree }
jobs:
  build:
    steps:
      - id: touch
        run: [sh, -c, 'printf "строка один\\nправка прогона\\nстрока три\\n" > спорный.txt']
        expect: [{ exit_code: 0 }]
`,
    });
    gitInit(project);
    commit(project, 'первый');

    const result = await run(project);

    // Пользователь правит ту же строку по-своему.
    project.write('спорный.txt', 'строка один\nправка пользователя\nстрока три\n');
    const beforeApply = readFileSync(project.path('спорный.txt'), 'utf8');

    assert.throws(
      () => applyRun({ paths: result.journal.paths, cwd: project.root }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /не сошлось/);
        assert.match(error.hint ?? '', /спорный\.txt/);
        return true;
      },
    );

    assert.equal(
      readFileSync(project.path('спорный.txt'), 'utf8'),
      beforeApply,
      'дерево должно остаться ровно таким, каким было до попытки',
    );
  });

  // Сценарий: «Наложение в режиме cwd»
  it('сообщает, что результат уже на месте, для прогона в каталоге запуска', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: на-месте
jobs:
  build:
    steps:
      - id: a
        run: [sh, -c, 'printf "уже тут\\n" > результат.txt']
        expect: [{ exit_code: 0 }]
`,
    });
    gitInit(project);
    commit(project, 'первый');

    const result = await run(project);
    const outcome = applyRun({ paths: result.journal.paths, cwd: project.root });

    assert.equal(outcome.kind, 'already-in-place');
    assert.equal(readFileSync(project.path('результат.txt'), 'utf8'), 'уже тут\n');
  });

  // Сценарий: «Прогон снят вне git»
  it('отклоняет наложение для прогона вне git и печатает путь дерева', async () => {
    const project = makeProject({ 'stepcast.yml': pipelineWriting('copy') });

    const result = await run(project);

    assert.throws(
      () => applyRun({ paths: result.journal.paths, cwd: project.root }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /вне git/);
        assert.match(error.hint ?? '', /build:/);
        return true;
      },
    );
  });

  // Задача 2.5 (merge-lanes-per-repo): составной прогон накладывается по
  // репозиториям — правки корня и части ложатся каждая в свой репозиторий.
  it('переносит вклад составного прогона в корень и в объявленный вложенный репозиторий', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: составной-возврат
workspace: { mode: worktree }
jobs:
  build:
    steps:
      - id: touch
        run: [sh, -c, 'printf "root\\n" > root.txt; printf "site\\n" > public-site/site.txt']
        expect: [{ exit_code: 0 }]
`,
      'public-site/.gitkeep': '',
    });
    gitInit(project);
    gitInitDir(project.path('public-site'));
    gitCommit(project.path('public-site'), 'начало части');
    commit(project, 'первый');

    const result = await runWithConfig(project, withNestedRepos(project, ['public-site']));
    assert.equal(result.status, 'success');

    const outcome = applyRun({ paths: result.journal.paths, cwd: project.root, nestedRepos: ['public-site'] });

    assert.equal(outcome.kind, 'applied');
    assert.equal(readFileSync(project.path('root.txt'), 'utf8'), 'root\n');
    assert.equal(readFileSync(project.path('public-site/site.txt'), 'utf8'), 'site\n');
  });

  it('конфликт в части откатывает и её, и уже наложенный корень, называя конфликтующие пути', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: составной-конфликт
workspace: { mode: worktree }
jobs:
  build:
    steps:
      - id: touch
        run: [sh, -c, 'printf "root\\n" > root.txt; printf "строка один\\nправка прогона\\nстрока три\\n" > public-site/спорный.txt']
        expect: [{ exit_code: 0 }]
`,
      'public-site/спорный.txt': 'строка один\nстрока два\nстрока три\n',
    });
    gitInit(project);
    gitInitDir(project.path('public-site'));
    gitCommit(project.path('public-site'), 'начало части');
    commit(project, 'первый');

    const result = await runWithConfig(project, withNestedRepos(project, ['public-site']));
    assert.equal(result.status, 'success');

    // Пользователь правит ту же строку части по-своему, до наложения.
    project.write('public-site/спорный.txt', 'строка один\nправка пользователя\nстрока три\n');
    const rootHeadBefore = execFileSync('git', ['-C', project.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    const partHeadBefore = execFileSync('git', ['-C', project.path('public-site'), 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    });

    assert.throws(
      () => applyRun({ paths: result.journal.paths, cwd: project.root, nestedRepos: ['public-site'] }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /не сошлось/);
        assert.match(error.hint ?? '', /спорный\.txt/);
        return true;
      },
    );

    assert.equal(existsSync(project.path('root.txt')), false, 'уже наложенный корень откатан');
    assert.equal(
      readFileSync(project.path('public-site/спорный.txt'), 'utf8'),
      'строка один\nправка пользователя\nстрока три\n',
      'правка пользователя в части сохранена, а не затёрта попыткой',
    );
    assert.equal(
      execFileSync('git', ['-C', project.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }),
      rootHeadBefore,
    );
    assert.equal(
      execFileSync('git', ['-C', project.path('public-site'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }),
      partHeadBefore,
    );
  });

  it('состояние чужого состава отказывает, называя расхождение, и не трогает дерева', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: составной-чужой-состав
workspace: { mode: worktree }
jobs:
  build:
    steps: [{ id: touch, run: [sh, -c, 'printf "root\\n" > root.txt'], expect: [{ exit_code: 0 }] }]
`,
      'public-site/.gitkeep': '',
      'vendor-sdk/.gitkeep': '',
    });
    gitInit(project);
    gitInitDir(project.path('public-site'));
    gitCommit(project.path('public-site'), 'начало части');
    gitInitDir(project.path('vendor-sdk'));
    gitCommit(project.path('vendor-sdk'), 'начало другой части');
    commit(project, 'первый');

    // Прогон снят на составе из одного public-site.
    const result = await runWithConfig(project, withNestedRepos(project, ['public-site']));
    assert.equal(result.status, 'success');

    const rootHeadBefore = execFileSync('git', ['-C', project.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });

    assert.throws(
      // Наложение вызвано при другом составе — public-site и vendor-sdk.
      () => applyRun({ paths: result.journal.paths, cwd: project.root, nestedRepos: ['public-site', 'vendor-sdk'] }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /не совпадает с действующим/);
        return true;
      },
    );

    assert.equal(existsSync(project.path('root.txt')), false, 'дерево не тронуто');
    assert.equal(
      execFileSync('git', ['-C', project.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }),
      rootHeadBefore,
    );
  });

  // Задача 2.2 (merge-lanes-per-repo): запись gitlink объявленного каталога
  // двигает коммит внутри части, которого прогон никогда не делает сам, —
  // такое состояние движок не порождает, и наложение обязано его назвать.
  it('патч, двигающий gitlink объявленного каталога, отказывает названной причиной', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: составной-gitlink
workspace: { mode: worktree }
jobs:
  build:
    steps:
      - id: touch
        run: [sh, -c, 'cd public-site && git commit --allow-empty -m "коммит части (тест)"']
        expect: [{ exit_code: 0 }]
`,
      'public-site/.gitkeep': '',
    });
    gitInit(project);
    gitInitDir(project.path('public-site'));
    gitCommit(project.path('public-site'), 'начало части');
    commit(project, 'первый');

    const result = await runWithConfig(project, withNestedRepos(project, ['public-site']));
    assert.equal(result.status, 'success');

    const rootHeadBefore = execFileSync('git', ['-C', project.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    const partHeadBefore = execFileSync('git', ['-C', project.path('public-site'), 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    });

    assert.throws(
      () => applyRun({ paths: result.journal.paths, cwd: project.root, nestedRepos: ['public-site'] }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /gitlink/);
        assert.match(error.message, /public-site/);
        return true;
      },
    );

    assert.equal(
      execFileSync('git', ['-C', project.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }),
      rootHeadBefore,
      'корень не тронут',
    );
    assert.equal(
      execFileSync('git', ['-C', project.path('public-site'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }),
      partHeadBefore,
      'часть не тронута',
    );
  });
});

describe('pipeline-lanes: apply --lane', () => {
  const LANES_PIPELINE = `
version: 1
kind: pipeline
name: дорожки
workspace: { mode: worktree }
jobs:
  a1:
    lane: a
    steps: [{ id: s, run: [sh, -c, 'printf "a1\\n" > a1.txt'], expect: [{ exit_code: 0 }] }]
  a2:
    lane: a
    needs: [a1]
    steps: [{ id: s, run: [sh, -c, 'printf "a2\\n" > a2.txt'], expect: [{ exit_code: 0 }] }]
  b1:
    lane: b
    steps: [{ id: s, run: [sh, -c, 'printf "b1\\n" > b1.txt'], expect: [{ exit_code: 0 }] }]
  b2:
    lane: b
    needs: [b1]
    steps: [{ id: s, run: [sh, -c, 'printf "b2\\n" > b2.txt'], expect: [{ exit_code: 0 }] }]
`;

  it('накладывает цепочку дорожки одним диффом, не трогая соседнюю', async () => {
    const project = makeProject({ 'stepcast.yml': LANES_PIPELINE });
    gitInit(project);
    project.write('затравка.txt', 'нужен хотя бы один коммит\n');
    commit(project, 'первый');

    const result = await run(project);
    assert.equal(result.status, 'success');

    const outcome = applyRun({ paths: result.journal.paths, cwd: project.root, lane: 'a' });
    assert.equal(outcome.kind, 'applied');
    if (outcome.kind === 'applied') {
      assert.deepEqual([...outcome.jobs].sort(), ['a1', 'a2']);
    }

    assert.equal(readFileSync(project.path('a1.txt'), 'utf8'), 'a1\n');
    assert.equal(readFileSync(project.path('a2.txt'), 'utf8'), 'a2\n');
    assert.equal(existsSync(project.path('b1.txt')), false);
    assert.equal(existsSync(project.path('b2.txt')), false);
  });

  it('дорожка без изолированных работ с якорями даёт nothing-to-apply', async () => {
    const project = makeProject({ 'stepcast.yml': LANES_PIPELINE });
    gitInit(project);
    project.write('затравка.txt', 'нужен хотя бы один коммит\n');
    commit(project, 'первый');

    const result = await run(project);
    const outcome = applyRun({ paths: result.journal.paths, cwd: project.root, lane: 'нет-такой' });
    assert.equal(outcome.kind, 'nothing-to-apply');
  });

  it('конфликт наложения дорожки откатывает дерево и называет пути', async () => {
    const project = makeProject({
      'спорный.txt': 'строка один\nстрока два\nстрока три\n',
      'stepcast.yml': `
version: 1
kind: pipeline
name: конфликт-дорожки
workspace: { mode: worktree }
jobs:
  build:
    lane: a
    steps:
      - id: touch
        run: [sh, -c, 'printf "строка один\\nправка прогона\\nстрока три\\n" > спорный.txt']
        expect: [{ exit_code: 0 }]
`,
    });
    gitInit(project);
    commit(project, 'первый');

    const result = await run(project);

    project.write('спорный.txt', 'строка один\nправка пользователя\nстрока три\n');
    const beforeApply = readFileSync(project.path('спорный.txt'), 'utf8');

    assert.throws(
      () => applyRun({ paths: result.journal.paths, cwd: project.root, lane: 'a' }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /не сошлось/);
        assert.match(error.hint ?? '', /спорный\.txt/);
        return true;
      },
    );

    assert.equal(readFileSync(project.path('спорный.txt'), 'utf8'), beforeApply);
  });

  // Задача 2.4/2.5 (merge-lanes-per-repo): `apply --lane` зовёт тот же
  // помощник наложения по репозиториям, что и наложение прогона целиком.
  it('накладывает составную дорожку по репозиториям — правки корня и части ложатся каждая в свой', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: составная-дорожка
workspace: { mode: worktree }
jobs:
  build:
    lane: a
    steps:
      - id: s
        run: [sh, -c, 'printf "root\\n" > root.txt; printf "site\\n" > public-site/site.txt']
        expect: [{ exit_code: 0 }]
`,
      'public-site/.gitkeep': '',
    });
    gitInit(project);
    gitInitDir(project.path('public-site'));
    gitCommit(project.path('public-site'), 'начало части');
    commit(project, 'первый');

    const result = await runWithConfig(project, withNestedRepos(project, ['public-site']));
    assert.equal(result.status, 'success');

    const outcome = applyRun({
      paths: result.journal.paths,
      cwd: project.root,
      lane: 'a',
      nestedRepos: ['public-site'],
    });

    assert.equal(outcome.kind, 'applied');
    assert.equal(readFileSync(project.path('root.txt'), 'utf8'), 'root\n');
    assert.equal(readFileSync(project.path('public-site/site.txt'), 'utf8'), 'site\n');
  });
});

describe('dependent-job-workspace: наложение цепочки', () => {
  // Сценарий: «Наложение цепочки»
  it('applyRun без --job даёт итоговое состояние цепочки без пропусков и двойного применения', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
workspace: { mode: worktree }
jobs:
  a:
    steps: [{ id: c, run: [sh, -c, 'printf "от-a\\n" > от-a.txt'], expect: [{ exit_code: 0 }] }]
  b:
    needs: [a]
    steps: [{ id: c, run: [sh, -c, 'printf "от-b\\n" > от-b.txt'], expect: [{ exit_code: 0 }] }]
  c:
    needs: [b]
    steps: [{ id: c, run: [sh, -c, 'printf "от-c\\n" > от-c.txt'], expect: [{ exit_code: 0 }] }]
`,
    });
    gitInit(project);
    commit(project, 'первый');

    const result = await run(project);
    assert.equal(result.status, 'success');

    const outcome = applyRun({ paths: result.journal.paths, cwd: project.root });
    assert.equal(outcome.kind, 'applied');

    assert.equal(readFileSync(project.path('от-a.txt'), 'utf8'), 'от-a\n');
    assert.equal(readFileSync(project.path('от-b.txt'), 'utf8'), 'от-b\n');
    assert.equal(readFileSync(project.path('от-c.txt'), 'utf8'), 'от-c\n');
  });

  // Сценарий: «Наложение до конца прогона»
  it('наложение работает на незавершённом прогоне по уже записавшим исход работам', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
workspace: { mode: worktree }
jobs:
  a:
    steps: [{ id: c, run: [sh, -c, 'printf "от-a\\n" > от-a.txt'], expect: [{ exit_code: 0 }] }]
  b:
    needs: [a]
    steps: [{ id: c, run: [sh, -c, 'sleep 2'], expect: [{ exit_code: 0 }] }]
`,
    });
    gitInit(project);
    commit(project, 'первый');

    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
    const expanded = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config });
    const pending = runPipeline({
      expanded,
      config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
    });

    // Ждём именно записанного исхода a, а не отмеренного времени: на нагруженной
    // машине сон нужной длины не гарантирует, что работа успела отчитаться.
    const paths = await waitForJobOutcome(runsRoot, project.root, 'a');
    const outcome = applyRun({ paths, cwd: project.root });
    assert.equal(outcome.kind, 'applied');
    assert.ok(
      existsSync(project.path('от-a.txt')),
      'наложение уже завершившейся работы сработало до конца прогона',
    );

    await pending;
  });

  // Сценарий: «Наложение одной работы» на работе из середины цепочки
  it('--job на работе из середины цепочки: конфликт с деревом без вклада предшественника', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
workspace: { mode: worktree }
jobs:
  a:
    steps: [{ id: c, run: [sh, -c, 'printf "от-a\\n" > общий.txt'], expect: [{ exit_code: 0 }] }]
  b:
    needs: [a]
    steps: [{ id: c, run: [sh, -c, 'printf "от-b\\n" > общий.txt'], expect: [{ exit_code: 0 }] }]
`,
    });
    gitInit(project);
    commit(project, 'первый');

    const result = await run(project);
    assert.equal(result.status, 'success');
    const beforeApply = existsSync(project.path('общий.txt'));

    // Вклад b — это правка «от-a» → «от-b»: без вклада a в дереве нет и
    // самого файла, поэтому наложение одной b на чистое дерево не сходится.
    assert.throws(
      () => applyRun({ paths: result.journal.paths, cwd: project.root, job: 'b' }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /не сошлось/);
        return true;
      },
    );

    assert.equal(
      existsSync(project.path('общий.txt')),
      beforeApply,
      'дерево остаётся неизменным при конфликте',
    );
  });
});

describe('workspace-modes: адресация прогона', () => {
  it('отклоняет неизвестный идентификатор, перечисляя последние прогоны', async () => {
    const project = makeProject({ 'stepcast.yml': pipelineWriting('copy') });
    const result = await run(project);
    const runsRoot = join(result.journal.paths.projectDir, '..');

    assert.throws(
      () => resolveRun(runsRoot, project.root, 'нет-такого'),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /не найден/);
        assert.match(error.hint ?? '', /Последние:/);
        return true;
      },
    );
  });

  it('разрешает короткий идентификатор и указатель на последний прогон', async () => {
    const project = makeProject({ 'stepcast.yml': pipelineWriting('copy') });
    const result = await run(project);
    const runsRoot = join(result.journal.paths.projectDir, '..');
    const full = result.journal.paths.runId;
    const short = full.slice(full.lastIndexOf('-') + 1);

    assert.equal(resolveRun(runsRoot, project.root, short).runId, full);
    assert.equal(resolveRun(runsRoot, project.root, 'latest').runId, full);
    assert.equal(resolveRun(runsRoot, project.root).runId, full);
  });
});

describe('workspace-modes: журнал вне рабочего дерева', () => {
  // Журнал внутри дерева обесценил бы каждый шаг: запись собственного журнала
  // сама выглядела бы изменением дерева.
  it('отклоняет каталог прогонов внутри рабочего дерева до первой работы', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: журнал-внутри
jobs:
  build:
    steps:
      - id: a
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
`,
    });

    const expanded = expandPipeline({
      pipelinePath: project.path('stepcast.yml'),
      config: project.config,
    });

    await assert.rejects(
      () =>
        runPipeline({
          expanded,
          config: {
            ...project.config,
            runs: { ...project.config.runs, root: join(project.root, '.stepcast', 'runs') },
          },
          projectRoot: project.root,
          cwd: project.root,
        }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /внутри рабочего дерева/);
        assert.match(error.hint ?? '', /вынесите runs\.root/i);
        return true;
      },
    );
  });

  it('находит нарушение, даже если путь к каталогу прогонов литерально другой из-за символической ссылки', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: журнал-через-ссылку
jobs:
  build:
    steps:
      - id: a
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
`,
    });

    // linkedRoot литерально не совпадает с project.root, но физически ведёт
    // туда же — так на macOS ведёт себя /tmp → /private/tmp.
    const linkBase = mkdtempSync(join(tmpdir(), 'stepcast-link-'));
    const linkedRoot = join(linkBase, 'alias');
    symlinkSync(project.root, linkedRoot, 'dir');

    const expanded = expandPipeline({
      pipelinePath: project.path('stepcast.yml'),
      config: project.config,
    });

    await assert.rejects(
      () =>
        runPipeline({
          expanded,
          config: {
            ...project.config,
            runs: { ...project.config.runs, root: join(linkedRoot, '.stepcast', 'runs') },
          },
          projectRoot: project.root,
          cwd: project.root,
        }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /внутри рабочего дерева/);
        return true;
      },
    );
  });
});

// Задача 7 (nested-repo-anchor): состав вложенных репозиториев проверяется
// до запуска первой работы — так же, как остальные предстартовые отказы этого
// файла.
describe('workspace-modes: состав вложенных репозиториев проверяется заранее', () => {
  it('отклоняет объявленный каталог, которого не существует', async () => {
    const project = makeProject({ 'stepcast.yml': pipelineWriting('cwd') });
    gitInit(project);
    commit(project, 'первый');

    await assert.rejects(
      () => runWithConfig(project, withNestedRepos(project, ['public-site'])),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /не существует/);
        assert.match(error.message, /public-site/);
        return true;
      },
    );
  });

  it('отклоняет объявленный каталог, который не является рабочим деревом git', async () => {
    const project = makeProject({
      'stepcast.yml': pipelineWriting('cwd'),
      // Файл, а не каталог: существует, но рабочим деревом git быть не может.
      'public-site': 'не каталог\n',
    });
    gitInit(project);
    commit(project, 'первый');

    await assert.rejects(
      () => runWithConfig(project, withNestedRepos(project, ['public-site'])),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /не является рабочим деревом git/);
        assert.match(error.message, /public-site/);
        return true;
      },
    );
  });

  it('отклоняет объявленный каталог, принадлежащий корневому репозиторию, а не собственному', async () => {
    const project = makeProject({
      'stepcast.yml': pipelineWriting('cwd'),
      'public-site/.gitkeep': '',
    });
    gitInit(project);
    commit(project, 'первый');

    await assert.rejects(
      () => runWithConfig(project, withNestedRepos(project, ['public-site'])),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /принадлежит репозиторию/);
        assert.match(error.message, /а не собственному/);
        assert.match(error.message, /public-site/);
        return true;
      },
    );
  });

  it('отклоняет состав, если корень рабочего дерева сам не является репозиторием git', async () => {
    const project = makeProject({
      'stepcast.yml': pipelineWriting('cwd'),
      'public-site/.gitkeep': '',
    });
    // Корень нарочно не инициализирован как git — только вложенный каталог.
    gitInitDir(project.path('public-site'));
    gitCommit(project.path('public-site'), 'начало части');

    await assert.rejects(
      () => runWithConfig(project, withNestedRepos(project, ['public-site'])),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /Корень рабочего дерева не является репозиторием git/);
        return true;
      },
    );
  });

  // Отказ бухгалтерии посреди прогона тихий: `add -A` корня падает на
  // «does not have a commit checked out», якорь не снимается, и границы
  // правок после этого просто не оцениваются. Значит, это предстартовый отказ.
  it('отклоняет объявленный каталог без единого коммита, который корень не игнорирует', async () => {
    const project = makeProject({
      'stepcast.yml': pipelineWriting('cwd'),
      'public-site/index.html': 'сайт\n',
    });
    gitInit(project);
    commit(project, 'первый');
    // Репозиторий части заведён, но коммита в нём нет.
    gitInitDir(project.path('public-site'));

    await assert.rejects(
      () => runWithConfig(project, withNestedRepos(project, ['public-site'])),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /public-site/);
        assert.match(error.message, /не имеет ни одного коммита/);
        assert.equal(error.at, 'project.nested_repos');
        return true;
      },
    );
  });

  // Обратная половина того же отказа: игнорируемая корнем часть в его `add -A`
  // не попадает вовсе и своим репозиторием снимается без коммита прекрасно —
  // отказывать здесь значило бы запретить рабочее дерево.
  it('пропускает объявленный каталог без коммита, если корень его игнорирует', async () => {
    const project = makeProject({
      'stepcast.yml': pipelineWriting('cwd'),
      '.gitignore': 'public-site/\n',
      'public-site/index.html': 'сайт\n',
    });
    gitInit(project);
    commit(project, 'первый');
    gitInitDir(project.path('public-site'));

    const result = await runWithConfig(project, withNestedRepos(project, ['public-site']));
    assert.equal(result.status, 'success');
  });

  // Задача 3 (nested-repo-isolation): изолированный режим worktree при
  // пригодном составе больше не отклоняется — часть материализуется своим
  // рабочим деревом, и якорь остаётся составным.
  it('пригодный состав в режиме worktree не мешает прогону', async () => {
    const project = makeProject({
      'stepcast.yml': pipelineWriting('worktree'),
      'public-site/.gitkeep': '',
    });
    gitInit(project);
    gitInitDir(project.path('public-site'));
    gitCommit(project.path('public-site'), 'начало части');
    commit(project, 'первый');

    const result = await runWithConfig(project, withNestedRepos(project, ['public-site']));
    assert.equal(result.status, 'success');
  });

  // Сегодняшнее послабление «часть без коммита допустима, если корень её
  // игнорирует» относится к корневому `add -A` и на `worktree add … HEAD`
  // части не распространяется: такой репозиторий вывести из HEAD невозможно.
  it('отклоняет часть без коммита в режиме worktree, даже если корень её игнорирует', async () => {
    const project = makeProject({
      'stepcast.yml': pipelineWriting('worktree'),
      '.gitignore': 'public-site/\n',
      'public-site/index.html': 'сайт\n',
    });
    gitInit(project);
    commit(project, 'первый');
    gitInitDir(project.path('public-site'));

    await assert.rejects(
      () => runWithConfig(project, withNestedRepos(project, ['public-site'])),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /public-site/);
        assert.match(error.message, /не имеет ни одного коммита/);
        assert.match(error.message, /worktree/);
        assert.equal(error.at, 'project.nested_repos');
        return true;
      },
    );
  });

  // Каталог стал репозиторием позже, чем его файлы попали в индекс корня:
  // выкладка корня в режиме worktree заняла бы этот каталог, и `worktree
  // add` части отказал бы диагностикой git посреди подготовки.
  it('отклоняет часть, чьи файлы отслеживает корень, в режиме worktree', async () => {
    const project = makeProject({
      'stepcast.yml': pipelineWriting('worktree'),
      'public-site/index.html': 'сайт\n',
    });
    gitInit(project);
    commit(project, 'первый');
    gitInitDir(project.path('public-site'));
    gitCommit(project.path('public-site'), 'начало части');

    await assert.rejects(
      () => runWithConfig(project, withNestedRepos(project, ['public-site'])),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /public-site/);
        assert.match(error.message, /отслеживает файлы/);
        assert.equal(error.at, 'project.nested_repos');
        return true;
      },
    );
  });

  it('отклоняет работу в режиме copy при объявленном составе', async () => {
    const project = makeProject({
      'stepcast.yml': pipelineWriting('copy'),
      'public-site/.gitkeep': '',
    });
    gitInit(project);
    gitInitDir(project.path('public-site'));
    gitCommit(project.path('public-site'), 'начало части');
    commit(project, 'первый');

    await assert.rejects(
      () => runWithConfig(project, withNestedRepos(project, ['public-site'])),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /copy/);
        return true;
      },
    );
  });

  it('пригодный состав в режиме каталога запуска прогону не мешает', async () => {
    const project = makeProject({
      'stepcast.yml': pipelineWriting('cwd'),
      'public-site/.gitkeep': '',
    });
    gitInit(project);
    gitInitDir(project.path('public-site'));
    gitCommit(project.path('public-site'), 'начало части');
    commit(project, 'первый');

    const result = await runWithConfig(project, withNestedRepos(project, ['public-site']));
    assert.equal(result.status, 'success');
  });

  it('без объявленного состава worktree и copy доступны как прежде', async () => {
    const project = makeProject({ 'stepcast.yml': pipelineWriting('worktree') });
    gitInit(project);
    commit(project, 'первый');

    const result = await run(project);
    assert.equal(result.status, 'success');
  });
});
