import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createFakeBackend, resultLine, type FakeBackend } from '../src/parts/pipeline/backend/fake.js';
import { StepcastError } from '../src/kernel/errors.js';
import { findStepDir, readExpectReports, readStatus, readUsageSoft } from '../src/parts/pipeline/run/journal/reader.js';
import { expandPipeline } from '../src/parts/pipeline/document/expand.js';
import { resolveLate } from '../src/parts/pipeline/document/late.js';
import { serializeLock } from '../src/parts/pipeline/document/lock.js';
import type { Job } from '../src/parts/pipeline/document/model.js';
import { computeStepKey } from '../src/parts/pipeline/run/stepKey.js';
import { builtinRegistry, createBuiltinKernel } from '../src/parts/builtin.js';
import type { ContributionService } from '../src/kernel/kernel.js';
import { applyContextPlugin, applyDeclarativePlugin } from '../src/kernel/load.js';
import { registryFromKernel, stepKindNames, type Registry } from '../src/kernel/registry.js';
import type { StepKindContribution, StepKindInput } from '../src/parts/pipeline/contract.js';
import { DECLARATIVE_CONTRIBUTION_FIELDS } from '../src/parts/pipeline/contract.js';
import { lintPipeline } from '../src/parts/pipeline/domain/lint.js';
import { resolveConfig } from '../src/parts/pipeline/config/resolve.js';
import { projectKey, runPaths } from '../src/parts/pipeline/run/journal/paths.js';
import { runPipeline } from '../src/parts/pipeline/run/runner.js';
import { buildPipelines } from '../src/parts/ui/pipelines.js';
import { buildSnapshot } from '../src/parts/ui/snapshot.js';
import { makeJournalBed, makeProject, seedRun, type Project } from './helpers.js';
import { tempDir } from './tmp.js';
import { writeDecisionRecord } from '../src/parts/pipeline/run/journal/writer.js';
import type { RunPaths } from '../src/parts/pipeline/run/journal/paths.js';

/**
 * Вид шага `http_probe`: поле `url` (строка), необязательное поле
 * `expect_status` (число). Достаточно, чтобы пройти весь путь от разбора
 * документа до исполнения и записи в журнал, без настоящей сети — `execute`
 * подменяется на сценарий теста.
 */
function fakeStepKind(overrides: Partial<StepKindContribution> = {}): StepKindContribution {
  return {
    name: 'http_probe',
    title: 'Проба HTTP',
    fields: {
      type: 'object',
      properties: { url: { type: 'string' }, expect_status: { type: 'number' } },
      required: ['url'],
      additionalProperties: false,
    },
    execute: () => ({ exitCode: 0, text: 'ok' }),
    ...overrides,
  };
}

async function stepKindRegistry(overrides: Partial<StepKindContribution> = {}): Promise<Registry> {
  const kernel = createBuiltinKernel();
  const registry = registryFromKernel(kernel);
  await applyDeclarativePlugin(kernel, { name: 'example-steps', version: '1.0.0', steps: [fakeStepKind(overrides)] }, '/модуль/example-steps.js', DECLARATIVE_CONTRIBUTION_FIELDS);
  return registry;
}

function pipelineWith(stepYaml: string, extra = ''): string {
  return `
version: 1
kind: pipeline
name: плагинный-вид-шага
jobs:
  build:
${extra}
    steps:
      - id: probe
${stepYaml}
`;
}

async function run(
  project: Project,
  registry: Registry,
  options: { readonly pipelinePath?: string; readonly backends?: Readonly<Record<string, FakeBackend>> } = {},
): Promise<ReturnType<typeof runPipeline>> {
  const runsRoot = tempDir('runs-');
  const config = project.config;
  const backends = options.backends;
  return runPipeline({
    expanded: expandPipeline({ pipelinePath: project.path(options.pipelinePath ?? 'stepcast.yml'), config, registry }),
    config: { ...config, runs: { ...config.runs, root: runsRoot } },
    projectRoot: project.root,
    cwd: project.root,
    registry,
    ...(backends === undefined
      ? {}
      : {
          adapterFor: (name: string) => {
            const backend = backends[name];
            assert.ok(backend !== undefined, `нет поддельного бэкенда для «${name}»`);
            return backend.adapter;
          },
        }),
  });
}

