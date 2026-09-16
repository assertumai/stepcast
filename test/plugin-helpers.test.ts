import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import {
  defineBackend,
  definePlugin,
  definePredicate,
  defineStepKind,
  type StepKindInput,
} from '../src/plugin.js';
import { StepcastPluginSchema, type StepcastPlugin } from '../src/core/plugins/contract.js';
import { applyDeclarativePlugin } from '../src/core/plugins/load.js';
import { availableNames, predicateNames, registryFromKernel, stepKindNames } from '../src/core/plugins/registry.js';
import { createPipelineKernel } from './helpers.js';

/**
 * Хелперы объявления вклада (`plugin-typed-helpers`, design.md Решение 1):
 * тождество в рантайме и типизация входа вычислителя. Этот файл проверяет обе
 * половины — рантайм здесь (`node:test`), типы компиляцией самого файла
 * (`npm run typecheck`, которым уже компилируется `test/**`).
 */

describe('plugin-helpers: тождество в рантайме', () => {
  it('definePlugin возвращает переданный объект', () => {
    const source: StepcastPlugin = { name: 'identity-plugin' };
    assert.equal(definePlugin(source), source);
  });

  it('defineBackend возвращает переданный объект', () => {
    const source = { create: () => ({}) as never };
    assert.equal(defineBackend(source), source);
  });

  it('definePredicate возвращает переданный объект, и evaluate — та же функция', () => {
    const evaluate = () => ({ predicate: 'even-number', passed: true, hard: true });
    const source = { name: 'even-number', schema: { type: 'number' }, evaluate };
    const returned = definePredicate<number>(source);
    assert.equal(returned, source);
    assert.equal(returned.evaluate, evaluate);
  });

  it('defineStepKind возвращает переданный объект, и execute — та же функция', () => {
    const execute = () => ({ exitCode: 0 });
    const source = { name: 'word-count', title: 'Счётчик слов', fields: { type: 'object' }, execute };
    const returned = defineStepKind<{ readonly text: string }>(source);
    assert.equal(returned, source);
    assert.equal(returned.execute, execute);
  });
});

describe('plugin-helpers: вклад из хелпера принимается загрузкой наравне с литералом', () => {
  /** Плагин теми же именами вкладов и теми же умолчаниями бэкенда, что и его литеральный эквивалент ниже. */
  function pluginFromHelpers(): StepcastPlugin {
    return definePlugin({
      name: 'helpers-plugin',
      version: '1.0.0',
      backends: {
        mybackend: defineBackend({
          create: () => ({}) as never,
          defaults: { command: 'mybackend', sessions: true },
        }),
      },
      predicates: [
        definePredicate<number>({
          name: 'even-number',
          schema: { type: 'integer' },
          evaluate: (value) => ({ predicate: 'even-number', passed: value % 2 === 0, hard: true }),
        }),
      ],
      steps: [
        defineStepKind<{ readonly text: string }>({
          name: 'word-count',
          title: 'Счётчик слов',
          fields: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          execute: (input) => ({ exitCode: 0, structured: { words: input.fields.text.split(/\s+/).length } }),
        }),
      ],
    });
  }

  /** Тот же состав, но объявленный объектными литералами с прежней аннотацией типа — контрольная группа. */
  function pluginFromLiterals(): StepcastPlugin {
    return {
      name: 'literals-plugin',
      version: '1.0.0',
      backends: {
        mybackend: {
          create: () => ({}) as never,
          defaults: { command: 'mybackend', sessions: true },
        },
      },
      predicates: [
        {
          name: 'even-number',
          schema: { type: 'integer' },
          evaluate: (value) => ({ predicate: 'even-number', passed: (value as number) % 2 === 0, hard: true }),
        },
      ],
      steps: [
        {
          name: 'word-count',
          title: 'Счётчик слов',
          fields: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          execute: (input) => ({ exitCode: 0, structured: { words: (input.fields as { text: string }).text.split(/\s+/).length } }),
        },
      ],
    };
  }

  it('плагин из хелперов проходит StepcastPluginSchema', () => {
    assert.equal(StepcastPluginSchema.safeParse(pluginFromHelpers()).success, true);
  });

  it('плагин из хелперов собирается в реестр — те же имена вкладов и те же умолчания бэкенда, что у эквивалента из литералов', async () => {
    const helperKernel = createPipelineKernel();
    await applyDeclarativePlugin(helperKernel, pluginFromHelpers(), '<synthetic-helpers>');
    const helperRegistry = registryFromKernel(helperKernel);

    const literalKernel = createPipelineKernel();
    await applyDeclarativePlugin(literalKernel, pluginFromLiterals(), '<synthetic-literals>');
    const literalRegistry = registryFromKernel(literalKernel);

    assert.deepEqual(availableNames(helperRegistry, 'backends'), availableNames(literalRegistry, 'backends'));
    assert.deepEqual(predicateNames(helperRegistry), predicateNames(literalRegistry));
    assert.deepEqual(stepKindNames(helperRegistry), stepKindNames(literalRegistry));
    assert.deepEqual(
      helperRegistry.backends.get('mybackend')?.defaults,
      literalRegistry.backends.get('mybackend')?.defaults,
    );
  });
});

