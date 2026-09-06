import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UsageAccumulator } from '../src/core/budget/accumulator.js';
import {
  authRefusalLine,
  createFakeBackend,
  initLine,
  rateLimitRefusalLine,
  resultLine,
  type FakeBackend,
} from '../src/core/backend/fake.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { readEvents, readStatus, readUsage, resolveRun } from '../src/core/journal/reader.js';
import { runPipeline, type RunOptions, type RunResult } from '../src/core/run/runner.js';
import { createWaitState } from '../src/core/run/waitState.js';
import { ExitCode } from '../src/core/errors.js';
import type { Config } from '../src/core/config/resolve.js';
import {
  AttemptRecordSchema,
  BudgetStateSchema,
  UsageAttemptReportSchema,
  UsageReportSchema,
  UsageSchema,
  type Usage,
} from '../src/core/journal/schema.js';
import { makeProject, type Project } from './helpers.js';
import { tempDir } from './tmp.js';

/** См. test/judge-attempt.test.ts: один поддельный бэкенд на объявленное имя. */
async function run(
  project: Project,
  backends: Readonly<Record<string, FakeBackend>>,
  options: {
    readonly configOverride?: Partial<Config['defaults']>;
    readonly signal?: AbortSignal;
    readonly onEvent?: RunOptions['onEvent'];
    /** Заранее известный корень прогонов — нужен тесту, читающему журнал по ходу исполнения. */
    readonly runsRoot?: string;
  } = {},
): Promise<RunResult> {
  const runsRoot = options.runsRoot ?? tempDir('runs-');
  return runPipeline({
    expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
    config: {
      ...project.config,
      runs: { ...project.config.runs, root: runsRoot },
      defaults: { ...project.config.defaults, ...options.configOverride },
    },
    projectRoot: project.root,
    cwd: project.root,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    adapterFor: (name) => {
      const backend = backends[name];
      assert.ok(backend !== undefined, `нет поддельного бэкенда для «${name}»`);
      return backend.adapter;
    },
  });
}

function stepStatus(result: RunResult, job: string, step: string): string {
  const status = readStatus(result.journal.paths);
  const found = status.jobs.find((item) => item.id === job)?.steps.find((item) => item.id === step);
  assert.ok(found !== undefined, `шаг ${job}/${step} не найден в состоянии`);
  return found.status;
}

