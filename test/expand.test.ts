import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';

import { expandPipeline } from '../src/core/pipeline/expand.js';
import { serializeLock } from '../src/core/pipeline/lock.js';
import { StepcastError } from '../src/core/errors.js';
import { asAgent, asRun, makeProject, MINIMAL_PIPELINE, type Project } from './helpers.js';

function expand(project: Project, file = 'stepcast.yml', inputs?: Record<string, string>) {
  return expandPipeline({
    pipelinePath: project.path(file),
    config: project.config,
    ...(inputs === undefined ? {} : { inputs }),
  });
}

describe('pipeline-definition: разбор и раскрытие', () => {
  // Сценарий: «Работа описана на месте»
  it('исполняет работу, описанную на месте', () => {
    const project = makeProject({ 'stepcast.yml': MINIMAL_PIPELINE });
    const { pipeline } = expand(project);

    assert.equal(pipeline.jobs.length, 1);
    const job = pipeline.jobs[0]!;
    assert.equal(job.id, 'build');
    assert.equal(job.source, project.path('stepcast.yml'));
    assert.equal(job.steps[0]!.kind, 'run');
  });

  // Сценарий: «Работа подключена файлом»
  it('раскрывает работу, подключённую файлом', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
name: p
jobs:
  build:
    uses: ./jobs/build.yml
`,
      'jobs/build.yml': `
kind: job
name: build
steps:
  - id: compile
    run: [echo, ok]
`,
    });

    const { pipeline } = expand(project);
    assert.equal(pipeline.jobs[0]!.source, project.path('jobs/build.yml'));
    assert.equal(pipeline.jobs[0]!.steps[0]!.id, 'compile');
  });

  it('отклоняет файл, у которого kind не job', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    uses: ./jobs/build.yml
`,
      'jobs/build.yml': 'kind: pipeline\njobs: {}\n',
    });
    assert.throws(() => expand(project), StepcastError);
  });

  // Сценарий: «Обязательный параметр не передан»
  it('требует обязательный параметр работы', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    uses: ./jobs/build.yml
`,
      'jobs/build.yml': `
kind: job
params:
  target: { type: string, required: true }
steps:
  - id: compile
    run: [echo, "\${params.target}"]
`,
    });

    assert.throws(
      () => expand(project),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /target/);
        return true;
      },
    );
  });

  // Сценарий: «Лишний ключ в with»
  it('отклоняет лишний ключ в with', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    uses: ./jobs/build.yml
    with: { nope: 1 }
`,
      'jobs/build.yml': 'kind: job\nsteps:\n  - id: c\n    run: [echo, ok]\n',
    });
    assert.throws(() => expand(project), StepcastError);
  });

  // Сценарий: «Умолчание параметра»
  it('подставляет умолчание параметра', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    uses: ./jobs/build.yml
`,
      'jobs/build.yml': `
kind: job
params:
  target: { type: string, default: desktop }
steps:
  - id: compile
    run: [echo, "\${params.target}"]
`,
    });

    const step = expand(project).pipeline.jobs[0]!.steps[0]!;
    assert.deepEqual(asRun(step).command, ['echo', 'desktop']);
  });

  it('приводит типы параметров', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
inputs:
  count: { type: int }
  flag: { type: bool }
jobs:
  build:
    steps:
      - id: c
        run: [echo, "\${inputs.count}-\${inputs.flag}"]
`,
    });

    const step = expand(project, 'stepcast.yml', { count: '3', flag: 'false' }).pipeline.jobs[0]!
      .steps[0]!;
    assert.deepEqual(asRun(step).command, ['echo', '3-false']);
  });

  // Сценарий: «needs в файле работы»
  it('отклоняет обвязку внутри файла работы', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    uses: ./jobs/build.yml
`,
      'jobs/build.yml': `
kind: job
needs: [other]
steps:
  - id: c
    run: [echo, ok]
`,
    });

    assert.throws(
      () => expand(project),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /needs недопустим внутри файла работы/);
        assert.equal(error.file, project.path('jobs/build.yml'));
        return true;
      },
    );
  });

  // Сценарий: «Подстановка входа пайплайна»
  it('подставляет вход пайплайна', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
inputs:
  change: { type: string, required: true }
jobs:
  build:
    steps:
      - id: c
        run: [echo, "\${inputs.change}"]
`,
    });

    const step = expand(project, 'stepcast.yml', { change: 'foo' }).pipeline.jobs[0]!.steps[0]!;
    assert.deepEqual(asRun(step).command, ['echo', 'foo']);
  });

  // Сценарий: «Неизвестное имя»
  it('отклоняет обращение к необъявленному входу', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: c
        run: [echo, "\${inputs.missing}"]
`,
    });
    assert.throws(() => expand(project), StepcastError);
  });

  it('работе недоступны inputs пайплайна', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
inputs:
  change: { type: string, default: x }
jobs:
  build:
    uses: ./jobs/build.yml
`,
      'jobs/build.yml': `
kind: job
steps:
  - id: c
    run: [echo, "\${inputs.change}"]
`,
    });

    assert.throws(
      () => expand(project),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.hint ?? '', /Работе недоступны inputs/);
        return true;
      },
    );
  });

  it('оставляет подстановки времени прогона нераскрытыми и запоминает их', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  plan:
    steps:
      - id: c
        run: [echo, ok]
  ship:
    needs: [plan]
    steps:
      - id: c
        run: [echo, "\${jobs.plan.output.target}"]
`,
    });

    const { pipeline, substitutions } = expand(project);
    assert.deepEqual(asRun(pipeline.jobs[1]!.steps[0]!).command, [
      'echo',
      '${jobs.plan.output.target}',
    ]);

    const recorded = [...substitutions.values()].flat();
    const deferred = recorded.find((item) => item.namespace === 'jobs');
    assert.ok(deferred !== undefined, 'подстановка времени прогона должна быть записана');
    assert.equal(deferred.deferred, true);
    assert.equal(deferred.expression, 'jobs.plan.output.target');
  });

  // Сценарий: «Экранирование в промпте»
  it('экранирует $${ в промпте', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  ask:
    steps:
      - id: a
        prompt: "file:./prompts/a.md"
`,
      'prompts/a.md': 'Литерал: $${params.x}\n',
    });

    const step = asAgent(expand(project).pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.prompt.trim(), 'Литерал: ${params.x}');
  });

  // Сценарий: «Промпт рядом с файлом работы»
  it('разрешает промпт от файла работы, а не от пайплайна', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  ask:
    uses: ./.stepcast/jobs/ask.yml
`,
      '.stepcast/jobs/ask.yml': `
kind: job
steps:
  - id: a
    prompt: "file:../prompts/ask.md"
`,
      '.stepcast/prompts/ask.md': 'спроси\n',
    });

    const step = asAgent(expand(project).pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.prompt.trim(), 'спроси');
    assert.equal(step.promptSource, project.path('.stepcast/prompts/ask.md'));
  });

  it('шаблонизирует файл промпта параметрами работы', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  ask:
    uses: ./jobs/ask.yml
    with: { topic: сессии }
`,
      'jobs/ask.yml': `
kind: job
params:
  topic: { type: string, required: true }
steps:
  - id: a
    prompt: "file:./ask.md"
`,
      'jobs/ask.md': 'Расскажи про \${params.topic}.\n',
    });

    const step = asAgent(expand(project).pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.prompt.trim(), 'Расскажи про сессии.');
  });

  it('применяет умолчания конфигурации и пайплайна к шагам', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
defaults:
  model: opus
jobs:
  ask:
    steps:
      - id: a
        prompt: спроси
      - id: b
        prompt: ещё
        model: sonnet
        timeout: 5m
`,
    });

    const steps = expand(project).pipeline.jobs[0]!.steps;
    const first = asAgent(steps[0]!);
    const second = asAgent(steps[1]!);

    assert.equal(first.agent, 'claude');
    assert.equal(first.model, 'opus');
    assert.equal(first.timeoutMs, 30 * 60_000, 'умолчание step_timeout из конфигурации');
    assert.equal(second.model, 'sonnet');
    assert.equal(second.timeoutMs, 5 * 60_000);
  });

  it('раздаёт псевдонимы сессий по режиму работы', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  shared_job:
    steps:
      - id: a
        prompt: раз
      - id: b
        prompt: два
  split_job:
    session: per_step
    steps:
      - id: a
        prompt: раз
      - id: b
        prompt: два
        session: named
`,
    });

    const [sharedJob, splitJob] = expand(project).pipeline.jobs;

    assert.deepEqual(
      sharedJob!.steps.map((step) => asAgent(step).session),
      ['default', 'default'],
    );
    assert.deepEqual(
      splitJob!.steps.map((step) => asAgent(step).session),
      ['a', 'named'],
    );
  });

  it('накладывает переопределения с места подключения поверх файла работы', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    uses: ./jobs/build.yml
    env: { NODE_ENV: development }
    budget: { tokens: 100k }
`,
      'jobs/build.yml': `
kind: job
env: { NODE_ENV: test, CI: "1" }
budget: { tokens: 900k }
steps:
  - id: c
    run: [echo, ok]
`,
    });

    const job = expand(project).pipeline.jobs[0]!;
    assert.equal(job.env.NODE_ENV, 'development', 'место подключения побеждает');
    assert.equal(job.env.CI, '1', 'остальное из файла работы сохраняется');
    assert.equal(job.budget?.tokens, 100_000);
  });

  it('отклоняет output без from у работы без агентских шагов', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    output: {}
    steps:
      - id: c
        run: [echo, ok]
`,
    });
    assert.throws(() => expand(project), StepcastError);
  });

  it('отклоняет превышение limits.attempts', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: c
        run: [echo, ok]
        attempts: { max: 9 }
`,
    });
    assert.throws(
      () => expand(project),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /limits\.attempts/);
        return true;
      },
    );
  });

  it('сохраняет порядок объявления работ', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  zebra:
    steps: [{ id: c, run: [echo, ok] }]
  alpha:
    steps: [{ id: c, run: [echo, ok] }]
  middle:
    steps: [{ id: c, run: [echo, ok] }]
`,
    });
    assert.deepEqual(
      expand(project).pipeline.jobs.map((job) => job.id),
      ['zebra', 'alpha', 'middle'],
    );
  });
});