describe('step-kinds-registry: реестр видов шага', () => {
  it('вид шага плагина в реестре с владельцем', async () => {
    const registry = await stepKindRegistry();
    assert.ok(registry.steps.has('http_probe'));
    assert.equal(registry.owners.get('steps:http_probe'), 'example-steps');
  });

  it('встроенные виды значатся в реестре, владельцем — встроенный', () => {
    const registry = builtinRegistry();
    // Не полный список: `decision` (`user-decision-steps`) тоже встроенный вид,
    // но внесён строкой дерева, а не внутренней формой document, — эти четыре
    // остаются ядром, проверяемым здесь, а не единственным содержимым реестра.
    for (const name of ['agent', 'run', 'script', 'uses']) {
      assert.ok(stepKindNames(registry).includes(name));
      assert.equal(registry.owners.get(`steps:${name}`), 'встроенный');
    }
  });

  it('конфликт двух плагинов на одно имя вида — отказ называет обоих', async () => {
    const kernel = createBuiltinKernel();
    await applyDeclarativePlugin(kernel, { name: 'first', steps: [fakeStepKind()] }, '<first>', DECLARATIVE_CONTRIBUTION_FIELDS);
    await assert.rejects(
      () => applyDeclarativePlugin(kernel, { name: 'second', steps: [fakeStepKind()] }, '<second>', DECLARATIVE_CONTRIBUTION_FIELDS),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /first/);
        assert.match(error.message, /second/);
        return true;
      },
    );
  });

  it('плагин не занимает имя встроенного вида', async () => {
    const kernel = createBuiltinKernel();
    await assert.rejects(
      () => applyDeclarativePlugin(kernel, { name: 'greedy', steps: [fakeStepKind({ name: 'run' })] }, '<synthetic>', DECLARATIVE_CONTRIBUTION_FIELDS),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /run/);
        assert.match(error.message, /встроенного вида/);
        return true;
      },
    );
  });

  it('имя вида шага не вправе совпасть с ключом общей части', async () => {
    const kernel = createBuiltinKernel();
    await assert.rejects(
      () => applyDeclarativePlugin(kernel, { name: 'greedy', steps: [fakeStepKind({ name: 'expect' })] }, '<synthetic>', DECLARATIVE_CONTRIBUTION_FIELDS),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /expect/);
        assert.match(error.message, /общей части/);
        return true;
      },
    );
  });

  it('имя вида шага не вправе совпасть с ключом встроенного вида (prompt)', async () => {
    const kernel = createBuiltinKernel();
    await assert.rejects(
      () => applyDeclarativePlugin(kernel, { name: 'greedy', steps: [fakeStepKind({ name: 'prompt' })] }, '<synthetic>', DECLARATIVE_CONTRIBUTION_FIELDS),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /prompt/);
        assert.match(error.message, /agent/);
        return true;
      },
    );
  });

  it('занятый ключ вида шага не вправе совпасть с ключом встроенного вида (prompt)', async () => {
    const kernel = createBuiltinKernel();
    await assert.rejects(
      () =>
        applyDeclarativePlugin(
          kernel,
          {
            name: 'greedy',
            steps: [
              fakeStepKind({
                name: 'deploy-kind',
                document: {
                  test: (raw) => 'deploy' in raw,
                  keys: ['deploy', 'prompt'],
                  schema: { type: 'object', properties: {}, required: [] },
                  parse: (raw) => raw,
                },
              }),
            ],
          },
          '<synthetic>',
          DECLARATIVE_CONTRIBUTION_FIELDS,
        ),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /prompt/);
        assert.match(error.message, /agent/);
        return true;
      },
    );
  });

  it('имя вида с объявленной формой документа проверяется наравне с занятыми ключами', async () => {
    // Занятые ключи вида с собственной формой записи имени не содержат, но
    // спека требует отвергать при регистрации «имя вида шага **и** всякий
    // объявленный им занятый ключ»: именем `expect` или `prompt` вид звался бы
    // в реестре, диагностике и витрине именем чужого ключа.
    const documentOf = (key: string) => ({
      test: (raw: Record<string, unknown>) => key in raw,
      keys: [key],
      schema: { type: 'object', properties: {}, required: [] },
      parse: (raw: unknown) => raw,
    });

    await assert.rejects(
      () =>
        applyDeclarativePlugin(
          createBuiltinKernel(),
          { name: 'greedy', steps: [fakeStepKind({ name: 'expect', document: documentOf('deploy') })] },
          '<synthetic>',
          DECLARATIVE_CONTRIBUTION_FIELDS,
        ),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.message, 'Имя вида шага expect занято ключом общей части шага');
        return true;
      },
    );

    await assert.rejects(
      () =>
        applyDeclarativePlugin(
          createBuiltinKernel(),
          { name: 'greedy', steps: [fakeStepKind({ name: 'prompt', document: documentOf('deploy') })] },
          '<synthetic>',
          DECLARATIVE_CONTRIBUTION_FIELDS,
        ),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.message, 'Имя вида шага prompt занято ключом встроенного вида шага agent');
        return true;
      },
    );
  });

  it('имя вида с формой документа не вправе совпасть с ключом, занятым другим видом', async () => {
    const kernel = createBuiltinKernel();
    await applyDeclarativePlugin(
      kernel,
      {
        name: 'first',
        steps: [
          fakeStepKind({
            name: 'first-kind',
            document: {
              test: (raw) => 'shared' in raw,
              keys: ['shared'],
              schema: { type: 'object', properties: {}, required: [] },
              parse: (raw) => raw,
            },
          }),
        ],
      },
      '<first>',
      DECLARATIVE_CONTRIBUTION_FIELDS,
    );

    // Вид без собственной формы записи занимает ключ-имя: `shared` уже занят
    // соседом, и в документе два вида боролись бы за один ключ.
    await assert.rejects(
      () =>
        applyDeclarativePlugin(kernel, { name: 'second', steps: [fakeStepKind({ name: 'shared' })] }, '<second>', DECLARATIVE_CONTRIBUTION_FIELDS),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /shared/);
        assert.match(error.message, /first-kind/);
        return true;
      },
    );
  });

  it('два вида шага на один занятый ключ — отказ называет ключ и обоих претендентов', async () => {
    const kernel = createBuiltinKernel();
    const documentOf = (key: string) => ({
      test: (raw: Record<string, unknown>) => key in raw,
      keys: [key],
      schema: { type: 'object', properties: {}, required: [] },
      parse: (raw: unknown) => raw,
    });
    await applyDeclarativePlugin(
      kernel,
      { name: 'first', steps: [fakeStepKind({ name: 'first-kind', document: documentOf('shared') })] },
      '<first>',
      DECLARATIVE_CONTRIBUTION_FIELDS,
    );
    await assert.rejects(
      () =>
        applyDeclarativePlugin(
          kernel,
          { name: 'second', steps: [fakeStepKind({ name: 'second-kind', document: documentOf('shared') })] },
          '<second>',
          DECLARATIVE_CONTRIBUTION_FIELDS,
        ),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /shared/);
        assert.match(error.message, /first-kind/);
        assert.match(error.message, /second-kind/);
        return true;
      },
    );
  });

  it('сервис steps нельзя завести плагином', async () => {
    const kernel = createBuiltinKernel();
    await assert.rejects(
      () =>
        applyContextPlugin(
          kernel,
          {
            name: 'greedy',
            apply(ctx) {
              const dispose = ctx.provide('steps');
              ctx.set('steps', {});
              return dispose;
            },
          },
          '<synthetic>',
        ),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /steps/);
        assert.match(error.message, /ядру/);
        return true;
      },
    );
  });

  it('снятие области снимает вид шага, освобождает имя, и ядро помнит прежнего владельца', async () => {
    const kernel = createBuiltinKernel();
    const fiber = await applyDeclarativePlugin(kernel, { name: 'example-steps', steps: [fakeStepKind()] }, '<synthetic>', DECLARATIVE_CONTRIBUTION_FIELDS);
    const registry = registryFromKernel(kernel);
    assert.ok(registry.steps.has('http_probe'));

    await fiber.dispose();

    assert.equal(registry.steps.has('http_probe'), false);
    const service = kernel.ctx.steps as ContributionService<unknown>;
    assert.equal(service.formerOwner('http_probe'), 'example-steps');

    // Освобождённое имя достаётся следующему плагину.
    await applyDeclarativePlugin(kernel, { name: 'other', steps: [fakeStepKind()] }, '<other>', DECLARATIVE_CONTRIBUTION_FIELDS);
    assert.equal(registry.owners.get('steps:http_probe'), 'other');
  });
});

