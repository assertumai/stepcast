import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { StepcastError } from '../src/core/errors.js';
import { BUILTIN_PREDICATE_NAMES, builtinRegistry, createBuiltinKernel } from '../src/parts/builtin.js';
import { applyDeclarativePlugin } from '../src/core/plugins/load.js';
import { createKernel } from '../src/core/plugins/kernel.js';
import { availableNames, predicateNames, registryFromKernel } from '../src/core/plugins/registry.js';
import type { PredicateContribution, StepcastPlugin, StepKindContribution } from '../src/core/plugins/contract.js';
import { ExitCode } from '../src/core/errors.js';

/** Вклад предиката, годный для реестра: содержимое здесь не важно. */
function predicate(name: string): PredicateContribution {
  return {
    name,
    schema: { type: 'string' },
    evaluate: () => ({ predicate: name, passed: true, hard: true }),
  };
}

/** Вклад вида шага, годный для реестра: содержимое здесь не важно — важно только имя. */
function fakeStepKind(name: string): StepKindContribution {
  return { name, title: name, fields: {}, execute: () => ({}) };
}

describe('plugin-contributions: реестр вкладов', () => {
  it('встроенный реестр содержит бэкенд claude и имена всех встроенных предикатов', () => {
    const registry = builtinRegistry();

    assert.deepEqual(availableNames(registry, 'backends'), ['claude']);
    assert.deepEqual(predicateNames(registry), [...BUILTIN_PREDICATE_NAMES].sort());
    // Вкладов у встроенных предикатов нет — только занятые имена.
    assert.deepEqual(availableNames(registry, 'predicates'), []);
  });

  it('заводится заново на каждый вызов: вклад одного реестра не течёт в другой', async () => {
    const kernel = createBuiltinKernel();
    await applyDeclarativePlugin(kernel, { name: 'a', predicates: [predicate('http_ok')] }, '/модуль/a.js');

    assert.deepEqual(predicateNames(builtinRegistry()), [...BUILTIN_PREDICATE_NAMES].sort());
  });

  it('плагин добавляет вклады трёх видов', async () => {
    const kernel = createBuiltinKernel();
    const registry = registryFromKernel(kernel);
    const plugin: StepcastPlugin = {
      name: 'пример',
      version: '1.2.0',
      backends: { codex: { create: () => ({}) as never } },
      predicates: [predicate('http_ok')],
      commands: [
        {
          name: 'hello',
          spec: { description: 'поздороваться' },
          run: () => ExitCode.ok,
        },
      ],
    };

    await applyDeclarativePlugin(kernel, plugin, '/модуль/пример.js');

    assert.deepEqual(availableNames(registry, 'backends'), ['claude', 'codex']);
    assert.deepEqual(availableNames(registry, 'commands'), ['hello']);
    assert.ok(predicateNames(registry).includes('http_ok'));
    assert.deepEqual(registry.plugins, [
      { name: 'пример', version: '1.2.0', source: '/модуль/пример.js' },
    ]);
  });

  it('плагин не может занять имя встроенного бэкенда', async () => {
    const kernel = createBuiltinKernel();

    await assert.rejects(
      () =>
        applyDeclarativePlugin(
          kernel,
          { name: 'самозванец', backends: { claude: { create: () => ({}) as never } } },
          '/м.js',
        ),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /бэкенда claude/);
        assert.match(error.message, /встроенный вклад/);
        assert.match(error.message, /плагин самозванец/);
        return true;
      },
    );
  });

  it('плагин не может занять имя встроенного предиката', async () => {
    const kernel = createBuiltinKernel();

    await assert.rejects(
      () => applyDeclarativePlugin(kernel, { name: 'самозванец', predicates: [predicate('exit_code')] }, '/м.js'),
      (error: unknown) =>
        error instanceof StepcastError &&
        /предиката exit_code/.test(error.message) &&
        /встроенный вклад/.test(error.message),
    );
  });

  it('два плагина не могут спорить за одно имя', async () => {
    const kernel = createBuiltinKernel();
    await applyDeclarativePlugin(kernel, { name: 'первый', predicates: [predicate('http_ok')] }, '/первый.js');

    await assert.rejects(
      () => applyDeclarativePlugin(kernel, { name: 'второй', predicates: [predicate('http_ok')] }, '/второй.js'),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /плагин первый/);
        assert.match(error.message, /плагин второй/);
        return true;
      },
    );
  });

  it('одно имя в разных видах вкладов конфликтом не считается', async () => {
    const kernel = createBuiltinKernel();
    const registry = registryFromKernel(kernel);

    await applyDeclarativePlugin(
      kernel,
      {
        name: 'codex-адаптер',
        backends: { codex: { create: () => ({}) as never } },
        commands: [{ name: 'codex', spec: { description: 'о бэкенде' }, run: () => ExitCode.ok }],
      },
      '/модуль.js',
    );

    assert.ok(registry.backends.has('codex'));
    assert.ok(registry.commands.has('codex'));
  });
});

