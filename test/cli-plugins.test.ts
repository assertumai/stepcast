import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import type { CliIo } from '../src/cli/args.js';
import { run as runCli } from '../src/cli/main.js';
import { ExitCode, type ExitCodeValue } from '../src/core/errors.js';
import { makeProject, withHome, type Project } from './helpers.js';

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

/** Плагин с командой: пишет своё приветствие и возвращает объявленный код. */
const HELLO_PLUGIN = `
export default {
  name: 'hello-plugin',
  version: '0.1.0',
  commands: [
    {
      name: 'hello',
      spec: {
        description: 'поздороваться',
        positional: ['кого'],
        flags: { loud: { kind: 'boolean', description: 'громко' } },
      },
      run: (args, io, env) => {
        io.out('привет, ' + (args.positional[0] ?? 'мир') + (args.flags.loud === true ? '!' : ''));
        io.out('каталог: ' + env.cwd);
        io.out('плагинов: ' + env.registry.plugins.length);
        return 0;
      },
    },
  ],
};
`;

function withPlugin(body: string, config = 'plugins: ["./plugins/hello.mjs"]\n'): Project {
  const project = makeProject({ '.stepcast/config.yml': config });
  const path = join(project.root, '.stepcast', 'plugins', 'hello.mjs');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return project;
}

describe('plugin-contributions: команды плагина в CLI', () => {
  it('команда плагина исполняется и возвращает свой код', async () => {
    const project = withPlugin(HELLO_PLUGIN);

    const outcome = await cli(project, ['hello', 'мир', '--loud']);

    assert.equal(outcome.code, ExitCode.ok);
    assert.match(outcome.stdout, /привет, мир!/);
    assert.match(outcome.stdout, /плагинов: 1/);
  });

  it('команда плагина попадает в справку рядом со встроенными', async () => {
    const project = withPlugin(HELLO_PLUGIN);

    const outcome = await cli(project, ['help']);

    assert.match(outcome.stderr, /stepcast hello/);
    assert.match(outcome.stderr, /поздороваться/);
    assert.match(outcome.stderr, /stepcast run/);
  });

  it('неизвестная команда перечисляет и плагинные', async () => {
    const project = withPlugin(HELLO_PLUGIN);

    const outcome = await cli(project, ['нетакой']);

    assert.equal(outcome.code, ExitCode.configError);
    assert.match(outcome.stderr, /Неизвестная команда/);
    assert.match(outcome.stderr, /stepcast hello/);
  });

  it('код возврата команды плагина доезжает до процесса', async () => {
    const project = withPlugin(`
export default {
  name: 'hello-plugin',
  commands: [
    { name: 'hello', spec: { description: 'отказать' }, run: () => 1 },
  ],
};
`);

    const outcome = await cli(project, ['hello']);

    assert.equal(outcome.code, ExitCode.jobFailed);
  });

  it('отказ загрузки плагина прекращает любую команду, включая config', async () => {
    const project = makeProject({ '.stepcast/config.yml': 'plugins: ["./plugins/нет.mjs"]\n' });

    const outcome = await cli(project, ['config']);

    assert.equal(outcome.code, ExitCode.configError);
    assert.match(outcome.stderr, /не загружается/);
    // Конфигурация, которой не будет, не печатается: отчёт врал бы о составе.
    assert.equal(outcome.stdout, '');
  });

  it('команда плагина, спорящая за встроенное имя, отказывает с обоими претендентами', async () => {
    const project = withPlugin(`
export default {
  name: 'impostor',
  commands: [
    { name: 'run', spec: { description: 'подменить' }, run: () => 0 },
  ],
};
`);

    const outcome = await cli(project, ['config']);

    assert.equal(outcome.code, ExitCode.configError);
    assert.match(outcome.stderr, /Имя команды run занято/);
    assert.match(outcome.stderr, /встроенный вклад/);
    assert.match(outcome.stderr, /плагин impostor/);
    // Расположение печатается наравне с текстом, как у прочих отказов
    // загрузки: реестр про конфигурацию не знает, и файл объявления дописывает
    // загрузчик — иначе отказ приходит без ответа на вопрос «где объявлено».
    assert.match(outcome.stderr, /где: .*\.stepcast[/\\]config\.yml: plugins/);
  });

  it('отчёт config отсылает к команде, печатающей итоговое дерево со слоями', async () => {
    const project = withPlugin(HELLO_PLUGIN);

    const outcome = await cli(project, ['config']);

    assert.equal(outcome.code, ExitCode.ok, outcome.stderr);
    assert.match(outcome.stdout, /Плагины \(полное дерево со слоями и порядком — stepcast plugins\)/);
  });

  it('строка, отключённая патчем, не числится в отчёте действующей, но вклад её слоя показан объявленным', async () => {
    const project = withPlugin(HELLO_PLUGIN);
    writeFileSync(
      join(project.root, '.stepcast', 'plugins.patch.yml'),
      'version: 1\nkind: plugins-patch\nplugins:\n  - id: ./plugins/hello.mjs\n    use: ./plugins/hello.mjs\n    enabled: false\n',
    );

    const outcome = await cli(project, ['config']);

    assert.equal(outcome.code, ExitCode.ok, outcome.stderr);
    const line = outcome.stdout.split('\n').find((entry) => entry.startsWith('plugins'));
    assert.ok(line !== undefined, outcome.stdout);
    // Действующее значение — проекция дерева: отключённой строки в нём нет.
    assert.ok(!line.includes('hello.mjs'), line);
    assert.match(line, /нет/);
    // Вклад слоя — объявленное: конфигурация плагин называла, и отчёт это показывает.
    assert.match(line, /config\.yml \(1\)/);
    // Раздела о загруженных плагинах нет вовсе — загружать было нечего.
    assert.ok(!outcome.stdout.includes('hello-plugin'), outcome.stdout);
  });

  it('строка, добавленная одним лишь патчем, числится в отчёте действующей', async () => {
    const project = makeProject({});
    const path = join(project.root, '.stepcast', 'plugins', 'hello.mjs');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, HELLO_PLUGIN);
    writeFileSync(
      join(project.root, '.stepcast', 'plugins.patch.yml'),
      'version: 1\nkind: plugins-patch\nplugins:\n  - id: hello\n    use: ./plugins/hello.mjs\n',
    );

    const outcome = await cli(project, ['config']);

    assert.equal(outcome.code, ExitCode.ok, outcome.stderr);
    // Ключ `plugins` не объявлял ни один слой — строку принёс патч, и отчёт
    // всё равно обязан назвать её среди действующих.
    const line = outcome.stdout.split('\n').find((entry) => entry.startsWith('plugins'));
    assert.match(line ?? '', /\.\/plugins\/hello\.mjs/);
  });

  it('без объявленных плагинов CLI работает как прежде', async () => {
    const project = makeProject({});

    const outcome = await cli(project, ['config']);

    assert.equal(outcome.code, ExitCode.ok);
    assert.match(outcome.stdout, /backends\.claude\.command/);
  });
});

