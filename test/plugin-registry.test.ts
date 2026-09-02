import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { StepcastError } from '../src/core/errors.js';
import { BUILTIN_PREDICATE_NAMES, builtinRegistry } from '../src/core/plugins/builtin.js';
import { addPlugin, availableNames, predicateNames } from '../src/core/plugins/registry.js';
import type { PredicateContribution, StepcastPlugin } from '../src/core/plugins/contract.js';
import { ExitCode } from '../src/core/errors.js';

/** Вклад предиката, годный для реестра: содержимое здесь не важно. */
function predicate(name: string): PredicateContribution {
  return {
    name,
    schema: { type: 'string' },
    evaluate: () => ({ predicate: name, passed: true, hard: true }),
  };
}

describe('plugin-contributions: реестр вкладов', () => {
  it('встроенный реестр содержит бэкенд claude и имена всех встроенных предикатов', () => {
    const registry = builtinRegistry();

    assert.deepEqual(availableNames(registry, 'backends'), ['claude']);
    assert.deepEqual(predicateNames(registry), [...BUILTIN_PREDICATE_NAMES].sort());
    // Вкладов у встроенных предикатов нет — только занятые имена.
    assert.deepEqual(availableNames(registry, 'predicates'), []);
  });

  it('заводится заново на каждый вызов: вклад одного реестра не течёт в другой', () => {
    const first = builtinRegistry();
    addPlugin(first, { name: 'a', predicates: [predicate('http_ok')] }, '/модуль/a.js');

    assert.deepEqual(predicateNames(builtinRegistry()), [...BUILTIN_PREDICATE_NAMES].sort());
  });

  it('плагин добавляет вклады трёх видов', () => {
    const registry = builtinRegistry();
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

    addPlugin(registry, plugin, '/модуль/пример.js');

    assert.deepEqual(availableNames(registry, 'backends'), ['claude', 'codex']);
    assert.deepEqual(availableNames(registry, 'commands'), ['hello']);
    assert.ok(predicateNames(registry).includes('http_ok'));
    assert.deepEqual(registry.plugins, [
      { name: 'пример', version: '1.2.0', source: '/модуль/пример.js' },
    ]);
  });

  it('плагин не может занять имя встроенного бэкенда', () => {
    const registry = builtinRegistry();

    assert.throws(
      () => addPlugin(registry, { name: 'самозванец', backends: { claude: { create: () => ({}) as never } } }, '/м.js'),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /бэкенда claude/);
        assert.match(error.message, /встроенный вклад/);
        assert.match(error.message, /плагин самозванец/);
        return true;
      },
    );
  });

  it('плагин не может занять имя встроенного предиката', () => {
    const registry = builtinRegistry();

    assert.throws(
      () => addPlugin(registry, { name: 'самозванец', predicates: [predicate('exit_code')] }, '/м.js'),
      (error: unknown) =>
        error instanceof StepcastError &&
        /предиката exit_code/.test(error.message) &&
        /встроенный вклад/.test(error.message),
    );
  });

  it('два плагина не могут спорить за одно имя', () => {
    const registry = builtinRegistry();
    addPlugin(registry, { name: 'первый', predicates: [predicate('http_ok')] }, '/первый.js');

    assert.throws(
      () => addPlugin(registry, { name: 'второй', predicates: [predicate('http_ok')] }, '/второй.js'),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /плагин первый/);
        assert.match(error.message, /плагин второй/);
        return true;
      },
    );
  });

  it('одно имя в разных видах вкладов конфликтом не считается', () => {
    const registry = builtinRegistry();

    addPlugin(
      registry,
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