describe('plugin-helpers: zod-модель через границу не проходит', () => {
  /**
   * Запрет на zod через границу (`docs/plugins.md`, «Один источник схемы и
   * типа») держится не только типом: плагин на JavaScript типов не знает
   * вовсе, и отказать обязана проверка формы вклада при загрузке. Проверяется
   * она здесь именно моделью, а не любым объектом-самозванцем: `z.record`
   * принимает простой объект и отклоняет экземпляр класса, а всякая
   * zod-модель — экземпляр класса.
   */
  it('модель полем schema предиката отклоняется проверкой формы, называя поле', () => {
    const plugin = {
      name: 'zod-boundary',
      predicates: [
        {
          name: 'even-number',
          schema: z.number().int(),
          evaluate: () => ({ predicate: 'even-number', passed: true, hard: true }),
        },
      ],
    };

    const parsed = StepcastPluginSchema.safeParse(plugin);
    assert.equal(parsed.success, false);
    assert.equal(parsed.error?.issues[0]?.path.join('.'), 'predicates.0.schema');
  });

  it('модель полем fields вида шага отклоняется проверкой формы, называя поле', () => {
    const plugin = {
      name: 'zod-boundary',
      steps: [
        {
          name: 'word-count',
          title: 'Счётчик слов',
          fields: z.object({ text: z.string() }),
          execute: () => ({ exitCode: 0 }),
        },
      ],
    };

    const parsed = StepcastPluginSchema.safeParse(plugin);
    assert.equal(parsed.success, false);
    assert.equal(parsed.error?.issues[0]?.path.join('.'), 'steps.0.fields');
  });
});

describe('plugin-helpers: форма document публикуется наравне с прочими вкладами', () => {
  it('вклад с document собирается хелпером без приведений и проходит StepcastPluginSchema', () => {
    const contribution = defineStepKind<{ readonly target: string; readonly to: unknown }>({
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
      execute: (input) => ({ exitCode: 0, structured: input.fields }),
    });

    assert.equal(
      StepcastPluginSchema.safeParse({ name: 'deploy-steps', steps: [contribution] }).success,
      true,
    );
  });

  it('поле внутренней формы встроенного вида (native) отклоняется проверкой формы при загрузке, называя поле', () => {
    const plugin = {
      name: 'zod-boundary',
      steps: [
        {
          name: 'sneaky',
          title: 'Подделка',
          fields: { type: 'object' },
          native: { test: () => true, parse: () => ({}) },
          execute: () => ({ exitCode: 0 }),
        },
      ],
    };

    const parsed = StepcastPluginSchema.safeParse(plugin);
    assert.equal(parsed.success, false);
    assert.equal(parsed.error?.issues[0]?.path.join('.'), 'steps.0.native');
  });
});

/**
 * Типовая проверка. Функции ниже не вызываются — тело значимо только для
 * компилятора (`npm run typecheck`), поэтому каждая ссылается на себя через
 * `void`, снимая срабатывание `no-unused-vars`; исполнение файла их не
 * достигает, и рантайм-часть выше от них не зависит.
 */

