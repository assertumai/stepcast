import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { overallStatus, schedule, type JobOutcome } from '../src/core/run/scheduler.js';
import { buildGraph } from '../src/core/graph.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { makeProject } from './helpers.js';
import type { Pipeline } from '../src/core/pipeline/model.js';

function pipelineOf(yaml: string, inputs?: Record<string, string>): Pipeline {
  const project = makeProject({ 'stepcast.yml': yaml });
  return expandPipeline({
    pipelinePath: project.path('stepcast.yml'),
    config: project.config,
    ...(inputs === undefined ? {} : { inputs }),
  }).pipeline;
}

const STEP = '{ id: c, run: [echo, ok] }';

interface Recorded {
  readonly executed: string[];
  readonly statuses: Map<string, string>;
  readonly reasons: Map<string, string | undefined>;
  readonly status: string;
}

async function drive(
  pipeline: Pipeline,
  outcomes: Readonly<Record<string, JobOutcome>> = {},
  signal?: AbortSignal,
): Promise<Recorded> {
  const executed: string[] = [];
  const result = await schedule({
    pipeline,
    ...(signal === undefined ? {} : { signal }),
    execute: async (job) => {
      executed.push(job.id);
      return outcomes[job.id] ?? { status: 'success' };
    },
  });

  return {
    executed,
    statuses: new Map(result.settled.map((job) => [job.id, job.status])),
    reasons: new Map(result.settled.map((job) => [job.id, job.reason])),
    status: result.status,
  };
}