describe('step-kinds-registry: разбор документа', () => {
  it('шаг плагинного вида раскрывается именем вида и полями', async () => {
    const project = makeProject({
      'stepcast.yml': pipelineWith(`        http_probe:
          url: https://example.org/health
          expect_status: 200
        expect: [{ exit_code: 0 }]`),
    });
    const { pipeline } = expandPipeline({
      pipelinePath: project.path('stepcast.yml'),
      config: project.config,
      registry: await stepKindRegistry(),
    });
    const step = pipeline.jobs[0]?.steps[0];
    assert.ok(step !== undefined && step.kind === 'plugin');
    assert.equal(step.name, 'http_probe');
    assert.deepEqual(step.fields, { url: 'https://example.org/health', expect_status: 200 });
  });

  it('значение не по схеме вклада отклоняется разбором, называя плагин', async () => {
    const project = makeProject({
      'stepcast.yml': pipelineWith(`        http_probe:
          expect_status: 200`),
    });
    const registry = await stepKindRegistry();
    assert.throws(
      () => expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config, registry }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /http_probe/);
        assert.match(error.hint ?? '', /example-steps/);
        return true;
      },
    );
  });

  it('неизвестный ключ вида шага отклоняется, называя ключ и перечень доступных', async () => {
    const project = makeProject({
      'stepcast.yml': pipelineWith(`        http_prob:
          url: https://example.org`),
    });
    const registry = await stepKindRegistry();
    assert.throws(
      () => expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config, registry }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /http_prob/);
        assert.match(error.hint ?? '', /agent, decision, http_probe, run, script, uses/);
        assert.equal(error.at, 'jobs.build.steps.0');
        return true;
      },
    );
  });

  it('шаг без ключа вида отклоняется, даже когда плагинный вид зарегистрирован', async () => {
    const project = makeProject({
      'stepcast.yml': pipelineWith('        expect: [{ exit_code: 0 }]'),
    });
    const registry = await stepKindRegistry();
    assert.throws(
      () => expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config, registry }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /не называет ни один известный вид/);
        return true;
      },
    );
  });

  it('пайплайн после снятия области плагина отказывает разбором, называя плагина', async () => {
    const kernel = createBuiltinKernel();
    const registry = registryFromKernel(kernel);
    const fiber = await applyDeclarativePlugin(kernel, { name: 'example-steps', steps: [fakeStepKind()] }, '<synthetic>', DECLARATIVE_CONTRIBUTION_FIELDS);
    const project = makeProject({
      'stepcast.yml': pipelineWith(`        http_probe:
          url: https://example.org`),
    });
    // Пока плагин на месте, тот же документ разбирается.
    expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config, registry });

    await fiber.dispose();

    assert.throws(
      () => expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config, registry }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /http_probe/);
        assert.match(error.message, /example-steps/);
        return true;
      },
    );
  });

  it('поля вида шага раскрываются типизированно: число остаётся числом, объект — объектом', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: типизированные-поля
inputs:
  status: { type: int, default: 204 }
jobs:
  build:
    steps:
      - id: probe
        http_probe:
          url: https://example.org
          expect_status: \${inputs.status}
`,
    });
    const registry = await stepKindRegistry();

    const { pipeline } = expandPipeline({
      pipelinePath: project.path('stepcast.yml'),
      config: project.config,
      registry,
    });

    const step = pipeline.jobs[0]?.steps[0];
    assert.ok(step !== undefined && step.kind === 'plugin');
    // Общий проход подстановок вернул бы строку «204», и схема вклада,
    // требующая число, отказала бы исправному документу.
    assert.deepEqual(step.fields, { url: 'https://example.org', expect_status: 204 });
  });

  it('плагинное поле входит в ключ шага', async () => {
    const registry = await stepKindRegistry();
    const key = (url: string): string => {
      const project = makeProject({
        'stepcast.yml': pipelineWith(`        http_probe:
          url: ${url}`),
      });
      const { pipeline } = expandPipeline({
        pipelinePath: project.path('stepcast.yml'),
        config: project.config,
        registry,
      });
      const job = pipeline.jobs[0]!;
      return computeStepKey({
        lockHash: 'лок',
        jobId: job.id,
        step: job.steps[0]!,
        inputsFingerprint: 'дерево',
        backendCommand: undefined,
        upstream: [],
      });
    };
    assert.notEqual(key('https://a.example'), key('https://b.example'));
  });

  it('отложенная подстановка объектом доходит до поля объектом, а не строкой', async () => {
    const project = makeProject({
      'stepcast.yml': pipelineWith(`        http_probe:
          url: https://example.org
          payload: \${jobs.plan.output.body}`),
    });
    const registry = await stepKindRegistry({
      fields: {
        type: 'object',
        properties: { url: { type: 'string' }, payload: { type: 'object' } },
        required: ['url'],
        additionalProperties: false,
      },
    });
    const { pipeline } = expandPipeline({
      pipelinePath: project.path('stepcast.yml'),
      config: project.config,
      registry,
    });

    const resolved = resolveLate(pipeline.jobs[0] as Job, {
      jobs: { plan: { status: 'success', output: { body: { ok: true, items: ['a'] } } } },
      run: { id: 'run-1', dir: '/runs/run-1', workspace: '/work', scratch: '/runs/run-1/scratch' },
      env: {},
    });

    const step = resolved.steps[0];
    assert.ok(step !== undefined && step.kind === 'plugin');
    assert.deepEqual(step.fields, {
      url: 'https://example.org',
      payload: { ok: true, items: ['a'] },
    });
  });

  it('замок печатает вид шага одним ключом с полями', async () => {
    const project = makeProject({
      'stepcast.yml': pipelineWith(`        http_probe:
          url: https://example.org`),
    });
    const { pipeline } = expandPipeline({
      pipelinePath: project.path('stepcast.yml'),
      config: project.config,
      registry: await stepKindRegistry(),
    });
    const lock = serializeLock(pipeline);
    assert.match(lock, /http_probe:/);
    assert.match(lock, /url: https:\/\/example\.org/);
  });
});

