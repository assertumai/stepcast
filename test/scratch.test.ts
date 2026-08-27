import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { expandPipeline } from '../src/core/pipeline/expand.js';
import { jobDir, jobScratchDir, runPaths } from '../src/core/journal/paths.js';
import { readEvents, readStatus, resolveRun } from '../src/core/journal/reader.js';
import { runPipeline, type RunResult } from '../src/core/run/runner.js';
import { makeProject, type Project } from './helpers.js';

function gitInit(project: Project): void {
  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', project.root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  };
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Тест');
  writeFileSync(project.path('.gitkeep'), '');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'начало');
}

async function run(project: Project, runsRoot: string): Promise<RunResult> {
  const expanded = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config });
  return runPipeline({
    expanded,
    config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
    projectRoot: project.root,
    cwd: project.root,
  });
}

describe('run-layout: путь каталога черновиков', () => {
  it('считается по тем же входам, что и jobDir, и лежит внутри jobDir работы', () => {
    const paths = runPaths('/runs', 'key1', 'run-1');
    const scratch = jobScratchDir(paths, 'build');
    assert.equal(scratch, join(jobDir(paths, 'build'), 'scratch'));
  });

  for (const mode of ['cwd', 'worktree', 'copy'] as const) {
    it(`лежит вне рабочего дерева в режиме ${mode}`, async () => {
      const project = makeProject({
        'stepcast.yml': `
version: 1
kind: pipeline
name: режим-${mode}
workspace: { mode: ${mode} }
jobs:
  build:
    steps:
      - id: noop
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
`,
      });
      if (mode === 'worktree') gitInit(project);

      const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
      const result = await run(project, runsRoot);
      assert.equal(result.status, 'success');

      const workspace = readStatus(result.journal.paths).jobs.find((job) => job.id === 'build')?.workspace;
      assert.ok(workspace !== undefined);
      const scratch = jobScratchDir(result.journal.paths, 'build');

      // Каталог черновиков — под `paths.jobs`, рабочая директория работы — по
      // своему пути режима; ни один не может оказаться внутри другого.
      assert.ok(!scratch.startsWith(`${workspace.path}/`) && scratch !== workspace.path);
      assert.ok(scratch.startsWith(`${result.journal.paths.jobs}/`));
    });
  }
});

