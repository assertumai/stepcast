import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { UsageAccumulator } from '../src/core/budget/accumulator.js';
import { createFakeBackend, initLine, resultLine, type FakeBackend } from '../src/core/backend/fake.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { readEvents, readStatus, readUsage, resolveRun } from '../src/core/journal/reader.js';
import { runPipeline, type RunResult } from '../src/core/run/runner.js';
import type { Config } from '../src/core/config/resolve.js';
import type { Usage } from '../src/core/journal/schema.js';
import { makeProject, type Project } from './helpers.js';

/** См. test/judge-attempt.test.ts: один поддельный бэкенд на объявленное имя. */
async function run(
  project: Project,
  backends: Readonly<Record<string, FakeBackend>>,
  options: { readonly configOverride?: Partial<Config['defaults']>; readonly signal?: AbortSignal } = {},
): Promise<RunResult> {
  const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
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

  it('агентский шаг получает budget_exceeded, когда расход судьи довёл до потолка', async () => {
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
    assert.equal(stepStatus(result, 'build', 'plan'), 'budget_exceeded');
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

  it('командный шаг получает budget_exceeded тем же образом', async () => {
    const project = makeProject({ 'stepcast.yml': RUN_PIPELINE_TOKENS });
    const fake = createFakeBackend({ lines: [] });
    const critic = createFakeBackend({
      lines: [
        resultLine({ structured: { pass: true, reason: 'ок' }, tokensIn: 10, tokensOut: 0 }),
      ],
    });

    const result = await run(project, { fake, critic });
    assert.equal(stepStatus(result, 'build', 'check'), 'budget_exceeded');
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
      // Зависание заведомо длинное, а порог — с большим запасом: в удачном
      // случае прогон завершается за десятки миллисекунд, и длина зависания
      // ничего не стоит. Узкий запас же ловил не регресс, а задержку чтения
      // потока под нагрузкой параллельных тестов.
      hangMs: 10_000,
    });

    const started = Date.now();
    const result = await run(project, { fake });

    assert.equal(result.status, 'budget_exceeded');
    assert.ok(Date.now() - started < 6_000, 'лимит должен остановить процесс, не дожидаясь hangMs');
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
 * процесса.
 *
 * Фейк печатает строки и только потом спит, но вывод идёт в трубу и
 * буферизуется: под нагрузкой строка с лимитом доходит до движка не сразу, а
 * иногда лишь при выходе процесса. Если окно уже, чем зависание, то первый
 * путь даёт сон, а второй — нулевой, и тест мигает не из-за движка, а из-за
 * буферизации. Запас `resetsAt - hangMs` держит сон измеримым на обоих путях.
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

    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
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

    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
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
