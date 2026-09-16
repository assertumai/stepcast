import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';

import { validateAgainstSchema } from '../src/core/expect/evaluate.js';
import { validateStepKindFields } from '../src/core/pipeline/expand.js';
import {
  buildPublishedSchemas,
  pluginPredicateEntries,
  pluginStepKindEntries,
} from '../src/core/pipeline/published-schema.js';
import type { PredicateContribution, StepcastPlugin, StepKindContribution } from '../src/core/plugins/contract.js';
import { applyDeclarativePlugin } from '../src/core/plugins/load.js';
import { registryFromKernel, type Registry } from '../src/core/plugins/registry.js';
import { createPipelineKernel } from './helpers.js';

/**
 * Образец `examples/plugins/typed` (design.md изменения `plugin-typed-helpers`,
 * Решение 8, 9): рантайм-половина проверки — типовая идёт своим проектом
 * TypeScript (`npm run typecheck:plugin`, `npm run build:plugin-example`).
 * Импортируется скомпилированным из `dist/examples/plugins/typed/index.js`
 * тем же приёмом, что и `test/packaged-schema.test.ts`: исходник образца не
 * должен попасть в программу корневого `tsconfig.json`.
 */
const EXAMPLE_PATH = fileURLToPath(new URL('../examples/plugins/typed/index.js', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TSC = fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url));

/**
 * Собранный образец для проверки — тем же приёмом, что и `ensureDashboard`
 * (`test/ui-server.test.ts`): `dist/examples/plugins/typed/index.js` нет ни в
 * git, ни в свежем worktree, и его заводит отдельный шаг `npm run check`
 * (`build:plugin-example`). Тест не имеет права падать оттого, что его гнали
 * частичным прогоном (`npm test`, `npm run test:only`), — иначе отказ говорит
 * о порядке команд, а не о проверяемой правке. Заглушкой здесь не обойтись, в
 * отличие от витрины: проверяется как раз то, во что образец компилируется,
 * поэтому недостающий артефакт собирается по-настоящему и остаётся лежать —
 * это обычный артефакт сборки в `dist`, а не мусор в дереве.
 */
