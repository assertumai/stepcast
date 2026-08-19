import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { expandPipeline } from '../src/core/pipeline/expand.js';
import { readStatus, resolveRun } from '../src/core/journal/reader.js';
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

  // Сценарий: «Изоляция работ друг от друга»
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
    needs: [первая]
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
});