describe('step-kinds-registry: линт', () => {
  it('диагностика хука вклада печатается с путём поля', async () => {
    const project = makeProject({
      'stepcast.yml': pipelineWith(`        http_probe:
          url: http://insecure.example`),
    });
    const registry = await stepKindRegistry({
      lint: (fields) =>
        typeof fields === 'object' && fields !== null && String((fields as { url?: unknown }).url).startsWith('http://')
          ? [{ severity: 'warning' as const, message: 'адрес без TLS' }]
          : [],
    });
    const diagnostics = lintPipeline(
      expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config, registry }),
      { config: project.config, registry },
    );
    const own = diagnostics.find((item) => item.message === 'адрес без TLS');
    assert.ok(own !== undefined, JSON.stringify(diagnostics));
    assert.match(own.at ?? '', /http_probe/);
  });

  it('вид шага, снятый вместе с плагином, отказывает при исполнении, называя плагина', async () => {
    const kernel = createBuiltinKernel();
    const registry = registryFromKernel(kernel);
    const fiber = await applyDeclarativePlugin(kernel, { name: 'example-steps', steps: [fakeStepKind()] }, '<synthetic>', DECLARATIVE_CONTRIBUTION_FIELDS);
    const project = makeProject({
      'stepcast.yml': pipelineWith(`        http_probe:
          url: https://example.org`),
    });
    const expanded = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config, registry });

    await fiber.dispose();

    const result = await runPipeline({
      expanded,
      config: { ...project.config, runs: { ...project.config.runs, root: tempDir('runs-') } },
      projectRoot: project.root,
      cwd: project.root,
      registry,
    });

    assert.equal(result.status, 'failed');
    const step = readStatus(result.journal.paths).jobs[0]?.steps[0];
    assert.match(step?.reason ?? '', /example-steps/);
  });
});

