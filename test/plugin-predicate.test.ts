import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { StepcastError } from '../src/core/errors.js';
import { evaluatePredicates } from '../src/core/expect/evaluate.js';
import { findStepDir, readStatus } from '../src/core/journal/reader.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { builtinRegistry } from '../src/core/plugins/builtin.js';
import { addPlugin, type Registry } from '../src/core/plugins/registry.js';
import type { PredicateContribution } from '../src/core/plugins/contract.js';
import { runPipeline } from '../src/core/run/runner.js';
import { computeStepKey } from '../src/core/run/stepKey.js';
import { lintPipeline } from '../src/core/lint.js';
import { makeProject, type Project } from './helpers.js';

/**
 * Плагин с одним предикатом: значение — строка, проверка проходит, если
 * текст шага её содержит. Достаточно, чтобы пройти весь путь от разбора
 * документа до записи результата в журнал.
 */
function pluginRegistry(overrides: Partial<PredicateContribution> = {}): Registry {
  const registry = builtinRegistry();
  addPlugin(
    registry,
    {
      name: 'example',
      version: '1.0.0',
      predicates: [
        {
          name: 'text_has',
          schema: { type: 'string', minLength: 1 },
          evaluate: (value, input) => ({
            predicate: 'text_has',
            passed: input.text.includes(String(value)),
            hard: true,
            expected: value,
            actual: input.text,
          }),
          ...overrides,
        } as PredicateContribution,
      ],
    },
    '/модуль/example.js',
  );
  return registry;
}

function pipelineWith(expect: string): string {
  return `
version: 1
kind: pipeline
name: плагинный-предикат
jobs:
  build:
    steps:
      - id: say
        run: [sh, -c, 'echo всё готово']
        expect: ${expect}
`;
}

async function run(project: Project, registry: Registry): Promise<ReturnType<typeof runPipeline>> {
  const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
  const config = project.config;
  return runPipeline({
    expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config, registry }),
    config: { ...config, runs: { ...config.runs, root: runsRoot } },
    projectRoot: project.root,
    cwd: project.root,
    registry,
  });
}

