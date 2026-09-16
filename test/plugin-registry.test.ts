import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { StepcastError } from '../src/core/errors.js';
import { applyRowOnRoot, builtinRegistry, createBuiltinKernel, createKernelShell } from '../src/parts/builtin.js';
import { applyDeclarativePlugin } from '../src/core/plugins/load.js';
import { availableNames, contributionOwner, predicateNames, registryFromKernel, type Registry } from '../src/core/plugins/registry.js';
import { DECLARATIVE_CONTRIBUTION_FIELDS, isNativeStepKind, type PredicateContribution, type PipelinePlugin, type StepKindContribution } from '../src/core/plugins/pipeline-contract.js';
import { DEFAULT_NATIVE_PREDICATES } from '../src/core/pipeline/schema.js';
import { ExitCode } from '../src/core/errors.js';
import { resolveWithPlugins } from '../src/parts/resolve.js';
import { BUILTIN_ROWS } from '../src/parts/rows.js';
import { row as pipeline } from '../src/parts/pipeline/row.js';
import { row as stepRun } from '../src/parts/steps/run/row.js';
import { row as stepUses } from '../src/parts/steps/uses/row.js';
import { row as stepScript } from '../src/parts/steps/script/row.js';
import { makeProject } from './helpers.js';

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
    assert.deepEqual(predicateNames(registry), [...DEFAULT_NATIVE_PREDICATES].sort());
    // Встроенные предикаты — настоящие вклады строки `predicates`, а не резерв
    // без содержания (`builtin-predicates-as-row`): все десять числятся среди
    // вкладов, и владелец каждого — «встроенный».
    assert.deepEqual(availableNames(registry, 'predicates'), [...DEFAULT_NATIVE_PREDICATES].sort());
    for (const name of DEFAULT_NATIVE_PREDICATES) {
      assert.equal(contributionOwner(registry, 'predicates', name), 'встроенный');
    }
  });

  it('заводится заново на каждый вызов: вклад одного реестра не течёт в другой', async () => {
    const kernel = createBuiltinKernel();
    await applyDeclarativePlugin(kernel, { name: 'a', predicates: [predicate('http_ok')] }, '/модуль/a.js', DECLARATIVE_CONTRIBUTION_FIELDS);

    assert.deepEqual(predicateNames(builtinRegistry()), [...DEFAULT_NATIVE_PREDICATES].sort());
  });

  it('плагин добавляет вклады трёх видов', async () => {
    const kernel = createBuiltinKernel();
    const registry = registryFromKernel(kernel);
    const plugin: PipelinePlugin = {
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

    await applyDeclarativePlugin(kernel, plugin, '/модуль/пример.js', DECLARATIVE_CONTRIBUTION_FIELDS);

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
          DECLARATIVE_CONTRIBUTION_FIELDS,
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
      () => applyDeclarativePlugin(kernel, { name: 'самозванец', predicates: [predicate('exit_code')] }, '/м.js', DECLARATIVE_CONTRIBUTION_FIELDS),
      (error: unknown) =>
        error instanceof StepcastError &&
        /предиката exit_code/.test(error.message) &&
        /встроенный вклад/.test(error.message),
    );
  });

  // Задача 6.2 (builtin-predicates-as-row): `script` — десятый встроенный
  // предикат, который до этого пункта в резерв не попадал и тихо не работал
  // за плагином (design.md, Решение 7). Строка вносит все десять форм разом,
  // и дыра закрывается сама: тот же отказ, что и на `exit_code`.
  it('плагин не может занять имя встроенного предиката script — дыра резерва закрыта', async () => {
    const kernel = createBuiltinKernel();

    await assert.rejects(
      () => applyDeclarativePlugin(kernel, { name: 'самозванец', predicates: [predicate('script')] }, '/м.js', DECLARATIVE_CONTRIBUTION_FIELDS),
      (error: unknown) =>
        error instanceof StepcastError &&
        /предиката script/.test(error.message) &&
        /встроенный вклад/.test(error.message),
    );
  });

  // Задача 6.3 (builtin-predicates-as-row): `predicateNames` — источник
  // перечня «Доступны: …» в отказе на неизвестном предикате (`expand.ts`,
  // `toPluginPredicate`); `script` называется в нём наравне с остальными
  // девятью, а не остаётся дырой резерва.
  it('перечень доступного называет script наравне с остальными встроенными предикатами', () => {
    const registry = builtinRegistry();

    assert.deepEqual(predicateNames(registry), [...DEFAULT_NATIVE_PREDICATES].sort());
    assert.ok(predicateNames(registry).includes('script'));
  });

  it('два плагина не могут спорить за одно имя', async () => {
    const kernel = createBuiltinKernel();
    await applyDeclarativePlugin(kernel, { name: 'первый', predicates: [predicate('http_ok')] }, '/первый.js', DECLARATIVE_CONTRIBUTION_FIELDS);

    await assert.rejects(
      () => applyDeclarativePlugin(kernel, { name: 'второй', predicates: [predicate('http_ok')] }, '/второй.js', DECLARATIVE_CONTRIBUTION_FIELDS),
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
      DECLARATIVE_CONTRIBUTION_FIELDS,
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
      () => applyDeclarativePlugin(kernel, { name: 'самозванец', steps: [fakeStepKind('expect')] }, '/м.js', DECLARATIVE_CONTRIBUTION_FIELDS),
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
      () => applyDeclarativePlugin(kernel, { name: 'самозванец', steps: [fakeStepKind('prompt')] }, '/м.js', DECLARATIVE_CONTRIBUTION_FIELDS),
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
      () => applyDeclarativePlugin(kernel, { name: 'самозванец2', steps: [fakeStepKind('on_fail')] }, '/м2.js', DECLARATIVE_CONTRIBUTION_FIELDS),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.message, 'Имя вида шага on_fail занято ключом встроенного вида шага run, script, uses');
        return true;
      },
    );
  });

  // Сценарий спеки `builtin-step-kinds-as-rows` «Плагин занимает имя
  // встроенного вида при отключённой строке» (находка ревью): резерв ключей
  // формата составом дерева не управляется. Пайплайн, где `run:` значит не то,
  // что во всех остальных, читается неверно и человеком, и документацией, и
  // линтом чужого проекта, — поэтому отключение строки `step-run` имени `run`
  // не освобождает, и отказ остаётся дословно прежним.
  it('отключённая строка вида шага не освобождает ни его имени, ни его ключей', async () => {
    const kernel = createKernelShell();
    await Promise.all(BUILTIN_ROWS.filter((row) => row.id !== 'step-run').map((row) => row.apply(kernel)));
    assert.equal(registryFromKernel(kernel).steps.has('run'), false, 'строка снята составом');

    await assert.rejects(
      () => applyDeclarativePlugin(kernel, { name: 'самозванец', steps: [fakeStepKind('run')] }, '/м.js', DECLARATIVE_CONTRIBUTION_FIELDS),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.message, 'Имя вида шага run занято ключом встроенного вида шага run');
        assert.equal(
          error.hint,
          'Выберите другое имя: ключи встроенных видов не могут стать именем плагинного вида шага',
        );
        return true;
      },
    );

    // И ключ документа того же вида — тем же отказом, не только имя.
    await assert.rejects(
      () => applyDeclarativePlugin(kernel, { name: 'самозванец2', steps: [fakeStepKind('on_fail')] }, '/м2.js', DECLARATIVE_CONTRIBUTION_FIELDS),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.message, 'Имя вида шага on_fail занято ключом встроенного вида шага run, script, uses');
        return true;
      },
    );
  });
});

