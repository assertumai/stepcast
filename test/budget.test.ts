import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createFakeBackend, initLine, resultLine, type FakeBackend } from '../src/core/backend/fake.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { readStatus, readUsage } from '../src/core/journal/reader.js';
import { runPipeline, type RunResult } from '../src/core/run/runner.js';
import { makeProject, type Project } from './helpers.js';

/** См. test/judge-attempt.test.ts: один поддельный бэкенд на объявленное имя. */
async function run(
  project: Project,
  backends: Readonly<Record<string, FakeBackend>>,
): Promise<RunResult> {
  const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
  return runPipeline({
    expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
    config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
    projectRoot: project.root,
    cwd: project.root,
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
