import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { StepcastError } from '../src/core/errors.js';
import { readStatus } from '../src/core/journal/reader.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { resolveLate } from '../src/core/pipeline/late.js';
import type { Job } from '../src/core/pipeline/model.js';
import { createBuiltinKernel } from '../src/parts/builtin.js';
import { pipelineContext } from '../src/parts/pipeline/surface.js';
import { applyContextPlugin, applyDeclarativePlugin } from '../src/core/plugins/load.js';
import { registryFromKernel, stepKindNames, type Registry } from '../src/core/plugins/registry.js';
import type { StepKindContribution } from '../src/core/plugins/pipeline-contract.js';
import { runPipeline } from '../src/core/run/runner.js';
import { buildPipelines } from '../src/ui/pipelines.js';
import { resolveConfig } from '../src/core/config/resolve.js';
import { makeJournalBed, makeProject, seedRun, type Project } from './helpers.js';
import { tempDir } from './tmp.js';

/**
 * Вид шага `deploy-kind`: собственная форма записи (design.md, Решение 1) —
 * узнаётся ключом `deploy`, занимает ключи `deploy` и `to`, разбирает их в
 * поля `{ target, to }`. Имя вида в документе не звучит вовсе — узнавание
 * идёт по занятым ключам, а не по ключу-имени, как у формы `fields`
 * (`test/plugin-step-kind.test.ts`).
 */
function fakeDocumentStepKind(overrides: Partial<StepKindContribution> = {}): StepKindContribution {
  return {
    name: 'deploy-kind',
    title: 'Деплой',
    fields: {
      type: 'object',
      properties: { target: { type: 'string' }, to: {} },
      required: ['target', 'to'],
      additionalProperties: false,
    },
    document: {
      test: (raw) => 'deploy' in raw,
      keys: ['deploy', 'to'],
      schema: {
        type: 'object',
        properties: { deploy: { type: 'string' }, to: {} },
        required: ['deploy', 'to'],
        additionalProperties: false,
      },
      parse: (raw) => ({ target: (raw as Record<string, unknown>).deploy, to: (raw as Record<string, unknown>).to }),
    },
    execute: () => ({ exitCode: 0 }),
    ...overrides,
  };
}

async function documentStepKindRegistry(overrides: Partial<StepKindContribution> = {}): Promise<Registry> {
  const kernel = createBuiltinKernel();
  const registry = registryFromKernel(kernel);
  await applyDeclarativePlugin(
    kernel,
    { name: 'deploy-steps', version: '1.0.0', steps: [fakeDocumentStepKind(overrides)] },
    '/модуль/deploy-steps.js',
  );
  return registry;
}

async function run(
  project: Project,
  registry: Registry,
): Promise<ReturnType<typeof runPipeline>> {
  const runsRoot = tempDir('runs-');
  const config = project.config;
  return runPipeline({
    expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config, registry }),
    config: { ...config, runs: { ...config.runs, root: runsRoot } },
    projectRoot: project.root,
    cwd: project.root,
    registry,
  });
}