// Задача 2.6 (kernel-domain-free-imports) заводила это как «голое ядро без
// проверок имени»: `createKernel()` принимало проверку опцией сборки, и без
// неё имя `expect` не отказывало. После pipeline-owns-services этой опции нет
// вовсе — проверка имени вида шага вшита в строку `pipeline` (design.md,
// Решение 1) и работает всегда, как только сервис `steps` заведён; выразить
// «ядро без проверки» стало нечем, и сценарий снят вместе с абзацем.

// Задача 1.3: снимок дефолтного дерева — чтобы переезд встроенного слоя
// (src/parts/**) было чем сверить.
describe('plugin-registry: снимок дефолтного дерева', () => {
  it('бэкенды, порядок регистрации видов шага и вклады встроенных предикатов не меняются переездом', () => {
    const kernel = createBuiltinKernel();

    assert.deepEqual([...kernel.ctx.backends.contributions.keys()], ['claude']);
    // Порядок — регистрации, не алфавитный, и записан он теперь только в
    // перечне строк (`src/parts/rows.ts`, `BUILTIN_ROWS`): строки видов шага
    // идут в нём после `backend-claude` — run, uses, script, agent, decision.
    assert.deepEqual([...kernel.ctx.steps.contributions.keys()], ['run', 'uses', 'script', 'agent', 'decision']);
    // Встроенные предикаты — вклады сервиса `predicates`, внесённые строкой
    // (`builtin-predicates-as-row`), а не зарезервированные без содержания
    // имена: порядок — порядок их перечисления в `src/parts/expect/row.ts`,
    // те же десять форм, что `DEFAULT_NATIVE_PREDICATES`.
    assert.deepEqual([...kernel.ctx.predicates.contributions.keys()].sort(), [...DEFAULT_NATIVE_PREDICATES].sort());
  });

  // Задача 1 (row-module-convention): переезд строк движка в модули
  // (`src/parts/backends/claude/row.ts`, `src/parts/steps/decision/row.ts`)
  // не вправе сменить владельца вклада — вклад остаётся внесённым на
  // корневой области ядра, а не через `kernel.ctx.plugin`, и это видно
  // снаружи только тут: по признаку области, а не по имени строки.
  it('владелец встроенного вклада бэкенда claude остаётся «встроенный»', () => {
    const registry = builtinRegistry();

    assert.equal(contributionOwner(registry, 'backends', 'claude'), 'встроенный');
  });

  // Задача 1.1 (builtin-step-kinds-as-rows): снимок владельца — не только у
  // бэкенда, но и у каждого вида шага. Все пять вносятся своей строкой тем же
  // вызовом сервиса на корневой области ядра (`ctx.steps.register`), а не
  // через `kernel.ctx.plugin`, — владелец поэтому «встроенный», а не имя
  // строки, и переезд регистрации в `BUILTIN_ROWS` этого не изменил.
  it('владелец каждого вида шага — «встроенный»', () => {
    const registry = builtinRegistry();

    for (const name of ['run', 'uses', 'script', 'agent', 'decision']) {
      assert.equal(contributionOwner(registry, 'steps', name), 'встроенный');
    }
  });

  // Задача 7.2 (builtin-predicates-as-row): владелец каждого встроенного
  // предиката — «встроенный», тем же приёмом, что и у видов шага.
  it('владелец каждого встроенного предиката — «встроенный»', () => {
    const registry = builtinRegistry();

    for (const name of DEFAULT_NATIVE_PREDICATES) {
      assert.equal(contributionOwner(registry, 'predicates', name), 'встроенный');
    }
  });
});

