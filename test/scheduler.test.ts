import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { overallStatus, schedule, type JobOutcome } from '../src/core/run/scheduler.js';
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
