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

  // Спека pipeline-definition: «Денежный потолок на трёх уровнях»
  it('раскрывает budget.cost независимо на трёх уровнях', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
budget: { cost: 20 }
jobs:
  build:
    budget: { cost: "$8" }
    steps:
      - id: s
        agent: claude
        prompt: hi
        budget: { cost: 2.5 }
`,
    });

    const { pipeline } = expand(project);
    assert.equal(pipeline.budget?.costMicroUsd, 20_000_000);
    const job = pipeline.jobs[0]!;
    assert.equal(job.budget?.costMicroUsd, 8_000_000);
    assert.equal(job.steps[0]!.budget?.costMicroUsd, 2_500_000);
  });

  it('cost рядом с tokens не отменяет его', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
budget: { tokens: 500k, cost: 5 }
jobs:
  build:
    steps:
      - id: s
        run: [echo, ok]
`,
    });

    const { pipeline } = expand(project);
    assert.equal(pipeline.budget?.tokens, 500_000);
    assert.equal(pipeline.budget?.costMicroUsd, 5_000_000);
  });

  it('отклоняет отрицательный budget.cost с указанием места', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
budget: { cost: -5 }
jobs:
  build:
    steps:
      - id: s
        run: [echo, ok]
`,
    });

    assert.throws(
      () => expand(project),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.at ?? '', /budget\.cost/);
        return true;
      },
    );
  });

  it('отклоняет валютный суффикс в budget.cost', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
budget: { cost: "12 EUR" }
jobs:
  build:
    steps:
      - id: s
        run: [echo, ok]
`,
    });

    assert.throws(() => expand(project), StepcastError);
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