// Задача 5.3 (pipeline-owns-services, design.md Решение 4, «Требование:
// Состав дефолта собирается и без обхода дерева — теми же телами строк»):
// синхронное умолчание библиотеки и обход дерева дефолта — два разных пути
// применения одних и тех же тел строк, и обязаны дать один и тот же состав.
describe('plugin-registry: синхронное умолчание и обход дерева дают один состав', () => {
  it('вклады, их порядок и их владельцы совпадают', async () => {
    const project = makeProject({});
    const { registry: treeRegistry } = await resolveWithPlugins(
      { cwd: project.root, home: project.home },
      { projectRoot: project.root },
    );
    const syncRegistry = builtinRegistry();

    assert.deepEqual(availableNames(syncRegistry, 'backends'), availableNames(treeRegistry, 'backends'));
    assert.deepEqual([...syncRegistry.steps.keys()], [...treeRegistry.steps.keys()]);
    assert.deepEqual([...syncRegistry.predicates.keys()], [...treeRegistry.predicates.keys()]);
    assert.deepEqual([...syncRegistry.owners], [...treeRegistry.owners]);
  });
});

// Задача 5.4 (pipeline-owns-services, design.md Решение 4, «Требование:
// Поставщик переставлен в конец перечня»): синхронная сборка умолчания не
// умеет ждать — поставщик обязан стоять в `BUILTIN_ROWS` раньше своих
// потребителей, и нарушение этого порядка даёт именованный отказ, а не
// `TypeError` на обращении к отсутствующему сервису. Обход дерева тем же
// переставленным порядком не задет — это уже закреплено отдельно
// (`test/plugin-tree.test.ts`, «потребитель и пользовательский плагин впереди
// pipeline»), где порядок строк узнавание не решает, решает `inject`.
describe('plugin-registry: поставщик в конце перечня ломает только синхронную сборку', () => {
  it('перестановка pipeline в конец перечня даёт именованный отказ синхронной сборки', () => {
    const kernel = createKernelShell();
    const reordered = [...BUILTIN_ROWS.filter((row) => row.id !== 'pipeline'), pipeline];

    assert.throws(
      () => {
        for (const row of reordered) applyRowOnRoot(kernel, row);
      },
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /backend-claude/);
        assert.match(error.message, /backends/);
        return true;
      },
    );
  });
});

/**
 * Первый вид, чей `native.test` узнаёт запись, — то же обращение к реестру,
 * каким `matchStepKind` (`src/core/pipeline/expand.ts`) обходит `registry.steps`
 * и останавливается на первом совпадении. Записывается здесь заново, а не
 * зовётся из `expand.ts`, потому что сама функция не экспортирована: вопрос
 * теста — «чей порядок это решает», а не «как разбирается документ», и полный
 * проход через схему документа тут не нужен и не пройден бы — `run` и `uses`
 * одновременно не проходят ни одну настоящую ветвь схемы (`declaredByManifest`).
 */
