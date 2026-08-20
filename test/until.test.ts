import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { expandPipeline } from '../src/core/pipeline/expand.js';
import { findStepDir, readEvents, readStatus } from '../src/core/journal/reader.js';
import { lintPipeline } from '../src/core/lint.js';
import { runPipeline, type RunResult } from '../src/core/run/runner.js';
import { HaltCause } from '../src/core/run/halt.js';
import { StepcastError } from '../src/core/errors.js';
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

function jobOf(result: RunResult, id: string) {
  return readStatus(result.journal.paths).jobs.find((job) => job.id === id);
}

/**
 * Работа, доходящая до успеха с N-й итерации: шаг увеличивает счётчик, а
 * проверка требует, чтобы он дорос до порога.
 */
function counting(threshold: number, maxIterations: number): string {
  return `
version: 1
kind: pipeline
name: цикл
jobs:
  работа:
    session: per_step
    budget: { tokens: 1M }
    until:
      max_iterations: ${maxIterations}
      check:
        - cmd: "test $(cat счётчик.txt) -ge ${threshold}"
    steps:
      - id: считает
        run: [sh, -c, 'echo $(( $(cat счётчик.txt) + 1 )) > счётчик.txt']
        expect: [{ exit_code: 0 }]
`;
}

describe('job-iteration: цикл повторяет шаги до выполнения условия', () => {
  // Сценарий: «Условие выполнено с первого захода»
  it('не начинает вторую итерацию, когда проверка прошла сразу', async () => {
    const project = makeProject({ 'счётчик.txt': '0\n', 'stepcast.yml': counting(1, 4) });
    const result = await run(project);

    assert.equal(result.status, 'success');
    assert.equal(jobOf(result, 'работа')?.iterations, 1);
    assert.equal(readFileSync(project.path('счётчик.txt'), 'utf8').trim(), '1');
  });

  // Сценарий: «Условие выполнено со второго захода»
  it('делает ровно столько итераций, сколько нужно', async () => {
    const project = makeProject({ 'счётчик.txt': '0\n', 'stepcast.yml': counting(3, 5) });
    const result = await run(project);

    assert.equal(result.status, 'success');
    assert.equal(jobOf(result, 'работа')?.iterations, 3);
    assert.equal(readFileSync(project.path('счётчик.txt'), 'utf8').trim(), '3');
  });

  // Сценарий: «Работа без цикла»
  it('исполняет работу без цикла один раз и не заводит итераций', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: без-цикла
jobs:
  работа:
    steps:
      - id: шаг
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
`,
    });
    const result = await run(project);

    assert.equal(result.status, 'success');
    assert.equal(jobOf(result, 'работа')?.iterations, undefined);
  });
});

describe('job-iteration: исчерпание итераций', () => {
  // Сценарий: «Предел исчерпан» / «Диагностика исчерпания»
  it('завершает работу отказом с причиной until_not_met', async () => {
    const project = makeProject({ 'счётчик.txt': '0\n', 'stepcast.yml': counting(10, 2) });
    const result = await run(project);

    assert.equal(result.status, 'failed');
    const job = jobOf(result, 'работа');
    assert.equal(job?.cause, HaltCause.untilNotMet);
    assert.match(job?.reason ?? '', /2 итераций/);
    assert.equal(job?.iterations, 2);

    // Диагностика исчерпания: непройденные предикаты последней итерации
    // должны быть видны без обращения к другим файлам.
    assert.ok(job?.last_check !== undefined, 'last_check должен быть записан');
    const failed = job.last_check.filter((item) => !item.passed);
    assert.ok(failed.length > 0);
    assert.equal(failed[0]?.predicate, 'cmd');
  });
});

describe('job-iteration: отказ шага прекращает цикл', () => {
  // Сценарий: «Шаг исчерпал попытки» / «Check не вычисляется после отказа шага»
  it('не начинает новую итерацию после отказа шага', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: падающий-шаг
jobs:
  работа:
    until:
      max_iterations: 3
      check:
        - cmd: "true"
    steps:
      - id: падает
        run: [sh, -c, 'echo раз >> попытки.txt; exit 1']
        expect: [{ exit_code: 0 }]
`,
    });

    const result = await run(project);
    assert.equal(result.status, 'failed');
    assert.equal(jobOf(result, 'работа')?.cause, HaltCause.expectFailed);

    // Шаг исполнялся ровно один раз: попытка одна, итерация одна.
    assert.equal(readFileSync(project.path('попытки.txt'), 'utf8').trim(), 'раз');
  });
});