function ensureExample(): string {
  if (!existsSync(EXAMPLE_PATH)) {
    execFileSync(process.execPath, [TSC, '-p', 'examples/plugins/typed/tsconfig.json'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
  }
  return EXAMPLE_PATH;
}

async function loadExample(): Promise<StepcastPlugin> {
  const module = (await import(pathToFileURL(ensureExample()).href)) as { default: StepcastPlugin };
  return module.default;
}

function onlyPredicate(plugin: StepcastPlugin): PredicateContribution {
  const [predicate, ...rest] = plugin.predicates ?? [];
  assert.ok(predicate !== undefined, 'образец несёт предикат');
  assert.equal(rest.length, 0, 'образец несёт ровно один предикат');
  return predicate;
}

function onlyStepKind(plugin: StepcastPlugin): StepKindContribution {
  const [step, ...rest] = plugin.steps ?? [];
  assert.ok(step !== undefined, 'образец несёт вид шага');
  assert.equal(rest.length, 0, 'образец несёт ровно один вид шага');
  return step;
}

/** Реестр с одним применённым образцом — тем же путём, каким его применяет загрузка. */
async function exampleRegistry(): Promise<Registry> {
  const kernel = createPipelineKernel();
  await applyDeclarativePlugin(kernel, await loadExample(), '<examples/plugins/typed>');
  return registryFromKernel(kernel);
}

/**
 * Пайплайн, применяющий оба вклада образца: шаг его вида и предикат на
 * соседнем шаге. Предикат стоит не на шаге плагинного вида намеренно — в
 * напечатанной схеме перечень предикатов внутри ветви плагинного вида шага
 * остаётся незаполненным (`inlineValues` заканчивает обход узла-метки вида
 * шага, не дойдя до `expect` того же узла, `published-schema.ts`), и документ
 * с неверным значением предиката там проходит. К хелперам это отношения не
 * имеет и правится не здесь; образец же обязан доказывать своё — что его
 * схемы движок вкладывает и они работают.
 */
function pipelineDocument(fields: unknown, predicateValue: unknown): unknown {
  return {
    version: 1,
    kind: 'pipeline',
    name: 'проверка',
    jobs: {
      build: {
        steps: [
          { id: 'считать', 'word-count': fields },
          { id: 'проверить', run: ['echo', 'ok'], expect: [{ 'even-number': predicateValue }] },
        ],
      },
    },
  };
}

describe('example-plugin: examples/plugins/typed — схемы вкладываются в схему проекта', () => {
  /**
   * Самодостаточность схем образца проверяется не копией перечня запрещённых
   * ключей, а настоящей печатью схемы проекта: `buildPublishedSchemas` — тот же
   * код, каким печатает `stepcast schema`, и он же обходит схему вклада
   * `FORBIDDEN_KEYS` и компилирует её `ajv`. Схема, которую движок вложить не
   * смог, доезжает сюда замечанием в `notes` — ровно тем тихим исходом, ради
   * которого тест и заведён (design.md, Решение 7).
   */
  it('печать схемы проекта не оставляет ни одного замечания', async () => {
    const registry = await exampleRegistry();
    const { notes } = buildPublishedSchemas(pluginPredicateEntries(registry), pluginStepKindEntries(registry));

    assert.deepEqual(notes, []);
  });

  it('напечатанная схема проекта проверяет значение предиката и поля вида шага', async () => {
    const registry = await exampleRegistry();
    const { pipeline } = buildPublishedSchemas(pluginPredicateEntries(registry), pluginStepKindEntries(registry));
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(pipeline);

    assert.equal(validate(pipelineDocument({ text: 'раз два' }, 4)), true, 'годный документ');
    assert.equal(validate(pipelineDocument({ text: 42 }, 4)), false, 'поля вида шага неверной формы');
    assert.equal(validate(pipelineDocument({ text: 'раз два' }, 4.5)), false, 'значение предиката неверной формы');
  });
});

describe('example-plugin: examples/plugins/typed — схемы проверяют значение', () => {
  it('схема предиката принимает годное значение модели и отклоняет негодное', async () => {
    const plugin = await loadExample();
    const schema = onlyPredicate(plugin).schema;

    assert.equal(validateAgainstSchema(schema, 4).passed, true);
    assert.equal(validateAgainstSchema(schema, 4.5).passed, false);
  });

  it('схема полей вида шага отклоняет негодное значение, называя поле', async () => {
    const registry = await exampleRegistry();
    const plugin = await loadExample();
    const step = onlyStepKind(plugin);
    const at = 'jobs.build.steps.0.word-count';

    assert.doesNotThrow(() => {
      validateStepKindFields(step, { text: 'раз два' }, at, registry);
    });
    assert.throws(
      () => {
        validateStepKindFields(step, { text: 42 }, at, registry);
      },
      /\/text/,
      'отказ называет поле',
    );
  });

  it('схема выхода вида шага принимает годный структурированный выход и отклоняет негодный', async () => {
    const plugin = await loadExample();
    const output = onlyStepKind(plugin).output;

    // Выход объявлен схемой — иначе движку нечем проверить `structured`, и
    // значение уходит в `${jobs.*.output}` непроверенным
    // (`src/core/exec/pluginStep.ts`).
    assert.ok(output !== undefined, 'вид шага образца объявляет схему выхода');
    assert.equal(validateAgainstSchema(output, { words: 3 }).passed, true);
    assert.equal(validateAgainstSchema(output, { words: 'три' }).passed, false);
    assert.equal(validateAgainstSchema(output, { words: 3, лишнее: true }).passed, false);
  });
});

describe('example-plugin: examples/plugins/typed — вклад исполним', () => {
  it('исполнитель вида шага отрабатывает на годных полях, и его выход отвечает схеме output', async () => {
    const plugin = await loadExample();
    const step = onlyStepKind(plugin);

    const outcome = await step.execute({
      fields: { text: 'раз два три', min: 2 },
      step: { id: 'считать', index: 0, timeoutMs: 1000 },
      job: { id: 'работа' },
      attempt: 1,
      env: {},
      cwd: process.cwd(),
      stepDir: process.cwd(),
      signal: new AbortController().signal,
      log: { note: () => undefined, file: () => '' },
      ctx: {} as never,
    });

    assert.equal(outcome.exitCode, 0);
    assert.deepEqual(outcome.structured, { words: 3 });
    // Та же проверка, какой движок встречает `structured` после попытки.
    assert.equal(validateAgainstSchema(step.output, outcome.structured).passed, true);
  });

  it('исполнитель вида шага отказывает попытку, не набрав порог', async () => {
    const plugin = await loadExample();
    const step = onlyStepKind(plugin);

    const outcome = await step.execute({
      fields: { text: 'раз два', min: 5 },
      step: { id: 'считать', index: 0, timeoutMs: 1000 },
      job: { id: 'работа' },
      attempt: 1,
      env: {},
      cwd: process.cwd(),
      stepDir: process.cwd(),
      signal: new AbortController().signal,
      log: { note: () => undefined, file: () => '' },
      ctx: {} as never,
    });

    assert.equal(outcome.exitCode, 1);
  });

  it('вычислитель предиката отдаёт исход по значению', async () => {
    const plugin = await loadExample();
    const predicate = onlyPredicate(plugin);

    const evenResult = await predicate.evaluate(4, {} as never);
    assert.equal(evenResult.passed, true);

    const oddResult = await predicate.evaluate(5, {} as never);
    assert.equal(oddResult.passed, false);
  });
});
