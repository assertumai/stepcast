import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import codexPlugin from '../src/parts/backends/codex/index.js';
import { resolveConfig } from '../src/parts/pipeline/config/resolve.js';
import { StepcastError } from '../src/kernel/errors.js';
import { expandPipeline } from '../src/parts/pipeline/document/expand.js';
import { serializeLock } from '../src/parts/pipeline/document/lock.js';
import { asAgent, makeProject } from './helpers.js';

const TIERS_CONFIG = `
backends:
  claude:
    model_tiers:
      max: claude-max
      deep: claude-deep
      balance: claude-balance
      fast: claude-fast
      mini: claude-mini
  codex:
    default_model: gpt-5.6-terra
    model_tiers:
      max: codex-max
      deep: codex-deep
      balance: codex-balance
      fast: codex-fast
      mini: codex-mini
`;

function expand(yaml: string, configYaml = TIERS_CONFIG, files: Record<string, string> = {}) {
  const project = makeProject({ 'pipeline.yml': yaml, '.stepcast/config.yml': configYaml, ...files });
  const { config } = resolveConfig({ cwd: project.root, home: project.home });
  return expandPipeline({ pipelinePath: project.path('pipeline.yml'), config });
}

const JOB = 'jobs:\n  work:\n    steps:\n      - id: ask\n        prompt: hello\n';

function selection(yaml: string, configYaml = TIERS_CONFIG) {
  const expanded = expand(yaml, configYaml);
  return asAgent(expanded.pipeline.jobs[0]!.steps[0]!);
}

describe('agent model tiers', () => {
  it('uses the requested built-in Claude and bundled Codex defaults', () => {
    assert.equal(selection(JOB, '').model, 'sonnet');
    assert.equal(codexPlugin.backends?.codex?.defaults?.default_model, 'gpt-5.6-terra');
  });

  it('uses the configured default agent when no pipeline level selects one', () => {
    const step = selection(JOB, `${TIERS_CONFIG}\ndefaults:\n  agent: codex\n`);
    assert.equal(step.agent, 'codex');
    assert.equal(step.model, 'gpt-5.6-terra');
  });

  for (const tier of ['max', 'deep', 'balance', 'fast', 'mini']) {
    it(`selects ${tier} for the final agent`, () => {
      const step = selection(`agent: codex\nmodel_tier: ${tier}\n${JOB}`);
      assert.equal(step.agent, 'codex');
      assert.equal(step.model, `codex-${tier}`);
    });
  }

  it('supports pipeline defaults and falls back for unmapped tiers', () => {
    assert.equal(selection(`defaults:\n  model_tier: deep\n${JOB}`).model, 'claude-deep');
    assert.equal(selection(`model_tier: deep\n${JOB}`, '').model, 'sonnet');
  });

  it('inherits each field independently through pipeline, job and step', () => {
    const { pipeline, modelOrigins } = expand(`
agent: claude
model_tier: balance
jobs:
  work:
    agent: codex
    model_tier: deep
    steps:
      - id: job
        prompt: hello
      - id: step
        agent: claude
        model_tier: fast
        prompt: hello
      - id: inherited-tier
        agent: claude
        prompt: hello
`);
    assert.deepEqual(pipeline.jobs[0]!.steps.map((step) => {
      const agent = asAgent(step);
      return [agent.agent, agent.model];
    }), [['codex', 'codex-deep'], ['claude', 'claude-fast'], ['claude', 'claude-deep']]);
    assert.deepEqual(modelOrigins.get('work/job'), { layer: 'tier', backend: 'codex', tier: 'deep', tierLayer: 'job' });
  });

  it('explicit models override tiers, including a closer tier', () => {
    const step = selection(`model: explicit\nmodel_tier: max\n${JOB.replace('prompt: hello', 'model_tier: mini\n        prompt: hello')}`);
    assert.equal(step.model, 'explicit');
    assert.equal(selection(`model_tier: deep\n${JOB}`, `${TIERS_CONFIG}\ndefaults:\n  model: legacy\n`).model, 'legacy');
  });

  it('job and step models override their parents and identify their origin', () => {
    const { pipeline, modelOrigins } = expand(`
model: pipeline-model
jobs:
  work:
    model: job-model
    steps:
      - id: inherited
        prompt: hello
      - id: own
        model: step-model
        prompt: hello
`);
    assert.equal(asAgent(pipeline.jobs[0]!.steps[0]!).model, 'job-model');
    assert.equal(asAgent(pipeline.jobs[0]!.steps[1]!).model, 'step-model');
    assert.deepEqual(modelOrigins.get('work/inherited'), { layer: 'job' });
    assert.deepEqual(modelOrigins.get('work/own'), { layer: 'step' });
  });

  it('pipeline root values override the existing defaults syntax', () => {
    const step = selection(`defaults:\n  agent: codex\n  model: old\n  model_tier: mini\nagent: claude\nmodel: new\nmodel_tier: max\n${JOB}`);
    assert.equal(step.agent, 'claude');
    assert.equal(step.model, 'new');
  });

  it('uses job-file selections and allows overrides at the uses site', () => {
    const result = expand(`
model_tier: balance
jobs:
  original:
    uses: ./job.yml
  override:
    uses: ./job.yml
    agent: codex
    model_tier: fast
  explicit:
    uses: ./job.yml
    model: site-model
`, TIERS_CONFIG, { 'job.yml': 'kind: job\nagent: claude\nmodel_tier: deep\nsteps:\n  - id: ask\n    prompt: hello\n' });
    assert.deepEqual(result.pipeline.jobs.map((job) => asAgent(job.steps[0]!).model), ['claude-deep', 'codex-fast', 'site-model']);
  });

  it('resolves tier parameters in reusable jobs and validates the result', () => {
    const files = { 'job.yml': 'kind: job\nparams:\n  tier:\n    type: string\n    required: true\nmodel_tier: ${params.tier}\nsteps:\n  - id: ask\n    prompt: hello\n' };
    const yaml = 'jobs:\n  work:\n    uses: ./job.yml\n    with:\n      tier: deep\n';
    assert.equal(asAgent(expand(yaml, TIERS_CONFIG, files).pipeline.jobs[0]!.steps[0]!).model, 'claude-deep');
    assert.throws(() => expand(yaml.replace('tier: deep', 'tier: nope'), TIERS_CONFIG, files), /model_tier/);
  });

  it('rejects unknown tiers and malformed tier maps', () => {
    assert.throws(() => expand(`model_tier: nope\n${JOB}`), /model_tier/);
    assert.throws(() => expand(JOB, 'backends:\n  claude:\n    model_tiers:\n      typo: opus\n'), (error: unknown) => error instanceof StepcastError && (error.at ?? '').includes('model_tiers'));
    assert.throws(() => expand(JOB, 'backends:\n  claude:\n    model_tiers:\n      deep: " "\n'), (error: unknown) => error instanceof StepcastError && (error.at ?? '').includes('model_tiers'));
  });

  it('locks the effective model without retaining tier selection in executable steps', () => {
    // Use the same source file so selection syntax is the only changing input.
    const project = makeProject({ 'pipeline.yml': `model_tier: deep\n${JOB}`, '.stepcast/config.yml': TIERS_CONFIG });
    const { config } = resolveConfig({ cwd: project.root, home: project.home });
    const opts = { pipelinePath: project.path('pipeline.yml'), config };
    const fromTier = expandPipeline(opts).pipeline;
    project.write('pipeline.yml', `model: claude-deep\n${JOB}`);
    assert.equal(serializeLock(fromTier), serializeLock(expandPipeline(opts).pipeline));
  });
});