describe('step-kind-document-form: узнавание и разбор', () => {
  it('шаг узнан по занятым ключам, поля — результат parse, исполнитель получает их input.fields', async () => {
    const seen: unknown[] = [];
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: форма-документа
jobs:
  build:
    steps:
      - id: probe
        deploy: prod
        to: staging
`,
    });
    const registry = await documentStepKindRegistry({
      execute: (input) => {
        seen.push(input.fields);
        return { exitCode: 0 };
      },
    });

    const { pipeline } = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config, registry });
    const step = pipeline.jobs[0]?.steps[0];
    assert.ok(step !== undefined && step.kind === 'plugin');
    assert.equal(step.name, 'deploy-kind');
    assert.deepEqual(step.fields, { target: 'prod', to: 'staging' });

    const result = await run(project, registry);
    assert.equal(result.status, 'success');
    assert.deepEqual(seen, [{ target: 'prod', to: 'staging' }]);
  });

  it('имя вида в документе не звучит — реестр, диагностика неизвестного вида и карточка витрины называют именно его', async () => {
    const registry = await documentStepKindRegistry();
    assert.ok(registry.steps.has('deploy-kind'));
    assert.ok(stepKindNames(registry).includes('deploy-kind'));

    // Диагностика неизвестного вида: другой, по-настоящему нераспознанный шаг
    // в том же реестре обязана назвать deploy-kind среди доступных.
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: форма-документа
jobs:
  build:
    steps:
      - id: probe
        unknown_kind: что-то
`,
    });
    assert.throws(
      () => expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config, registry }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.hint ?? '', /deploy-kind/);
        return true;
      },
    );

    // Карточка витрины: собрана из реестра, называет объявленное имя вида,
    // хотя это имя нигде в документе не написано.
    const bed = makeJournalBed();
    seedRun(bed.runsRoot, bed.projectRoot, { runId: 'a' });
    mkdirSync(join(bed.projectRoot, '.stepcast', 'plugins'), { recursive: true });
    writeFileSync(
      join(bed.projectRoot, '.stepcast', 'plugins', 'deploy.mjs'),
      `
export default {
  name: 'deploy-steps',
  steps: [
    {
      name: 'deploy-kind',
      title: 'Деплой',
      fields: { type: 'object', properties: { target: { type: 'string' }, to: {} }, required: ['target', 'to'], additionalProperties: false },
      document: {
        test: (raw) => 'deploy' in raw,
        keys: ['deploy', 'to'],
        schema: { type: 'object', properties: { deploy: { type: 'string' }, to: {} }, required: ['deploy', 'to'], additionalProperties: false },
        parse: (raw) => ({ target: raw.deploy, to: raw.to }),
      },
      execute: () => ({ exitCode: 0 }),
    },
  ],
};
`,
    );
    writeFileSync(join(bed.projectRoot, '.stepcast', 'config.yml'), 'plugins: ["./plugins/deploy.mjs"]\n');
    writeFileSync(
      join(bed.projectRoot, 'stepcast.yml'),
      `
version: 1
kind: pipeline
name: витрина-формы-документа
jobs:
  build:
    steps:
      - id: probe
        deploy: prod
        to: staging
`,
    );
    const { config } = resolveConfig({ cwd: bed.home, home: bed.home, projectPath: null });
    const view = (await buildPipelines(bed.runsRoot, config, { home: bed.home })).pipelines[0];

    assert.ok(view !== undefined);
    assert.equal(view.error, undefined, view.error);
    const step = view.jobs[0]?.steps[0];
    assert.equal(step?.kind, 'plugin');
    assert.equal(step?.pluginKindName, 'deploy-kind');
    assert.equal(step?.pluginUnknownReason, undefined);
  });

  it('шаг, узнанный test, но не отвечающий document.schema, — отказ называет вид, поле, адрес шага и владельца', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: форма-документа
jobs:
  build:
    steps:
      - id: probe
        deploy: 42
        to: staging
`,
    });
    const registry = await documentStepKindRegistry();

    assert.throws(
      () => expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config, registry }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /deploy-kind/);
        assert.match(error.message, /deploy/);
        assert.equal(error.at, 'jobs.build.steps.0');
        assert.match(error.hint ?? '', /deploy-steps/);
        return true;
      },
    );
  });

  it('parse, бросивший исключение, даёт отказ разбора с тем же составом, а не необработанное исключение', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: форма-документа
jobs:
  build:
    steps:
      - id: probe
        deploy: boom
        to: staging
`,
    });
    const registry = await documentStepKindRegistry({
      document: {
        test: (raw) => 'deploy' in raw,
        keys: ['deploy', 'to'],
        schema: {
          type: 'object',
          properties: { deploy: { type: 'string' }, to: {} },
          required: ['deploy', 'to'],
          additionalProperties: false,
        },
        parse: (raw) => {
          if ((raw as Record<string, unknown>).deploy === 'boom') throw new Error('деплой недоступен');
          return { target: (raw as Record<string, unknown>).deploy, to: (raw as Record<string, unknown>).to };
        },
      },
    });

    assert.throws(
      () => expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config, registry }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /deploy-kind/);
        assert.match(error.message, /деплой недоступен/);
        assert.equal(error.at, 'jobs.build.steps.0');
        assert.match(error.hint ?? '', /deploy-steps/);
        return true;
      },
    );
  });

  it('подстановка параметра в занятом ключе раскрыта до parse — тип сохранён, а не строка', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: форма-документа
inputs:
  count: { type: int, default: 42 }
jobs:
  build:
    steps:
      - id: probe
        deploy: prod
        to: \${inputs.count}
`,
    });
    const registry = await documentStepKindRegistry();

    const { pipeline } = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config, registry });
    const step = pipeline.jobs[0]?.steps[0];
    assert.ok(step !== undefined && step.kind === 'plugin');
    // Общий проход подстановок вернул бы строку «42» — типизированный проход
    // по занятым ключам сохраняет число.
    assert.deepEqual(step.fields, { target: 'prod', to: 42 });
  });

  it('отложенная подстановка откладывает проверку схемами до попытки: шаг есть в модели, отказ приходит от exec/pluginStep.ts', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: форма-документа
jobs:
  build:
    steps:
      - id: probe
        deploy: prod
        to: \${jobs.plan.output.value}
`,
    });
    const registry = await documentStepKindRegistry();

    // Схема не проверена статически (значение ещё содержит подстановку) — шаг
    // тем не менее существует в модели, а `parse` уже вызван.
    const { pipeline } = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config, registry });
    const step = pipeline.jobs[0]?.steps[0];
    assert.ok(step !== undefined && step.kind === 'plugin');

    const resolved = resolveLate(
      pipeline.jobs[0] as Job,
      {
        jobs: { plan: { status: 'success', output: { value: { ok: true } } } },
        run: { id: 'run-1', dir: '/runs/run-1', workspace: '/work', scratch: '/runs/run-1/scratch' },
        env: {},
      },
      registry,
    );
    const resolvedStep = resolved.steps[0];
    assert.ok(resolvedStep !== undefined && resolvedStep.kind === 'plugin');
    // Значение раскрыто объектом, не строкой.
    assert.deepEqual(resolvedStep.fields, { target: 'prod', to: { ok: true } });
  });

  it('отложенная подстановка, чьё окончательное значение не проходит схему fields, отказывает при попытке — с адресом ключа и составом, как у прежней проверки', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: форма-документа-отложенная
jobs:
  plan:
    output: { from: emit }
    steps:
      - id: emit
        deploy: seed
        to: 7
  build:
    needs: [plan]
    steps:
      - id: probe
        deploy: prod
        to: \${jobs.plan.output.to}
`,
    });
    const registry = await documentStepKindRegistry({
      fields: {
        type: 'object',
        properties: { target: { type: 'string' }, to: { type: 'number' } },
        required: ['target', 'to'],
        additionalProperties: false,
      },
      // Строкой, а не числом: значение, годное для job plan (проходит fields
      // при разборе, число не деферится), становится негодным для job build
      // после позднего раскрытия — вторая проверка ловит это перед попыткой.
      execute: (input) => ({ exitCode: 0, structured: { to: String((input.fields as { to: unknown }).to) } }),
    });

    const result = await run(project, registry);

    assert.equal(result.status, 'failed');
    const step = readStatus(result.journal.paths).jobs.find((job) => job.id === 'build')?.steps[0];
    assert.match(step?.reason ?? '', /deploy-kind/);
    assert.match(step?.reason ?? '', /не соответствуют его схеме/);
  });

  it('непроходимая отложенная подстановка называет адрес шага, а не путь с именем вида', async () => {
    // Имя вида в документе не звучит: `jobs.build.steps.0.deploy-kind` назвал
    // бы путь, которого в файле нет (Решение 6).
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: форма-документа
jobs:
  build:
    steps:
      - id: probe
        deploy: prod
        to: \${jobs.plan.output.value}
`,
    });
    const registry = await documentStepKindRegistry();
    const { pipeline } = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config, registry });

    assert.throws(
      () =>
        resolveLate(
          pipeline.jobs[0] as Job,
          {
            jobs: {},
            run: { id: 'run-1', dir: '/runs/run-1', workspace: '/work', scratch: '/runs/run-1/scratch' },
            env: {},
          },
          registry,
        ),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.at, 'jobs.build.steps.0.to');
        return true;
      },
    );
  });
});

