import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { expandPipeline } from '../src/core/pipeline/expand.js';
import { readStatus } from '../src/core/journal/reader.js';
import { runPipeline, type RunResult } from '../src/core/run/runner.js';
import { makeProject, type Project } from './helpers.js';

async function run(project: Project): Promise<RunResult> {
  const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
  return runPipeline({
    expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
    config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
    projectRoot: project.root,
    cwd: project.root,
  });
}

/**
 * Пайплайн с работой, которая наверняка споткнётся посреди исполнения, и
 * завершающей работой, которая обязана отработать в любом случае.
 *
 * Путь с подстановкой статически не проверяется — это и есть законный способ
 * получить нечитаемый файл уже в прогоне, а не до него. Триггером выбран
 * контекст агентского шага: предикат `schema` на командном шаге до чтения
 * файла не доходит — он отсекается раньше отсутствием структурированного
 * вывода, и проверял бы не тот путь.
 */
function pipeline(broken: string): string {
  return `
version: 1
kind: pipeline
name: contained
workspace: { mode: cwd }
jobs:
  ok:
    steps:
      - id: noop
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
  broken:
    needs: [ok]
${broken}
  after:
    needs: all
    on: always
    steps:
      - id: mark
        run: [sh, -c, 'echo done > after.txt']
        expect: [{ exit_code: 0 }]
`;
}

describe('pipeline-execution: ошибка внутри работы не роняет прогон', () => {
  it('нечитаемый файл контекста роняет работу, а не прогон', async () => {
    const project = makeProject({
      'stepcast.yml': pipeline(`    steps:
      - id: think
        agent: claude
        prompt: ok
        context:
          - \${run.id}/missing.md`),
    });

    const result = await run(project);
    const status = readStatus(result.journal.paths);

    assert.equal(result.status, 'failed');
    const broken = status?.jobs.find((job) => job.id === 'broken');
    assert.equal(broken?.status, 'failed');
    assert.match(broken?.reason ?? '', /прервана ошибкой/);
  });

  it('прогон получает ненулевой код возврата', async () => {
    const project = makeProject({
      'stepcast.yml': pipeline(`    steps:
      - id: think
        agent: claude
        prompt: ok
        context:
          - \${run.id}/missing.md`),
    });

    const result = await run(project);
    const status = readStatus(result.journal.paths);

    assert.equal(result.status, 'failed');
    assert.notEqual(result.exitCode, 0);
    assert.equal(status?.jobs.find((job) => job.id === 'broken')?.status, 'failed');
  });

  it('состояние прогона получает конечный статус, а не остаётся в running', async () => {
    const project = makeProject({
      'stepcast.yml': pipeline(`    steps:
      - id: think
        agent: claude
        prompt: ok
        context:
          - \${run.id}/missing.md`),
    });

    const result = await run(project);
    const status = readStatus(result.journal.paths);

    assert.notEqual(status?.status, 'running');
    assert.equal(status?.status, 'failed');
    // Работа, успевшая отработать до ошибки, сохраняет свой статус.
    assert.equal(status?.jobs.find((job) => job.id === 'ok')?.status, 'success');
  });

  it('работа с needs: all отрабатывает после такой ошибки', async () => {
    const project = makeProject({
      'stepcast.yml': pipeline(`    steps:
      - id: think
        agent: claude
        prompt: ok
        context:
          - \${run.id}/missing.md`),
    });

    const result = await run(project);
    const status = readStatus(result.journal.paths);

    assert.equal(status?.jobs.find((job) => job.id === 'after')?.status, 'success');
    assert.ok(existsSync(project.path('after.txt')), 'завершающая работа не отработала');
  });

  it('причина записывается событием в журнал', async () => {
    const project = makeProject({
      'stepcast.yml': pipeline(`    steps:
      - id: think
        agent: claude
        prompt: ok
        context:
          - \${run.id}/missing.md`),
    });

    const result = await run(project);
    const events = readFileSync(join(result.journal.paths.dir, 'events.ndjson'), 'utf8');
    const errored = events
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { kind: string; job?: string; detail?: string })
      .find((event) => event.kind === 'job.errored');

    assert.equal(errored?.job, 'broken');
    assert.match(errored?.detail ?? '', /контекста/);
  });
});