describe('step-kinds-registry: витрина', () => {
  const PLUGIN_MODULE = `
export default {
  name: 'example-steps',
  steps: [
    {
      name: 'http_probe',
      title: 'Проба HTTP',
      fields: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'адрес запроса' },
          expect_status: { type: 'number' },
        },
        required: ['url'],
      },
      output: { type: 'object' },
      execute: () => ({ exitCode: 0 }),
    },
  ],
};
`;

  const PIPELINE = `
version: 1
kind: pipeline
name: витрина-плагинного-шага
jobs:
  build:
    steps:
      - id: probe
        http_probe:
          url: https://example.org
`;

  it('карточка пайплайна собрана из реестра: название вклада, поля с подписями, признак выхода', async () => {
    const bed = makeJournalBed();
    seedRun(bed.runsRoot, bed.projectRoot, { runId: 'a' });
    mkdirSync(join(bed.projectRoot, '.stepcast', 'plugins'), { recursive: true });
    writeFileSync(join(bed.projectRoot, '.stepcast', 'plugins', 'steps.mjs'), PLUGIN_MODULE);
    writeFileSync(
      join(bed.projectRoot, '.stepcast', 'config.yml'),
      'plugins: ["./plugins/steps.mjs"]\n',
    );
    writeFileSync(join(bed.projectRoot, 'stepcast.yml'), PIPELINE);
    const { config } = resolveConfig({ cwd: bed.home, home: bed.home, projectPath: null });

    const view = (await buildPipelines(bed.runsRoot, config, { home: bed.home })).pipelines[0];

    assert.ok(view !== undefined);
    assert.equal(view.error, undefined, view.error);
    const step = view.jobs[0]?.steps[0];
    assert.equal(step?.kind, 'plugin');
    assert.equal(step?.pluginKindName, 'http_probe');
    assert.equal(step?.pluginKindTitle, 'Проба HTTP');
    assert.equal(step?.pluginHasOutput, true);
    assert.deepEqual(
      step?.pluginFields?.map((field) => [field.name, field.required, field.description]),
      [
        ['url', true, 'адрес запроса'],
        ['expect_status', false, undefined],
      ],
    );
    assert.equal(step?.pluginUnknownReason, undefined);
  });

  it('прогон с видом шага, которого больше нет, показан из замка с названной причиной', async () => {
    const registry = await stepKindRegistry();
    const project = makeProject({ 'stepcast.yml': PIPELINE });
    const lock = serializeLock(
      expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config, registry }).pipeline,
    );

    const bed = makeJournalBed();
    const journal = seedRun(bed.runsRoot, bed.projectRoot, {
      runId: 'run-плагин',
      lock,
      jobs: [
        {
          id: 'build',
          status: 'success',
          steps: [
            {
              id: 'probe',
              index: 1,
              kind: 'plugin',
              key: 'k1',
              status: 'success',
              plugin_step: { name: 'http_probe', plugin: 'example-steps' },
              attempts: [
                {
                  attempt: 1,
                  status: 'success',
                  started_at: '2026-08-01T00:00:00.000Z',
                  finished_at: '2026-08-01T00:00:01.000Z',
                },
              ],
            },
          ],
        },
      ],
    });

    // Плагина в этом процессе нет вовсе — снимок строится по журналу.
    const step = buildSnapshot(journal.paths, projectKey(bed.projectRoot)).jobs[0]?.steps[0];

    assert.equal(step?.kind, 'plugin');
    assert.equal(step?.pluginKindName, 'http_probe');
    assert.equal(step?.pluginPlugin, 'example-steps');
    assert.deepEqual(step?.pluginFields, { url: 'https://example.org' });
    assert.match(step?.pluginNote ?? '', /from the run lock/);
    assert.match(step?.pluginNote ?? '', /example-steps/);
    // Остальная карточка цела: статус, попытки и расход на месте.
    assert.equal(step?.status, 'success');
    assert.equal(step?.attempts, 1);
  });
});