// Сценарий: «Фиксация перед запуском»
describe('pipeline.lock.yml', () => {
  it('не содержит ссылок uses и нераскрытых подстановок пайплайна', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
inputs:
  change: { type: string, required: true }
jobs:
  build:
    uses: ./jobs/build.yml
    with: { change: "\${inputs.change}" }
`,
      'jobs/build.yml': `
kind: job
params:
  change: { type: string, required: true }
steps:
  - id: c
    run: [echo, "\${params.change}"]
`,
    });

    const lock = serializeLock(expand(project, 'stepcast.yml', { change: 'foo' }).pipeline);
    assert.doesNotMatch(lock, /uses:/);
    assert.doesNotMatch(lock, /\$\{(inputs|params)\./);
    assert.match(lock, /foo/);

    const parsed = parseYaml(lock) as { kind: string; jobs: unknown[] };
    assert.equal(parsed.kind, 'pipeline.lock');
    assert.equal(parsed.jobs.length, 1);
  });

  it('сохраняет подстановки времени прогона как есть', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  plan:
    steps: [{ id: c, run: [echo, ok] }]
  ship:
    needs: [plan]
    steps: [{ id: c, run: [echo, "\${jobs.plan.output.x}"] }]
`,
    });
    assert.match(serializeLock(expand(project).pipeline), /\$\{jobs\.plan\.output\.x\}/);
  });

  it('раскрывает умолчания, чтобы лок был самодостаточен', () => {
    const project = makeProject({ 'stepcast.yml': MINIMAL_PIPELINE });
    const parsed = parseYaml(serializeLock(expand(project).pipeline)) as {
      concurrency: number;
      fail_fast: boolean;
      workspace: { mode: string };
      jobs: Array<{ on: string; session: string; steps: Array<{ timeout: string }> }>;
    };

    assert.equal(parsed.concurrency, 1);
    assert.equal(parsed.fail_fast, true);
    assert.equal(parsed.workspace.mode, 'cwd');
    assert.equal(parsed.jobs[0]!.on, 'success');
    assert.equal(parsed.jobs[0]!.session, 'shared');
    assert.equal(parsed.jobs[0]!.steps[0]!.timeout, '30m');
  });
});