/** Дождаться появления события в журнале прогона, ещё идущего. */
async function waitForRunEvent(
  runsRoot: string,
  projectRoot: string,
  kind: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (readEvents(resolveRun(runsRoot, projectRoot)).some((event) => event.kind === kind)) return;
    } catch {
      // Журнал прогона ещё не создан — рано, пробуем снова.
    }
    if (Date.now() > deadline) throw new Error(`событие ${kind} не появилось за ${timeoutMs}мс`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('judge-budget: расход судьи виден в отчёте', () => {
  const PIPELINE = `
version: 1
kind: pipeline
name: judge-budget-usage
jobs:
  build:
    steps:
      - id: plan
        agent: fake
        prompt: "Сделай план"
        expect:
          - exit_code: 0
          - judge: "план полный"
            hard: true
            agent: critic
`;

  it('токены и время судьи входят в usage.json попытки', async () => {
    const project = makeProject({ 'stepcast.yml': PIPELINE });
    const fake = createFakeBackend({
      lines: [initLine(), resultLine({ text: 'план готов', tokensIn: 40, tokensOut: 10 })],
    });
    const critic = createFakeBackend({
      lines: [
        resultLine({ structured: { pass: true, reason: 'ок' }, tokensIn: 7, tokensOut: 3 }),
      ],
    });

    const result = await run(project, { fake, critic });
    assert.equal(stepStatus(result, 'build', 'plan'), 'success');

    const usage = readUsage(result.journal.paths);
    const step = usage.jobs.build?.steps.plan;
    assert.ok(step !== undefined, 'расход шага не найден в отчёте');
    // 50 (шаг) + 10 (судья) = 60: расход судьи слился с расходом попытки, а
    // не подменил его собой.
    assert.equal(step.billable_tokens, 60);
  });
});

describe('judge-budget: превышение потолка шага после вызова судьи', () => {
  const PIPELINE_TOKENS = `
version: 1
kind: pipeline
name: judge-budget-exceed
jobs:
  build:
    steps:
      - id: plan
        agent: fake
        prompt: "Сделай план"
        budget:
          tokens: 45
        expect:
          - exit_code: 0
          - judge: "план полный"
            hard: true
            agent: critic
`;

  it('шаг, дошедший до конца, числится success, даже когда его последняя запись расхода перевела потолок', async () => {
    const project = makeProject({ 'stepcast.yml': PIPELINE_TOKENS });
    const fake = createFakeBackend({
      lines: [initLine(), resultLine({ text: 'план готов', tokensIn: 40, tokensOut: 0 })],
    });
    const critic = createFakeBackend({
      lines: [
        resultLine({ structured: { pass: true, reason: 'ок' }, tokensIn: 10, tokensOut: 0 }),
      ],
    });

    const result = await run(project, { fake, critic });
    // Попытка дошла до собственного конца — результат получен и оплачен,
    // статус шага её собственный. Перейдён при этом потолок шага, и он не
    // остановил ничего: следующему шагу область отсчитывалась бы заново,
    // а следующего шага и нет. Прогон доигран целиком и остановленным по
    // бюджету не числится (run-journal, «Перейдённый потолок шага никого не
    // остановил»).
    assert.equal(stepStatus(result, 'build', 'plan'), 'success');
    assert.equal(result.status, 'success');
    assert.equal(result.exitCode, ExitCode.ok);
    assert.equal(readStatus(result.journal.paths).budget.exceeded, undefined);
  });

  const RUN_PIPELINE_TOKENS = `
version: 1
kind: pipeline
name: judge-budget-exceed-run
jobs:
  build:
    steps:
      - id: check
        run: [echo, привет]
        budget:
          tokens: 5
        expect:
          - exit_code: 0
          - judge: "вывод корректен"
            hard: true
            agent: critic
`;

  it('командный шаг остаётся success тем же образом, и прогон доигран', async () => {
    const project = makeProject({ 'stepcast.yml': RUN_PIPELINE_TOKENS });
    const fake = createFakeBackend({ lines: [] });
    const critic = createFakeBackend({
      lines: [
        resultLine({ structured: { pass: true, reason: 'ок' }, tokensIn: 10, tokensOut: 0 }),
      ],
    });

    const result = await run(project, { fake, critic });
    assert.equal(stepStatus(result, 'build', 'check'), 'success');
    assert.equal(result.status, 'success');
    assert.equal(result.exitCode, ExitCode.ok);
    assert.equal(readStatus(result.journal.paths).budget.exceeded, undefined);
  });
});

describe('judge-budget: бюджет, исчерпанный до вызова', () => {
  const PIPELINE = `
version: 1
kind: pipeline
name: judge-budget-exhausted
jobs:
  build:
    steps:
      - id: plan
        agent: fake
        prompt: "Сделай план"
        budget:
          tokens: 10
        expect:
          - exit_code: 0
          - judge: "план полный"
            hard: true
            agent: critic
`;

  it('судья не вызывается, если бюджет уже исчерпан к моменту проверки', async () => {
    const project = makeProject({ 'stepcast.yml': PIPELINE });
    const fake = createFakeBackend({
      lines: [initLine(), resultLine({ text: 'план готов', tokensIn: 40, tokensOut: 0 })],
    });
    const critic = createFakeBackend({
      lines: [resultLine({ structured: { pass: true, reason: 'ок' } })],
    });

    const result = await run(project, { fake, critic });

    assert.equal(critic.invocations.length, 0, 'бюджет уже исчерпан расходом самого шага');
    assert.equal(stepStatus(result, 'build', 'plan'), 'budget_exceeded');
  });
});

describe('early-exit: шаг, начатый после исчерпанного потолка', () => {
  const PIPELINE = `
version: 1
kind: pipeline
name: early-exit-before-step
budget:
  tokens: 45
jobs:
  build:
    steps:
      - id: first
        agent: fake
        prompt: "первый"
        expect:
          - exit_code: 0
          - judge: "план полный"
            hard: true
            agent: critic
      - id: second
        agent: fake2
        prompt: "второй"
        expect:
          - exit_code: 0
`;

  it('второй шаг не запускается: первый исчерпал потолок, дойдя до своего конца', async () => {
    const project = makeProject({ 'stepcast.yml': PIPELINE });
    // Первый шаг переходит потолок последней записью расхода — усилиями
    // судьи, вызванного уже после того, как собственный процесс шага
    // отработал и вышел: перевод потолка её ничего не прерывает, и исход
    // шага остаётся его собственным (success). Второй шаг упирается в тот
    // же потолок ещё до старта: его бэкенд не запускается вовсе.
    const fake = createFakeBackend({
      lines: [initLine(), resultLine({ text: 'план готов', tokensIn: 40, tokensOut: 0 })],
    });
    const critic = createFakeBackend({
      lines: [resultLine({ structured: { pass: true, reason: 'ок' }, tokensIn: 10, tokensOut: 0 })],
    });
    const fake2 = createFakeBackend({ lines: [initLine(), resultLine({ text: 'не должно случиться' })] });

    const result = await run(project, { fake, critic, fake2 });

    assert.equal(stepStatus(result, 'build', 'first'), 'success');
    assert.equal(stepStatus(result, 'build', 'second'), 'budget_exceeded');
    // Второй шаг не исполнялся вовсе: его бэкенд не был вызван.
    assert.equal(fake2.invocations.length, 0, 'процесс второго шага не стартовал');
    assert.equal(result.status, 'budget_exceeded');
    assert.equal(result.exitCode, ExitCode.budgetExceeded);
  });

  // Спека run-journal: «Отмена важнее исчерпанного потолка»
  it('отменённый прогон с записью о перейдённом потолке остаётся canceled', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: budget-then-cancel
concurrency: 1
budget:
  tokens: 45
jobs:
  plan:
    steps:
      - id: p
        agent: fake
        prompt: "план"
        expect:
          - exit_code: 0
          - judge: "план полный"
            hard: true
            agent: critic
  cleanup:
    needs: all
    on: always
    budget_exempt: true
    budget:
      tokens: 200
    steps:
      - id: c
        agent: cleaner
        prompt: "разбор"
`,
    });
    const controller = new AbortController();
    const fake = createFakeBackend({
      lines: [initLine(), resultLine({ text: 'план готов', tokensIn: 40, tokensOut: 0 })],
    });
    const critic = createFakeBackend({
      lines: [resultLine({ structured: { pass: true, reason: 'ок' }, tokensIn: 10, tokensOut: 0 })],
    });
    // Освобождённая работа исполняется и после остановки по бюджету — на её
    // зависании прогон и застаёт отмена.
    const cleaner = createFakeBackend({ hangMs: 30_000, lines: [initLine()] });

    const runsRoot = tempDir('runs-');
    const promise = runPipeline({
      expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
      config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
      signal: controller.signal,
      adapterFor: (name) => {
        const backend = { fake, critic, cleaner }[name];
        assert.ok(backend !== undefined, `нет поддельного бэкенда для «${name}»`);
        return backend.adapter;
      },
    });

    // Отмена — после того, как потолок уже перейдён (защёлка заполнена) и
    // освобождённая работа дошла до своего шага: так проверяется именно
    // старшинство отмены над исчерпанным потолком, а не гонка.
    const deadline = Date.now() + 20_000;
    for (;;) {
      const started = readEvents(resolveRun(runsRoot, project.root)).some(
        (event) => event.kind === 'step.started' && event.job === 'cleanup',
      );
      if (started) break;
      if (Date.now() > deadline) throw new Error('освобождённая работа не дошла до своего шага');
      await sleep(20);
    }
    controller.abort();

    const result = await promise;

    assert.equal(result.status, 'canceled');
    assert.equal(result.exitCode, ExitCode.canceled);
    // Защёлка при этом заполнена: отмена важнее, но причину остановки
    // состояние всё равно называет.
    assert.ok(readStatus(result.journal.paths).budget.exceeded !== undefined);
  });
});

describe('budget-exempt: работа, освобождённая от потолка прогона', () => {
  const PIPELINE = `
version: 1
kind: pipeline
name: budget-exempt-pipeline
concurrency: 1
budget:
  tokens: 45
jobs:
  plan:
    steps:
      - id: p
        agent: fake
        prompt: "план"
        expect:
          - exit_code: 0
          - judge: "план полный"
            hard: true
            agent: critic
  blocked:
    needs: [plan]
    steps:
      - id: b
        run: [echo, ok]
  cleanup:
    needs: all
    on: always
    budget_exempt: true
    steps:
      - id: c
        run: [echo, cleanup]
  audit:
    needs: all
    on: always
    steps:
      - id: a
        run: [echo, audit]
`;

  it('освобождённая on: always исполняется и отчитывается успехом; неосвобождённая — budget_exceeded', async () => {
    const project = makeProject({ 'stepcast.yml': PIPELINE });
    const fake = createFakeBackend({
      lines: [initLine(), resultLine({ text: 'план готов', tokensIn: 40, tokensOut: 0 })],
    });
    const critic = createFakeBackend({
      lines: [resultLine({ structured: { pass: true, reason: 'ок' }, tokensIn: 10, tokensOut: 0 })],
    });

    const result = await run(project, { fake, critic });

    assert.equal(stepStatus(result, 'plan', 'p'), 'success');
    assert.equal(stepStatus(result, 'blocked', 'b'), 'budget_exceeded');
    // Освобождённая работа исполняется и после остановки по бюджету — тест
    // должен упасть, если её успешный шаг снова метят budget_exceeded.
    assert.equal(stepStatus(result, 'cleanup', 'c'), 'success');
    assert.equal(stepStatus(result, 'audit', 'a'), 'budget_exceeded');

    assert.equal(result.status, 'budget_exceeded');
    assert.equal(result.exitCode, ExitCode.budgetExceeded);

    // Подсказка resume называет действительно не доведённую работу, а не
    // освобождённую cleanup, которая успешно отработала (design.md, решение 3;
    // спека run-journal).
    const status = readStatus(result.journal.paths);
    assert.equal(status.resume?.blocked_by, 'blocked');

    // Причина остановки читается из состояния, а не собирается разбором
    // статусов работ: перешёл потолок успешно завершившийся шаг plan/p
    // (спека run-journal, «Причина остановки читается из состояния»).
    BudgetStateSchema.parse(status.budget);
    const exceeded = status.budget.exceeded;
    assert.ok(exceeded !== undefined, 'состояние называет перейдённый потолок');
    assert.equal(exceeded.scope, 'пайплайн');
    assert.equal(exceeded.dimension, 'tokens');
    assert.equal(exceeded.limit, 45);
    assert.ok(exceeded.used > exceeded.limit, 'израсходованное выше потолка');
    assert.equal(exceeded.job, 'plan');
    assert.equal(exceeded.step, 'p');
  });

  const USAGE_PIPELINE = `
version: 1
kind: pipeline
name: budget-exempt-usage
concurrency: 1
budget:
  tokens: 45
jobs:
  plan:
    steps:
      - id: p
        agent: fake
        prompt: "план"
        expect:
          - exit_code: 0
          - judge: "план полный"
            hard: true
            agent: critic
  cleanup:
    needs: all
    on: always
    budget_exempt: true
    budget:
      tokens: 200
    steps:
      - id: c
        agent: cleaner
        prompt: "разбор"
        expect:
          - exit_code: 0
`;

  // Спека pipeline-execution: «Расход освобождённой работы виден»
  it('расход освобождённой работы целиком виден в отчёте и в состоянии прогона', async () => {
    const project = makeProject({ 'stepcast.yml': USAGE_PIPELINE });
    const fake = createFakeBackend({
      lines: [initLine(), resultLine({ text: 'план готов', tokensIn: 40, tokensOut: 0 })],
    });
    const critic = createFakeBackend({
      lines: [resultLine({ structured: { pass: true, reason: 'ок' }, tokensIn: 10, tokensOut: 0 })],
    });
    const cleaner = createFakeBackend({
      lines: [initLine(), resultLine({ text: 'разобрано', tokensIn: 30, tokensOut: 0, costUsd: 0.25 })],
    });

    const result = await run(project, { fake, critic, cleaner });

    assert.equal(stepStatus(result, 'cleanup', 'c'), 'success');

    // Освобождение снимает применение потолка, а не учёт: траты работы за
    // остановкой видны целиком — и в отчёте о расходе, и в блоке budget
    // состояния прогона, где 80 = 40 (план) + 10 (судья) + 30 (разбор).
    const usage = readUsage(result.journal.paths);
    assert.equal(usage.jobs.cleanup?.steps.c?.billable_tokens, 30);
    const status = readStatus(result.journal.paths);
    assert.equal(status.budget.tokens_used, 80);
    assert.ok((status.budget.cost_used_usd ?? 0) >= 0.25, 'цена освобождённой работы вошла в счёт прогона');
  });

  // Спека pipeline-execution: «Собственный потолок освобождённой работы действует»
  it('собственный потолок освобождённой работы обрывает её попытку', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: budget-exempt-own-budget
concurrency: 1
budget:
  tokens: 45
jobs:
  plan:
    steps:
      - id: p
        agent: fake
        prompt: "план"
        expect:
          - exit_code: 0
          - judge: "план полный"
            hard: true
            agent: critic
  cleanup:
    needs: all
    on: always
    budget_exempt: true
    budget:
      tokens: 50
    steps:
      - id: c
        agent: cleaner
        prompt: "разбор"
`,
    });
    const fake = createFakeBackend({
      lines: [initLine(), resultLine({ text: 'план готов', tokensIn: 40, tokensOut: 0 })],
    });
    const critic = createFakeBackend({
      lines: [resultLine({ structured: { pass: true, reason: 'ок' }, tokensIn: 10, tokensOut: 0 })],
    });
    // Тот же приём, что в «streaming budget»: расход приходит в потоке до
    // терминальной записи, и применение потолка обрывает попытку на середине.
    const cleaner = createFakeBackend({
      lines: [
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'msg-exempt-over-budget',
            content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/a.ts' } }],
            usage: { input_tokens: 60 },
          },
        }),
      ],
      hangMs: 5_000,
    });

    const result = await run(project, { fake, critic, cleaner });

    // Освобождение снимает потолок прогона, а не собственный потолок работы:
    // 60 токенов перевели её потолок в 50, и попытку это оборвало.
    assert.equal(stepStatus(result, 'cleanup', 'c'), 'budget_exceeded');
    assert.equal(result.status, 'budget_exceeded');
  });

  // Спека pipeline-execution: «Окно лимита подписки сторожит и освобождённую работу»
  it('rate_limit_pct прогона усыпляет и освобождённую работу', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: budget-exempt-rate-limit
concurrency: 1
budget:
  tokens: 45
  rate_limit_pct: 50
  on_exceed: wait
jobs:
  plan:
    steps:
      - id: p
        agent: fake
        prompt: "план"
        expect:
          - exit_code: 0
          - judge: "план полный"
            hard: true
            agent: critic
  cleanup:
    needs: all
    on: always
    budget_exempt: true
    budget:
      tokens: 200
    steps:
      - id: c
        agent: cleaner
        prompt: "разбор"
        attempts:
          max: 2
        expect:
          - exit_code: 0
`,
    });
    const fake = createFakeBackend({
      lines: [initLine(), resultLine({ text: 'план готов', tokensIn: 40, tokensOut: 0 })],
    });
    const critic = createFakeBackend({
      lines: [resultLine({ structured: { pass: true, reason: 'ок' }, tokensIn: 10, tokensOut: 0 })],
    });
    const cleaner = createFakeBackend({
      hangMs: 1_000,
      lines: (index) =>
        index === 0
          ? [
              initLine(),
              resultLine({
                text: 'упёрлись в лимит',
                tokensIn: 10,
                tokensOut: 0,
                rateLimits: { five_hour: { usedPct: 80, resetsAt: Date.now() + 4_000 } },
              }),
            ]
          : [initLine(), resultLine({ text: 'разобрано', tokensIn: 10, tokensOut: 0 })],
    });

    const result = await run(project, { fake, critic, cleaner }, { configOverride: { maxWaitMs: 60_000 } });

    // Доля окна лимита — не потолок расхода, а условие бэкенда: освобождение
    // снимает потолок прогона, но не право бэкенда сказать «сейчас нельзя».
    assert.equal(stepStatus(result, 'cleanup', 'c'), 'success');
    assert.equal(cleaner.invocations.length, 2, 'освобождённая работа дождалась сброса и переисполнила шаг');
    const events = readEvents(result.journal.paths);
    assert.equal(events.some((event) => event.kind === 'budget.waiting'), true);
    assert.equal(events.some((event) => event.kind === 'budget.resumed'), true);
  });
});

describe('streaming budget: usage в tool_use', () => {
  it('прерывает агентский процесс до terminal result, когда usage пришёл вместе с tool_use', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: streaming-tool-usage
jobs:
  build:
    steps:
      - id: implement
        agent: fake
        prompt: "Реализуй"
        budget:
          tokens: 50
`,
    });
    const fake = createFakeBackend({
      lines: [
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'msg-over-budget',
            content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/a.ts' } }],
            usage: { input_tokens: 60 },
          },
        }),
      ],
      // Зависание длинное, порог — с запасом на запуск процесса: прерывание
      // срабатывает за десятки миллисекунд, поэтому длина зависания ничего не
      // стоит, а запас ловит регресс, а не задержку под нагрузкой.
      hangMs: 5_000,
    });

    const started = Date.now();
    const result = await run(project, { fake });

    // Применение потолка оборвало попытку на середине (процесс ещё не дошёл
    // до terminal result) — шаг отдаёт budget_exceeded сам, это и оборвало его.
    assert.equal(stepStatus(result, 'build', 'implement'), 'budget_exceeded');
    assert.equal(result.status, 'budget_exceeded');
    assert.ok(Date.now() - started < 2_000, 'лимит должен остановить процесс, не дожидаясь hangMs');
  });
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function usageWith(partial: Partial<Usage>): Usage {
  return {
    backend: 'fake',
    tokens_in: null,
    tokens_out: null,
    cache_read: null,
    cache_write: null,
    wallclock_ms: 0,
    ...partial,
  };
}