describe('step-kinds-registry: исполнение', () => {
  it('сквозной прогон: исполнитель вызван с полями, попытка успешна', async () => {
    const seen: StepKindInput[] = [];
    const project = makeProject({
      'stepcast.yml': pipelineWith(`        http_probe:
          url: https://example.org/health
          expect_status: 200
        expect: [{ exit_code: 0 }]`),
    });
    const registry = await stepKindRegistry({
      execute: (input) => {
        seen.push(input);
        return { exitCode: 0, text: 'ответ получен', structured: { status: 200 } };
      },
    });

    const result = await run(project, registry);

    assert.equal(result.status, 'success');
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0]?.fields, { url: 'https://example.org/health', expect_status: 200 });
    assert.equal(seen[0]?.attempt, 1);
    assert.equal(seen[0]?.job.id, 'build');

    const step = readStatus(result.journal.paths).jobs[0]?.steps[0];
    assert.equal(step?.kind, 'plugin');

    // Имя файла — то же, что у командного шага: первая попытка пишет
    // `stdout.log` (его читают `stepcast logs` и витрина), а не `stdout.1.log`.
    const stepDir = findStepDir(result.journal.paths, 'build', 'probe');
    const stdout = readFileSync(join(stepDir as string, 'stdout.log'), 'utf8');
    assert.equal(stdout, 'ответ получен');

    // Структурированный выход исполнителя — выход шага: он записан в
    // output.json и опубликован работой.
    const output = JSON.parse(readFileSync(join(stepDir as string, 'output.json'), 'utf8')) as unknown;
    assert.deepEqual(output, { status: 200 });
  });

  it('вторая попытка пишет stdout.2.log, не затирая первую', async () => {
    let calls = 0;
    const project = makeProject({
      'stepcast.yml': pipelineWith(`        http_probe:
          url: https://example.org
        expect: [{ exit_code: 0 }]
        attempts: { max: 2 }`),
    });
    const registry = await stepKindRegistry({
      execute: () => {
        calls += 1;
        return calls === 1 ? { exitCode: 1, text: 'первая' } : { exitCode: 0, text: 'вторая' };
      },
    });

    const result = await run(project, registry);

    const stepDir = findStepDir(result.journal.paths, 'build', 'probe') as string;
    assert.equal(readFileSync(join(stepDir, 'stdout.log'), 'utf8'), 'первая');
    assert.equal(readFileSync(join(stepDir, 'stdout.2.log'), 'utf8'), 'вторая');
  });

  it('структурированный выход без схемы output доходит до выхода работы', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: выход-плагинного-шага
jobs:
  build:
    output: { from: probe }
    steps:
      - id: probe
        http_probe:
          url: https://example.org
`,
    });
    const registry = await stepKindRegistry({
      execute: () => ({ exitCode: 0, structured: { status: 200, body: { ok: true } } }),
    });

    const result = await run(project, registry);

    assert.equal(result.status, 'success');
    const artifact = JSON.parse(
      readFileSync(join(result.journal.paths.artifacts, 'build.json'), 'utf8'),
    ) as unknown;
    assert.deepEqual(artifact, { status: 200, body: { ok: true } });
  });

  it('первая попытка проваливает жёсткий предикат — вторая попытка исполняется с номером 2', async () => {
    let calls = 0;
    const project = makeProject({
      'stepcast.yml': pipelineWith(`        http_probe:
          url: https://example.org
        expect: [{ exit_code: 0 }]
        attempts: { max: 2 }`),
    });
    const registry = await stepKindRegistry({
      execute: () => {
        calls += 1;
        return { exitCode: calls === 1 ? 1 : 0 };
      },
    });

    const result = await run(project, registry);

    assert.equal(result.status, 'success');
    assert.equal(calls, 2);
  });

  it('исключение исполнителя — непройденная попытка с названной причиной, а не крушение прогона', async () => {
    const project = makeProject({
      'stepcast.yml': pipelineWith(`        http_probe:
          url: https://example.org`),
    });
    const registry = await stepKindRegistry({
      execute: () => {
        throw new Error('сеть недоступна');
      },
    });

    const result = await run(project, registry);

    assert.equal(result.status, 'failed');
    const step = readStatus(result.journal.paths).jobs[0]?.steps[0];
    assert.match(step?.reason ?? '', /сеть недоступна/);
  });

  it('таймаут шага отказывает попытку, а сигнал взводится', async () => {
    let aborted = false;
    const project = makeProject({
      'stepcast.yml': pipelineWith(`        http_probe:
          url: https://example.org
        timeout: 0.05s
        attempts: { max: 1 }`),
    });
    const registry = await stepKindRegistry({
      execute: (input) =>
        new Promise((resolve) => {
          input.signal.addEventListener('abort', () => {
            aborted = true;
          });
          setTimeout(() => resolve({ exitCode: 0 }), 500);
        }),
    });

    const result = await run(project, registry);

    assert.equal(result.status, 'failed');
    assert.equal(aborted, true);
  });

  it('выход не по схеме output отказывает попытку жёстким предикатом', async () => {
    const project = makeProject({
      'stepcast.yml': pipelineWith(`        http_probe:
          url: https://example.org`),
    });
    const registry = await stepKindRegistry({
      output: { type: 'object', properties: { status: { type: 'number' } }, required: ['status'] },
      execute: () => ({ exitCode: 0, structured: { status: 'не число' } }),
    });

    const result = await run(project, registry);

    assert.equal(result.status, 'failed');
    const stepDir = findStepDir(result.journal.paths, 'build', 'probe');
    const report = JSON.parse(readFileSync(join(stepDir as string, 'expect.json'), 'utf8')) as {
      results: { predicate: string; passed: boolean }[];
    };
    assert.ok(report.results.some((item) => item.predicate === 'step_output' && !item.passed));
  });

  it('файл, записанный исполнителем, ложится в каталог попытки, а не рядом с ним', async () => {
    let written: string | undefined;
    let stepDir: string | undefined;
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: каталог-попытки
jobs:
  build:
    until:
      max_iterations: 1
      check: [{ exit_code: 0 }]
    steps:
      - id: probe
        http_probe:
          url: https://example.org
`,
    });
    const registry = await stepKindRegistry({
      execute: (input) => {
        stepDir = input.stepDir;
        written = input.log.file('заметка.txt', 'что-то важное');
        return { exitCode: 0 };
      },
    });

    const result = await run(project, registry);

    assert.equal(result.status, 'success');
    assert.ok(written !== undefined && stepDir !== undefined);
    assert.equal(written, join(stepDir, 'заметка.txt'));
    assert.equal(readFileSync(written, 'utf8'), 'что-то важное');
  });

  it('судья в expect вычисляется вторым проходом и решает исход шага', async () => {
    const project = makeProject({
      'stepcast.yml': pipelineWith(`        http_probe:
          url: https://example.org
        expect:
          - exit_code: 0
          - judge: "ответ похож на здоровый"
            hard: true
            agent: critic`),
    });
    const registry = await stepKindRegistry({
      execute: () => ({ exitCode: 0, text: 'ответ получен', structured: { status: 500 } }),
    });
    const critic = createFakeBackend({
      lines: [resultLine({ structured: { pass: false, reason: 'статус 500' }, tokensIn: 7, tokensOut: 1 })],
    });

    const result = await run(project, registry, { backends: { critic } });

    assert.equal(result.status, 'failed');
    const [report] = readExpectReports(result.journal.paths, 'build', 'probe');
    const judge = report?.results.find((item) => item.predicate === 'judge');
    assert.ok(judge !== undefined, JSON.stringify(report));
    assert.equal(judge.passed, false);
    assert.match(judge.detail ?? '', /статус 500/);
    // Задание, отданное судье, называет вклад: `describeStepTask` берёт его
    // название из реестра.
    const prompt = readFileSync(
      join(findStepDir(result.journal.paths, 'build', 'probe') as string, 'judge-1', 'prompt.txt'),
      'utf8',
    );
    assert.match(prompt, /Проба HTTP/);
  });

  it('предикат script на плагинном шаге вычисляется, а не падает без контракта вызова', async () => {
    const project = makeProject({
      'проверка.mjs': 'process.exit(0);\n',
      'stepcast.yml': pipelineWith(`        http_probe:
          url: https://example.org
        expect:
          - script: ./проверка.mjs`),
    });
    const registry = await stepKindRegistry();

    const result = await run(project, registry);

    assert.equal(result.status, 'success');
    const [report] = readExpectReports(result.journal.paths, 'build', 'probe');
    assert.ok(report?.results.some((item) => item.predicate === 'script' && item.passed), JSON.stringify(report));
  });

  it('таймаут шага числится причиной остановки timeout, а не отказом expect', async () => {
    const project = makeProject({
      'stepcast.yml': pipelineWith(`        http_probe:
          url: https://example.org
        timeout: 0.05s
        attempts: { max: 1 }`),
    });
    const registry = await stepKindRegistry({
      execute: () => new Promise((resolve) => setTimeout(() => resolve({ exitCode: 0 }), 500)),
    });

    const result = await run(project, registry);

    const step = readStatus(result.journal.paths).jobs[0]?.steps[0];
    assert.equal(step?.cause, 'timeout');
    assert.match(step?.reason ?? '', /Шаг не завершился за 50 мс/);
  });

  it('потолок прогона, перейденный расходом исполнителя, останавливает прогон', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: потолок-прогона
budget:
  tokens: 5
jobs:
  build:
    steps:
      - id: probe
        http_probe:
          url: https://example.org
`,
    });
    const registry = await stepKindRegistry({
      execute: () => ({
        exitCode: 0,
        usage: {
          backend: 'http_probe',
          tokens_in: 40,
          tokens_out: 0,
          cache_read: 0,
          cache_write: 0,
          wallclock_ms: 5,
        },
      }),
    });

    const result = await run(project, registry);

    // Сам шаг дошёл до конца успехом — и всё же прогон остановлен потолком
    // прогона: защёлка взводится исходом шага, а он обязан отдать превышение
    // наружу.
    assert.equal(readStatus(result.journal.paths).jobs[0]?.steps[0]?.status, 'success');
    assert.equal(result.status, 'budget_exceeded');
    const exceeded = readStatus(result.journal.paths).budget.exceeded;
    assert.ok(exceeded !== undefined);
    assert.equal(exceeded.step, 'probe');
  });

  it('расход, сообщённый исполнителем, попадает в отчёт расхода прогона', async () => {
    const project = makeProject({
      'stepcast.yml': pipelineWith(`        http_probe:
          url: https://example.org`),
    });
    const registry = await stepKindRegistry({
      execute: () => ({
        exitCode: 0,
        usage: {
          backend: 'http_probe',
          tokens_in: 10,
          tokens_out: 5,
          cache_read: 0,
          cache_write: 0,
          wallclock_ms: 5,
        },
      }),
    });

    const result = await run(project, registry);

    assert.equal(result.status, 'success');
    const { summary } = readUsageSoft(result.journal.paths);
    const stepUsage = summary?.jobs.build?.steps.probe;
    assert.ok(stepUsage !== undefined);
    assert.ok((stepUsage.billable_tokens ?? 0) > 0);
  });
});

