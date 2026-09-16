import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createClaudeAdapter } from '../src/parts/backends/claude/adapter.js';
import { discoverModels, resetModelDiscoveryCache } from '../src/parts/pipeline/backend/models.js';
import type { ModelDiscovery, ProbeOutput } from '../src/parts/pipeline/backend/types.js';
import { resolveConfig, type Config } from '../src/parts/pipeline/config/resolve.js';
import { lintPipeline } from '../src/parts/pipeline/domain/lint.js';
import { expandPipeline } from '../src/parts/pipeline/document/expand.js';
import { registryFromKernel, type Registry } from '../src/kernel/registry.js';
import type { BackendContribution } from '../src/parts/pipeline/contract.js';
import { asAgent, createPipelineKernel, makeProject } from './helpers.js';
import { tempDir } from './tmp.js';

/** Config настоящим разбором YAML — те же слои, что видит демон витрины. */
function configFrom(yaml: string): Config {
  const base = tempDir('models-config-');
  const home = join(base, 'home');
  mkdirSync(join(home, '.stepcast'), { recursive: true });
  const globalPath = join(home, '.stepcast', 'config.yml');
  writeFileSync(globalPath, yaml);
  return resolveConfig({ cwd: base, home, globalPath, projectPath: null }).config;
}

/** Реестр из одних заданных бэкендов, зарегистрированных на корне ядра — синоним прежнего `createRegistry`. */
function registryOf(backends: Record<string, BackendContribution>): Registry {
  const kernel = createPipelineKernel();
  for (const [name, contribution] of Object.entries(backends)) kernel.ctx.backends.register(name, contribution);
  return registryFromKernel(kernel);
}

function registryWith(name: string, models?: ModelDiscovery): Registry {
  return registryOf({ [name]: { create: () => ({ name }) as never, ...(models === undefined ? {} : { models }) } });
}

/** Разбор простого JSON-массива имён из stdout — общий для проб этого файла. */
function jsonNamesDiscovery(command: readonly string[]): ModelDiscovery {
  return {
    probe: () => ({ command, stdin: '' }),
    parse: (output: ProbeOutput) => {
      let names: unknown;
      try {
        names = JSON.parse(output.stdout);
      } catch {
        return [];
      }
      return Array.isArray(names) ? names.map((name) => ({ name: String(name) })) : [];
    },
  };
}

function nodeScript(script: string): readonly string[] {
  return [process.execPath, '-e', script];
}