describe('budget-wait-on-exceed: аккумулятор', () => {
  it('check() выбирает окно с более поздним resets_at среди превысивших порог', () => {
    const usage = new UsageAccumulator(() => 1);
    const found = usage.check(
      [{ kind: 'step', name: 's', jobId: 'j', stepId: 's', budget: { rateLimitPct: 50, onExceed: 'wait' } }],
      usageWith({
        rate_limits: {
          five_hour: { used_pct: 80, resets_at: 1_000 },
          week: { used_pct: 90, resets_at: 2_000 },
        },
      }),
    );
    assert.ok(found !== undefined);
    assert.equal(found.dimension, 'rate_limit');
    assert.equal(found.resetsAt, 2_000);
    assert.equal(found.onExceed, 'wait');
  });

  it('окно, не превысившее порог, не участвует в выборе', () => {
    const usage = new UsageAccumulator(() => 1);
    const found = usage.check(
      [{ kind: 'step', name: 's', jobId: 'j', stepId: 's', budget: { rateLimitPct: 50, onExceed: 'wait' } }],
      usageWith({
        rate_limits: {
          five_hour: { used_pct: 30, resets_at: 5_000 },
          week: { used_pct: 90, resets_at: 2_000 },
        },
      }),
    );
    assert.equal(found?.resetsAt, 2_000);
  });

  it('превышение без сообщённого resets_at оставляет его неопределённым', () => {
    const usage = new UsageAccumulator(() => 1);
    const found = usage.check(
      [{ kind: 'step', name: 's', jobId: 'j', stepId: 's', budget: { rateLimitPct: 50, onExceed: 'wait' } }],
      usageWith({ rate_limits: { five_hour: { used_pct: 80 } } }),
    );
    assert.ok(found !== undefined);
    assert.equal(found.resetsAt, undefined);
  });

  it('elapsedMs() вычитает время сна', async () => {
    const usage = new UsageAccumulator(() => 1);
    await sleep(20);
    const waitStart = Date.now();
    await sleep(60);
    usage.recordWait(waitStart, Date.now());
    await sleep(10);
    const elapsed = usage.elapsedMs();
    assert.ok(elapsed < 60, `сон должен быть вычтен из elapsedMs: ${elapsed}мс`);
  });

  it('область, начавшаяся после сна, не вычитает его из своей длительности', async () => {
    const usage = new UsageAccumulator(() => 1);
    const waitStart = Date.now();
    await sleep(30);
    usage.recordWait(waitStart, Date.now());
    const startedAt = Date.now();
    await sleep(25);

    const found = usage.check([
      { kind: 'job', name: 'работа', jobId: 'j', startedAt, budget: { wallclockMs: 5, onExceed: 'stop' } },
    ]);
    assert.ok(found !== undefined, 'сон случился до начала области и не должен её оправдывать');
    assert.equal(found.dimension, 'wallclock');
  });

  it('wouldExceedMaxWait учитывает уже проспанное время', () => {
    const usage = new UsageAccumulator(() => 1);
    usage.recordWait(0, 100);
    assert.equal(usage.wouldExceedMaxWait(50, 200), false);
    assert.equal(usage.wouldExceedMaxWait(150, 200), true);
  });

  // Сценарий: «Непересекающиеся ожидания складываются»
  it('непересекающиеся ожидания складываются', () => {
    const usage = new UsageAccumulator(() => 1);
    usage.recordWait(0, 600_000);
    usage.recordWait(1_000_000, 1_600_000);
    assert.equal(usage.totalWaitMs(), 1_200_000);
  });

  // Сценарий: «Два одновременных ожидания считаются один раз»
  it('одновременные ожидания дают в учёт своё объединение, а не сумму', () => {
    const usage = new UsageAccumulator(() => 1);
    usage.recordWait(0, 600_000);
    usage.recordWait(0, 600_000);
    assert.equal(usage.totalWaitMs(), 600_000, 'прогон проспал десять минут, а не двадцать');
  });

  it('пересекающиеся ожидания сливаются в один интервал', () => {
    const usage = new UsageAccumulator(() => 1);
    usage.recordWait(0, 100);
    usage.recordWait(60, 200);
    assert.equal(usage.totalWaitMs(), 200);
  });

  it('вложенное ожидание не добавляет к учёту ничего', () => {
    const usage = new UsageAccumulator(() => 1);
    usage.recordWait(0, 300);
    usage.recordWait(100, 200);
    assert.equal(usage.totalWaitMs(), 300);
  });

  // Сценарий: «Вычитание из wallclock не превышает проспанного»
  it('одновременные ожидания вычитаются из wallclock один раз', () => {
    const usage = new UsageAccumulator(() => 1);
    const startedAt = Date.now() - 1_000;
    usage.recordWait(startedAt, startedAt + 400);
    usage.recordWait(startedAt, startedAt + 400);

    const found = usage.check([
      { kind: 'job', name: 'работа', jobId: 'j', startedAt, budget: { wallclockMs: 500, onExceed: 'stop' } },
    ]);
    assert.ok(
      found !== undefined,
      'из тысячи миллисекунд вычитаются четыреста, а не восемьсот: потолок в пятьсот превышен',
    );
  });

  it('предел max_wait исчерпывается объединением, а не суммой', () => {
    const usage = new UsageAccumulator(() => 1);
    usage.recordWait(0, 600_000);
    usage.recordWait(0, 600_000);
    assert.equal(
      usage.wouldExceedMaxWait(300_000, 1_000_000),
      false,
      'два одновременных ожидания по десять минут не должны исчерпать предел в час',
    );
  });
});