/** Отложить исход работы до внешнего разрешения — так проверяется одновременность. */
function gate(): { readonly promise: Promise<void>; open: () => void } {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { promise, open };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Traced {
  readonly started: string[];
  readonly finished: string[];
  readonly statuses: Map<string, string>;
  readonly status: string;
  /** Наибольшее число работ, шедших одновременно. */
  readonly peak: number;
}

/**
 * Прогнать граф, отдав исполнение под наблюдение: каждая работа сообщает о
 * начале и завершении, а её длительность задаётся вызывающим.
 */
async function trace(
  pipeline: Pipeline,
  options: {
    readonly concurrency?: number;
    readonly hold?: Readonly<Record<string, Promise<void>>>;
    readonly outcomes?: Readonly<Record<string, JobOutcome>>;
    readonly signal?: AbortSignal;
    readonly onStarted?: (id: string) => void;
  } = {},
): Promise<Traced> {
  const started: string[] = [];
  const finished: string[] = [];
  let running = 0;
  let peak = 0;

  const result = await schedule({
    pipeline,
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    execute: async (job) => {
      started.push(job.id);
      running += 1;
      peak = Math.max(peak, running);
      options.onStarted?.(job.id);
      await (options.hold?.[job.id] ?? tick());
      running -= 1;
      finished.push(job.id);
      return options.outcomes?.[job.id] ?? { status: 'success' };
    },
  });

  return {
    started,
    finished,
    statuses: new Map(result.settled.map((job) => [job.id, job.status])),
    status: result.status,
    peak,
  };
}

const FOUR_INDEPENDENT = `
kind: pipeline
jobs:
  a: { steps: [${STEP}] }
  b: { steps: [${STEP}] }
  c: { steps: [${STEP}] }
  d: { steps: [${STEP}] }
`;

describe('pipeline-execution: исполнение выборки', () => {
  // Сценарий: «Независимые работы идут одновременно»
  it('вторая готовая работа начинается, не дожидаясь завершения первой', async () => {
    const first = gate();
    const pipeline = pipelineOf(`
kind: pipeline
jobs:
  a: { steps: [${STEP}] }
  b: { steps: [${STEP}] }
`);

    const traced = trace(pipeline, { concurrency: 2, hold: { a: first.promise } });
    await tick();
    await tick();
    first.open();
    const result = await traced;

    assert.deepEqual(result.started, ['a', 'b']);
    assert.equal(result.peak, 2, 'обе работы должны идти одновременно');
    assert.deepEqual(result.finished, ['b', 'a'], 'порядок исходов — порядок завершения');
  });

  // Сценарий: «Единица даёт прежний порядок»
  it('при concurrency: 1 работы идут по одной в порядке объявления', async () => {
    const result = await trace(pipelineOf(FOUR_INDEPENDENT), { concurrency: 1 });
    assert.equal(result.peak, 1);
    assert.deepEqual(result.started, ['a', 'b', 'c', 'd']);
    assert.deepEqual(result.finished, ['a', 'b', 'c', 'd']);
  });

  // Сценарий: «Число идущих работ ограничено»
  it('одновременно идут не больше объявленного числа работ', async () => {
    const held = { a: gate(), b: gate(), c: gate(), d: gate() };
    const traced = trace(pipelineOf(FOUR_INDEPENDENT), {
      concurrency: 2,
      hold: Object.fromEntries(Object.entries(held).map(([id, item]) => [id, item.promise])),
    });

    await tick();
    await tick();
    for (const item of Object.values(held)) item.open();
    const result = await traced;

    assert.equal(result.peak, 2, 'третья работа обязана дождаться места');
    assert.deepEqual(result.started, ['a', 'b', 'c', 'd']);
  });

  // Сценарий: «Освободившееся место занимается сразу»
  it('освободившееся место занимает следующая готовая работа', async () => {
    const a = gate();
    const b = gate();
    const c = gate();
    const seen: string[] = [];
    const traced = trace(
      pipelineOf(`
kind: pipeline
jobs:
  a: { steps: [${STEP}] }
  b: { steps: [${STEP}] }
  c: { steps: [${STEP}] }
`),
      {
        concurrency: 2,
        hold: { a: a.promise, b: b.promise, c: c.promise },
        onStarted: (id) => seen.push(id),
      },
    );

    await tick();
    await tick();
    a.open();
    // Место освободилось только у одной из двух идущих работ: `b` ещё идёт.
    await tick();
    await tick();
    await tick();

    assert.deepEqual(seen, ['a', 'b', 'c'], 'третья работа начата, пока вторая ещё идёт');

    b.open();
    c.open();
    await traced;
  });

  it('предел, поданный планировщику, ограничивает прогон и без линта', async () => {
    // Сценарий «Потолок конфигурации ограничивает прогон»: пайплайн объявил
    // больше, но прогон получил сведённое значение.
    const held = { a: gate(), b: gate(), c: gate(), d: gate() };
    const traced = trace(pipelineOf(`${FOUR_INDEPENDENT}concurrency: 8\n`), {
      concurrency: 2,
      hold: Object.fromEntries(Object.entries(held).map(([id, item]) => [id, item.promise])),
    });

    await tick();
    await tick();
    for (const item of Object.values(held)) item.open();

    assert.equal((await traced).peak, 2);
  });
});

describe('pipeline-execution: остановка и отмена при идущих работах', () => {
  // Сценарий: «Идущая работа не обрывается»
  it('отказ одной работы не обрывает вторую идущую и не пускает новые', async () => {
    const failing = gate();
    const running = gate();
    const pipeline = pipelineOf(`
kind: pipeline
jobs:
  a: { steps: [${STEP}] }
  b: { steps: [${STEP}] }
  c: { needs: [a], steps: [${STEP}] }
`);

    const traced = trace(pipeline, {
      concurrency: 2,
      hold: { a: failing.promise, b: running.promise },
      outcomes: { a: { status: 'failed', reason: 'тесты' } },
    });

    await tick();
    await tick();
    failing.open();
    await tick();
    await tick();
    running.open();
    const result = await traced;

    assert.deepEqual(result.finished, ['a', 'b'], 'вторая доведена до конца');
    assert.equal(result.statuses.get('b'), 'success', 'её исход — её собственный, а не canceled');
    assert.equal(result.statuses.get('c'), 'skipped');
    assert.equal(result.started.includes('c'), false, 'новые работы не запускаются');
  });

  // Сценарий: «Отмена при нескольких идущих работах»
  it('отмена дожидается идущих работ и не запускает новых', async () => {
    const controller = new AbortController();
    const a = gate();
    const b = gate();
    const pipeline = pipelineOf(`
kind: pipeline
jobs:
  a: { steps: [${STEP}] }
  b: { steps: [${STEP}] }
  c: { needs: [a], steps: [${STEP}] }
  triage: { needs: all, on: always, steps: [${STEP}] }
`);

    const traced = trace(pipeline, {
      concurrency: 2,
      hold: { a: a.promise, b: b.promise },
      signal: controller.signal,
    });

    await tick();
    await tick();
    controller.abort();
    a.open();
    b.open();
    const result = await traced;

    assert.deepEqual(result.finished.slice(0, 2).sort(), ['a', 'b']);
    assert.equal(result.statuses.get('a'), 'success', 'начатая до отмены работа отдаёт свой исход');
    assert.equal(result.statuses.get('b'), 'success');
    assert.equal(result.statuses.get('c'), 'canceled');
    assert.equal(result.started.includes('c'), false);
    assert.equal(result.statuses.get('triage'), 'success', 'разбор нужен именно при отмене');
    assert.equal(result.status, 'canceled');
  });

  // Дефект исполнителя — не исход графа: работа, не отдавшая исхода вовсе,
  // не получает пропуска, а вторая фаза не начинается.
  it('исключение исполнителя дожидается идущих работ и не превращается в пропуск', async () => {
    const failing = gate();
    const running = gate();
    const settled: string[] = [];
    const started: string[] = [];

    const pipeline = pipelineOf(`
kind: pipeline
jobs:
  a: { steps: [${STEP}] }
  b: { steps: [${STEP}] }
  triage: { needs: all, on: always, steps: [${STEP}] }
`);

    const promise = schedule({
      pipeline,
      concurrency: 2,
      execute: async (job) => {
        started.push(job.id);
        if (job.id === 'a') {
          await failing.promise;
          throw new Error('дефект исполнителя');
        }
        await (job.id === 'b' ? running.promise : tick());
        return { status: 'success' };
      },
      onSettled: (job) => {
        settled.push(job.id);
      },
    });

    await tick();
    await tick();
    failing.open();
    await tick();
    await tick();
    running.open();

    await assert.rejects(promise, /дефект исполнителя/);
    assert.deepEqual(settled, ['b'], 'упавшая с ошибкой работа исхода не получает');
    assert.equal(started.includes('triage'), false, 'вторая фаза после дефекта не начинается');
  });

  // Сценарий: «Работы needs: all после всего»
  it('работы needs: all начинаются после завершения всех идущих', async () => {
    const a = gate();
    const startedWhileRunning: string[] = [];
    const traced = trace(
      pipelineOf(`
kind: pipeline
jobs:
  a: { steps: [${STEP}] }
  b: { steps: [${STEP}] }
  triage: { needs: all, on: always, steps: [${STEP}] }
`),
      {
        concurrency: 4,
        hold: { a: a.promise },
        onStarted: (id) => {
          if (id === 'triage') startedWhileRunning.push(id);
        },
      },
    );

    await tick();
    await tick();
    assert.deepEqual(startedWhileRunning, [], 'вторая фаза не идёт вперемешку с основным графом');
    a.open();

    const result = await traced;
    assert.equal(result.started.at(-1), 'triage');
  });
});

describe('pipeline-execution: порядок', () => {
  // Сценарий: «Порядок по зависимостям»
  it('исполняет работы в топологическом порядке', async () => {
    const result = await drive(
      pipelineOf(`
kind: pipeline
jobs:
  typecheck: { needs: [implement], steps: [${STEP}] }
  implement: { needs: [plan], steps: [${STEP}] }
  plan: { steps: [${STEP}] }
`),
    );
    assert.deepEqual(result.executed, ['plan', 'implement', 'typecheck']);
  });

  // Сценарий: «Независимые работы упорядочены объявлением»
  it('упорядочивает независимые работы по объявлению и повторяемо', async () => {
    const pipeline = pipelineOf(`
kind: pipeline
jobs:
  zebra: { steps: [${STEP}] }
  alpha: { steps: [${STEP}] }
  middle: { steps: [${STEP}] }
`);
    const first = await drive(pipeline);
    const second = await drive(pipeline);
    assert.deepEqual(first.executed, ['zebra', 'alpha', 'middle']);
    assert.deepEqual(second.executed, first.executed);
  });
});

describe('pipeline-execution: условия', () => {
  // Сценарий: «Зависимость упала»
  it('пропускает работу, если зависимость упала', async () => {
    const result = await drive(
      pipelineOf(`
kind: pipeline
jobs:
  build: { steps: [${STEP}] }
  ship: { needs: [build], steps: [${STEP}] }
`),
      { build: { status: 'failed', reason: 'тесты' } },
    );

    assert.equal(result.statuses.get('ship'), 'skipped');
    assert.match(result.reasons.get('ship') ?? '', /on: success/);
    assert.equal(result.executed.includes('ship'), false);
  });

  // Сценарий: «Разбор отказа»
  it('запускает работу с on: failure при отказе зависимости', async () => {
    const result = await drive(
      pipelineOf(`
kind: pipeline
jobs:
  build: { steps: [${STEP}] }
  triage: { needs: [build], on: failure, steps: [${STEP}] }
`),
      { build: { status: 'failed' } },
    );
    assert.equal(result.statuses.get('triage'), 'success');
  });

  it('пропускает on: failure, когда отказов не было', async () => {
    const result = await drive(
      pipelineOf(`
kind: pipeline
jobs:
  build: { steps: [${STEP}] }
  triage: { needs: [build], on: failure, steps: [${STEP}] }
`),
    );
    assert.equal(result.statuses.get('triage'), 'skipped');
  });

  // Сценарий: «Превышение бюджета считается отказом»
  it('трактует budget_exceeded как отказ для обоих условий', async () => {
    const result = await drive(
      pipelineOf(`
kind: pipeline
jobs:
  build: { steps: [${STEP}] }
  ship: { needs: [build], steps: [${STEP}] }
  triage: { needs: [build], on: failure, steps: [${STEP}] }
`),
      { build: { status: 'budget_exceeded' } },
    );
    assert.equal(result.statuses.get('ship'), 'skipped');
    assert.equal(result.statuses.get('triage'), 'success');
    assert.equal(result.status, 'budget_exceeded');
  });

  // Сценарий: «Одна из зависимостей пропущена»
  it('не блокирует работу пропущенной зависимостью', async () => {
    const result = await drive(
      pipelineOf(`
kind: pipeline
inputs:
  skip_review: { type: bool, default: true }
jobs:
  typecheck: { steps: [${STEP}] }
  review: { needs: [typecheck], if: "not inputs.skip_review", steps: [${STEP}] }
  archive: { needs: [review, typecheck], steps: [${STEP}] }
`),
    );

    assert.equal(result.statuses.get('review'), 'skipped');
    assert.equal(result.statuses.get('archive'), 'success', 'пропуск ревью не отменяет архивацию');
  });

  // Сценарий: «Все зависимости пропущены»
  it('пропускает работу, у которой пропущены все зависимости', async () => {
    const result = await drive(
      pipelineOf(`
kind: pipeline
inputs:
  skip: { type: bool, default: true }
jobs:
  review: { if: "not inputs.skip", steps: [${STEP}] }
  archive: { needs: [review], steps: [${STEP}] }
`),
    );
    assert.equal(result.statuses.get('archive'), 'skipped');
    assert.match(result.reasons.get('archive') ?? '', /все зависимости пропущены/);
  });

  // Сценарий: «Ложное условие по входу»
  it('пропускает работу по ложному условию', async () => {
    const result = await drive(
      pipelineOf(
        `
kind: pipeline
inputs:
  skip_review: { type: bool, required: true }
jobs:
  review: { if: "not inputs.skip_review", steps: [${STEP}] }
`,
        { skip_review: 'true' },
      ),
    );
    assert.equal(result.statuses.get('review'), 'skipped');
  });

  // Сценарий: «Выражение над выходом зависимости»
  it('вычисляет условие по опубликованному выходу зависимости', async () => {
    const yaml = `
kind: pipeline
jobs:
  review: { steps: [${STEP}] }
  fix: { needs: [review], if: "jobs.review.output.findings", steps: [${STEP}] }
`;

    const withFindings = await drive(pipelineOf(yaml), {
      review: { status: 'success', output: { findings: [{ severity: 'high' }] } },
    });
    assert.equal(withFindings.statuses.get('fix'), 'success');

    const clean = await drive(pipelineOf(yaml), {
      review: { status: 'success', output: { findings: [] } },
    });
    assert.equal(clean.statuses.get('fix'), 'skipped');
  });

  // Сценарий: «Оба условия должны выполниться»
  it('требует одновременного выполнения on и if', async () => {
    const result = await drive(
      pipelineOf(`
kind: pipeline
inputs:
  enabled: { type: bool, default: false }
jobs:
  build: { steps: [${STEP}] }
  ship: { needs: [build], on: success, if: "inputs.enabled", steps: [${STEP}] }
`),
    );
    assert.equal(result.statuses.get('ship'), 'skipped');
  });
});

describe('pipeline-execution: needs all и fail_fast', () => {
  // Сценарий: «Разбор после отказа»
  it('выполняет работу с needs: all последней', async () => {
    const result = await drive(
      pipelineOf(`
kind: pipeline
jobs:
  plan: { steps: [${STEP}] }
  build: { needs: [plan], steps: [${STEP}] }
  triage: { needs: all, on: failure, steps: [${STEP}] }
`),
      { build: { status: 'failed' } },
    );
    assert.deepEqual(result.executed, ['plan', 'build', 'triage']);
  });

  // Сценарий: «Две работы после всего»
  it('не заставляет работы с needs: all ждать друг друга', async () => {
    const result = await drive(
      pipelineOf(`
kind: pipeline
jobs:
  build: { steps: [${STEP}] }
  notify: { needs: all, on: always, steps: [${STEP}] }
  archive: { needs: all, on: always, steps: [${STEP}] }
`),
    );
    assert.deepEqual(result.executed, ['build', 'notify', 'archive']);
  });

  // Сценарий: «Остановка графа»
  it('останавливает граф после отказа и всё равно запускает разбор', async () => {
    const result = await drive(
      pipelineOf(`
kind: pipeline
jobs:
  implement: { steps: [${STEP}] }
  typecheck: { needs: [implement], steps: [${STEP}] }
  ship: { needs: [typecheck], steps: [${STEP}] }
  triage: { needs: all, on: failure, steps: [${STEP}] }
`),
      { implement: { status: 'failed' } },
    );

    assert.equal(result.statuses.get('typecheck'), 'skipped');
    assert.equal(result.statuses.get('ship'), 'skipped');
    assert.equal(result.statuses.get('triage'), 'success');
    assert.equal(result.status, 'failed');
  });

  it('fail_fast не глушит разбор в основном графе', async () => {
    // Остановка касается продолжения работы, а не её разбора: иначе после
    // первого же отказа разбирать его будет нечем.
    const result = await drive(
      pipelineOf(`
kind: pipeline
jobs:
  build: { steps: [${STEP}] }
  ship: { needs: [build], steps: [${STEP}] }
  explain: { needs: [build], on: failure, steps: [${STEP}] }
`),
      { build: { status: 'failed' } },
    );

    assert.equal(result.statuses.get('ship'), 'skipped');
    assert.equal(result.statuses.get('explain'), 'success');
  });

  // Сценарий: «Полный проход»
  it('доигрывает граф целиком при fail_fast: false', async () => {
    const result = await drive(
      pipelineOf(`
kind: pipeline
fail_fast: false
jobs:
  a: { steps: [${STEP}] }
  b: { steps: [${STEP}] }
  c: { steps: [${STEP}] }
`),
      { a: { status: 'failed' } },
    );
    assert.deepEqual(result.executed, ['a', 'b', 'c']);
  });
});

describe('pipeline-execution: исходы', () => {
  // Сценарий: «Отказ работы»
  it('прогон с отказавшей работой завершается отказом', async () => {
    const result = await drive(
      pipelineOf(`
kind: pipeline
jobs:
  build: { steps: [${STEP}] }
`),
      { build: { status: 'failed' } },
    );
    assert.equal(result.status, 'failed');
  });

  // Сценарий: «Все работы успешны или пропущены»
  it('прогон без отказов успешен', async () => {
    const result = await drive(
      pipelineOf(`
kind: pipeline
inputs:
  skip: { type: bool, default: true }
jobs:
  build: { steps: [${STEP}] }
  extra: { if: "not inputs.skip", steps: [${STEP}] }
`),
    );
    assert.equal(result.status, 'success');
  });

  // Сценарий: «Прерывание по Ctrl-C»
  it('отменяет незапущенные работы и всё равно выполняет разбор', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await drive(
      pipelineOf(`
kind: pipeline
jobs:
  build: { steps: [${STEP}] }
  ship: { needs: [build], steps: [${STEP}] }
  triage: { needs: all, on: always, steps: [${STEP}] }
`),
      {},
      controller.signal,
    );

    assert.equal(result.statuses.get('build'), 'canceled');
    assert.equal(result.statuses.get('ship'), 'canceled');
    assert.equal(result.statuses.get('triage'), 'success', 'разбор нужен именно при отмене');
    assert.equal(result.status, 'canceled');
  });

  it('отмена важнее исчерпания бюджета, бюджет важнее обычного отказа', () => {
    assert.equal(
      overallStatus([
        { id: 'a', status: 'failed' },
        { id: 'b', status: 'budget_exceeded' },
        { id: 'c', status: 'canceled' },
      ]),
      'canceled',
    );
    assert.equal(
      overallStatus([
        { id: 'a', status: 'failed' },
        { id: 'b', status: 'budget_exceeded' },
      ]),
      'budget_exceeded',
    );
    assert.equal(overallStatus([{ id: 'a', status: 'skipped' }]), 'success');
  });
});

