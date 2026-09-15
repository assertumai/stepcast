import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { expandPipeline } from '../src/core/pipeline/expand.js';
import { runPipeline, type RunResult } from '../src/core/run/runner.js';
import type { EngineLocation } from '../src/core/run/engine.js';
import { readStatus } from '../src/core/journal/reader.js';
import { gitCommit, gitInit, makeProject, testBaseEnv, type Project } from './helpers.js';
import { tempDir } from './tmp.js';

async function run(project: Project, engineLocator?: () => EngineLocation): Promise<RunResult> {
  const runsRoot = tempDir('runs-');
  return runPipeline({
    expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
    config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
    projectRoot: project.root,
    cwd: project.root,
    // Сам этот тест может исполняться шагом stepcast (петля саморазвития), и
    // тогда process.env уже несёт STEPCAST_STEP снаружи — без очистки
    // проверка «переменная шага сюда не доходит» была бы неверной по причине,
    // не имеющей отношения к движку.
    baseEnv: testBaseEnv(),
    ...(engineLocator === undefined ? {} : { engineLocator }),
  });
}

describe('job-iteration: окружение проверки цикла', () => {
  it('env_files из корня проекта доступны шагу и проверке в отдельном worktree', async () => {
    const project = makeProject({
      '.gitignore': '.machine.env\n',
      'stepcast.yml': `
version: 1
kind: pipeline
name: checked
workspace: { mode: worktree }
env_files: [.machine.env]
jobs:
  looped:
    until:
      max_iterations: 1
      check:
        - cmd: 'test "$FROM_MACHINE" = root'
    steps:
      - id: require-env
        run: [sh, -c, 'test "$FROM_MACHINE" = root']
        expect: [{ exit_code: 0 }]
`,
    });
    gitInit(project.root);
    gitCommit(project.root, 'init');
    project.write('.machine.env', 'FROM_MACHINE=root\n');

    assert.equal((await run(project)).status, 'success');
  });

  /**
   * Проверка цикла запускает настоящую команду сборки или тестов. Раньше она
   * получала пустой набор переменных, а `execaSync` зовётся с
   * `extendEnv: false` — то есть без PATH, и любая команда, кроме встроенной
   * в оболочку, отвечала «command not found». Цикл при этом честно исчерпывал
   * итерации, каждый раз выполняя работу заново.
   */
  it('команда проверки находит инструменты из PATH', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: checked
workspace: { mode: cwd }
jobs:
  looped:
    until:
      max_iterations: 2
      check:
        - cmd: node --version
    steps:
      - id: noop
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
`,
    });

    const result = await run(project);

    assert.equal(result.status, 'success', 'проверка цикла не нашла node в PATH');
  });

  it('переменные пайплайна и работы доходят до проверки цикла', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: checked
workspace: { mode: cwd }
env:
  FROM_PIPELINE: "1"
jobs:
  looped:
    env:
      FROM_JOB: "1"
    until:
      max_iterations: 1
      check:
        - cmd: 'test "$FROM_PIPELINE$FROM_JOB$STEPCAST_JOB" = "11looped"'
    steps:
      - id: noop
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
`,
    });

    assert.equal((await run(project)).status, 'success');
  });

  it('STEPCAST_BIN доходит до проверки цикла', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: checked
workspace: { mode: cwd }
jobs:
  looped:
    until:
      max_iterations: 1
      check:
        - cmd: 'test -n "$STEPCAST_BIN"'
    steps:
      - id: noop
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
`,
    });

    assert.equal((await run(project)).status, 'success');
  });

  /**
   * merge-check-rebuilds-engine: движок правимого дерева фиксируется снимком
   * в каталоге прогона, и `STEPCAST_BIN` называет его точку входа — тем же
   * значением, что видит шаг (run-engine-snapshot, «STEPCAST_BIN называет
   * точку входа движка этого прогона»). Проверка цикла — не шаг, и обязана
   * получать то же самое, а не прежнее `process.argv[1]`.
   */
  it('STEPCAST_BIN проверки цикла ведёт в каталог прогона, когда движок снят снимком', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: checked
workspace: { mode: cwd }
jobs:
  looped:
    until:
      max_iterations: 1
      check:
        - cmd: 'test "$STEPCAST_BIN" = "$STEPCAST_RUN_DIR/engine/dist/src/bin.js"'
    steps:
      - id: noop
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
`,
    });
    const engineRoot = project.path('vendor/engine');
    mkdirSync(join(engineRoot, 'dist', 'src'), { recursive: true });
    writeFileSync(join(engineRoot, 'package.json'), JSON.stringify({ name: 'fake-engine', files: ['dist'] }));
    const entry = join(engineRoot, 'dist', 'src', 'bin.js');
    writeFileSync(entry, 'x');
    chmodSync(entry, 0o755);

    const result = await run(project, () => ({ root: engineRoot, entry }));

    assert.equal(result.status, 'success');
  });

  it('переменная уровня шага проверке цикла не объявляется', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: checked
workspace: { mode: cwd }
jobs:
  looped:
    until:
      max_iterations: 1
      check:
        - cmd: 'test -z "$STEPCAST_STEP"'
    steps:
      - id: noop
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
`,
    });

    assert.equal((await run(project)).status, 'success');
  });

  it('непройденная проверка по-прежнему исчерпывает итерации', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: checked
workspace: { mode: cwd }
jobs:
  looped:
    until:
      max_iterations: 2
      check:
        - cmd: 'false'
    steps:
      - id: noop
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
`,
    });

    const result = await run(project);
    const status = readStatus(result.journal.paths);

    assert.equal(result.status, 'failed');
    assert.match(status?.jobs[0]?.reason ?? '', /until/);
  });
});