describe('budget-wait-on-exceed: множество ожиданий прогона', () => {
  it('в состояние идёт ближайший момент пробуждения', () => {
    const waits = createWaitState();
    waits.begin('2026-08-27T12:00:00.000Z');
    waits.begin('2026-08-27T10:00:00.000Z');
    assert.equal(waits.earliest(), '2026-08-27T10:00:00.000Z');
  });

  it('снятие одного ожидания не убирает чужой момент', () => {
    const waits = createWaitState();
    const first = waits.begin('2026-08-27T10:00:00.000Z');
    waits.begin('2026-08-27T12:00:00.000Z');

    first();
    assert.equal(
      waits.earliest(),
      '2026-08-27T12:00:00.000Z',
      'вторая работа всё ещё спит — момент её пробуждения остаётся в состоянии',
    );
  });

  it('одинаковые моменты снимаются по отдельности', () => {
    const waits = createWaitState();
    const first = waits.begin('2026-08-27T10:00:00.000Z');
    waits.begin('2026-08-27T10:00:00.000Z');

    first();
    assert.equal(waits.earliest(), '2026-08-27T10:00:00.000Z');
  });

  it('без ожиданий момента пробуждения нет', () => {
    const waits = createWaitState();
    const release = waits.begin('2026-08-27T10:00:00.000Z');
    release();
    assert.equal(waits.earliest(), undefined);
  });

  it('sealStep сохраняет расход прерванной попытки, а переисполнение считает заново под тем же именем', () => {
    const usage = new UsageAccumulator(() => 1);
    usage.record('build', 'plan', 1, usageWith({ tokens_in: 100, tokens_out: 0 }));
    assert.equal(usage.stepTokens('build', 'plan', 1), 100);

    usage.sealStep('build', 'plan');
    usage.record('build', 'plan', 1, usageWith({ tokens_in: 30, tokens_out: 0 }));

    assert.equal(usage.stepTokens('build', 'plan', 1), 30, 'видимый счёт — только новый заход');
    assert.equal(usage.jobTokens('build'), 130, 'расход оборванной попытки остаётся учтён в работе');

    const found = usage.check([
      { kind: 'step', name: 'шаг', jobId: 'build', stepId: 'plan', budget: { tokens: 100, onExceed: 'stop' } },
    ]);
    assert.ok(found !== undefined, 'потолок шага считается по сумме сохранённой и новой попытки');
  });
});

/**
 * Окно сброса во всех тестах ниже заведомо шире, чем зависание фейкового
 * процесса: запас `resetsAt - hangMs` держит сон измеримым, даже если
 * обнаружение придётся на самый конец зависания.
 */
describe('budget-wait-on-exceed: ожидание сброса окна лимита в прогоне', () => {
  const WAIT_PIPELINE = `
version: 1
kind: pipeline
name: wait-resume
jobs:
  build:
    steps:
      - id: plan
        agent: fake
        prompt: "Сделай план"
        budget:
          rate_limit_pct: 50
          on_exceed: wait
        attempts:
          max: 2
        expect:
          - exit_code: 0
`;

  it('превышение rate_limit_pct с известным resets_at усыпляет прогон и переисполняет шаг', async () => {
    const project = makeProject({ 'stepcast.yml': WAIT_PIPELINE });
    const fake = createFakeBackend({
      hangMs: 1_000,
      lines: (index) =>
        index === 0
          ? [
              initLine(),
              resultLine({
                text: 'упёрлись в лимит',
                tokensIn: 10,
                tokensOut: 0,
                rateLimits: { five_hour: { usedPct: 80, resetsAt: Date.now() + 4_000 } },
              }),
            ]
          : [initLine(), resultLine({ text: 'план готов', tokensIn: 10, tokensOut: 0 })],
    });

    const result = await run(project, { fake }, { configOverride: { maxWaitMs: 60_000 } });

    assert.equal(result.status, 'success');
    assert.equal(stepStatus(result, 'build', 'plan'), 'success');
    assert.equal(fake.invocations.length, 2, 'шаг должен быть переисполнен целиком');

    const events = readEvents(result.journal.paths);
    assert.equal(events.some((event) => event.kind === 'budget.waiting'), true);
    assert.equal(events.some((event) => event.kind === 'budget.resumed'), true);
  });

  it('переисполнение не расходует attempts.max, а расход оборванной попытки остаётся в usage', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: wait-attempts
jobs:
  build:
    steps:
      - id: plan
        agent: fake
        prompt: "Сделай план"
        budget:
          rate_limit_pct: 50
          on_exceed: wait
        attempts:
          max: 1
        expect:
          - exit_code: 0
`,
    });
    const fake = createFakeBackend({
      hangMs: 1_000,
      lines: (index) =>
        index === 0
          ? [
              initLine(),
              resultLine({
                text: 'упёрлись в лимит',
                tokensIn: 40,
                tokensOut: 0,
                rateLimits: { five_hour: { usedPct: 80, resetsAt: Date.now() + 4_000 } },
              }),
            ]
          : [initLine(), resultLine({ text: 'план готов', tokensIn: 15, tokensOut: 0 })],
    });

    const result = await run(project, { fake }, { configOverride: { maxWaitMs: 60_000 } });

    // attempts.max: 1 — будь переисполнение настоящей попыткой, вторая
    // попытка была бы отклонена самим циклом попыток.
    assert.equal(result.status, 'success');

    const usage = readUsage(result.journal.paths);
    const step = usage.jobs.build?.steps.plan;
    assert.ok(step !== undefined);
    // 40 (оборванная попытка, осталась учтена) + 15 (успешное переисполнение).
    assert.equal(step.billable_tokens, 55);
  });

  it('отсутствие resets_at даёт budget_exceeded с причиной о неизвестном сбросе', async () => {
    const project = makeProject({ 'stepcast.yml': WAIT_PIPELINE });
    const fake = createFakeBackend({
      hangMs: 4_000,
      lines: [
        initLine(),
        resultLine({
          text: 'упёрлись в лимит без момента сброса',
          tokensIn: 10,
          tokensOut: 0,
          rateLimits: { five_hour: { usedPct: 80 } },
        }),
      ],
    });

    const result = await run(project, { fake });

    assert.equal(result.status, 'budget_exceeded');
    const status = readStatus(result.journal.paths);
    const reason = status.jobs.find((job) => job.id === 'build')?.reason ?? '';
    assert.match(reason, /момент сброса/);
  });

  it('сброс дальше объявленного предела ожидания даёт budget_exceeded с причиной о пределе', async () => {
    const project = makeProject({ 'stepcast.yml': WAIT_PIPELINE });
    const fake = createFakeBackend({
      hangMs: 4_000,
      lines: [
        initLine(),
        resultLine({
          text: 'упёрлись в лимит',
          tokensIn: 10,
          tokensOut: 0,
          rateLimits: { five_hour: { usedPct: 80, resetsAt: Date.now() + 60_000 } },
        }),
      ],
    });

    const result = await run(project, { fake }, { configOverride: { maxWaitMs: 100 } });

    assert.equal(result.status, 'budget_exceeded');
    const status = readStatus(result.journal.paths);
    const reason = status.jobs.find((job) => job.id === 'build')?.reason ?? '';
    assert.match(reason, /предел ожидания/);
  });

  it('превышение потолка токенов при on_exceed: wait останавливает прогон без ожидания', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: wait-tokens
jobs:
  build:
    steps:
      - id: plan
        agent: fake
        prompt: "Сделай план"
        budget:
          tokens: 5
          on_exceed: wait
        expect:
          - exit_code: 0
`,
    });
    const fake = createFakeBackend({
      lines: [initLine(), resultLine({ text: 'много токенов', tokensIn: 40, tokensOut: 0 })],
    });

    const result = await run(project, { fake });

    assert.equal(result.status, 'budget_exceeded');
    assert.equal(fake.invocations.length, 1, 'потолок токенов не ждёт и не переисполняет шаг');

    const events = readEvents(result.journal.paths);
    assert.equal(events.some((event) => event.kind === 'budget.waiting'), false);
  });

  it('ожидание не засчитывается в wallclock прогона', async () => {
    const project = makeProject({ 'stepcast.yml': WAIT_PIPELINE });
    const fake = createFakeBackend({
      hangMs: 1_000,
      lines: (index) =>
        index === 0
          ? [
              initLine(),
              resultLine({
                text: 'упёрлись в лимит',
                tokensIn: 10,
                tokensOut: 0,
                rateLimits: { five_hour: { usedPct: 80, resetsAt: Date.now() + 4_000 } },
              }),
            ]
          : [initLine(), resultLine({ text: 'план готов', tokensIn: 10, tokensOut: 0 })],
    });

    const startedAt = Date.now();
    const result = await run(project, { fake }, { configOverride: { maxWaitMs: 60_000 } });
    const elapsedReal = Date.now() - startedAt;

    assert.equal(result.status, 'success');

    // Сравнение внутри одного прогона: сколько бы система ни притормаживала
    // сам тестовый процесс, разница между реальным и учтённым временем не
    // зависит от этого — она равна вычтенному сну (~1.5с), а не нулю.
    const status = readStatus(result.journal.paths);
    assert.ok(
      status.budget.wallclock_ms < elapsedReal - 800,
      `учтённое время (${status.budget.wallclock_ms}мс) должно быть заметно меньше реального (${elapsedReal}мс) — сон обязан быть вычтен`,
    );
  });

  /** Дождаться появления события в журнале прогона, ещё идущего. */
  async function waitForEvent(
    runsRoot: string,
    projectRoot: string,
    kind: string,
    timeoutMs = 20_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        if (readEvents(resolveRun(runsRoot, projectRoot)).some((event) => event.kind === kind)) return;
      } catch {
        // Журнал прогона ещё не создан — рано, пробуем снова.
      }
      if (Date.now() > deadline) {
        throw new Error(`событие ${kind} не появилось за ${timeoutMs}мс`);
      }
      await sleep(20);
    }
  }

  it('отмена во время сна прекращает ожидание и даёт canceled без budget.resumed', async () => {
    const project = makeProject({ 'stepcast.yml': WAIT_PIPELINE });
    const controller = new AbortController();
    const fake = createFakeBackend({
      hangMs: 4_000,
      lines: [
        initLine(),
        resultLine({
          text: 'упёрлись в лимит',
          tokensIn: 10,
          tokensOut: 0,
          rateLimits: { five_hour: { usedPct: 80, resetsAt: Date.now() + 60_000 } },
        }),
      ],
    });

    const runsRoot = tempDir('runs-');
    const promise = runPipeline({
      expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
      config: {
        ...project.config,
        runs: { ...project.config.runs, root: runsRoot },
        defaults: { ...project.config.defaults, maxWaitMs: 3_600_000 },
      },
      projectRoot: project.root,
      cwd: project.root,
      signal: controller.signal,
      adapterFor: (name) => {
        assert.equal(name, 'fake');
        return fake.adapter;
      },
    });

    // Отменяем ровно после того, как прогон действительно ушёл в сон — не
    // угадывая паузу, а дожидаясь записи в журнале: так тест не зависит от
    // того, насколько нагружена машина.
    await waitForEvent(runsRoot, project.root, 'budget.waiting');
    controller.abort();

    const result = await promise;
    assert.equal(result.status, 'canceled');

    const events = readEvents(result.journal.paths);
    const waiting = events.filter((event) => event.kind === 'budget.waiting');
    const resumed = events.filter((event) => event.kind === 'budget.resumed');
    assert.equal(waiting.length, 1);
    assert.equal(resumed.length, 0, 'отменённое ожидание не пишет budget.resumed');
    assert.equal(readStatus(result.journal.paths).wake_at, undefined, 'отмена очищает момент пробуждения');
  });

  it('состояние со сна доступно снаружи до пробуждения', async () => {
    const project = makeProject({ 'stepcast.yml': WAIT_PIPELINE });
    const controller = new AbortController();
    const fake = createFakeBackend({
      hangMs: 4_000,
      lines: [
        initLine(),
        resultLine({
          text: 'упёрлись в лимит',
          tokensIn: 10,
          tokensOut: 0,
          // Момент сброса нарочно далёк: тест смотрит только на состояние во
          // время сна, а не дожидается пробуждения, — далёкий момент не даёт
          // сну случайно закончиться раньше, чем тест успеет его застать
          // даже на нагруженной машине.
          rateLimits: { five_hour: { usedPct: 80, resetsAt: Date.now() + 60_000 } },
        }),
      ],
    });

    const runsRoot = tempDir('runs-');
    const promise = runPipeline({
      expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
      config: {
        ...project.config,
        runs: { ...project.config.runs, root: runsRoot },
        defaults: { ...project.config.defaults, maxWaitMs: 3_600_000 },
      },
      projectRoot: project.root,
      cwd: project.root,
      signal: controller.signal,
      adapterFor: (name) => {
        assert.equal(name, 'fake');
        return fake.adapter;
      },
    });

    // Дожидаемся самого события ухода в сон, а не гадаем с фиксированной
    // паузой — так же надёжно и на загруженной машине.
    await waitForEvent(runsRoot, project.root, 'budget.waiting');

    const status = readStatus(resolveRun(runsRoot, project.root));
    assert.equal(status.status, 'running');
    assert.ok(status.wake_at !== undefined, 'момент пробуждения должен быть на диске во время сна');

    controller.abort();
    await promise;
  });
});