// Задача 1.1–1.2 (openspec/changes/kernel-domain-free-imports): тексты обоих
// отказов по занятому имени вида шага сегодня не проверяет ни один тест —
// закрепляются здесь, на неизменённом коде, до переноса проверки в разбор
// документа.
describe('plugin-registry: имя вида шага занято ключом документа', () => {
  it('имя, совпавшее с ключом общей части шага, отказывает дословным текстом и подсказкой', async () => {
    const kernel = createBuiltinKernel();

    await assert.rejects(
      () => applyDeclarativePlugin(kernel, { name: 'самозванец', steps: [fakeStepKind('expect')] }, '/м.js'),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.message, 'Имя вида шага expect занято ключом общей части шага');
        assert.equal(
          error.hint,
          'Ключи общей части (id, env, context, timeout, expect, attempts, …) не могут стать именем вида шага',
        );
        return true;
      },
    );
  });

  it('имя, совпавшее с ключом встроенного вида шага, отказывает дословным текстом, называющим виды-владельцы', async () => {
    const kernel = createBuiltinKernel();

    await assert.rejects(
      () => applyDeclarativePlugin(kernel, { name: 'самозванец', steps: [fakeStepKind('prompt')] }, '/м.js'),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.message, 'Имя вида шага prompt занято ключом встроенного вида шага agent');
        assert.equal(
          error.hint,
          'Выберите другое имя: ключи встроенных видов не могут стать именем плагинного вида шага',
        );
        return true;
      },
    );

    await assert.rejects(
      () => applyDeclarativePlugin(kernel, { name: 'самозванец2', steps: [fakeStepKind('on_fail')] }, '/м2.js'),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.message, 'Имя вида шага on_fail занято ключом встроенного вида шага run, script, uses');
        return true;
      },
    );
  });
});

// Задача 2.6: голое ядро без проверок имени — перечня занятых имён в нём нет
// вовсе, только вызов того, что подано параметром сборки (`createKernelShell`).
describe('plugin-registry: ядро без проверки имени', () => {
  it('createKernel() без параметров регистрирует вид шага expect без отказа', async () => {
    const kernel = createKernel();

    await applyDeclarativePlugin(kernel, { name: 'смелый', steps: [fakeStepKind('expect')] }, '/м.js');

    assert.ok(registryFromKernel(kernel).steps.has('expect'));
  });
});

// Задача 1.3: снимок дефолтного дерева — чтобы переезд встроенного слоя
// (src/parts/**) было чем сверить.
describe('plugin-registry: снимок дефолтного дерева', () => {
  it('бэкенды, порядок регистрации видов шага и зарезервированные предикаты не меняются переездом', () => {
    const kernel = createBuiltinKernel();

    assert.deepEqual([...kernel.ctx.backends.contributions.keys()], ['claude']);
    // Порядок — регистрации, не алфавитный: run, uses, script, agent (ядро),
    // затем decision (первая строка встроенного слоя, `BUILTIN_ROWS`).
    assert.deepEqual([...kernel.ctx.steps.contributions.keys()], ['run', 'uses', 'script', 'agent', 'decision']);
    assert.deepEqual([...kernel.ctx.predicates.reserved].sort(), [...BUILTIN_PREDICATE_NAMES].sort());
  });
});