function firstNativeMatch(record: Record<string, unknown>, registry: Registry): string | undefined {
  for (const [name, kind] of registry.steps) {
    if (isNativeStepKind(kind) && kind.native.test(record)) return name;
  }
  return undefined;
}

// Задача 7.5 (builtin-step-kinds-as-rows), пересмотрено задачей 1.1
// (pipeline-owns-services, design.md Решение 11): порядок узнавания —
// свойство перечня строк-потребителей (`src/parts/rows.ts`, `BUILTIN_ROWS`),
// а не порядка вызовов нигде больше. После переезда служебных сервисов в
// строку `pipeline` регистрация видов шага откладывается до её появления
// (`ctx.inject`), и порядок узнавания обязан остаться порядком применения
// потребителей — тем самым, что назвал перечень, — а не порядком, в котором
// cordis впоследствии разрешает отложенные области.
describe('plugin-registry: порядок узнавания — свойство порядка потребителей, не поставщика', () => {
  const AMBIGUOUS_RECORD = { run: 'echo hi', uses: 'some-step' };

  it('run перед uses в перечне потребителей — запись, назвавшая оба ключа, узнаётся видом run', async () => {
    const kernel = createKernelShell();
    await pipeline.apply(kernel);
    await stepRun.apply(kernel);
    await stepUses.apply(kernel);
    const registry = registryFromKernel(kernel);

    assert.equal(firstNativeMatch(AMBIGUOUS_RECORD, registry), 'run');
  });

  it('та же пара строк-потребителей в обратном порядке — та же запись узнаётся видом uses', async () => {
    const kernel = createKernelShell();
    await pipeline.apply(kernel);
    await stepUses.apply(kernel);
    await stepRun.apply(kernel);
    const registry = registryFromKernel(kernel);

    assert.equal(firstNativeMatch(AMBIGUOUS_RECORD, registry), 'uses');
  });

  // Сторожевой тест задачи 1.1: строка-поставщик стоит в дереве последней —
  // оба потребителя заведены собственной областью и ждут сервис `steps`
  // раньше, чем он появится. Узнавание не переходит на порядок разрешения
  // cordis: `uses` по-прежнему узнаёт запись раньше `script`.
  it('поставщик применяется последним — uses по-прежнему узнаёт запись раньше script', async () => {
    const kernel = createKernelShell();
    const usesFiber = stepUses.apply(kernel);
    const scriptFiber = stepScript.apply(kernel);
    await pipeline.apply(kernel);
    await usesFiber;
    await scriptFiber;
    const registry = registryFromKernel(kernel);

    assert.equal(firstNativeMatch({ uses: 'some-step', script: './main.cjs' }, registry), 'uses');
  });
});

// Задача 7.5 (builtin-predicates-as-row): у строки предикатов своего
// ограничения порядка нет — ключи предикатов не пересекаются, и место
// `predicates` в перечне не решает ничего, кроме порядка печати состава
// (design.md, Решение 8). В отличие от строк видов шага, перестановка
// `predicates` относительно `backend-claude`/`step-*` не меняет ни состава
// вкладов, ни того, какой предикат узнает запись.
describe('plugin-registry: место строки предикатов в перечне ничего не решает', () => {
  it('predicates первой или последней в перечне — реестр содержит один и тот же состав предикатов', async () => {
    const orderedKernel = createKernelShell();
    await Promise.all(BUILTIN_ROWS.map((row) => row.apply(orderedKernel)));
    const orderedRegistry = registryFromKernel(orderedKernel);

    // Строка предикатов переставлена в самый конец перечня — единственная
    // правка порядка вызова, состав строк тот же.
    const reorderedRows = [...BUILTIN_ROWS.filter((row) => row.id !== 'predicates'), ...BUILTIN_ROWS.filter((row) => row.id === 'predicates')];
    const reorderedKernel = createKernelShell();
    await Promise.all(reorderedRows.map((row) => row.apply(reorderedKernel)));
    const reorderedRegistry = registryFromKernel(reorderedKernel);

    assert.deepEqual(predicateNames(reorderedRegistry), predicateNames(orderedRegistry));
    assert.deepEqual([...reorderedRegistry.predicates.keys()].sort(), [...orderedRegistry.predicates.keys()].sort());
    assert.deepEqual([...reorderedRegistry.steps.keys()], [...orderedRegistry.steps.keys()]);
  });
});