function typeCheckStepKindFieldsTyped(): void {
  defineStepKind<{ readonly url: string }>({
    name: 'http-check',
    title: 'Проверка HTTP',
    fields: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    execute(input) {
      const url: string = input.fields.url;
      void url;
      return { exitCode: 0 };
    },
  });
}
void typeCheckStepKindFieldsTyped;

function typeCheckPredicateValueTyped(): void {
  definePredicate<string>({
    name: 'slug',
    schema: { type: 'string' },
    evaluate(value) {
      const length: number = value.length;
      void length;
      return { predicate: 'slug', passed: true, hard: true };
    },
  });
}
void typeCheckPredicateValueTyped;

function typeCheckUndeclaredField(): void {
  defineStepKind<{ readonly url: string }>({
    name: 'http-check',
    title: 'Проверка HTTP',
    fields: { type: 'object' },
    execute(input) {
      // @ts-expect-error — поле method не объявлено в переданном параметре типа F
      void input.fields.method;
      return { exitCode: 0 };
    },
  });
}
void typeCheckUndeclaredField;

function typeCheckEvaluateIncompatibleWithTypeParam(): void {
  definePredicate<string>({
    name: 'slug',
    schema: { type: 'string' },
    // @ts-expect-error — evaluate сужает T до буквального типа: бивариантная проверка метода пропустила бы это молча (design.md, Решение 2)
    evaluate: (value: 'ровно-этот-слаг') => ({ predicate: 'slug', passed: value === 'ровно-этот-слаг', hard: true }),
  });
}
void typeCheckEvaluateIncompatibleWithTypeParam;

function typeCheckStepKindWithoutTitle(): void {
  defineStepKind<{ readonly url: string }>(
    // @ts-expect-error — вклад вида шага без title не проходит контракт StepKindContribution
    {
      name: 'http-check',
      fields: { type: 'object' },
      execute: (input: StepKindInput<{ readonly url: string }>) => {
        void input;
        return { exitCode: 0 };
      },
    },
  );
}
void typeCheckStepKindWithoutTitle;

function typeCheckLintReceivesUnknownFields(): void {
  defineStepKind<{ readonly url: string }>({
    name: 'http-check',
    title: 'Проверка HTTP',
    fields: { type: 'object' },
    // @ts-expect-error — lint получает значение как unknown: поле с отложенной подстановкой к моменту статической проверки схемой вклада не проверено (design.md, Решение 5), и обещать здесь F было бы ложью
    lint: (fields: { readonly url: string }) => {
      void fields;
      return [];
    },
    execute: (input: StepKindInput<{ readonly url: string }>) => {
      void input;
      return { exitCode: 0 };
    },
  });
}
void typeCheckLintReceivesUnknownFields;

function typeCheckLintReceivesUnknownValue(): void {
  definePredicate<string>({
    name: 'slug',
    schema: { type: 'string' },
    // @ts-expect-error — правило одно для обоих хелперов: lint предиката тоже объявлен unknown, чтобы автору не приходилось помнить асимметрию (design.md, Решение 5)
    lint: (value: string) => {
      void value;
      return [];
    },
    evaluate: (value: string) => ({ predicate: 'slug', passed: value.length > 0, hard: true }),
  });
}
void typeCheckLintReceivesUnknownValue;

function typeCheckZodModelIsNotASchema(): void {
  defineStepKind<{ readonly url: string }>({
    name: 'http-check',
    title: 'Проверка HTTP',
    // @ts-expect-error — через границу едет JSON Schema, а не zod-модель: поле fields объявлено записью данных, и модель ему не подходит
    fields: z.object({ url: z.string() }),
    execute: (input: StepKindInput<{ readonly url: string }>) => {
      void input;
      return { exitCode: 0 };
    },
  });
}
void typeCheckZodModelIsNotASchema;

function typeCheckStepKindWaitsFalse(): void {
  defineStepKind<{ readonly url: string }>({
    name: 'http-check',
    title: 'Проверка HTTP',
    fields: { type: 'object' },
    // @ts-expect-error — waits принимает только литерал true либо отсутствие поля, не false
    waits: false,
    execute: (input: StepKindInput<{ readonly url: string }>) => {
      void input;
      return { exitCode: 0 };
    },
  });
}
void typeCheckStepKindWaitsFalse;
