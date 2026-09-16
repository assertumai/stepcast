import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { stepDecisionContribution } from '../src/steps/decision/index.js';
import { lintDecisionFields } from '../src/steps/decision/fields.js';
import { builtinRegistry } from '../src/parts/builtin.js';
import { lintPipeline } from '../src/core/lint.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { serializeLock } from '../src/core/pipeline/lock.js';
import type { StepKindDecisionRequest, StepKindDecisionResult, StepKindInput } from '../src/core/plugins/contract.js';
import { makeProject } from './helpers.js';

function baseInput(fields: unknown = { prompt: 'продолжить?', outcomes: { approve: 'continue' } }): Omit<StepKindInput, 'decision'> {
  return {
    fields,
    step: { id: 'gate', index: 1, timeoutMs: 30 * 60_000 },
    job: { id: 'build' },
    attempt: 1,
    env: {},
    cwd: '/tmp',
    stepDir: '/tmp/step',
    signal: new AbortController().signal,
    log: { note: () => {}, file: () => '/tmp/step/x' },
    ctx: {} as StepKindInput['ctx'],
  };
}

function fakeInput(
  decide: (request: StepKindDecisionRequest) => Promise<StepKindDecisionResult> = async () => ({
    outcome: 'approve',
    effect: 'continue',
    by: 'user',
  }),
  fields?: unknown,
): StepKindInput {
  return { ...baseInput(fields), decision: { request: decide } };
}

describe('step-decision: реестр видов шага', () => {
  it('строка step-decision заводит вид decision во встроенном дереве', () => {
    const registry = builtinRegistry();
    assert.ok(registry.steps.has('decision'));
    assert.equal(registry.owners.get('steps:decision'), 'встроенный');
  });
});

describe('step-decision: поля и линт', () => {
  it('пустой перечень outcomes отклонён линтом', () => {
    const diagnostics = lintDecisionFields({ prompt: 'q', outcomes: {} }, { file: 'p.yml', at: 'jobs.build.steps.0.decision', cwd: '/' });
    assert.ok(diagnostics.some((d) => d.severity === 'error' && /пустой перечень/.test(d.message)));
  });

  it('on_expire вне перечня outcomes отклонён', () => {
    const diagnostics = lintDecisionFields(
      { prompt: 'q', outcomes: { approve: 'continue' }, deadline: '1h', on_expire: 'nope' },
      { file: 'p.yml', at: 'jobs.build.steps.0.decision', cwd: '/' },
    );
    assert.ok(diagnostics.some((d) => d.severity === 'error' && /nope/.test(d.message)));
  });

  it('on_expire эффектом restart отклонён', () => {
    const diagnostics = lintDecisionFields(
      { prompt: 'q', outcomes: { redo: 'restart' }, deadline: '1h', on_expire: 'redo' },
      { file: 'p.yml', at: 'jobs.build.steps.0.decision', cwd: '/' },
    );
    assert.ok(diagnostics.some((d) => d.severity === 'error' && /restart/.test(d.message)));
  });

  it('deadline без on_expire отклонён', () => {
    const diagnostics = lintDecisionFields(
      { prompt: 'q', outcomes: { approve: 'continue' }, deadline: '1h' },
      { file: 'p.yml', at: 'jobs.build.steps.0.decision', cwd: '/' },
    );
    assert.ok(diagnostics.some((d) => d.severity === 'error' && /on_expire/.test(d.message)));
  });

  it('исход с эффектом вне закрытого набора отклонён', () => {
    const diagnostics = lintDecisionFields(
      { prompt: 'q', outcomes: { approve: 'continue', maybe: 'postpone' } },
      { file: 'p.yml', at: 'jobs.build.steps.0.decision', cwd: '/' },
    );
    assert.ok(
      diagnostics.some((d) => d.severity === 'error' && /maybe/.test(d.message) && /postpone/.test(d.message)),
      JSON.stringify(diagnostics),
    );
  });

  it('негодная длительность срока отклонена линтом, а не исключением посреди прогона', () => {
    const diagnostics = lintDecisionFields(
      { prompt: 'q', outcomes: { approve: 'continue' }, deadline: '4hh', on_expire: 'approve' },
      { file: 'p.yml', at: 'jobs.build.steps.0.decision', cwd: '/' },
    );
    assert.ok(
      diagnostics.some((d) => d.severity === 'error' && /deadline/.test(d.message)),
      JSON.stringify(diagnostics),
    );
  });

  it('исправное объявление проходит без диагностик', () => {
    const diagnostics = lintDecisionFields(
      { prompt: 'q', outcomes: { approve: 'continue', deny: { effect: 'reject', label: 'Отклонить' } } },
      { file: 'p.yml', at: 'jobs.build.steps.0.decision', cwd: '/' },
    );
    assert.deepEqual(diagnostics, []);
  });
});

