import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { createAnchorer } from '../src/core/anchor/index.js';
import type { Config } from '../src/core/config/resolve.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { findStepDir, readStatus } from '../src/core/journal/reader.js';
import { removeRun } from '../src/core/run/cleanup.js';
import { runPipeline, type RunResult } from '../src/core/run/runner.js';
import { projectKey } from '../src/core/journal/paths.js';
import { gitCommit, gitInit, makeProject, type Project } from './helpers.js';

/**
 * Сквозной сценарий составного изолированного дерева (задача 8, план
 * `nested-repo-isolation`): корневой репозиторий с двумя объявленными
 * частями — одна игнорируется корнем, другая отслеживается гитлинком, — и
 * пайплайн из нескольких работ в режиме `worktree`.
 *
 * Отдельные свойства (заведение части, восстановление, уборка одной записи)
 * уже покрыты юнит-тестами `test/worktrees.test.ts`, `test/anchor.test.ts`,
 * `test/cleanup.test.ts` и `test/workspace.test.ts`; здесь они проверяются
 * вместе, на одном настоящем многочастном дереве, — то, что юнит-тест
 * с одной частью или с подделкой якоря не в силах показать.
 */

const PIPELINE = `
version: 1
kind: pipeline
name: сквозной
workspace: { mode: worktree }
jobs:
  propose:
    lane: a
    steps:
      - id: touch
        run: [sh, -c, 'echo корень-propose > root-propose.txt; echo сайт-propose > linked-part/site.txt; echo vendor-propose > ignored-part/vendor-propose.txt']
        expect: [{ exit_code: 0 }]
  verify:
    lane: a
    needs: [propose]
    steps:
      - id: touch
        run: [sh, -c, 'echo корень-verify > root-verify.txt; printf "сайт-verify\\n" >> linked-part/site.txt']
        expect:
          - { exit_code: 0 }
          - { changed_only: ['root-verify.txt', 'linked-part/**'] }
  independent:
    steps:
      - id: touch
        run: [sh, -c, 'echo чужое > root-independent.txt; echo чужое > linked-part/independent.txt']
        expect: [{ exit_code: 0 }]
`;

function twoPartsProject(): Project {
  const project = makeProject({
    'stepcast.yml': PIPELINE,
    '.gitignore': 'ignored-part/\n',
    'ignored-part/.gitkeep': '',
    'linked-part/.gitkeep': '',
  });
  gitInit(project.root);
  gitInit(project.path('ignored-part'));
  gitCommit(project.path('ignored-part'), 'начало игнорируемой части');
  gitInit(project.path('linked-part'));
  gitCommit(project.path('linked-part'), 'начало отслеживаемой части');
  gitCommit(project.root, 'первый');
  return project;
}

function withNestedRepos(project: Project, nestedRepos: readonly string[]): Config {
  return { ...project.config, project: { ...project.config.project, nestedRepos } };
}

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

function gitHead(dir: string): string {
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
}

function gitStatus(dir: string): string {
  return execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });
}