describe('backend-refusal: упор в лимит подписки бэкенда и отказ аутентификации', () => {
  const WAIT_REFUSAL_PIPELINE = `
version: 1
kind: pipeline
name: backend-refusal-wait
jobs:
  build:
    steps:
      - id: plan
        agent: fake
        prompt: "Сделай план"
        budget:
          on_exceed: wait
        attempts:
          max: 2
        expect:
          - exit_code: 0
`;

  const STOP_REFUSAL_PIPELINE = `
version: 1
kind: pipeline
name: backend-refusal-stop
jobs:
  build:
    steps:
      - id: plan
        agent: fake
        prompt: "Сделай план"
        expect:
          - exit_code: 0
`;

  it('усыпляет прогон и переисполняет шаг, когда объявлен on_exceed: wait', async () => {
    const project = makeProject({ 'stepcast.yml': WAIT_REFUSAL_PIPELINE });
    const resetAt = Date.now() + 3_000;
    const fake = createFakeBackend({
      hangMs: 1_000,
      lines: (index) =>
        index === 0
          ? [initLine(), rateLimitRefusalLine({ resetText: `resets ${new Date(resetAt).toISOString()}` })]
          : [initLine(), resultLine({ text: 'план готов' })],
    });

    const result = await run(project, { fake }, { configOverride: { maxWaitMs: 60_000 } });

    assert.equal(result.status, 'success');
    assert.equal(fake.invocations.length, 2, 'шаг должен быть переисполнен целиком');

    const events = readEvents(result.journal.paths);
    assert.equal(events.some((event) => event.kind === 'backend.refused'), true);
    assert.equal(events.some((event) => event.kind === 'budget.waiting'), true);
    assert.equal(events.some((event) => event.kind === 'budget.resumed'), true);
  });

  it('расход прерванной попытки остаётся учтённым после ожидания и переисполнения', async () => {
    // Ключ расхода — `job/step#attempt`: без запечатывания перед
    // переисполнением вторая попытка легла бы под тем же ключом, и разностный
    // учёт вычел бы из потолков расход прерванной попытки.
    const project = makeProject({ 'stepcast.yml': WAIT_REFUSAL_PIPELINE });
    const resetAt = Date.now() + 1_000;
    const fake = createFakeBackend({
      lines: (index) =>
        index === 0
          ? [
              initLine(),
              rateLimitRefusalLine({
                resetText: `resets ${new Date(resetAt).toISOString()}`,
                tokensIn: 700,
                tokensOut: 0,
              }),
            ]
          : [initLine(), resultLine({ text: 'план готов', tokensIn: 300, tokensOut: 0 })],
    });

    const result = await run(project, { fake }, { configOverride: { maxWaitMs: 60_000 } });
    assert.equal(result.status, 'success');

    const usage = readUsage(result.journal.paths);
    assert.equal(usage.jobs.build?.steps.plan?.billable_tokens, 1000, 'расход обеих попыток учтён');
    assert.equal(usage.jobs.build?.billable_tokens, 1000);
    assert.equal(usage.total.billable_tokens, 1000);
  });

  it('бюджет внутренней области без on_exceed не отменяет объявленный снаружи wait', async () => {
    // `on_exceed: stop` материализуется в каждом объявленном бюджете как
    // умолчание — режим ищется у ближайшей области, которая его написала.
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: backend-refusal-inherited-wait
budget:
  on_exceed: wait
jobs:
  build:
    steps:
      - id: plan
        agent: fake
        prompt: "Сделай план"
        budget:
          tokens: 50k
        expect:
          - exit_code: 0
`,
    });
    const resetAt = Date.now() + 1_000;
    const fake = createFakeBackend({
      lines: (index) =>
        index === 0
          ? [initLine(), rateLimitRefusalLine({ resetText: `resets ${new Date(resetAt).toISOString()}` })]
          : [initLine(), resultLine({ text: 'план готов' })],
    });

    const result = await run(project, { fake }, { configOverride: { maxWaitMs: 60_000 } });

    assert.equal(result.status, 'success');
    assert.equal(fake.invocations.length, 2, 'шаг должен быть переисполнен после ожидания');
  });

  it('без объявленного on_exceed: wait останавливает прогон с budget_exceeded', async () => {
    const project = makeProject({ 'stepcast.yml': STOP_REFUSAL_PIPELINE });
    const fake = createFakeBackend({ lines: [rateLimitRefusalLine({ resetText: 'подождите' })] });

    const result = await run(project, { fake });

    assert.equal(result.status, 'budget_exceeded');
    assert.equal(result.exitCode, ExitCode.budgetExceeded);
    const status = readStatus(result.journal.paths);
    const build = status.jobs.find((job) => job.id === 'build');
    assert.equal(build?.cause, 'backend_rate_limited');
  });

  it('нераспознанный момент сброса останавливает прогон, даже когда объявлен wait', async () => {
    const project = makeProject({ 'stepcast.yml': WAIT_REFUSAL_PIPELINE });
    const fake = createFakeBackend({ lines: [rateLimitRefusalLine({ resetText: 'скоро' })] });

    const result = await run(project, { fake });

    assert.equal(result.status, 'budget_exceeded');
    const status = readStatus(result.journal.paths);
    const reason = status.jobs.find((job) => job.id === 'build')?.reason ?? '';
    assert.match(reason, /момент сброса/);
  });

  it('момент сброса дальше предела ожидания останавливает прогон', async () => {
    const project = makeProject({ 'stepcast.yml': WAIT_REFUSAL_PIPELINE });
    const resetAt = Date.now() + 60_000;
    const fake = createFakeBackend({
      lines: [rateLimitRefusalLine({ resetText: `resets ${new Date(resetAt).toISOString()}` })],
    });

    const result = await run(project, { fake }, { configOverride: { maxWaitMs: 100 } });

    assert.equal(result.status, 'budget_exceeded');
    const status = readStatus(result.journal.paths);
    const reason = status.jobs.find((job) => job.id === 'build')?.reason ?? '';
    assert.match(reason, /предел ожидания/);
  });

  it('отчёт о расходе не содержит доли использования окна, которой бэкенд не сообщал', async () => {
    const project = makeProject({ 'stepcast.yml': STOP_REFUSAL_PIPELINE });
    const fake = createFakeBackend({ lines: [rateLimitRefusalLine({ resetText: 'подождите' })] });

    const result = await run(project, { fake });

    const usage = readUsage(result.journal.paths);
    assert.equal(usage.jobs.build?.steps.plan?.billable_tokens, 0);
  });

  it('отмена во время сна по отказу бэкенда прекращает ожидание', async () => {
    const project = makeProject({ 'stepcast.yml': WAIT_REFUSAL_PIPELINE });
    const controller = new AbortController();
    const resetAt = Date.now() + 60_000;
    const fake = createFakeBackend({
      hangMs: 4_000,
      lines: [initLine(), rateLimitRefusalLine({ resetText: `resets ${new Date(resetAt).toISOString()}` })],
    });

    const runsRoot = tempDir('runs-');
    const promise = runPipeline({
      expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
      config: {
        ...project.config,
        runs: { ...project.config.runs, root: runsRoot },
        defaults: { ...project.config.defaults, maxWaitMs: 3_600_000 },
      },
      projectRoot: project.root,
      cwd: project.root,
      signal: controller.signal,
      adapterFor: (name) => {
        assert.equal(name, 'fake');
        return fake.adapter;
      },
    });

    await waitForRunEvent(runsRoot, project.root, 'budget.waiting');
    controller.abort();

    const result = await promise;
    assert.equal(result.status, 'canceled');
  });

  it('отказ аутентификации прекращает прогон даже при fail_fast: false', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: auth-fail-fast-false
fail_fast: false
jobs:
  first:
    steps:
      - id: ask
        agent: fake
        prompt: "спроси"
        expect: [{ exit_code: 0 }]
  second:
    steps:
      - id: ask
        agent: fake
        prompt: "спроси"
        expect: [{ exit_code: 0 }]
`,
    });
    const fake = createFakeBackend({ lines: [authRefusalLine()] });

    const result = await run(project, { fake });

    assert.equal(result.status, 'failed');
    assert.equal(result.exitCode, ExitCode.backendUnavailable);
    assert.equal(fake.invocations.length, 1, 'вторая работа не должна быть запущена');

    const status = readStatus(result.journal.paths);
    const first = status.jobs.find((job) => job.id === 'first');
    const second = status.jobs.find((job) => job.id === 'second');
    assert.equal(first?.cause, 'backend_unauthenticated');
    assert.match(first?.reason ?? '', /аутентификации/);
    assert.equal(second?.status, 'skipped');

    // Способ починки должен быть в той же записи, которую читает `stepcast
    // status`, — в причине последней попытки, а не только у работы.
    const step = first?.steps.find((item) => item.id === 'ask');
    const attempt = step?.attempts.at(-1);
    for (const reason of [first?.reason, step?.reason, attempt?.reason]) {
      assert.match(reason ?? '', /Failed to authenticate/);
      assert.match(reason ?? '', /возобновите прогон командой stepcast resume/);
    }
  });
});