describe('agent-backend: перечисление моделей — разбор и запуск', () => {
  it('успешный разбор: имена в порядке разбора, без повторов', async () => {
    resetModelDiscoveryCache();
    const config = configFrom('backends:\n  probe:\n    command: probe\n');
    const registry = registryWith(
      'probe',
      jsonNamesDiscovery(nodeScript('process.stdout.write(JSON.stringify(["b","a","a"]))')),
    );

    const result = await discoverModels('probe', config, registry);

    assert.deepEqual(result, { status: 'ok', models: [{ name: 'b' }, { name: 'a' }] });
  });

  it('вклад без models — unsupported', async () => {
    resetModelDiscoveryCache();
    const config = configFrom('backends:\n  probe:\n    command: probe\n');
    const registry = registryWith('probe');

    assert.deepEqual(await discoverModels('probe', config, registry), { status: 'unsupported' });
  });

  it('несуществующая команда — not_installed с именем команды', async () => {
    resetModelDiscoveryCache();
    const missing = join(tempDir('models-missing-'), 'нет-такой-команды');
    const config = configFrom('backends:\n  probe:\n    command: probe\n');
    const registry = registryWith('probe', jsonNamesDiscovery([missing]));

    assert.deepEqual(await discoverModels('probe', config, registry), {
      status: 'not_installed',
      command: missing,
    });
  });

  it('ненулевой код возврата — failed с текстом CLI как есть', async () => {
    resetModelDiscoveryCache();
    const config = configFrom('backends:\n  probe:\n    command: probe\n');
    const registry = registryWith(
      'probe',
      jsonNamesDiscovery(nodeScript('process.stderr.write("отказ CLI"); process.exit(3);')),
    );

    assert.deepEqual(await discoverModels('probe', config, registry), {
      status: 'failed',
      message: 'отказ CLI',
    });
  });

  it('разбор, вернувший пустой список — unparsed, а не пустой список моделей', async () => {
    resetModelDiscoveryCache();
    const config = configFrom('backends:\n  probe:\n    command: probe\n');
    const registry = registryWith(
      'probe',
      jsonNamesDiscovery(nodeScript('process.stdout.write("справка без описания моделей")')),
    );

    assert.deepEqual(await discoverModels('probe', config, registry), { status: 'unparsed' });
  });

  // Сценарий: «Проба зависла дольше предела»
  it('CLI без ответа за предел — timeout, процесс завершён', async () => {
    resetModelDiscoveryCache();
    const config = configFrom('backends:\n  probe:\n    command: probe\n');
    const registry = registryWith('probe', jsonNamesDiscovery(nodeScript('setTimeout(() => {}, 60_000);')));

    const result = await discoverModels('probe', config, registry);

    assert.deepEqual(result, { status: 'timeout' });
  });

  it('окружение: проба идёт argv без оболочки, переменная backends.<имя>.env доходит, запрет env_deny — нет', async () => {
    resetModelDiscoveryCache();
    const config = configFrom(
      'backends:\n  probe:\n    command: probe\n    env:\n      PROBE_MARKER: пропущенная\n      PROBE_TOKEN: секрет\n',
    );
    const registry = registryWith(
      'probe',
      jsonNamesDiscovery(
        nodeScript(
          'const out = [];' +
            'if (process.env.PROBE_MARKER !== undefined) out.push(process.env.PROBE_MARKER);' +
            'if (process.env.PROBE_TOKEN !== undefined) out.push("запрещённая-дошла");' +
            'process.stdout.write(JSON.stringify(out));',
        ),
      ),
    );

    const result = await discoverModels('probe', config, registry);

    assert.deepEqual(result, { status: 'ok', models: [{ name: 'пропущенная' }] });
  });

  it('окружение пробы: переменная из LaunchSpec доходит и побеждает переменную записи бэкенда', async () => {
    resetModelDiscoveryCache();
    const config = configFrom('backends:\n  probe:\n    command: probe\n    env:\n      PROBE_MARKER: из-записи\n');
    const registry = registryWith('probe', {
      probe: () => ({
        command: nodeScript('process.stdout.write(JSON.stringify([process.env.PROBE_MARKER, process.env.PROBE_EXTRA]))'),
        stdin: '',
        env: { PROBE_MARKER: 'из-пробы', PROBE_EXTRA: 'своя' },
      }),
      parse: (output: ProbeOutput) => (JSON.parse(output.stdout) as string[]).map((name) => ({ name })),
    });

    const result = await discoverModels('probe', config, registry);

    assert.deepEqual(
      result,
      { status: 'ok', models: [{ name: 'из-пробы' }, { name: 'своя' }] },
      'LaunchSpec.env применяется так же, как при запуске шага: поверх окружения записи бэкенда',
    );
  });
});

/**
 * Вклад — чужой код, и сорваться он вправе. Отказ маршрута `/api/models` от
 * этого недопустим: страница ждёт по каждому агенту либо список, либо
 * названную причину, и один сорвавшийся вклад не имеет права скрыть списки
 * остальных.
 */