describe('step-decision: исполнитель', () => {
  it('отдаёт структурированный выход для эффекта continue', async () => {
    const outcome = await stepDecisionContribution.execute(fakeInput());
    assert.deepEqual(outcome.structured, { outcome: 'approve', effect: 'continue', by: 'user' });
  });

  it('передаёт вопрос, исходы и срок в decision.request', async () => {
    let seen: StepKindDecisionRequest | undefined;
    await stepDecisionContribution.execute(
      fakeInput(
        async (request) => {
          seen = request;
          return { outcome: 'approve', effect: 'continue', by: 'user' };
        },
        {
          prompt: 'слить в main?',
          outcomes: { approve: 'continue', deny: { effect: 'reject', label: 'Отклонить' } },
          deadline: '1h',
          on_expire: 'approve',
        },
      ),
    );
    assert.ok(seen !== undefined);
    assert.equal(seen.prompt, 'слить в main?');
    assert.deepEqual(seen.outcomes, {
      approve: { effect: 'continue' },
      deny: { effect: 'reject', label: 'Отклонить' },
    });
    assert.equal(seen.deadlineMs, 3_600_000);
    assert.equal(seen.onExpire, 'approve');
  });

  it('без decision во входе отказывает названно, а не крушением', async () => {
    await assert.rejects(
      async () => stepDecisionContribution.execute(baseInput() as StepKindInput),
      /способность ожидания/,
    );
  });
});

describe('step-decision: раскрытие документа', () => {
  it('шаг decision раскрывается и печатается в замок одним ключом с полями', () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: решение
jobs:
  build:
    steps:
      - id: gate
        decision:
          prompt: продолжить?
          outcomes:
            approve: continue
`,
    });
    const { pipeline } = expandPipeline({
      pipelinePath: project.path('stepcast.yml'),
      config: project.config,
      registry: builtinRegistry(),
    });
    const step = pipeline.jobs[0]?.steps[0];
    assert.ok(step !== undefined && step.kind === 'plugin');
    assert.equal(step.name, 'decision');
    assert.deepEqual(step.fields, { prompt: 'продолжить?', outcomes: { approve: 'continue' } });

    const lock = serializeLock(pipeline);
    assert.match(lock, /decision:/);
    assert.match(lock, /prompt: продолжить\?/);
  });

  it('пайплайн с негодным объявлением decision отвергается stepcast lint без единой исполненной работы', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: решение-негодная
jobs:
  build:
    steps:
      - id: gate
        decision:
          prompt: продолжить?
          outcomes: {}
`,
    });
    const registry = builtinRegistry();
    const diagnostics = lintPipeline(
      expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config, registry }),
      { config: project.config, registry },
    );
    assert.ok(diagnostics.some((d) => d.severity === 'error' && /пустой перечень/.test(d.message)));
  });

  it('timeout на ожидающем шаге предупреждён, а attempts > 1 отклонён', () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: решение-таймаут
jobs:
  build:
    steps:
      - id: gate
        decision:
          prompt: продолжить?
          outcomes:
            approve: continue
        timeout: 5m
        attempts: { max: 2 }
`,
    });
    const registry = builtinRegistry();
    const diagnostics = lintPipeline(
      expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config, registry }),
      { config: project.config, registry },
    );
    assert.ok(diagnostics.some((d) => d.severity === 'warning' && /timeout/.test(d.message)));
    assert.ok(diagnostics.some((d) => d.severity === 'error' && /attempts/.test(d.message)));
  });
});