describe('step-kind-document-form: занятые ключи и обязательность', () => {
  /** Вид с ключом-спутником: обязателен только `deploy`, `to` — необязателен (форма `uses:` + `with:`). */
  function companionKind(): Partial<StepKindContribution> {
    return {
      fields: {
        type: 'object',
        properties: { target: { type: 'string' }, to: {} },
        required: ['target'],
        additionalProperties: false,
      },
      document: {
        test: (raw) => 'deploy' in raw,
        keys: ['deploy', 'to'],
        schema: {
          type: 'object',
          properties: { deploy: { type: 'string' }, to: {} },
          required: ['deploy'],
          additionalProperties: false,
        },
        parse: (raw) => {
          const record = raw as Record<string, unknown>;
          return record.to === undefined
            ? { target: record.deploy }
            : { target: record.deploy, to: record.to };
        },
      },
    };
  }

  it('ключ-спутник необязателен: шаг без него разбирается схемой документа, а не отклоняется ветвью', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: ключ-спутник
jobs:
  build:
    steps:
      - id: probe
        deploy: prod
`,
    });
    const registry = await documentStepKindRegistry(companionKind());

    const { pipeline } = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config, registry });
    const step = pipeline.jobs[0]?.steps[0];
    assert.ok(step !== undefined && step.kind === 'plugin');
    assert.deepEqual(step.fields, { target: 'prod' });
  });

  it('оба ключа на месте — разбираются оба', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: ключ-спутник
jobs:
  build:
    steps:
      - id: probe
        deploy: prod
        to: staging
`,
    });
    const registry = await documentStepKindRegistry(companionKind());

    const { pipeline } = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config, registry });
    const step = pipeline.jobs[0]?.steps[0];
    assert.ok(step !== undefined && step.kind === 'plugin');
    assert.deepEqual(step.fields, { target: 'prod', to: 'staging' });
  });

  it('обязательность занятого ключа объявляет схема документа вклада, и отказ приходит её словами', async () => {
    // Тот же вид, но `to` объявлен обязательным: отказ обязан звучать словами
    // вклада, а не дампом объединения ветвей шага (Решение 6).
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: ключ-спутник
jobs:
  build:
    steps:
      - id: probe
        deploy: prod
`,
    });
    const registry = await documentStepKindRegistry();

    assert.throws(
      () => expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config, registry }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /Шаг вида deploy-kind не соответствует его форме/);
        assert.match(error.message, /to/);
        assert.equal(error.at, 'jobs.build.steps.0');
        return true;
      },
    );
  });

  it('ключ рядом с занятыми, которого вид не объявлял, отклонён разбором документа', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: ключ-спутник
jobs:
  build:
    steps:
      - id: probe
        deploy: prod
        to: staging
        unknown_key: 1
`,
    });
    const registry = await documentStepKindRegistry();

    assert.throws(
      () => expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config, registry }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /unknown_key/);
        return true;
      },
    );
  });
});

