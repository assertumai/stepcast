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

const EFFORT_CONFIG = `
defaults:
  effort: medium
`;

const TIER_EFFORT_CONFIG = `
backends:
  claude:
    model_tiers:
      deep:
        model: claude-deep
        effort: high
      review:
        model: claude-review
        effort: xhigh
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
  it('normalizes legacy strings and custom object tiers in backend configuration', () => {
    const project = makeProject({
      '.stepcast/config.yml': `
backends:
  codex:
    model_tiers:
      balance: gpt-6-sol
      review:
        model: gpt-6-astra
        effort: high
`,
    });
    const { config } = resolveConfig({ cwd: project.root, home: project.home });
    assert.deepEqual(config.backends.codex?.modelTiers, {
      balance: { model: 'gpt-6-sol' },
      review: { model: 'gpt-6-astra', effort: 'high' },
    });
  });

  it('rejects malformed custom tier names and incomplete object selections', () => {
    for (const modelTiers of [
      'Review: gpt-6-sol',
      '9fast: gpt-6-sol',
      'review: { effort: high }',
      'review: { model: gpt-6-sol, effort: " " }',
    ]) {
      assert.throws(
        () => expand(JOB, `backends:\n  claude:\n    model_tiers:\n      ${modelTiers}\n`),
        (error: unknown) => error instanceof StepcastError,
      );
    }
  });

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

  it('selects model and effort together from a tier bundle', () => {
    const step = selection(`model_tier: deep\n${JOB}`, TIER_EFFORT_CONFIG);
    assert.equal(step.model, 'claude-deep');
    assert.equal(step.effort, 'high');
  });

  it('does not keep tier effort when an explicit model overrides the tier', () => {
    const step = selection(`model_tier: deep\nmodel: explicit\n${JOB}`, TIER_EFFORT_CONFIG);
    assert.equal(step.model, 'explicit');
    assert.equal(step.effort, undefined);
  });

  it('lets an explicit effort override the selected tier effort', () => {
    const step = selection(`model_tier: deep\neffort: low\n${JOB}`, TIER_EFFORT_CONFIG);
    assert.equal(step.model, 'claude-deep');
    assert.equal(step.effort, 'low');
  });

  it('rejects empty effort produced by pipeline input interpolation', () => {
    assert.throws(() => expand(`
inputs:
  level: { type: string, default: "   " }
effort: \${inputs.level}
${JOB}`), (error: unknown) =>
      error instanceof StepcastError && /effort/.test(error.message) && error.at === 'effort');
  });

  it('rejects empty effort produced by reusable-job parameter interpolation', () => {
    const files = {
      'job.yml': `kind: job
params:
  level: { type: string, required: true }
effort: \${params.level}
steps:
  - id: ask
    prompt: hello
`,
    };
    assert.throws(() => expand(`jobs:
  work:
    uses: ./job.yml
    with:
      level: " "
`, TIERS_CONFIG, files), (error: unknown) =>
      error instanceof StepcastError && /effort/.test(error.message) && error.at === 'jobs.work.effort');
  });

  it('inherits effort independently through config, pipeline, job and step', () => {
    const { pipeline, effortOrigins } = expand(`
effort: high
jobs:
  inherited:
    steps:
      - id: pipeline
        prompt: hello
  overridden:
    effort: low
    steps:
      - id: job
        prompt: hello
      - id: step
        effort: xhigh
        prompt: hello
`, EFFORT_CONFIG);
    assert.deepEqual(pipeline.jobs.flatMap((job) => job.steps.map((raw) => asAgent(raw).effort)), ['high', 'low', 'xhigh']);
    assert.deepEqual(effortOrigins.get('inherited/pipeline'), { layer: 'pipeline' });
    assert.deepEqual(effortOrigins.get('overridden/job'), { layer: 'job' });
    assert.deepEqual(effortOrigins.get('overridden/step'), { layer: 'step' });

    const configStep = selection(JOB, EFFORT_CONFIG);
    assert.equal(configStep.effort, 'medium');
  });

  it('identifies tier effort provenance', () => {
    const { effortOrigins } = expand(`model_tier: deep\n${JOB}`, `
backends:
  claude:
    model_tiers:
      deep:
        model: claude-deep
        effort: high
`);
    assert.deepEqual(effortOrigins.get('work/ask'), {
      layer: 'tier', backend: 'claude', tier: 'deep', tierLayer: 'pipeline',
    });
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

  it('resolves built-in and custom tier parameters in reusable jobs', () => {
    const files = { 'job.yml': 'kind: job\nparams:\n  tier:\n    type: string\n    required: true\nmodel_tier: ${params.tier}\nsteps:\n  - id: ask\n    prompt: hello\n' };
    const yaml = 'jobs:\n  work:\n    uses: ./job.yml\n    with:\n      tier: deep\n';
    assert.equal(asAgent(expand(yaml, TIERS_CONFIG, files).pipeline.jobs[0]!.steps[0]!).model, 'claude-deep');
    assert.equal(asAgent(expand(yaml.replace('tier: deep', 'tier: nope'), TIERS_CONFIG, files).pipeline.jobs[0]!.steps[0]!).model, 'sonnet');
  });

  it('accepts custom tiers and rejects malformed tier maps', () => {
    assert.equal(selection(`model_tier: nope\n${JOB}`).model, 'sonnet');
    assert.equal(selection(`model_tier: typo\n${JOB}`, 'backends:\n  claude:\n    model_tiers:\n      typo: opus\n').model, 'opus');
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

  it('includes effective effort in the executable lock', () => {
    const project = makeProject({ 'pipeline.yml': `effort: low\n${JOB}`, '.stepcast/config.yml': '' });
    const { config } = resolveConfig({ cwd: project.root, home: project.home });
    const opts = { pipelinePath: project.path('pipeline.yml'), config };
    const low = serializeLock(expandPipeline(opts).pipeline);
    project.write('pipeline.yml', `effort: high\n${JOB}`);
    assert.notEqual(low, serializeLock(expandPipeline(opts).pipeline));
  });
});
