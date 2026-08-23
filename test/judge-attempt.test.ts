import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createFakeBackend, initLine, resultLine, type FakeBackend } from '../src/core/backend/fake.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { findStepDir, readExpectReports, readStatus } from '../src/core/journal/reader.js';
import { runPipeline, type RunResult } from '../src/core/run/runner.js';
import { makeProject, type Project } from './helpers.js';

/**
 * Прогон с двумя поддельными бэкендами: `fake` играет роль самого шага,
 * остальные имена — судей. Так каждый вызов адресуется своим фиксированным
 * потоком, и вердикт судьи не путается с ответом шага.
 */
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

function stepReason(result: RunResult, job: string, step: string): string | undefined {
  const status = readStatus(result.journal.paths);
  return status.jobs.find((item) => item.id === job)?.steps.find((item) => item.id === step)?.reason;
}

const AGENT_STEP_HARD = `
version: 1
kind: pipeline
name: judge-attempt-agent
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

describe('judge-attempt: жёсткий вердикт агентского шага', () => {
  // Сценарий: «Жёсткий вердикт отклоняет попытку»
  it('hard: true и pass: false отклоняют попытку', async () => {
    const project = makeProject({ 'stepcast.yml': AGENT_STEP_HARD });
    const fake = createFakeBackend({ lines: [initLine(), resultLine({ text: 'план готов' })] });
    const critic = createFakeBackend({
      lines: [resultLine({ structured: { pass: false, reason: 'ретраи не покрыты' } })],
    });

    const result = await run(project, { fake, critic });

    assert.equal(stepStatus(result, 'build', 'plan'), 'failed');
    assert.match(stepReason(result, 'build', 'plan') ?? '', /ретраи не покрыты/);
  });

  it('hard: true и pass: true проводят попытку', async () => {
    const project = makeProject({ 'stepcast.yml': AGENT_STEP_HARD });
    const fake = createFakeBackend({ lines: [initLine(), resultLine({ text: 'план готов' })] });
    const critic = createFakeBackend({
      lines: [resultLine({ structured: { pass: true, reason: 'план полный' } })],
    });

    const result = await run(project, { fake, critic });

    assert.equal(stepStatus(result, 'build', 'plan'), 'success');
  });
});

const AGENT_STEP_SOFT = `
version: 1
kind: pipeline
name: judge-attempt-soft
jobs:
  build:
    steps:
      - id: plan
        agent: fake
        prompt: "Сделай план"
        expect:
          - exit_code: 0
          - judge: "план полный"
            agent: critic
`;

describe('judge-attempt: совещательный вердикт не отклоняет попытку', () => {
  it('pass: false без hard записан как совещательный, но попытка проходит', async () => {
    const project = makeProject({ 'stepcast.yml': AGENT_STEP_SOFT });
    const fake = createFakeBackend({ lines: [initLine(), resultLine({ text: 'план готов' })] });
    const critic = createFakeBackend({
      lines: [resultLine({ structured: { pass: false, reason: 'неполный охват' } })],
    });

    const result = await run(project, { fake, critic });

    assert.equal(stepStatus(result, 'build', 'plan'), 'success');

    const [report] = readExpectReports(result.journal.paths, 'build', 'plan');
    const judgeResult = report?.results.find((item) => item.predicate === 'judge');
    assert.equal(judgeResult?.hard, false);
    assert.equal(judgeResult?.passed, false);
    assert.equal(judgeResult?.detail, 'неполный охват');
  });
});

const AGENT_STEP_TWO_JUDGES = `
version: 1
kind: pipeline
name: judge-attempt-two
jobs:
  build:
    steps:
      - id: plan
        agent: fake
        prompt: "Сделай план"
        expect:
          - exit_code: 0
          - judge: "первое утверждение"
            agent: critic-soft
          - judge: "второе утверждение"
            hard: true
            agent: critic-hard
`;

describe('judge-attempt: непройденный совещательный вердикт не мешает следующему судье', () => {
  it('судья по второму предикату вызывается, несмотря на отказ первого', async () => {
    const project = makeProject({ 'stepcast.yml': AGENT_STEP_TWO_JUDGES });
    const fake = createFakeBackend({ lines: [initLine(), resultLine({ text: 'план готов' })] });
    const criticSoft = createFakeBackend({
      lines: [resultLine({ structured: { pass: false, reason: 'первое не покрыто' } })],
    });
    const criticHard = createFakeBackend({
      lines: [resultLine({ structured: { pass: true, reason: 'второе покрыто' } })],
    });

    const result = await run(project, { fake, 'critic-soft': criticSoft, 'critic-hard': criticHard });

    assert.equal(criticHard.invocations.length, 1, 'второй судья должен быть вызван');
    assert.equal(stepStatus(result, 'build', 'plan'), 'success');
  });
});

const RUN_STEP_JUDGE = `
version: 1
kind: pipeline
name: judge-attempt-run
jobs:
  build:
    steps:
      - id: check
        run: [echo, привет]
        expect:
          - exit_code: 0
          - judge: "вывод корректен"
            hard: true
            agent: critic
`;

const AGENT_STEP_ESCALATION = `
version: 1
kind: pipeline
name: judge-attempt-escalation
jobs:
  build:
    steps:
      - id: plan
        agent: fake
        prompt: "Сделай план"
        attempts:
          max: 2
          escalation:
            - include_failure: true
        expect:
          - exit_code: 0
          - judge: "план полный"
            hard: true
            agent: critic
`;

describe('judge-attempt: причина непройденного вердикта уходит в следующую попытку', () => {
  it('reason жёсткого отказа входит в разбор прошлой неудачи следующей попытки', async () => {
    const project = makeProject({ 'stepcast.yml': AGENT_STEP_ESCALATION });
    const fake = createFakeBackend({ lines: [initLine(), resultLine({ text: 'план готов' })] });
    const critic = createFakeBackend({
      lines: [resultLine({ structured: { pass: false, reason: 'не покрыты крайние случаи' } })],
    });

    const result = await run(project, { fake, critic });

    assert.equal(stepStatus(result, 'build', 'plan'), 'failed');

    const dir = findStepDir(result.journal.paths, 'build', 'plan');
    assert.ok(dir !== undefined);
    const secondPrompt = readFileSync(join(dir, 'prompt.2.txt'), 'utf8');
    assert.match(secondPrompt, /не покрыты крайние случаи/);
  });
});

describe('judge-attempt: судья на шаге командной строки', () => {
  it('вызывается, а местом структурированного вывода служит stdout', async () => {
    const project = makeProject({ 'stepcast.yml': RUN_STEP_JUDGE });
    // Командному шагу собственный бэкенд не нужен: он не агентский. Имя
    // фигурирует только затем, чтобы adapterFor знал, кому какой ответ дать.
    const fake = createFakeBackend({ lines: [] });
    const critic = createFakeBackend({
      lines: [resultLine({ structured: { pass: true, reason: 'вывод совпал' } })],
    });

    const result = await run(project, { fake, critic });

    assert.equal(critic.invocations.length, 1);
    assert.equal(stepStatus(result, 'build', 'check'), 'success');

    const dir = findStepDir(result.journal.paths, 'build', 'check');
    assert.ok(dir !== undefined);
    const prompt = readFileSync(join(dir, 'judge-1', 'prompt.txt'), 'utf8');
    assert.match(prompt, /echo привет/);
    assert.match(prompt, /привет/);
  });
});