describe('step-kind-document-form: узнавание не спрашивает о происхождении', () => {
  it('вклад, внесённый register и случайно несущий поле native, узнаётся своей формой, а не падает', async () => {
    // `StepKindContributionSchema` видит только декларативный плагин — вклад,
    // внесённый `ctx.steps.register` напрямую, ею не проверяется. Узнавание
    // спрашивает `hasStepExecutor`, а не наличие поля `native`, поэтому
    // посторонний `native` не доводит до вызова `native.test` на объекте без
    // такого метода.
    const kernel = createBuiltinKernel();
    const registry = registryFromKernel(kernel);
    await applyContextPlugin(
      kernel,
      {
        name: 'native-impostor',
        apply(ctx) {
          (pipelineContext(ctx).steps as { register(name: string, value: unknown): () => void }).register('deploy-kind', {
            ...fakeDocumentStepKind(),
            native: { смысла: 'нет' },
          });
          return () => {};
        },
      },
      '<synthetic>',
    );

    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: самозванец
jobs:
  build:
    steps:
      - id: probe
        deploy: prod
        to: staging
`,
    });

    const { pipeline } = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config, registry });
    const step = pipeline.jobs[0]?.steps[0];
    assert.ok(step !== undefined && step.kind === 'plugin');
    assert.deepEqual(step.fields, { target: 'prod', to: 'staging' });
  });
});