describe('usage-visibility: расход попыток попадает в сводку', () => {
  const RETRY_PIPELINE = `
version: 1
kind: pipeline
name: retry-usage
jobs:
  build:
    steps:
      - id: plan
        agent: fake
        prompt: "Сделай план"
        attempts:
          max: 2
        expect:
          - matches: "готово"
`;

  it('вторая попытка не затирает первую, а длительность доезжает до работы и шага', async () => {
    // Обе ошибки жили рядом: номер попытки в записи расхода был литеральной
    // единицей, поэтому вторая попытка ложилась под ключ первой и стирала её
    // из итога; а `wallclock_ms` проставлялся уже после потока событий и в
    // аккумулятор не попадал вовсе, оставляя работе и шагу честный на вид нуль.
    const fake = createFakeBackend({
      lines: (index) =>
        index === 0
          ? [initLine(), resultLine({ text: 'мимо', tokensIn: 100, tokensOut: 0 })]
          : [initLine(), resultLine({ text: 'готово', tokensIn: 300, tokensOut: 0 })],
    });

    const result = await run(makeProject({ 'stepcast.yml': RETRY_PIPELINE }), { fake });
    assert.equal(result.status, 'success');

    const usage = readUsage(result.journal.paths);
    const step = usage.jobs.build?.steps.plan;

    assert.deepEqual(
      step?.attempts.map((entry) => entry.attempt),
      [1, 2],
      'обе попытки различимы в сводке',
    );
    assert.equal(step?.attempts[0]?.billable_tokens, 100, 'расход первой попытки уцелел');
    assert.equal(step?.attempts[1]?.billable_tokens, 300);
    assert.equal(step?.billable_tokens, 400, 'шаг суммирует обе попытки');
    assert.equal(usage.jobs.build?.billable_tokens, 400, 'работа суммирует обе попытки');

    assert.ok((step?.wallclock_ms ?? 0) > 0, 'у шага есть измеренная длительность, а не нуль');
    assert.ok((usage.jobs.build?.wallclock_ms ?? 0) > 0, 'у работы тоже');
  });
});