describe('plugin-contributions: предикат плагина через CLI', () => {
  /**
   * Сквозной путь: `stepcast lint` и `stepcast run` обязаны видеть предикат
   * плагина так же, как программный вызов. Проверка именно через CLI не
   * лишняя: реестр собирает точка входа, и команда, не передавшая его в
   * раскрытие, отклоняла бы валидный документ как опечатку — а тест,
   * зовущий `expandPipeline` с реестром напрямую, этого не заметил бы.
   */
  const PREDICATE_PLUGIN = `
export default {
  name: 'probe',
  predicates: [
    {
      name: 'always_ok',
      schema: { type: 'boolean' },
      evaluate: () => ({ predicate: 'always_ok', passed: true, hard: true }),
    },
  ],
};
`;

  const PIPELINE = `
version: 1
kind: pipeline
name: проба
jobs:
  build:
    steps:
      - id: say
        run: [echo, ок]
        expect: [{ exit_code: 0 }, { always_ok: true }]
`;

  function project(): Project {
    const box = withPlugin(PREDICATE_PLUGIN, 'plugins: ["./plugins/hello.mjs"]\n');
    writeFileSync(join(box.root, 'stepcast.yml'), PIPELINE);
    return box;
  }

  it('stepcast lint принимает документ с предикатом плагина', async () => {
    const outcome = await cli(project(), ['lint', 'stepcast.yml']);

    assert.equal(outcome.code, ExitCode.ok, outcome.stderr);
    assert.match(outcome.stdout, /^ok: /m);
  });

  it('stepcast run исполняет шаг с предикатом плагина', async () => {
    const outcome = await cli(project(), ['run', 'stepcast.yml', '--quiet']);

    assert.equal(outcome.code, ExitCode.ok, outcome.stderr);
    assert.match(outcome.stdout, /success/);
  });

  it('без объявленного плагина тот же документ отклоняется', async () => {
    const box = makeProject({ 'stepcast.yml': PIPELINE });

    const outcome = await cli(box, ['lint', 'stepcast.yml']);

    assert.equal(outcome.code, ExitCode.configError);
    // Диагностику разбора печатает сама команда, а не обработчик ошибок.
    assert.match(outcome.stdout, /неизвестный ключ always_ok/);
  });
});

describe('plugin-contributions: умолчания бэкенда плагина через CLI', () => {
  /**
   * Точка входа разрешает конфигурацию вместе с плагинами, и `stepcast config`
   * показывает `backends.<имя>` плагина источником `plugin:<имя>`. Команды,
   * читавшие конфигурацию заново сами, этот слой теряли: `lint` и `run`
   * отказывали «неизвестный бэкенд», хотя плагин загружен, а его умолчания
   * напечатаны строкой выше. Нашёл это первый настоящий адаптер (Codex).
   */
  const BACKEND_PLUGIN = `
export default {
  name: 'probe-backend',
  backends: {
    probe: {
      create: (config) => ({
        name: 'probe',
        capabilities: { sessions: false, structuredOutput: false, strictPermissions: false, mcp: false, sessionIdSource: 'engine' },
        launch: (invocation) => ({ command: [config.command], stdin: invocation.prompt }),
        parseLine: () => ({ kind: 'ignored' }),
      }),
      defaults: { command: 'probe-cli', sessions: false, structured_output: false },
    },
  },
};
`;

  const PIPELINE = `
version: 1
kind: pipeline
name: проба-бэкенда
jobs:
  ask:
    steps:
      - id: say
        agent: probe
        prompt: "привет"
        expect: [{ exit_code: 0 }]
`;

  function project(): Project {
    const box = withPlugin(BACKEND_PLUGIN, 'plugins: ["./plugins/hello.mjs"]\n');
    writeFileSync(join(box.root, 'stepcast.yml'), PIPELINE);
    return box;
  }

  it('stepcast lint видит бэкенд, объявленный умолчаниями плагина', async () => {
    const outcome = await cli(project(), ['lint', 'stepcast.yml']);

    assert.equal(outcome.code, ExitCode.ok, outcome.stdout + outcome.stderr);
    assert.match(outcome.stdout, /^ok: /m);
  });

  it('stepcast run --dry-run доходит до проверки с тем же бэкендом', async () => {
    const outcome = await cli(project(), ['run', 'stepcast.yml', '--dry-run']);

    assert.equal(outcome.code, ExitCode.ok, outcome.stdout + outcome.stderr);
    assert.match(outcome.stdout, /проверка пройдена/);
  });
});