describe('dependent-job-workspace: число потомков в графе', () => {
  it('линейная цепочка — у каждой работы ровно один потомок', () => {
    const { graph } = buildGraph(
      pipelineOf(`
kind: pipeline
jobs:
  a:
    steps: [${STEP}]
  b:
    needs: [a]
    steps: [${STEP}]
  c:
    needs: [b]
    steps: [${STEP}]
`),
    );
    assert.deepEqual(graph.dependents.get('a'), ['b']);
    assert.deepEqual(graph.dependents.get('b'), ['c']);
    assert.deepEqual(graph.dependents.get('c'), []);
  });

  it('развилка — у общего предшественника два потомка', () => {
    const { graph } = buildGraph(
      pipelineOf(`
kind: pipeline
jobs:
  a:
    steps: [${STEP}]
  b:
    needs: [a]
    steps: [${STEP}]
  c:
    needs: [a]
    steps: [${STEP}]
`),
    );
    assert.deepEqual(graph.dependents.get('a'), ['b', 'c']);
  });

  it('needs: all не считается потомком — иначе цепочка неотличима от развилки', () => {
    const { graph } = buildGraph(
      pipelineOf(`
kind: pipeline
jobs:
  a:
    steps: [${STEP}]
  b:
    needs: [a]
    steps: [${STEP}]
  z:
    needs: all
    steps: [${STEP}]
`),
    );
    assert.deepEqual(graph.dependents.get('a'), ['b']);
    assert.deepEqual(graph.dependents.get('b'), []);
  });
});