describe('agent-backend: исключение из кода вклада — названная причина, а не отказ', () => {
  it('probe() бросил — probe_error с текстом исключения', async () => {
    resetModelDiscoveryCache();
    const config = configFrom('backends:\n  probe:\n    command: probe\n');
    const registry = registryWith('probe', {
      probe: () => { throw new Error('вклад споткнулся о конфигурацию'); },
      parse: () => [],
    });

    assert.deepEqual(await discoverModels('probe', config, registry), {
      status: 'probe_error',
      message: 'вклад споткнулся о конфигурацию',
    });
  });

  it('parse() бросил — probe_error, а не необработанное исключение', async () => {
    resetModelDiscoveryCache();
    const config = configFrom('backends:\n  probe:\n    command: probe\n');
    const registry = registryWith('probe', {
      probe: () => ({ command: nodeScript('process.stdout.write("вывод")'), stdin: '' }),
      parse: () => { throw new Error('разбор споткнулся о вывод'); },
    });

    assert.deepEqual(await discoverModels('probe', config, registry), {
      status: 'probe_error',
      message: 'разбор споткнулся о вывод',
    });
  });

  it('пустая команда пробы — probe_error: runProcess отвергает её синхронно', async () => {
    resetModelDiscoveryCache();
    const config = configFrom('backends:\n  probe:\n    command: probe\n');
    const registry = registryWith('probe', { probe: () => ({ command: [], stdin: '' }), parse: () => [] });

    const result = await discoverModels('probe', config, registry);

    assert.equal(result.status, 'probe_error');
  });

  it('сорвавшийся вклад одного бэкенда не мешает перечислению соседнего', async () => {
    resetModelDiscoveryCache();
    const config = configFrom('backends:\n  broken:\n    command: broken\n  good:\n    command: good\n');
    const registry = registryOf({
      broken: {
        create: () => ({ name: 'broken' }) as never,
        models: { probe: () => { throw new Error('сорвался'); }, parse: () => [] },
      },
      good: {
        create: () => ({ name: 'good' }) as never,
        models: jsonNamesDiscovery(nodeScript('process.stdout.write(JSON.stringify(["живая"]))')),
      },
    });

    const [broken, good] = await Promise.all([
      discoverModels('broken', config, registry),
      discoverModels('good', config, registry),
    ]);

    assert.equal(broken.status, 'probe_error');
    assert.deepEqual(good, { status: 'ok', models: [{ name: 'живая' }] });
  });

  it('удержание сорвавшегося вклада снимается требованием перечислить заново', async () => {
    resetModelDiscoveryCache();
    const dir = tempDir('models-recover-');
    const counter = join(dir, 'counter');
    writeFileSync(counter, '');
    const config = configFrom(`backends:\n  probe:\n    command: probe\n    env:\n      COUNTER_FILE: ${counter}\n`);
    let broken = true;
    const registry = registryWith('probe', {
      probe: (backendConfig) => {
        if (broken) throw new Error('пока сорван');
        return {
          command: nodeScript('process.stdout.write(JSON.stringify(["починено"]))'),
          stdin: '',
          env: backendConfig.env,
        };
      },
      parse: (output: ProbeOutput) => (JSON.parse(output.stdout) as string[]).map((name) => ({ name })),
    });

    assert.equal((await discoverModels('probe', config, registry)).status, 'probe_error');
    broken = false;
    assert.equal(
      (await discoverModels('probe', config, registry)).status,
      'probe_error',
      'без явного требования отдаётся удержанный ответ',
    );
    assert.deepEqual(
      await discoverModels('probe', config, registry, { refresh: true }),
      { status: 'ok', models: [{ name: 'починено' }] },
      'явное «перечислить заново» пробует снова, а не отдаёт застывший отказ',
    );
  });
});

/**
 * Требование «Перечисление не ограничивает выбор модели» (спека
 * `agent-backend`): сегодня оно держится на том, что `ModelNameSchema`, лint и
 * старт прогона перечисления не знают вовсе. Тест закрепляет это, чтобы
 * будущая попытка «подсказать» пользователю проверкой по распознанному списку
 * не прошла зелёной.
 */