describe('cost-budget: применение денежного потолка', () => {
  // Спека pipeline-execution: «Денежный потолок шага, работы, пайплайна»
  it('превышение денежного потолка шага останавливает шаг с budget_exceeded', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: cost-step
jobs:
  build:
    steps:
      - id: plan
        agent: fake
        prompt: "Сделай план"
        budget:
          cost: 1
        expect:
          - exit_code: 0
`,
    });
    const fake = createFakeBackend({
      lines: [initLine(), resultLine({ text: 'готово', tokensIn: 10, tokensOut: 0, costUsd: 2 })],
    });

    const result = await run(project, { fake });
    assert.equal(stepStatus(result, 'build', 'plan'), 'budget_exceeded');

    const status = readStatus(result.journal.paths);
    const step = status.jobs.find((job) => job.id === 'build')?.steps.find((s) => s.id === 'plan');
    assert.match(step?.reason ?? '', /потрачено \$2\.00.*потолке \$1\.00/);
    // Цена приходит один раз, в финальной записи попытки: остановка не может
    // случиться раньше — перерасход не больше цены одной попытки.
    assert.equal(fake.invocations.length, 1, 'потолок связал после единственной попытки, а не переисполнил шаг');
  });

  it('превышение денежного потолка работы останавливает шаг с budget_exceeded', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: cost-job
jobs:
  build:
    budget:
      cost: 1
    steps:
      - id: plan
        agent: fake
        prompt: "Сделай план"
        expect:
          - exit_code: 0
`,
    });
    const fake = createFakeBackend({
      lines: [initLine(), resultLine({ text: 'готово', tokensIn: 10, tokensOut: 0, costUsd: 2 })],
    });

    const result = await run(project, { fake });
    assert.equal(stepStatus(result, 'build', 'plan'), 'budget_exceeded');
  });

  it('превышение денежного потолка пайплайна останавливает шаг с budget_exceeded', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: cost-pipeline
budget:
  cost: 1
jobs:
  build:
    steps:
      - id: plan
        agent: fake
        prompt: "Сделай план"
        expect:
          - exit_code: 0
`,
    });
    const fake = createFakeBackend({
      lines: [initLine(), resultLine({ text: 'готово', tokensIn: 10, tokensOut: 0, costUsd: 2 })],
    });

    const result = await run(project, { fake });
    assert.equal(stepStatus(result, 'build', 'plan'), 'budget_exceeded');
  });

  // Спека pipeline-execution: «Сосуществование денежного и токенного потолков»
  it('денежный потолок, исчерпанный раньше токенного, останавливает по cost', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: cost-before-tokens
jobs:
  build:
    steps:
      - id: plan
        agent: fake
        prompt: "Сделай план"
        budget:
          tokens: 10000
          cost: 1
        expect:
          - exit_code: 0
`,
    });
    const fake = createFakeBackend({
      lines: [initLine(), resultLine({ text: 'готово', tokensIn: 10, tokensOut: 0, costUsd: 5 })],
    });

    const result = await run(project, { fake });
    const status = readStatus(result.journal.paths);
    const step = status.jobs.find((job) => job.id === 'build')?.steps.find((s) => s.id === 'plan');
    assert.equal(step?.status, 'budget_exceeded');
    assert.match(step?.reason ?? '', /\$/);
  });

  it('токенный потолок, исчерпанный раньше денежного, останавливает по tokens', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: tokens-before-cost
jobs:
  build:
    steps:
      - id: plan
        agent: fake
        prompt: "Сделай план"
        budget:
          tokens: 5
          cost: 1000
        expect:
          - exit_code: 0
`,
    });
    const fake = createFakeBackend({
      lines: [initLine(), resultLine({ text: 'готово', tokensIn: 40, tokensOut: 0, costUsd: 0.01 })],
    });

    const result = await run(project, { fake });
    const status = readStatus(result.journal.paths);
    const step = status.jobs.find((job) => job.id === 'build')?.steps.find((s) => s.id === 'plan');
    assert.equal(step?.status, 'budget_exceeded');
    assert.doesNotMatch(step?.reason ?? '', /\$/);
  });

  // Спека pipeline-execution: «on_exceed: wait не применяется к деньгам»
  it('on_exceed: wait с денежным превышением останавливает прогон без ожидания', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: cost-wait
jobs:
  build:
    steps:
      - id: plan
        agent: fake
        prompt: "Сделай план"
        budget:
          cost: 1
          on_exceed: wait
        expect:
          - exit_code: 0
`,
    });
    const fake = createFakeBackend({
      lines: [initLine(), resultLine({ text: 'готово', tokensIn: 10, tokensOut: 0, costUsd: 2 })],
    });

    const result = await run(project, { fake });

    assert.equal(result.status, 'budget_exceeded');
    assert.equal(fake.invocations.length, 1, 'денежный потолок не ждёт и не переисполняет шаг');

    const events = readEvents(result.journal.paths);
    assert.equal(events.some((event) => event.kind === 'budget.waiting'), false);
  });

  // Спека pipeline-execution: «Цена судьи входит в потолок»
  it('цена вызова судьи входит в цену попытки и в потолок шага', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: cost-judge
jobs:
  build:
    steps:
      - id: plan
        agent: fake
        prompt: "Сделай план"
        budget:
          cost: 1
        expect:
          - exit_code: 0
          - judge: "план полный"
            hard: true
            agent: critic
`,
    });
    const fake = createFakeBackend({
      lines: [initLine(), resultLine({ text: 'готово', tokensIn: 10, tokensOut: 0, costUsd: 0.6 })],
    });
    const critic = createFakeBackend({
      lines: [resultLine({ structured: { pass: true, reason: 'ок' }, tokensIn: 5, tokensOut: 0, costUsd: 0.6 })],
    });

    const result = await run(project, { fake, critic });
    // Попытка дошла до собственного конца, перейдя потолок последней ценой —
    // исход её собственный. Перейден потолок шага, никого не остановивший:
    // прогон доигран и остановленным по бюджету не числится.
    assert.equal(stepStatus(result, 'build', 'plan'), 'success');
    assert.equal(result.status, 'success');

    const usage = readUsage(result.journal.paths);
    const step = usage.jobs.build?.steps.plan;
    assert.ok(step !== undefined);
    assert.ok(Math.abs((step.cost_usd ?? 0) - 1.2) < 1e-9, 'цена шага и судьи сложились');
  });

  // Спека run-journal: «Попытка без сообщённой цены»
  it('попытка без цены не входит в сумму, а отчёт называет её несообщённой', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: cost-unreported
jobs:
  build:
    budget:
      cost: 100
    steps:
      - id: plan
        agent: fake
        prompt: "Сделай план"
        expect:
          - exit_code: 0
`,
    });
    const fake = createFakeBackend({
      lines: [initLine(), resultLine({ text: 'готово', tokensIn: 10, tokensOut: 0 })],
    });

    const result = await run(project, { fake });
    assert.equal(result.status, 'success');

    const usage = readUsage(result.journal.paths);
    assert.equal(usage.total.cost_usd, undefined, 'ни одна попытка не сообщила цены');
    assert.ok(usage.unreported.includes('reported_cost_usd'));

    const status = readStatus(result.journal.paths);
    assert.equal(status.budget.cost_unreported_attempts, 1);
  });

  // Спека pipeline-execution: «Полностью несообщённая цена»
  it('денежный потолок при полностью несообщённой цене: событие, предупреждение, прогон доведён до конца', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: cost-silent
jobs:
  build:
    steps:
      - id: plan
        agent: fake
        prompt: "Сделай план"
        budget:
          cost: 5
        expect:
          - exit_code: 0
`,
    });
    const fake = createFakeBackend({
      lines: [initLine(), resultLine({ text: 'готово', tokensIn: 10, tokensOut: 0 })],
    });

    const result = await run(project, { fake });
    assert.equal(result.status, 'success', 'прогон доведён до конца тем же кодом возврата');
    assert.equal(result.costLimitUnapplied, true);

    const events = readEvents(result.journal.paths);
    const unreportedEvents = events.filter((event) => event.kind === 'budget.cost_unreported');
    assert.equal(unreportedEvents.length, 1, 'событие ровно одно за прогон');
  });

  // Спека run-journal: «Частично несообщённая цена»
  it('часть попыток без цены: потолок применяется по учтённой части, число неучтённых названо', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: cost-partial
jobs:
  a:
    steps:
      - id: s
        agent: fake
        prompt: "a"
        expect:
          - exit_code: 0
  b:
    steps:
      - id: s
        agent: fake2
        prompt: "b"
        expect:
          - exit_code: 0
`,
    });
    const fake = createFakeBackend({
      lines: [initLine(), resultLine({ text: 'готово', tokensIn: 10, tokensOut: 0, costUsd: 0.5 })],
    });
    const fake2 = createFakeBackend({
      lines: [initLine(), resultLine({ text: 'готово', tokensIn: 10, tokensOut: 0 })],
    });

    const result = await run(project, { fake, fake2 });
    assert.equal(result.status, 'success');

    const usage = readUsage(result.journal.paths);
    assert.ok(Math.abs((usage.total.cost_usd ?? 0) - 0.5) < 1e-9, 'сумма по учтённой части');

    const status = readStatus(result.journal.paths);
    assert.equal(status.budget.cost_unreported_attempts, 1);
  });

  // Спека run-journal: «Сводка и состояние прежней формы» — прочерк, не отказ схемы
  it('старая сводка и состояние без денежных полей проходят схему без изменений', () => {
    const emptyUsageReport = {
      run_id: 'run-old',
      total: { tokens_in: 1, tokens_out: 1, cache_read: 0, cache_write: 0, billable_tokens: 2, wallclock_ms: 10 },
      unreported: [],
      jobs: {},
    };
    const parsedUsage = UsageReportSchema.safeParse(emptyUsageReport);
    assert.equal(parsedUsage.success, true);

    const emptyBudgetState = { tokens_used: 2, wallclock_ms: 10 };
    const parsedBudget = BudgetStateSchema.safeParse(emptyBudgetState);
    assert.equal(parsedBudget.success, true);
  });

  // Спека run-journal: «Наибольший префикс обращения виден рядом с расходом» —
  // запись прежней формы, записанная до появления поля, обязана читаться.
  it('запись расхода прежней формы без пика проходит все затронутые схемы', () => {
    const oldUsage = {
      backend: 'claude',
      model: 'sonnet',
      tokens_in: 100,
      tokens_out: 50,
      cache_read: 0,
      cache_write: 0,
      wallclock_ms: 1_000,
    };
    assert.equal(UsageSchema.safeParse(oldUsage).success, true);

    const oldAttemptRecord = {
      attempt: 1,
      status: 'success',
      started_at: '2026-08-01T00:00:00.000Z',
      finished_at: '2026-08-01T00:00:30.000Z',
      usage: oldUsage,
    };
    assert.equal(AttemptRecordSchema.safeParse(oldAttemptRecord).success, true);

    const oldAttemptReport = {
      attempt: 1,
      backend: 'claude',
      billable_tokens: 150,
      wallclock_ms: 1_000,
    };
    assert.equal(UsageAttemptReportSchema.safeParse(oldAttemptReport).success, true);

    const oldStepNode = {
      run_id: 'run-old',
      total: { tokens_in: 1, tokens_out: 1, cache_read: 0, cache_write: 0, billable_tokens: 2, wallclock_ms: 10 },
      unreported: [],
      jobs: {
        build: {
          billable_tokens: 150,
          wallclock_ms: 1_000,
          steps: { compile: { billable_tokens: 150, wallclock_ms: 1_000, attempts: [oldAttemptReport] } },
        },
      },
    };
    assert.equal(UsageReportSchema.safeParse(oldStepNode).success, true);
  });
});

