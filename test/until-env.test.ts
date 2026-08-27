import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { expandPipeline } from '../src/core/pipeline/expand.js';
import { runPipeline, type RunResult } from '../src/core/run/runner.js';
import { readStatus } from '../src/core/journal/reader.js';
import { makeProject, testBaseEnv, type Project } from './helpers.js';

async function run(project: Project): Promise<RunResult> {
  const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
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
  });
}

describe('job-iteration: окружение проверки цикла', () => {
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