describe('plugin-contributions: предикат плагина в документе', () => {
  it('разбирается, вычисляется и попадает в журнал под своим именем', async () => {
    const project = makeProject({ 'stepcast.yml': pipelineWith('[{ exit_code: 0 }, { text_has: "готово" }]') });

    const result = await run(project, pluginRegistry());

    assert.equal(result.status, 'success');

    const stepDir = findStepDir(result.journal.paths, 'build', 'say');
    const report = JSON.parse(readFileSync(join(stepDir as string, 'expect.json'), 'utf8')) as {
      results: { predicate: string; passed: boolean }[];
    };
    assert.deepEqual(
      report.results.map((item) => item.predicate),
      ['exit_code', 'text_has'],
    );
    assert.equal(report.results[1]?.passed, true);
  });

  it('непройденный предикат плагина отклоняет попытку', async () => {
    const project = makeProject({ 'stepcast.yml': pipelineWith('[{ text_has: "провалено" }]') });

    const result = await run(project, pluginRegistry());

    assert.equal(result.status, 'failed');
    const record = readStatus(result.journal.paths).jobs[0]?.steps[0];
    assert.equal(record?.status, 'failed');

    const stepDir = findStepDir(result.journal.paths, 'build', 'say');
    const report = JSON.parse(readFileSync(join(stepDir as string, 'expect.json'), 'utf8')) as {
      results: { predicate: string; passed: boolean }[];
    };
    assert.equal(report.results[0]?.predicate, 'text_has');
    assert.equal(report.results[0]?.passed, false);
  });

  it('значение не по схеме вклада отклоняется разбором документа', () => {
    const project = makeProject({ 'stepcast.yml': pipelineWith('[{ text_has: 42 }]') });

    assert.throws(
      () =>
        expandPipeline({
          pipelinePath: project.path('stepcast.yml'),
          config: project.config,
          registry: pluginRegistry(),
        }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /Значение предиката text_has не соответствует его схеме/);
        assert.match(error.at ?? '', /expect\.0\.text_has/);
        return true;
      },
    );
  });

  it('неизвестный ключ предиката отклоняется с перечнем доступных', () => {
    const project = makeProject({ 'stepcast.yml': pipelineWith('[{ exit_cod: 0 }]') });

    assert.throws(
      () =>
        expandPipeline({
          pipelinePath: project.path('stepcast.yml'),
          config: project.config,
          registry: pluginRegistry(),
        }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        // Перечень называет и встроенные, и плагинные — пользователь не обязан
        // знать, что из этого чем предоставлено.
        assert.match(error.message, /не соответствует схеме|Неизвестный предикат/);
        return true;
      },
    );
  });

  it('предикат плагина без плагина в документе не принимается', () => {
    const project = makeProject({ 'stepcast.yml': pipelineWith('[{ text_has: "готово" }]') });

    assert.throws(() => expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }));
  });

  it('асинхронный вычислитель дожидается результата', async () => {
    const project = makeProject({ 'stepcast.yml': pipelineWith('[{ text_has: "готово" }]') });
    const registry = pluginRegistry({
      evaluate: async (value, input) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          predicate: 'text_has',
          passed: input.text.includes(String(value)),
          hard: true,
        };
      },
    });

    const result = await run(project, registry);

    assert.equal(result.status, 'success');
  });

  it('отказ вычислителя — непройденный предикат с названной причиной, а не крушение', async () => {
    const registry = pluginRegistry({
      evaluate: () => {
        throw new Error('внешняя система недоступна');
      },
    });

    const [result] = await evaluatePredicates(
      [{ kind: 'plugin', name: 'text_has', value: 'готово' }],
      { exitCode: 0, text: 'всё готово', structured: undefined, cwd: process.cwd(), env: {} },
      registry,
    );

    assert.equal(result?.passed, false);
    assert.equal(result?.hard, true);
    assert.match(result?.detail ?? '', /внешняя система недоступна/);
  });

  it('предикат без вклада в реестре не проходит и называет причину', async () => {
    const [result] = await evaluatePredicates(
      [{ kind: 'plugin', name: 'text_has', value: 'готово' }],
      { exitCode: 0, text: 'всё готово', structured: undefined, cwd: process.cwd(), env: {} },
      builtinRegistry(),
    );

    assert.equal(result?.passed, false);
    assert.match(result?.detail ?? '', /не предоставлен ни одним загруженным плагином/);
  });

  it('значение предиката входит в ключ шага', () => {
    const registry = pluginRegistry();
    const key = (value: string): string => {
      const project = makeProject({ 'stepcast.yml': pipelineWith(`[{ text_has: "${value}" }]`) });
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

    assert.notEqual(key('готово'), key('другое'));
  });

  it('предикат плагина в until.check вычисляется и линтится тем же хуком', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: цикл
jobs:
  build:
    until:
      max_iterations: 2
      check: [{ text_has: "готово" }]
    budget: { tokens: 100k }
    steps:
      - id: say
        run: [sh, -c, 'echo всё готово']
        expect: [{ exit_code: 0 }]
`,
    });
    // Проверка цикла вычисляется с пустым текстом и нулевым кодом возврата
    // (`evaluateCheck`): она относится к состоянию работы, а не к выводу
    // последнего шага, — поэтому предикат цикла на текст шага полагаться не
    // может, и вклад здесь смотрит на то, что цикл ему действительно даёт.
    const seen: { text: string; cwd: string }[] = [];
    const registry = pluginRegistry({
      lint: () => [{ severity: 'warning', message: 'проверка цикла осмотрена' }],
      evaluate: (_value, input) => {
        seen.push({ text: input.text, cwd: input.cwd });
        return { predicate: 'text_has', passed: input.cwd.length > 0, hard: true };
      },
    });

    // Линт зовёт хук вклада и для предиката цикла: место объявления на
    // статическую проверку влиять не должно.
    const diagnostics = lintPipeline(
      expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config, registry }),
      { config: project.config, registry },
    );
    const own = diagnostics.find((item) => item.message === 'проверка цикла осмотрена');
    assert.ok(own !== undefined, JSON.stringify(diagnostics));
    assert.match(own.at ?? '', /until\.check\.0\.text_has/);

    const result = await run(project, registry);
    assert.equal(result.status, 'success');
    // Вклад позван один раз — после первой итерации, — и получил рабочий
    // каталог работы при пустом тексте.
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.text, '');
    assert.ok((seen[0]?.cwd.length ?? 0) > 0);
  });

  it('статическая проверка вклада печатается линтом', () => {
    const project = makeProject({ 'stepcast.yml': pipelineWith('[{ text_has: "готово" }]') });
    const registry = pluginRegistry({
      lint: (value) =>
        String(value).length < 10 ? [{ severity: 'warning', message: 'слишком короткое ожидание' }] : [],
    });

    const diagnostics = lintPipeline(
      expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config, registry }),
      { config: project.config, registry },
    );

    const own = diagnostics.find((item) => item.message === 'слишком короткое ожидание');
    assert.ok(own !== undefined, JSON.stringify(diagnostics));
    assert.equal(own.severity, 'warning');
    assert.match(own.at ?? '', /expect\.0\.text_has/);
  });
});
