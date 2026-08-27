import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, it } from 'node:test';

import { createAnchorer } from '../src/core/anchor/index.js';
import { buildGraph } from '../src/core/graph.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { readStatus, resolveRun } from '../src/core/journal/reader.js';
import { resolveInheritSource, type CompletedJob } from '../src/core/run/inherit.js';
import { runPipeline, type RunResult } from '../src/core/run/runner.js';
import { StepcastError } from '../src/core/errors.js';
import { applyRun } from '../src/core/run/apply.js';
import { HaltCause } from '../src/core/run/halt.js';
import { makeProject, type Project } from './helpers.js';

function gitInit(project: Project): void {
  const run = (...args: string[]): void => {
    execFileSync('git', ['-C', project.root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  };
  run('init', '--quiet', '--initial-branch=main');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Тест');
}

function commit(project: Project, message: string): void {
  execFileSync('git', ['-C', project.root, 'add', '-A'], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['-C', project.root, 'commit', '--quiet', '-m', message], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function run(project: Project): Promise<RunResult> {
  const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
  const expanded = expandPipeline({
    pipelinePath: project.path('stepcast.yml'),
    config: project.config,
  });
  return runPipeline({
    expanded,
    config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
    projectRoot: project.root,
    cwd: project.root,
  });
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