describe('job-iteration: раскладка журнала', () => {
  // Сценарий: «Раскладка работы с циклом»
  it('группирует каталоги шагов по итерациям', async () => {
    const project = makeProject({ 'счётчик.txt': '0\n', 'stepcast.yml': counting(2, 4) });
    const result = await run(project);

    const steps = join(result.journal.paths.jobs, 'работа', 'steps');
    assert.ok(existsSync(join(steps, 'iter-1', '01-считает')));
    assert.ok(existsSync(join(steps, 'iter-2', '01-считает')));
  });

  // Сценарий: «Раскладка работы без цикла не меняется»
  it('оставляет раскладку работы без цикла прежней', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: без-цикла
jobs:
  работа:
    steps:
      - id: шаг
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
`,
    });
    const result = await run(project);

    const steps = join(result.journal.paths.jobs, 'работа', 'steps');
    assert.ok(existsSync(join(steps, '01-шаг')));
    assert.equal(existsSync(join(steps, 'iter-1')), false);
  });

  // Сценарий: «Адресация шага без указания итерации»
  it('адресует шаг по последней выполненной итерации, если она не указана', async () => {
    const project = makeProject({ 'счётчик.txt': '0\n', 'stepcast.yml': counting(3, 5) });
    const result = await run(project);

    const latest = findStepDir(result.journal.paths, 'работа', 'считает');
    const second = findStepDir(result.journal.paths, 'работа', 'считает', 2);

    assert.ok(latest?.includes('iter-3'), `ожидалась третья итерация, получено ${latest}`);
    assert.ok(second?.includes('iter-2'));
  });
});

describe('job-iteration: события итераций', () => {
  // Сценарий: «События итерации»
  it('пишет начало, завершение и исход проверки каждой итерации', async () => {
    const project = makeProject({ 'счётчик.txt': '0\n', 'stepcast.yml': counting(2, 4) });
    const result = await run(project);

    const events = readEvents(result.journal.paths);
    const started = events.filter((event) => event.kind === 'iteration.started');
    const finished = events.filter((event) => event.kind === 'iteration.finished');

    assert.equal(started.length, 2);
    assert.deepEqual(
      finished.map((event) => (event as { passed: boolean }).passed),
      [false, true],
    );
  });
});

describe('job-iteration: статическая проверка', () => {
  // Сценарий: «Предел итераций не объявлен»
  it('отклоняет until без max_iterations', () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: без-предела
jobs:
  работа:
    until:
      check:
        - cmd: "true"
    steps:
      - id: шаг
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
`,
    });

    assert.throws(
      () => expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /без max_iterations/);
        return true;
      },
    );
  });

  // Сценарий: «Пустой список проверок»
  it('отклоняет until с пустым check', () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: пустой-check
jobs:
  работа:
    until:
      max_iterations: 2
      check: []
    steps:
      - id: шаг
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
`,
    });

    assert.throws(
      () => expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /пустым check/);
        return true;
      },
    );
  });

  // Сценарий: «Цикл без бюджета работы»
  it('предупреждает о цикле без собственного бюджета и оценивает худший случай', () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: без-бюджета
budget: { tokens: 1M }
jobs:
  работа:
    until:
      max_iterations: 4
      check:
        - cmd: "true"
    steps:
      - id: шаг
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
`,
    });

    const expanded = expandPipeline({
      pipelinePath: project.path('stepcast.yml'),
      config: project.config,
    });
    const diagnostics = lintPipeline(expanded, { config: project.config });
    const warning = diagnostics.find((item) => item.message.includes('цикл until'));

    assert.ok(warning !== undefined, 'ожидалось предупреждение о цикле без бюджета');
    assert.equal(warning.severity, 'warning');
    assert.match(warning.hint ?? '', /4 итераций/);
  });

  // Сценарий: «Предикат границ изменений допустим»
  it('больше не отклоняет предикат changed_only', () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: границы
jobs:
  работа:
    steps:
      - id: шаг
        run: [echo, ok]
        expect:
          - exit_code: 0
          - changed_only: ["src/**"]
`,
    });

    const expanded = expandPipeline({
      pipelinePath: project.path('stepcast.yml'),
      config: project.config,
    });
    const errors = lintPipeline(expanded, { config: project.config }).filter(
      (item) => item.severity === 'error',
    );

    assert.deepEqual(errors, []);
  });
});