describe('usage-snapshot: снимок накопленного расхода для наблюдателя событий', () => {
  it('снимок несёт токены, время и цену той же величины, что и блок budget', () => {
    const usage = new UsageAccumulator(() => 1);
    usage.record('build', 'plan', 1, usageWith({ tokens_in: 100, tokens_out: 0, reported_cost_usd: 0.5 }));

    const snapshot = usage.snapshot();
    assert.equal(snapshot.tokens, usage.runTokens());
    assert.equal(snapshot.costMicroUsd, usage.runCostMicroUsd());
    assert.equal(snapshot.costUnreportedAttempts, usage.costUnreportedAttemptCount());
    assert.ok(snapshot.elapsedMs >= 0);
  });

  it('прогон без единой сообщённой цены не несёт цены в снимке', () => {
    const usage = new UsageAccumulator(() => 1);
    usage.record('build', 'plan', 1, usageWith({ tokens_in: 100, tokens_out: 0 }));

    const snapshot = usage.snapshot();
    assert.equal(snapshot.costMicroUsd, undefined, 'несообщённая цена — отсутствующая величина, не ноль');
  });

  it('снимок не убывает между двумя последовательными вызовами', () => {
    const usage = new UsageAccumulator(() => 1);
    usage.record('build', 'plan', 1, usageWith({ tokens_in: 100, tokens_out: 0 }));
    const first = usage.snapshot();

    usage.record('build', 'plan', 1, usageWith({ tokens_in: 150, tokens_out: 0 }));
    const second = usage.snapshot();

    assert.ok(second.tokens >= first.tokens);
    assert.ok(second.elapsedMs >= first.elapsedMs);
  });
});

describe('budget-parallel: превышение при нескольких идущих работах', () => {
  // Работы `дорогая` и `долгая` идут одновременно и обращаются к разным
  // бэкендам — предел мест их не выстраивает в очередь. Командный шаг
  // `дорогой` держит её агентский вызов позади начала долгого: к моменту, когда
  // расход перевалит потолок прогона, попытка соседа уже идёт.
  const THREE_JOBS = `
version: 1
kind: pipeline
name: budget-parallel
concurrency: 2
budget:
  cost: 1
jobs:
  дорогая:
    steps:
      - id: ждёт
        run: [sh, -c, 'sleep 0.2']
        expect:
          - exit_code: 0
      - id: тратит
        agent: дорогой
        prompt: "трать"
        expect:
          - exit_code: 0
  долгая:
    steps:
      - id: думает
        agent: дешёвый
        prompt: "думай"
        expect:
          - exit_code: 0
  третья:
    steps:
      - id: думает
        agent: дешёвый
        prompt: "думай"
        expect:
          - exit_code: 0
`;

  // Спека pipeline-execution: «Превышение обнаружено при двух идущих работах»
  // и «Прогон останавливается с объявленной причиной».
  it('доводит начатую работу до конца, новых не запускает и называет причину', async () => {
    const project = makeProject({ 'stepcast.yml': THREE_JOBS });
    // Имя адаптера у поддельного бэкенда общее, а место считается по нему:
    // без переименования оба вызова встали бы в одну очередь и перестали быть
    // одновременными.
    const дорогойБазовый = createFakeBackend({
      lines: [initLine(), resultLine({ text: 'готово', tokensIn: 10, tokensOut: 0, costUsd: 2 })],
    });
    const дорогой: FakeBackend = {
      ...дорогойБазовый,
      adapter: { ...дорогойБазовый.adapter, name: 'дорогой' },
    };
    const дешёвый = createFakeBackend({
      lines: [initLine(), resultLine({ text: 'готово', tokensIn: 10, tokensOut: 0, costUsd: 0 })],
      // Дольше, чем нужно дорогой работе на превышение: место освобождается
      // уже после остановки, и третьей работе взяться неоткуда.
      hangMs: 1_200,
    });

    const result = await run(project, { дорогой, дешёвый });

    assert.equal(result.status, 'budget_exceeded');
    assert.equal(дешёвый.invocations.length, 1, 'третья работа после превышения не запускается');

    const status = readStatus(result.journal.paths);
    const jobStatus = (id: string): string | undefined =>
      status.jobs.find((job) => job.id === id)?.status;
    assert.equal(jobStatus('дорогая'), 'budget_exceeded');
    assert.equal(
      jobStatus('долгая'),
      'success',
      'идущая попытка доведена до конца, и чужой перерасход её исход не переписывает',
    );
    assert.equal(jobStatus('третья'), 'skipped', 'после превышения новых работ не запускается');

    // Состояние называет работу и шаг, на которых превышение обнаружено.
    assert.equal(status.resume?.blocked_by, 'дорогая');
    assert.equal(stepStatus(result, 'дорогая', 'тратит'), 'budget_exceeded');

    const exceeded = readEvents(result.journal.paths).find(
      (event) => event.kind === 'budget.exceeded',
    );
    assert.ok(exceeded !== undefined);
    if (exceeded?.kind === 'budget.exceeded') {
      assert.equal(exceeded.job, 'дорогая');
      assert.equal(exceeded.step, 'тратит');
    }
  });
});

describe('usage-live-progress: сводка расхода пишется по ходу прогона', () => {
  const TWO_JOBS = `
version: 1
kind: pipeline
name: usage-live-progress
jobs:
  a:
    steps:
      - id: only
        agent: fake
        prompt: "первая работа"
        expect: [{ exit_code: 0 }]
  b:
    needs: [a]
    steps:
      - id: only
        agent: fake
        prompt: "вторая работа"
        expect: [{ exit_code: 0 }]
`;

  // Спека run-journal: «Сводка доступна до конца прогона»
  it('usage.json несёт расход завершившейся работы и признак незаконченности, пока прогон идёт', async () => {
    const project = makeProject({ 'stepcast.yml': TWO_JOBS });
    const fake = createFakeBackend({
      lines: [initLine(), resultLine({ text: 'готово', tokensIn: 40, tokensOut: 10 })],
    });
    const runsRoot = tempDir('runs-');

    let duringRun: ReturnType<typeof readUsage> | undefined;
    const result = await run(
      project,
      { fake },
      {
        runsRoot,
        onEvent: (event) => {
          // b зависит от a, поэтому на этом поводе b ещё не исполнялась —
          // первая попытка снять снимок и есть проверяемый момент.
          if (event.kind !== 'job.finished' || event.job !== 'a' || duringRun !== undefined) return;
          duringRun = readUsage(resolveRun(runsRoot, project.root));
        },
      },
    );

    assert.ok(duringRun !== undefined, 'событие job.finished для «a» не поймано');
    assert.equal(duringRun?.partial, true, 'сводка идущего прогона несёт признак незаконченности');
    assert.equal(duringRun?.jobs.a?.steps.only?.billable_tokens, 50);
    assert.equal(duringRun?.jobs.b, undefined, 'вторая работа к этому поводу ещё не исполнялась');

    // После завершения прогона сводка подведена и несёт обе работы.
    const final = readUsage(result.journal.paths);
    assert.equal(final.partial, undefined);
    assert.equal(final.jobs.a?.steps.only?.billable_tokens, 50);
    assert.equal(final.jobs.b?.steps.only?.billable_tokens, 50);
  });

  // Спека run-journal: «Итог сводки не расходится с состоянием»
  it('итог сводки расхода совпадает с накопленной величиной состояния', async () => {
    const project = makeProject({ 'stepcast.yml': TWO_JOBS });
    const fake = createFakeBackend({
      lines: [initLine(), resultLine({ text: 'готово', tokensIn: 40, tokensOut: 10 })],
    });
    const runsRoot = tempDir('runs-');

    let snapshot: { readonly billable: number; readonly tokensUsed: number } | undefined;
    await run(
      project,
      { fake },
      {
        runsRoot,
        onEvent: (event) => {
          if (event.kind !== 'job.finished' || event.job !== 'a' || snapshot !== undefined) return;
          const paths = resolveRun(runsRoot, project.root);
          snapshot = {
            billable: readUsage(paths).total.billable_tokens,
            tokensUsed: readStatus(paths).budget.tokens_used,
          };
        },
      },
    );

    assert.ok(snapshot !== undefined, 'событие job.finished для «a» не поймано');
    assert.equal(snapshot?.billable, snapshot?.tokensUsed);
  });
});
