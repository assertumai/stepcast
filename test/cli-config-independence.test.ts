import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { CliIo } from '../src/kernel/cli/args.js';
import { buildIndependentCommandEnv, run as runCli } from '../src/parts/cli/main.js';
import { COMMAND_ROWS } from '../src/parts/cli/rows.js';
import { ExitCode, StepcastError, type ExitCodeValue } from '../src/kernel/errors.js';
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

describe('config-error-breaks-every-command: граница выводится из объявлений строк (cli-commands-as-rows)', () => {
  it('независимыми объявлены ровно data, down и init', () => {
    // Единственный источник перечня — сами строки (design.md изменения
    // `cli-commands-as-rows`, Решение 5): второго списка имён рядом с ними
    // нет, и опечатка в объявлении строки была бы видна здесь же.
    const independentNames = COMMAND_ROWS.filter((row) => row.independent).map((row) => row.command.name).sort();
    assert.deepEqual(independentNames, ['data', 'down', 'init']);
  });

  it('каждая встроенная команда вне независимых строк отказывает при сломанной конфигурации', async () => {
    const dependentNames = COMMAND_ROWS.filter((row) => !row.independent).map((row) => row.command.name);
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

/** Патч, отключающий одну названную строку. */
function withDisabledRowPatch(project: Project, id: string): void {
  mkdirSync(join(project.root, '.stepcast'), { recursive: true });
  writeFileSync(
    join(project.root, '.stepcast', 'plugins.patch.yml'),
    `version: 1\nkind: plugins-patch\nplugins:\n  - id: ${id}\n    use: stepcast:${id}\n    enabled: false\n`,
  );
}

// Задача 6.4 (`cli-commands-as-rows`, design.md Решение 6): состав не вправе
// распорядиться строкой независимой команды — патч, отключивший её, не
// действует так, как подействовал бы на любую другую строку. `resolveConfig`
// возвращает строке встроенную идентичность и нанизывает на неё
// `TreeRowFailure` вместо того, чтобы дать патчу снять её тихо.
describe('cli-commands-as-rows: составу не принадлежит строка независимой команды', () => {
  it('патч отключает строку command-init: зависимая команда отказывает названно, называя строку и то, что составу она не принадлежит', async () => {
    const project = makeProject({});
    withDisabledRowPatch(project, 'command-init');

    const outcome = await cli(project, ['status']);

    assert.equal(outcome.code, ExitCode.configError);
    assert.match(outcome.stderr, /command-init/);
    assert.match(outcome.stderr, /не распоряжается/);
  });

  it('сама независимая команда init при том же патче исполняется прежним образом и прежним кодом возврата', async () => {
    const project = makeProject({});
    withDisabledRowPatch(project, 'command-init');

    const outcome = await cli(project, ['init']);

    assert.equal(outcome.code, ExitCode.ok);
    assert.ok(existsSync(project.path('stepcast.yml')));
  });

  it('stepcast plugins печатает дерево целиком, строка-виновница несёт причину', async () => {
    const project = makeProject({});
    withDisabledRowPatch(project, 'command-init');

    const outcome = await cli(project, ['plugins']);

    // Строка вернулась активной (Решение 6: `enabled: true`, а не тихо
    // отключённой) и несёт названный отказ — тем же правилом, что и всякая
    // другая явная строка, отказавшая при загрузке (`plugin-tree`, «Отказ
    // загрузки не заслоняет дерево»): команда осмотра переживает его и
    // печатает дерево целиком, но код возврата — ошибка конфигурации.
    assert.equal(outcome.code, ExitCode.configError);
    const line = outcome.stdout.split('\n').find((entry) => entry.includes('command-init'));
    assert.match(line ?? '', /отказ:/);
    assert.match(line ?? '', /не распоряжается/);
  });

  it('своя команда под другим именем заводится как обычно — независимость не мешает замене чужим именем', async () => {
    const project = makeProject({
      '.stepcast/config.yml': 'plugins: ["./plugins/hello.mjs"]\n',
    });
    project.write(
      '.stepcast/plugins/hello.mjs',
      "export default { name: 'hello-plugin', commands: [{ name: 'hello', spec: { description: 'привет' }, run: (args, io) => { io.out('привет'); return 0; } }] };\n",
    );

    const outcome = await cli(project, ['hello']);

    assert.equal(outcome.code, ExitCode.ok);
    assert.match(outcome.stdout, /привет/);
  });
});