describe('step-kinds-registry: waits и способность ожидания (user-decision-steps)', () => {
  it('вклад с waits не отказывает по таймауту шага, дольше которого он работает', async () => {
    const project = makeProject({
      'stepcast.yml': pipelineWith(`        http_probe:
          url: https://example.org
        timeout: 0.05s
        attempts: { max: 1 }`),
    });
    const registry = await stepKindRegistry({
      waits: true,
      execute: () => new Promise((resolve) => setTimeout(() => resolve({ exitCode: 0 }), 300)),
    });

    const result = await run(project, registry);

    assert.equal(result.status, 'success');
  });

  it('вклад без waits по-прежнему отказывает по таймауту тем же текстом, что и раньше', async () => {
    const project = makeProject({
      'stepcast.yml': pipelineWith(`        http_probe:
          url: https://example.org
        timeout: 0.05s
        attempts: { max: 1 }`),
    });
    const registry = await stepKindRegistry({
      execute: () => new Promise((resolve) => setTimeout(() => resolve({ exitCode: 0 }), 300)),
    });

    const result = await run(project, registry);

    assert.equal(result.status, 'failed');
    const step = readStatus(result.journal.paths).jobs[0]?.steps[0];
    assert.equal(step?.cause, 'timeout');
    assert.match(step?.reason ?? '', /Шаг не завершился за 50 мс/);
  });

  it('вид без waits не получает способности ожидания во входе исполнителя', async () => {
    let sawDecision: boolean | undefined;
    const project = makeProject({
      'stepcast.yml': pipelineWith(`        http_probe:
          url: https://example.org`),
    });
    const registry = await stepKindRegistry({
      execute: (input) => {
        sawDecision = input.decision !== undefined;
        return { exitCode: 0 };
      },
    });

    const result = await run(project, registry);

    assert.equal(result.status, 'success');
    assert.equal(sawDecision, false);
  });

  it('исполнитель, проглотивший отказ обещания decision.request, не меняет судьбы прогона', async () => {
    const runsRoot = tempDir('runs-');
    const project = makeProject({
      'stepcast.yml': pipelineWith(`        http_probe:
          url: https://example.org`),
    });
    const registry = await stepKindRegistry({
      waits: true,
      execute: async (input) => {
        try {
          await input.decision?.request({ outcomes: { deny: { effect: 'reject' } }, prompt: 'q' });
        } catch {
          // Вклад ловит и глотает отказ обещания — судьба прогона уже решена
          // защёлкой движка, и притворяться успехом здесь бессмысленно.
        }
        return { exitCode: 0, text: 'вклад считает себя успешным' };
      },
    });

    let paths: RunPaths | undefined;
    const promise = runPipeline({
      expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config, registry }),
      config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
      registry,
      decisionPollIntervalMs: 20,
      onEvent: (event) => {
        if (event.kind !== 'run.started') return;
        paths = runPaths(runsRoot, projectKey(project.root), event.run_id);
      },
    });

    const started = Date.now();
    while (paths === undefined) {
      if (Date.now() - started > 5000) throw new Error('прогон не начался вовремя');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    while (readStatus(paths).awaiting === undefined || (readStatus(paths).awaiting?.length ?? 0) === 0) {
      if (Date.now() - started > 5000) throw new Error('ожидание не объявлено вовремя');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const waitId = readStatus(paths).awaiting?.[0]?.wait_id as string;
    writeDecisionRecord(paths, waitId, { outcome: 'deny', reason: 'отказано' });

    const result = await promise;
    // Вклад вернул успех, но защёлка эффекта решения останавливает прогон
    // раньше, чем управление дошло до этого возврата (design.md, решение 5).
    assert.equal(result.status, 'canceled');
  });
});