describe('agent-backend: перечисление не ограничивает выбор модели', () => {
  const PIPELINE = 'agent: claude\nmodel: заведомо-вне-перечисления\n'
    + 'jobs:\n  work:\n    steps:\n      - id: ask\n        prompt: привет\n';

  it('модель вне перечисления разрешается конфигурацией, проходит проверку и уходит в запуск шага', async () => {
    resetModelDiscoveryCache();
    const config = configFrom('backends:\n  probe:\n    command: probe\n');
    const registry = registryWith(
      'probe',
      jsonNamesDiscovery(nodeScript('process.stdout.write(JSON.stringify(["только-эта"]))')),
    );
    assert.deepEqual(await discoverModels('probe', config, registry), {
      status: 'ok',
      models: [{ name: 'только-эта' }],
    });

    const project = makeProject({ 'stepcast.yml': PIPELINE });
    const projectConfig = resolveConfig({ cwd: project.root, home: project.home }).config;
    const expanded = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: projectConfig });

    assert.equal(asAgent(expanded.pipeline.jobs[0]!.steps[0]!).model, 'заведомо-вне-перечисления');
    assert.deepEqual(
      lintPipeline(expanded, { config: projectConfig })
        .filter((item) => item.severity === 'error')
        .map((item) => item.message),
      [],
      'статическая проверка не знает перечисления и не судит модель по нему',
    );

    const launch = createClaudeAdapter(projectConfig.backends.claude!).launch({
      prompt: 'привет',
      cwd: project.root,
      model: 'заведомо-вне-перечисления',
      resumeSession: false,
    });
    assert.ok(
      launch.command.includes('заведомо-вне-перечисления'),
      'имя уходит в CLI как есть: перечисление не подменяет и не отсекает его',
    );
  });

  it('недоступность перечисления не меняет ни разрешения конфигурации, ни статической проверки', async () => {
    resetModelDiscoveryCache();
    const missing = join(tempDir('models-unavailable-'), 'нет-такой-команды');
    const config = configFrom('backends:\n  probe:\n    command: probe\n');
    const registry = registryWith('probe', jsonNamesDiscovery([missing]));
    assert.equal((await discoverModels('probe', config, registry)).status, 'not_installed');

    const project = makeProject({ 'stepcast.yml': PIPELINE });
    const projectConfig = resolveConfig({ cwd: project.root, home: project.home }).config;
    const expanded = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: projectConfig });

    assert.equal(asAgent(expanded.pipeline.jobs[0]!.steps[0]!).model, 'заведомо-вне-перечисления');
    assert.deepEqual(
      lintPipeline(expanded, { config: projectConfig })
        .filter((item) => item.severity === 'error')
        .map((item) => item.message),
      [],
    );
  });
});

describe('agent-backend: удержание распознанного на время жизни процесса', () => {
  it('повторный вызов не поднимает нового процесса; ?refresh перечисляет заново', async () => {
    resetModelDiscoveryCache();
    const dir = tempDir('models-cache-');
    const counter = join(dir, 'counter');
    writeFileSync(counter, '');
    const config = configFrom(`backends:\n  probe:\n    command: probe\n    env:\n      COUNTER_FILE: ${counter}\n`);
    const registry = registryWith(
      'probe',
      jsonNamesDiscovery(
        nodeScript(
          'const fs = require("fs");' +
            'fs.appendFileSync(process.env.COUNTER_FILE, "x");' +
            'const n = fs.readFileSync(process.env.COUNTER_FILE, "utf8").length;' +
            'process.stdout.write(JSON.stringify(["run-" + n]));',
        ),
      ),
    );

    const first = await discoverModels('probe', config, registry);
    const second = await discoverModels('probe', config, registry);
    assert.deepEqual(first, { status: 'ok', models: [{ name: 'run-1' }] });
    assert.deepEqual(second, first, 'повторный вызов отдаёт удержанный ответ, не поднимая процесс заново');

    const refreshed = await discoverModels('probe', config, registry, { refresh: true });
    assert.deepEqual(refreshed, { status: 'ok', models: [{ name: 'run-2' }] });
  });

  it('смена command бэкенда даёт новую пробу, а не удержанный ответ прежней команды', async () => {
    resetModelDiscoveryCache();
    const dir = tempDir('models-cache-command-');
    const counter = join(dir, 'counter');
    writeFileSync(counter, '');
    const script = nodeScript(
      'const fs = require("fs");' +
        'fs.appendFileSync(process.env.COUNTER_FILE, "x");' +
        'const n = fs.readFileSync(process.env.COUNTER_FILE, "utf8").length;' +
        'process.stdout.write(JSON.stringify(["run-" + n]));',
    );
    const registry = registryWith('probe', jsonNamesDiscovery(script));

    const configA = configFrom(`backends:\n  probe:\n    command: cmd-a\n    env:\n      COUNTER_FILE: ${counter}\n`);
    const configB = configFrom(`backends:\n  probe:\n    command: cmd-b\n    env:\n      COUNTER_FILE: ${counter}\n`);

    assert.deepEqual(await discoverModels('probe', configA, registry), { status: 'ok', models: [{ name: 'run-1' }] });
    assert.deepEqual(
      await discoverModels('probe', configA, registry),
      { status: 'ok', models: [{ name: 'run-1' }] },
      'та же команда — удержанный ответ',
    );
    assert.deepEqual(
      await discoverModels('probe', configB, registry),
      { status: 'ok', models: [{ name: 'run-2' }] },
      'другая команда — новая проба',
    );
  });
});