// Спека pipeline-definition: «Единицы измерения» — подстановка в числовые поля
describe('pipeline-definition: подстановка в числовые поля', () => {
  // Сценарий: «Предел итераций задан параметром»
  it('раскрывает max_iterations из with в число', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    uses: ./jobs/build.yml
    with: { max_iterations: 4 }
`,
      'jobs/build.yml': `
kind: job
params:
  max_iterations: { type: int, required: true }
until:
  max_iterations: "\${params.max_iterations}"
  check: [{ file_exists: done.txt }]
steps:
  - id: c
    run: [echo, ok]
`,
    });

    const job = expand(project).pipeline.jobs[0]!;
    assert.equal(job.until?.maxIterations, 4);
  });

  // Сценарий: «Число попыток задано параметром»
  it('раскрывает attempts.max из подстановки в число', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    uses: ./jobs/build.yml
    with: { retries: 3 }
`,
      'jobs/build.yml': `
kind: job
params:
  retries: { type: int, required: true }
steps:
  - id: c
    run: [echo, ok]
    attempts: { max: "\${params.retries}" }
`,
    });

    const job = expand(project).pipeline.jobs[0]!;
    assert.equal(job.steps[0]!.attempts.max, 3);
  });

  // Сценарий: «Ширина параллелизма задана входом пайплайна»
  it('раскрывает concurrency из входа пайплайна в число', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
inputs:
  workers: { type: int, required: true }
concurrency: "\${inputs.workers}"
jobs:
  build:
    steps: [{ id: c, run: [echo, ok] }]
`,
    });

    const { pipeline } = expand(project, 'stepcast.yml', { workers: '2' });
    assert.equal(pipeline.concurrency, 2);
  });

  // Сценарий: «Числовой литерал разбирается как прежде»
  it('литеральная запись числовых полей разбирается как прежде', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
concurrency: 1
jobs:
  build:
    until:
      max_iterations: 4
      check: [{ file_exists: done.txt }]
    steps: [{ id: c, run: [echo, ok] }]
`,
    });

    const { pipeline } = expand(project);
    assert.equal(pipeline.concurrency, 1);
    assert.equal(pipeline.jobs[0]!.until?.maxIterations, 4);
  });

  // Сценарий: «Нечисловое значение отклонено» и «Ошибка называет источник значения»
  it('отклоняет нечисловое значение с путём поля, значением и источником', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
inputs:
  n: { type: string, required: true }
jobs:
  build:
    until:
      max_iterations: "\${inputs.n}"
      check: [{ file_exists: done.txt }]
    steps: [{ id: c, run: [echo, ok] }]
`,
    });

    assert.throws(
      () => expand(project, 'stepcast.yml', { n: 'много' }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.at ?? '', /until\.max_iterations/);
        assert.match(error.message, /много/);
        assert.match(error.hint ?? '', /\$\{inputs\.n\}/);
        return true;
      },
    );
  });

  // Сценарий: «Отложенная подстановка в числовом поле отклонена»
  it('отклоняет ${jobs.*} в числовом поле объясняющей ошибкой', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  plan:
    steps: [{ id: c, run: [echo, ok] }]
  ship:
    needs: [plan]
    until:
      max_iterations: "\${jobs.plan.output.rounds}"
      check: [{ file_exists: done.txt }]
    steps: [{ id: c, run: [echo, ok] }]
`,
    });

    assert.throws(
      () => expand(project),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /jobs/);
        assert.match(error.hint ?? '', /разбор(е|а) пайплайна/);
        return true;
      },
    );
  });

  it('отклоняет ${run.*} и ${env.*} в числовом поле объясняющей ошибкой', () => {
    const runProject = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps: [{ id: c, run: [echo, ok], attempts: { max: "\${run.id}" } }]
`,
    });
    assert.throws(
      () => expand(runProject),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /run/);
        return true;
      },
    );

    const envProject = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps: [{ id: c, run: [echo, ok], attempts: { max: "\${env.WORKERS}" } }]
`,
    });
    assert.throws(
      () => expand(envProject),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /env/);
        return true;
      },
    );
  });

  // Сценарий: «Отложенная подстановка доезжает до числового поля через параметр»
  it('называет отложенное пространство, когда оно доехало через params', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  plan:
    steps: [{ id: c, run: [echo, ok] }]
  ship:
    needs: [plan]
    uses: ./jobs/ship.yml
    with: { n: "\${jobs.plan.output.rounds}" }
`,
      'jobs/ship.yml': `
kind: job
params:
  n: { type: string, required: true }
until:
  max_iterations: "\${params.n}"
  check: [{ file_exists: done.txt }]
steps:
  - id: c
    run: [echo, ok]
`,
    });

    assert.throws(
      () => expand(project),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /отложенное пространство jobs/);
        assert.match(error.hint ?? '', /\$\{params\.n\}/);
        return true;
      },
    );
  });

  // Экранирование оставляет в тексте литерал `${`, а не подстановку: числовое
  // поле должно жаловаться на неразбираемое число, а не на пространство.
  it('отклоняет экранированный литерал в числовом поле как неразбираемое число', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
concurrency: "$\${params.x}"
jobs:
  build:
    steps: [{ id: c, run: [echo, ok] }]
`,
    });

    assert.throws(
      () => expand(project),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /Не удалось разобрать счётчик/);
        assert.doesNotMatch(error.message, /отложенное пространство/);
        return true;
      },
    );
  });

  // Сценарий: «Ограничение поля проверяется после раскрытия»
  it('attempts.max из подстановки, превышающий limits.attempts, даёт ошибку о потолке', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    uses: ./jobs/build.yml
    with: { retries: 9 }
`,
      'jobs/build.yml': `
kind: job
params:
  retries: { type: int, required: true }
steps:
  - id: c
    run: [echo, ok]
    attempts: { max: "\${params.retries}" }
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

  // Сценарий: «Работа объявляет источник наследования»
  it('раскрывает workspace.inherit и сохраняет его в локе', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
workspace: { mode: worktree }
jobs:
  a:
    steps: [{ id: s, run: [echo, a] }]
  b:
    steps: [{ id: s, run: [echo, b] }]
  c:
    needs: [a, b]
    workspace: { inherit: a }
    steps: [{ id: s, run: [echo, c] }]
`,
    });

    const { pipeline } = expand(project);
    const c = pipeline.jobs.find((job) => job.id === 'c');
    assert.equal(c?.workspace.inherit, 'a');
    // Режим не переобъявлен на работе — унаследован от пайплайна, а не потерян
    // при слиянии с частичным workspace работы.
    assert.equal(c?.workspace.mode, 'worktree');

    assert.match(serializeLock(pipeline), /inherit: a/);
  });

  // Слияние частичного workspace работы с пайплайновым не должно протаскивать
  // в работу пайплайновый путь размещения копий: он принадлежит пайплайновому
  // режиму, а при режиме, отличном от copy, и вовсе запрещён.
  it('не наследует пайплайновый path работе, сменившей режим', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
workspace: { mode: copy, path: ./сборка }
jobs:
  a:
    steps: [{ id: s, run: [echo, a] }]
  b:
    workspace: { mode: worktree }
    steps: [{ id: s, run: [echo, b] }]
`,
    });

    const { pipeline } = expand(project);
    const a = pipeline.jobs.find((job) => job.id === 'a');
    const b = pipeline.jobs.find((job) => job.id === 'b');
    assert.equal(a?.workspace.path, './сборка', 'режим тот же — путь пайплайна в силе');
    assert.equal(b?.workspace.mode, 'worktree');
    assert.equal(b?.workspace.path, undefined);
  });

  it('раскрывает работу без inherit как прежде', () => {
    const project = makeProject({ 'stepcast.yml': MINIMAL_PIPELINE });
    const { pipeline } = expand(project);
    assert.equal(pipeline.jobs[0]!.workspace.inherit, undefined);
    assert.doesNotMatch(serializeLock(pipeline), /inherit/);
  });

  // Сценарий: «Пайплайн без триггеров не изменился»
  it('раскрывает пайплайн без triggers ровно как прежде', () => {
    const project = makeProject({ 'stepcast.yml': MINIMAL_PIPELINE });
    const { pipeline } = expand(project);
    assert.equal(pipeline.triggers, undefined);

    const plain = parseYaml(serializeLock(pipeline)) as Record<string, unknown>;
    assert.equal('triggers' in plain, false);
  });

  // Сценарий: «Расписание объявлено одной записью»
  it('видит объявленное расписание в раскрытой модели и в локе', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
name: scheduled
triggers:
  schedule:
    - cron: "0 3 * * *"
      timezone: Asia/Nicosia
jobs:
  build:
    steps: [{ id: c, run: [echo, ok] }]
`,
    });

    const { pipeline } = expand(project);
    assert.deepEqual(pipeline.triggers, {
      schedule: [{ cron: '0 3 * * *', timezone: 'Asia/Nicosia' }],
    });

    const plain = parseYaml(serializeLock(pipeline)) as {
      triggers: { schedule: Array<{ cron: string; timezone?: string }> };
    };
    assert.deepEqual(plain.triggers.schedule, [{ cron: '0 3 * * *', timezone: 'Asia/Nicosia' }]);
  });

  // Сценарий: «Два расписания на один пайплайн»
  it('раскрывает несколько записей расписания', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
triggers:
  schedule:
    - cron: "0 8 * * 1-5"
    - cron: "0 12 * * 6,0"
jobs:
  build:
    steps: [{ id: c, run: [echo, ok] }]
`,
    });

    const { pipeline } = expand(project);
    assert.equal(pipeline.triggers?.schedule.length, 2);
    assert.equal(pipeline.triggers?.schedule[0]?.timezone, undefined);
  });

  // Сценарий: «Триггер в файле работы»
  it('отклоняет triggers внутри файла работы, как и прочую обвязку', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    uses: ./jobs/build.yml
`,
      'jobs/build.yml': `
kind: job
triggers:
  schedule: [{ cron: "0 3 * * *" }]
steps:
  - id: compile
    run: [echo, ok]
`,
    });

    assert.throws(() => expand(project), StepcastError);
  });

  // Сценарий: «Незнакомый вид триггера»
  it('отклоняет незнакомый вид триггера, называя его ключ', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
triggers:
  github: {}
jobs:
  build:
    steps: [{ id: c, run: [echo, ok] }]
`,
    });

    assert.throws(() => expand(project), (error: unknown) => {
      assert.ok(error instanceof StepcastError);
      assert.match(error.message, /github/);
      return true;
    });
  });
});