describe('nested-repo-isolation: сквозной сценарий составного дерева', () => {
  it('обе части материализованы, у каждой своя база объектов и свой HEAD', async () => {
    const project = twoPartsProject();
    const result = await runWithConfig(project, withNestedRepos(project, ['ignored-part', 'linked-part']));
    assert.equal(result.status, 'success');

    const propose = readStatus(result.journal.paths).jobs.find((job) => job.id === 'propose');
    assert.ok(propose?.workspace !== undefined);
    const dir = propose.workspace.path;
    const nested = propose.workspace.nested ?? [];
    assert.deepEqual(
      nested.map((part) => part.dir).sort(),
      ['ignored-part', 'linked-part'],
    );

    for (const relDir of ['ignored-part', 'linked-part']) {
      const partDir = join(dir, relDir);
      const toplevel = execFileSync('git', ['-C', partDir, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
      }).trim();
      assert.equal(
        realpathSync(toplevel),
        realpathSync(partDir),
        `${relDir} должна быть вершиной собственного рабочего дерева`,
      );
      assert.notEqual(gitHead(partDir), gitHead(dir), `${relDir} должна иметь свою базу объектов`);
    }
  });

  it('правка части даёт путь с префиксом в diff.patch и проходит changed_only, работы не видят чужих правок', async () => {
    const project = twoPartsProject();
    const result = await runWithConfig(project, withNestedRepos(project, ['ignored-part', 'linked-part']));
    assert.equal(result.status, 'success');

    // changed_only работы verify прошёл бы отказом, будь путь части
    // прочитан без префикса, — сам факт success это уже подтверждает.
    const verify = readStatus(result.journal.paths).jobs.find((job) => job.id === 'verify');
    assert.equal(verify?.status, 'success');

    const stepDir = findStepDir(result.journal.paths, 'verify', 'touch');
    assert.ok(stepDir !== undefined);
    const patch = readFileSync(join(stepDir, 'diff.patch'), 'utf8');
    assert.match(patch, /linked-part\/site\.txt/);
    assert.match(patch, /root-verify\.txt/);

    // Работа independent не входит в дорожку a и не видит её правок — ни в
    // корне, ни в частях, — а дорожка a не видит правок independent.
    const independentDir = readStatus(result.journal.paths).jobs.find((job) => job.id === 'independent')
      ?.workspace?.path;
    assert.ok(independentDir !== undefined);
    assert.equal(existsSync(join(independentDir, 'root-verify.txt')), false);
    assert.equal(existsSync(join(independentDir, 'linked-part', 'site.txt')), false);

    const verifyDir = verify?.workspace?.path;
    assert.ok(verifyDir !== undefined);
    assert.equal(existsSync(join(verifyDir, 'root-independent.txt')), false);
    assert.equal(existsSync(join(verifyDir, 'linked-part', 'independent.txt')), false);
  });

  it('приведение путей одной части не трогает соседнюю часть и корень; дерево проекта не тронуто за весь прогон', async () => {
    const project = twoPartsProject();
    const rootHeadBefore = gitHead(project.root);
    const linkedHeadBefore = gitHead(project.path('linked-part'));
    const ignoredHeadBefore = gitHead(project.path('ignored-part'));
    const rootStatusBefore = gitStatus(project.root);
    const linkedStatusBefore = gitStatus(project.path('linked-part'));
    const ignoredStatusBefore = gitStatus(project.path('ignored-part'));

    const result = await runWithConfig(project, withNestedRepos(project, ['ignored-part', 'linked-part']));
    assert.equal(result.status, 'success');

    // Рабочие деревья проекта — корень и обе части — не тронуты подготовкой
    // и исполнением ни одной из трёх работ прогона.
    assert.equal(gitHead(project.root), rootHeadBefore);
    assert.equal(gitHead(project.path('linked-part')), linkedHeadBefore);
    assert.equal(gitHead(project.path('ignored-part')), ignoredHeadBefore);
    assert.equal(gitStatus(project.root), rootStatusBefore);
    assert.equal(gitStatus(project.path('linked-part')), linkedStatusBefore);
    assert.equal(gitStatus(project.path('ignored-part')), ignoredStatusBefore);

    // Радиус разрушения: правки в двух частях и в корне дорожки работы
    // propose, приведение путей одной части не задевает остальные.
    const dir = readStatus(result.journal.paths).jobs.find((job) => job.id === 'propose')?.workspace?.path;
    assert.ok(dir !== undefined);
    const stateDir = mkdtempSync(join(tmpdir(), 'stepcast-nested-anchor-'));
    const anchorer = createAnchorer({
      dir,
      stateDir,
      nested: ['ignored-part', 'linked-part'],
    });
    const saved = anchorer.capture();
    // Дорожка a уже прогнала verify в этом же каталоге (продолжение цепочки),
    // так что «исходное» здесь — состояние после обеих работ дорожки, не
    // только после propose.
    const linkedSiteBefore = readFileSync(join(dir, 'linked-part', 'site.txt'), 'utf8');

    execFileSync('sh', ['-c', `printf "порча\\n" > ${join(dir, 'root-propose.txt')}`]);
    execFileSync('sh', ['-c', `printf "порча\\n" > ${join(dir, 'ignored-part', 'vendor-propose.txt')}`]);
    execFileSync('sh', ['-c', `printf "порча\\n" > ${join(dir, 'linked-part', 'site.txt')}`]);

    anchorer.restorePaths(saved, ['linked-part/site.txt']);

    assert.equal(readFileSync(join(dir, 'linked-part', 'site.txt'), 'utf8'), linkedSiteBefore);
    assert.equal(readFileSync(join(dir, 'root-propose.txt'), 'utf8'), 'порча\n', 'правка корня должна остаться');
    assert.equal(
      readFileSync(join(dir, 'ignored-part', 'vendor-propose.txt'), 'utf8'),
      'порча\n',
      'правка соседней части должна остаться',
    );
  });

  it('уборка снимает записи обеих частей и корня, а посторонняя запись того же репозитория цела', async () => {
    const project = twoPartsProject();
    const result = await runWithConfig(project, withNestedRepos(project, ['ignored-part', 'linked-part']));
    assert.equal(result.status, 'success');

    const worktreeRecords = (repoDir: string): string[] => {
      try {
        return readdirSync(join(repoDir, '.git', 'worktrees'));
      } catch {
        return [];
      }
    };

    // Два корневых worktree этого прогона: propose делится своим с verify
    // (продолжение цепочки), а independent заводит собственный.
    assert.equal(worktreeRecords(project.root).length, 2);
    assert.ok(worktreeRecords(project.path('linked-part')).length > 0);
    assert.ok(worktreeRecords(project.path('ignored-part')).length > 0);

    // Постороннее рабочее дерево того же корневого репозитория — не заведено
    // этим прогоном, и уборка не должна его знать.
    const foreignDir = mkdtempSync(join(tmpdir(), 'stepcast-nested-foreign-'));
    const foreignPath = join(foreignDir, 'foreign');
    execFileSync('git', ['-C', project.root, 'worktree', 'add', '--quiet', '--detach', foreignPath, 'HEAD']);
    assert.equal(worktreeRecords(project.root).length, 3, 'записи прогона (2) и постороннего дерева (1)');

    const runsRoot = dirname(dirname(result.journal.paths.dir));
    const key = projectKey(project.root);
    const removal = removeRun(runsRoot, key, result.journal.paths.runId);
    assert.deepEqual(removal.unresolvedWorktrees, []);

    assert.equal(worktreeRecords(project.root).length, 1, 'только постороннее дерево должно остаться');
    assert.equal(worktreeRecords(project.path('linked-part')).length, 0);
    assert.equal(worktreeRecords(project.path('ignored-part')).length, 0);
    assert.ok(existsSync(foreignPath), 'постороннее дерево должно остаться на месте');
  });

  it('продолжение видит части предшественника с его правками, а развилка получает части, приведённые к источнику', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: наследование-составное
workspace: { mode: worktree }
jobs:
  seed:
    steps:
      - id: touch
        run: [sh, -c, 'echo корень-seed > root.txt; echo часть-seed > linked-part/site.txt']
        expect: [{ exit_code: 0 }]
  chain:
    needs: [seed]
    steps:
      - id: touch
        run: [sh, -c, 'true']
        expect: [{ exit_code: 0 }]
  forkA:
    needs: [chain]
    steps:
      - id: touch
        run: [sh, -c, 'true']
        expect: [{ exit_code: 0 }]
  forkB:
    needs: [chain]
    steps:
      - id: touch
        run: [sh, -c, 'true']
        expect: [{ exit_code: 0 }]
`,
      '.gitignore': 'ignored-part/\n',
      'ignored-part/.gitkeep': '',
      'linked-part/.gitkeep': '',
    });
    gitInit(project.root);
    gitInit(project.path('ignored-part'));
    gitCommit(project.path('ignored-part'), 'начало игнорируемой части');
    gitInit(project.path('linked-part'));
    gitCommit(project.path('linked-part'), 'начало отслеживаемой части');
    gitCommit(project.root, 'первый');

    const result = await runWithConfig(project, withNestedRepos(project, ['ignored-part', 'linked-part']));
    assert.equal(result.status, 'success');

    const status = readStatus(result.journal.paths);
    const seedDir = status.jobs.find((job) => job.id === 'seed')?.workspace?.path;
    const chainWorkspace = status.jobs.find((job) => job.id === 'chain')?.workspace;
    const forkAWorkspace = status.jobs.find((job) => job.id === 'forkA')?.workspace;
    const forkBWorkspace = status.jobs.find((job) => job.id === 'forkB')?.workspace;
    assert.ok(seedDir !== undefined && chainWorkspace !== undefined);
    assert.ok(forkAWorkspace !== undefined && forkBWorkspace !== undefined);

    // Продолжение: тот же каталог, что у seed, — правка его части уже там.
    assert.equal(chainWorkspace.continued, true);
    assert.equal(chainWorkspace.path, seedDir);
    assert.equal(readFileSync(join(chainWorkspace.path, 'linked-part', 'site.txt'), 'utf8'), 'часть-seed\n');

    // Развилка: собственный каталог, части приведены к состоянию источника.
    for (const fork of [forkAWorkspace, forkBWorkspace]) {
      assert.notEqual(fork.path, seedDir);
      assert.equal(fork.inherited_from, 'chain');
      assert.equal(readFileSync(join(fork.path, 'linked-part', 'site.txt'), 'utf8'), 'часть-seed\n');
      assert.equal(readFileSync(join(fork.path, 'root.txt'), 'utf8'), 'корень-seed\n');
    }
  });

  // Регрессия режима cwd: тот же состав, тот же способ фиксации, та же
  // форма записи, что и до этого изменения — части не материализуются.
  it('режим cwd на том же дереве не заводит части и ведёт себя как прежде', async () => {
    const project = twoPartsProject();
    project.write('stepcast.yml', PIPELINE.replace('mode: worktree', 'mode: cwd'));

    const result = await runWithConfig(project, withNestedRepos(project, ['ignored-part', 'linked-part']));
    assert.equal(result.status, 'success');

    const status = readStatus(result.journal.paths);
    const propose = status.jobs.find((job) => job.id === 'propose');
    assert.equal(propose?.workspace?.mode, 'cwd');
    assert.equal(propose?.workspace?.path, project.root);
    assert.equal(propose?.workspace?.nested, undefined);
    assert.equal(propose?.steps[0]?.anchor_kind, 'composite');
  });
});
