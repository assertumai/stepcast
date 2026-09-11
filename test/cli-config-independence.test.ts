import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { CliIo } from '../src/cli/args.js';
import {
  BUILTIN_COMMANDS,
  CONFIG_INDEPENDENT_COMMANDS,
  buildIndependentCommandEnv,
  run as runCli,
} from '../src/cli/main.js';
import { ExitCode, StepcastError, type ExitCodeValue } from '../src/core/errors.js';
import { makeProject, seedRun, withHome, type Project } from './helpers.js';

interface Outcome {
  readonly code: ExitCodeValue;
  readonly stdout: string;
  readonly stderr: string;
}

async function cli(project: Project, argv: readonly string[]): Promise<Outcome> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    cwd: project.root,
  };
  const code = await withHome(project.home, () => runCli(argv, io));
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

/** Проект с проектным `.stepcast/config.yml`, не разбирающимся как YAML. */
function withBrokenProjectConfig(): Project {
  return makeProject({ '.stepcast/config.yml': 'plugins: [нет закрывающей\n' });
}

/** Проект с глобальным `.stepcast/config.yml`, не соответствующим схеме. */
function withBrokenGlobalConfig(): Project {
  const project = makeProject({});
  writeFileSync(
    join(project.home, '.stepcast', 'config.yml'),
    'совсем_не_ключ_конфигурации: да\n',
  );
  return project;
}

/**
 * Корень прогонов умолчания для проекта теста: `~/.stepcast/runs` при
 * подменённом `HOME`. Именно его убирала бы `gc`, разреши она конфигурацию.
 */
function defaultRunsRoot(project: Project): string {
  return join(project.home, '.stepcast', 'runs');
}

/** Плагин с командой `hello`: тот же контракт, что у настоящих плагинов. */
const HELLO_PLUGIN = `
export default {
  name: 'hello-plugin',
  version: '0.1.0',
  commands: [
    {
      name: 'hello',
      spec: { description: 'поздороваться' },
      run: (args, io) => {
        io.out('привет');
        return 0;
      },
    },
  ],
};
`;

/** Позвать `data set` внутри STEPCAST_JOB_DIR, восстановив окружение после вызова. */
async function withJobDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const original = process.env.STEPCAST_JOB_DIR;
  process.env.STEPCAST_JOB_DIR = dir;
  try {
    return await fn();
  } finally {
    if (original === undefined) delete process.env.STEPCAST_JOB_DIR;
    else process.env.STEPCAST_JOB_DIR = original;
  }
}

/** Каталог работы на диске с объявлением ключей данных — тот же вид, что заводит журнал прогона. */
function makeJobDir(declared: readonly string[]): string {
  const dir = join(makeProject({}).root, 'jobs', 'работа');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'resolved.json'), JSON.stringify({ data: declared }));
  return dir;
}

describe('config-error-breaks-every-command: команды перечня исполняются при сломанной конфигурации', () => {
  it('data set пишет данные работы при неразбираемом проектном конфиге', async () => {
    const project = withBrokenProjectConfig();
    // Ключ данных ограничен латиницей, цифрами, подчёркиванием и дефисом
    // (`assertDataKey`) — значение остаётся произвольной строкой.
    const jobDir = makeJobDir(['result']);

    const outcome = await withJobDir(jobDir, () => cli(project, ['data', 'set', 'result', 'готово']));

    assert.equal(outcome.code, ExitCode.ok);
    assert.deepEqual(
      JSON.parse(readFileSync(join(jobDir, 'data.json'), 'utf8')) as unknown,
      { result: 'готово' },
    );
    assert.equal(outcome.stderr, '');
  });

  it('down исполняется при неразбираемом глобальном конфиге', async () => {
    const project = withBrokenGlobalConfig();

    const outcome = await cli(project, ['down']);

    assert.equal(outcome.code, ExitCode.ok);
    assert.match(outcome.stdout, /витрина/);
    assert.equal(outcome.stderr, '');
  });

  it('init заводит пайплайн поверх ключа, недопустимого в проектном слое', async () => {
    // runs.root допустим только в глобальной конфигурации — этот же ключ в
    // проектном слое отказывает разбором ещё до того, как известно, что
    // звали init.
    const project = makeProject({ '.stepcast/config.yml': 'runs:\n  root: /куда-то\n' });

    const outcome = await cli(project, ['init']);

    assert.equal(outcome.code, ExitCode.ok);
    assert.ok(existsSync(project.path('stepcast.yml')));
    assert.ok(existsSync(project.path('.stepcast/jobs/example.yml')));
    assert.equal(outcome.stderr, '');
  });

  it('data get исполняется, когда валидная конфигурация объявляет несуществующий модуль плагина, — модуль не импортируется', async () => {
    const project = makeProject({ '.stepcast/config.yml': 'plugins: ["./plugins/нет.mjs"]\n' });
    const jobDir = makeJobDir([]);

    const outcome = await withJobDir(jobDir, () => cli(project, ['data', 'get']));

    assert.equal(outcome.code, ExitCode.ok);
    assert.deepEqual(JSON.parse(outcome.stdout) as unknown, {});

    // Та же конфигурация зависимой команде мешает: плагин из неё загружается,
    // модуля нет — отказ, значит независимая команда действительно его
    // пропустила, а не совпала с плагином, который на самом деле загрузился.
    const dependent = await cli(project, ['config']);
    assert.equal(dependent.code, ExitCode.configError);
  });
});