describe('run-layout: жизненный цикл каталога черновиков', () => {
  it('заведён до первого шага, даже если шаг только проверяет его, не создавая', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: заведён-заранее
workspace: { mode: cwd }
jobs:
  build:
    steps:
      - id: check
        run: [sh, -c, 'test -d "$STEPCAST_JOB_DIR/scratch" && echo найден > найден.txt']
        expect: [{ exit_code: 0 }]
`,
    });
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
    const result = await run(project, runsRoot);

    assert.equal(result.status, 'success', 'каталог должен существовать уже к первому шагу');
    assert.equal(readFileSync(project.path('найден.txt'), 'utf8').trim(), 'найден');
  });

  it('пустой каталог снят по завершении работы', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: пустой-снят
workspace: { mode: cwd }
jobs:
  build:
    steps:
      - id: noop
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
`,
    });
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
    const result = await run(project, runsRoot);

    assert.equal(result.status, 'success');
    assert.equal(existsSync(jobScratchDir(result.journal.paths, 'build')), false);
  });

  it('непустой каталог остаётся нетронутым', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: непустой-сохранён
workspace: { mode: cwd }
jobs:
  build:
    steps:
      - id: draft
        run: [sh, -c, 'echo черновик > "$STEPCAST_JOB_DIR/scratch/заметка.txt"']
        expect: [{ exit_code: 0 }]
`,
    });
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
    const result = await run(project, runsRoot);

    assert.equal(result.status, 'success');
    const scratch = jobScratchDir(result.journal.paths, 'build');
    assert.equal(existsSync(scratch), true);
    assert.equal(readFileSync(join(scratch, 'заметка.txt'), 'utf8').trim(), 'черновик');
  });

  // Движок шагу удалять каталог не запрещает, и убранное им — достигнутый
  // результат, а не отказ учёта: жалобы в журнале тут быть не должно.
  it('каталог, убранный самим шагом, не даёт отказа учёта', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: убран-шагом
workspace: { mode: cwd }
jobs:
  build:
    steps:
      - id: sweep
        run: [sh, -c, 'rm -rf "$STEPCAST_SCRATCH"']
        expect: [{ exit_code: 0 }]
`,
    });
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
    const result = await run(project, runsRoot);

    assert.equal(result.status, 'success');
    assert.equal(existsSync(jobScratchDir(result.journal.paths, 'build')), false);
    const failures = readEvents(result.journal.paths).filter(
      (event) => event.kind === 'bookkeeping.failed',
    );
    assert.deepEqual(failures, []);
  });

  it('отказ снятия пустого каталога не роняет работу, а идёт в bookkeeping.failed', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: отказ-снятия
workspace: { mode: cwd }
jobs:
  build:
    steps:
      - id: slow
        run: [sleep, '0.4']
        expect: [{ exit_code: 0 }]
`,
    });
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));

    const pending = run(project, runsRoot);

    // Каталог черновиков заводится синхронно в самом начале работы, до того
    // как процесс шага вообще стартует, — окно в 0.4с шага с большим запасом
    // хватает, чтобы закрыть к нему доступ до того, как `finally` работы
    // дойдёт до снятия.
    let scratch: string | undefined;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        const paths = resolveRun(runsRoot, project.root);
        const candidate = jobScratchDir(paths, 'build');
        if (existsSync(candidate)) {
          scratch = candidate;
          break;
        }
      } catch {
        // Журнал прогона ещё не заведён — подождём и попробуем снова.
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(scratch !== undefined, 'каталог черновиков должен появиться до конца работы');
    // Каталог без прав нельзя ни прочитать, ни снять — способ вызвать отказ,
    // одинаково работающий и на macOS, и на Linux (ср. test/cleanup.test.ts).
    chmodSync(scratch as string, 0o000);

    try {
      const result = await pending;
      assert.equal(result.status, 'success', 'отказ уборки не должен становиться исходом работы');

      const failures = readEvents(result.journal.paths).filter(
        (event) => event.kind === 'bookkeeping.failed',
      );
      assert.ok(
        failures.some((event) => (event as { operation: string }).operation === 'снятие каталога черновиков'),
        'отказ снятия каталога должен быть записан в журнал',
      );
    } finally {
      chmodSync(scratch as string, 0o700);
    }
  });

  // Каталог заводится в `prepareJob` — раньше и подготовки рабочей директории,
  // и раскрытия подстановок. Оба шага могут отказать, и работа, ничего в
  // каталог не записавшая, не должна оставлять его в раскладке.
  it('снят и когда работа отказала на подготовке рабочей директории', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: отказ-подготовки
workspace: { mode: worktree }
jobs:
  build:
    steps:
      - id: noop
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
`,
    });
    // Репозиторий есть — предстартовая проверка проходит, — но коммита в нём
    // нет, и `git worktree add … HEAD` отказывает уже внутри работы, до
    // первого шага.
    execFileSync('git', ['-C', project.root, 'init', '--quiet', '--initial-branch=main'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
    const result = await run(project, runsRoot);

    assert.notEqual(result.status, 'success');
    assert.equal(existsSync(jobScratchDir(result.journal.paths, 'build')), false);
  });

  it('снят и когда работа отказала на раскрытии подстановки', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: отказ-подстановки
workspace: { mode: cwd }
jobs:
  build:
    steps:
      - id: noop
        run: [echo, '\${run.нет-такого}']
        expect: [{ exit_code: 0 }]
`,
    });
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
    const result = await run(project, runsRoot);

    assert.notEqual(result.status, 'success');
    assert.equal(existsSync(jobScratchDir(result.journal.paths, 'build')), false);
  });
});