describe('config-error-breaks-every-command: зависимые команды и справка отказывают', () => {
  const DEPENDENT_CALLS: readonly (readonly string[])[] = [
    ['status'],
    ['gc', '--older-than', '30d'],
    ['config'],
    ['--help'],
    ['нетакая-команда'],
  ];

  for (const argv of DEPENDENT_CALLS) {
    it(`stepcast ${argv.join(' ')} отказывает кодом configError`, async () => {
      const project = withBrokenProjectConfig();

      const outcome = await cli(project, argv);

      assert.equal(outcome.code, ExitCode.configError);
      assert.match(outcome.stderr, /\.stepcast[/\\]config\.yml/);
      assert.equal(outcome.stdout, '');
    });
  }

  it('gc --older-than не сносит прогон из корня умолчания при сломанной конфигурации', async () => {
    // Отказ обязан наступить раньше, чем станет известен `runs.root`, поэтому
    // прогон заводится там, куда `gc` пошла бы по умолчанию — `~/.stepcast/runs`
    // подменённого `HOME`, — и заведомо старше порога вызова. Уцелеть обязан
    // артефакт: сама директория прогона уборку переживает всегда (`gc` бережёт
    // `run.json`, `status.json` и `usage.json`), и её существование не отличило
    // бы отказ от состоявшейся уборки.
    const project = withBrokenProjectConfig();
    const journal = seedRun(defaultRunsRoot(project), project.root, {
      manifest: { started_at: '2020-01-01T00:00:00.000Z', finished_at: '2020-01-01T00:05:00.000Z' },
      artifacts: { сборка: { итог: 'да' } },
    });
    const artifact = join(journal.paths.dir, 'artifacts', 'сборка.json');
    assert.ok(existsSync(artifact));
    const before = readdirSync(journal.paths.dir).sort();

    const outcome = await cli(project, ['gc', '--older-than', '30d']);

    assert.equal(outcome.code, ExitCode.configError);
    assert.ok(existsSync(artifact), 'артефакт прогона обязан уцелеть');
    assert.deepEqual(readdirSync(journal.paths.dir).sort(), before);
  });

  it('команда плагина независимой не бывает: то же имя исполняется, пока конфигурация цела', async () => {
    // Плагин объявлен разбираемым проектным слоем, ломается глобальный: имя
    // `hello` в этом проекте настоящее — что и отличает случай от неизвестной
    // команды, — но при неразобранной конфигурации о нём неизвестно ничего.
    const project = makeProject({ '.stepcast/config.yml': 'plugins: ["./plugins/hello.mjs"]\n' });
    project.write('.stepcast/plugins/hello.mjs', HELLO_PLUGIN);

    const whole = await cli(project, ['hello']);
    assert.equal(whole.code, ExitCode.ok);
    assert.match(whole.stdout, /привет/);

    writeFileSync(join(project.home, '.stepcast', 'config.yml'), 'совсем_не_ключ: да\n');
    const broken = await cli(project, ['hello']);

    assert.equal(broken.code, ExitCode.configError);
    assert.equal(broken.stdout, '');
    assert.match(broken.stderr, /config\.yml/);
  });

  it('--help не печатает перечень команд при сломанной конфигурации', async () => {
    const project = withBrokenProjectConfig();

    const outcome = await cli(project, ['--help']);

    assert.doesNotMatch(outcome.stderr, /stepcast run/);
  });
});

describe('config-error-breaks-every-command: граница покрывает весь состав BUILTIN_COMMANDS', () => {
  it('перечень независимых состоит из имён встроенных команд', () => {
    // Вторая сторона границы: опечатка в перечне не отказала бы ничем
    // заметным — имя, которого нет среди встроенных, просто увело бы настоящую
    // команду на зависимый путь молча.
    const builtinNames = new Set(BUILTIN_COMMANDS.map((contribution) => contribution.name));

    for (const name of CONFIG_INDEPENDENT_COMMANDS) {
      assert.ok(builtinNames.has(name), `перечень называет невстроенную команду ${name}`);
    }
    assert.equal(CONFIG_INDEPENDENT_COMMANDS.size, 3);
  });

  it('каждая встроенная команда вне перечня независимых отказывает при сломанной конфигурации', async () => {
    const dependentNames = BUILTIN_COMMANDS.map((contribution) => contribution.name).filter(
      (name) => !CONFIG_INDEPENDENT_COMMANDS.has(name),
    );
    assert.ok(dependentNames.length > 0);

    for (const name of dependentNames) {
      const project = withBrokenProjectConfig();
      const outcome = await cli(project, [name]);
      assert.equal(outcome.code, ExitCode.configError, `команда ${name} обязана отказать`);
    }
  });
});

describe('config-error-breaks-every-command: команда перечня, обратившаяся к конфигурации', () => {
  it('чтение config бросает StepcastError, называющую команду и её независимость', () => {
    const env = buildIndependentCommandEnv('data', '/tmp');

    assert.throws(
      () => env.config,
      (error: unknown) =>
        error instanceof StepcastError &&
        /data/.test(error.message) &&
        /независим/.test(error.message),
    );
  });

  it('чтение registry бросает ту же форму отказа', () => {
    const env = buildIndependentCommandEnv('down', '/tmp');

    assert.throws(
      () => env.registry,
      (error: unknown) =>
        error instanceof StepcastError &&
        /down/.test(error.message) &&
        /независим/.test(error.message),
    );
  });

  it('чтение ctx бросает ту же форму отказа', () => {
    const env = buildIndependentCommandEnv('down', '/tmp');

    assert.throws(
      () => env.ctx,
      (error: unknown) =>
        error instanceof StepcastError &&
        /down/.test(error.message) &&
        /независим/.test(error.message),
    );
  });
});
