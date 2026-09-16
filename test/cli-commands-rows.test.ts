import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { CliIo } from '../src/kernel/cli/args.js';
import { run as runCli } from '../src/parts/cli/main.js';
import { ExitCode, type ExitCodeValue } from '../src/kernel/errors.js';
import { makeProject, withHome, type Project } from './helpers.js';

/**
 * Встроенная команда — строка дерева (`plugin-tree`, дельта изменения
 * `cli-commands-as-rows`): её можно заменить патчем состава, отключить
 * поодиночке, обойти вставкой своей строки. Здесь проверяются ровно эти три
 * сценария дельты (находки ревью) — их не покрывали ни `plugins-command`, где
 * отключаются все восемнадцать доменных строк разом, ни
 * `cli-config-independence`, где отключается защищённая строка и срабатывает
 * другая ветка.
 */

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

function withProjectPatch(project: Project, body: string): void {
  mkdirSync(join(project.root, '.stepcast'), { recursive: true });
  writeFileSync(join(project.root, '.stepcast', 'plugins.patch.yml'), body);
}

/** Модуль плагина рядом с патчем: относительный `use` разрешается от каталога патча. */
function withProjectModule(project: Project, name: string, body: string): void {
  mkdirSync(join(project.root, '.stepcast'), { recursive: true });
  writeFileSync(join(project.root, '.stepcast', name), body);
}

/** Декларативный плагин с одной командой — тот же контракт, что у всякого плагина. */
function commandPlugin(pluginName: string, command: string, description: string, printed: string): string {
  return (
    'export default {\n' +
    `  name: ${JSON.stringify(pluginName)},\n` +
    '  commands: [\n' +
    '    {\n' +
    `      name: ${JSON.stringify(command)},\n` +
    `      spec: { description: ${JSON.stringify(description)} },\n` +
    `      run: (args, io) => { io.out(${JSON.stringify(printed)}); return 0; },\n` +
    '    },\n' +
    '  ],\n' +
    '};\n'
  );
}

/**
 * Перечень команд общей справки, по одной строке на команду и на флаг, с
 * отступами, снятыми обрезкой: первая строка подсказки печатается с лишним
 * отступом (`reportError`), и сравнивать перечни построчно иначе не выйдет.
 * Заголовок «ошибка: …» отброшен — он говорит о причине печати, а не о
 * составе.
 */
async function helpLines(project: Project): Promise<readonly string[]> {
  const outcome = await cli(project, []);
  assert.equal(outcome.code, ExitCode.configError);
  return outcome.stderr.split('\n').slice(1).map((line) => line.trim());
}

/** Тот же перечень без блока одной команды: её строка и следующие за ней строки флагов. */
function withoutCommandBlock(lines: readonly string[], command: string): readonly string[] {
  const start = lines.findIndex((line) => line === `stepcast ${command}` || line.startsWith(`stepcast ${command} `));
  assert.notEqual(start, -1, `команда ${command} обязана быть в справке дефолтного состава`);
  let end = start + 1;
  while (end < lines.length && lines[end]?.startsWith('--') === true) end += 1;
  return [...lines.slice(0, start), ...lines.slice(end)];
}

describe('plugin-tree: патч заменяет строку встроенной команды', () => {
  it('команда с тем же именем от модуля пользователя исполняет его тело, конфликта имён нет', async () => {
    const project = makeProject({});
    withProjectModule(
      project,
      'own-widgets.mjs',
      commandPlugin('own-widgets', 'widgets', 'свой состав виджетов', 'тело пользователя'),
    );
    withProjectPatch(
      project,
      'version: 1\nkind: plugins-patch\nplugins:\n  - id: command-widgets\n    use: ./own-widgets.mjs\n',
    );

    const outcome = await cli(project, ['widgets']);

    assert.equal(outcome.code, ExitCode.ok);
    assert.equal(outcome.stdout, 'тело пользователя');
    assert.equal(outcome.stderr, '', 'конфликта имён быть не должно: встроенная строка заменена целиком');

    // Встроенное тело не применялось вовсе: в справке стоит описание
    // пользователя, а не прежнее описание встроенной команды.
    const lines = await helpLines(project);
    assert.ok(
      lines.includes('stepcast widgets — свой состав виджетов'),
      `справка обязана называть команду пользователя: ${lines.join(' | ')}`,
    );
  });

  it('замена, не принёсшая одноимённой команды, отказывает названно: строка названа заменённой патчем', async () => {
    const project = makeProject({});
    withProjectModule(project, 'own-empty.mjs', "export default { name: 'own-empty' };\n");
    withProjectPatch(
      project,
      'version: 1\nkind: plugins-patch\nplugins:\n  - id: command-widgets\n    use: ./own-empty.mjs\n',
    );

    const outcome = await cli(project, ['widgets']);

    assert.equal(outcome.code, ExitCode.configError);
    assert.match(outcome.stderr, /widgets/);
    assert.match(outcome.stderr, /command-widgets/);
    assert.match(outcome.stderr, /заменена патчем состава, не принёсшим этой команды/);
    assert.match(outcome.stderr, /stepcast plugins/);
    // Не общая справка: отказ называет строку, а не перечисляет команды.
    assert.doesNotMatch(outcome.stderr, /Неизвестная команда/);
  });
});

describe('plugin-tree: патч отключает строку одной команды', () => {
  it('ядерная команда снята поодиночке: её в перечне нет, прочие команды стоят прежним порядком', async () => {
    const project = makeProject({});
    withProjectPatch(
      project,
      'version: 1\nkind: plugins-patch\nplugins:\n  - id: command-widgets\n    use: stepcast:command-widgets\n    enabled: false\n',
    );

    const outcome = await cli(project, ['widgets']);
    assert.equal(outcome.code, ExitCode.configError);
    assert.match(outcome.stderr, /command-widgets/);
    assert.match(outcome.stderr, /отключена патчем состава/);

    // Изоляция отключения: строки применяются по очереди, и отказ одной мог бы
    // остановить обход — перечень команд обязан отличаться от дефолтного ровно
    // на блок снятой команды и ничем больше.
    const patched = await helpLines(project);
    const plain = await helpLines(makeProject({}));
    assert.deepEqual(patched, withoutCommandBlock(plain, 'widgets'));

    // Соседняя команда не просто числится в перечне, а исполняется.
    const config = await cli(project, ['config']);
    assert.equal(config.code, ExitCode.ok);
    assert.match(config.stdout, /runs\.root/);
  });

  it('доменная команда снята поодиночке: соседние доменные команды доходят до собственных тел', async () => {
    const project = makeProject({});
    withProjectPatch(
      project,
      'version: 1\nkind: plugins-patch\nplugins:\n  - id: command-diff\n    use: stepcast:command-diff\n    enabled: false\n',
    );

    const outcome = await cli(project, ['diff', 'a', 'b']);
    assert.equal(outcome.code, ExitCode.configError);
    assert.match(outcome.stderr, /command-diff/);
    assert.match(outcome.stderr, /отключена патчем состава/);

    const patched = await helpLines(project);
    const plain = await helpLines(makeProject({}));
    assert.deepEqual(patched, withoutCommandBlock(plain, 'diff'));

    // Соседняя доменная команда осталась при своих сервисах: отказ приходит из
    // её тела (файла нет), а не от снятой строки.
    const lint = await cli(project, ['lint', 'nonexistent.yml']);
    assert.equal(lint.code, ExitCode.configError);
    assert.match(lint.stdout, /Файл не найден/);
  });
});

describe('plugin-tree: строка плагина вставлена перед строкой команды', () => {
  it('команда плагина регистрируется раньше и стоит в справке раньше, прочий порядок сохраняется', async () => {
    const project = makeProject({});
    withProjectModule(
      project,
      'own-first.mjs',
      commandPlugin('own-first', 'own-first', 'своя команда впереди всех', 'тело своей команды'),
    );
    withProjectPatch(
      project,
      'version: 1\nkind: plugins-patch\nplugins:\n  - id: own-first\n    use: ./own-first.mjs\n    before: command-run\n',
    );

    const patched = await helpLines(project);
    const plain = await helpLines(makeProject({}));

    const inserted = 'stepcast own-first — своя команда впереди всех';
    const at = patched.indexOf(inserted);
    assert.notEqual(at, -1, `команда плагина обязана быть в справке: ${patched.join(' | ')}`);
    assert.equal(patched[at + 1], plain[0], 'вставленная строка стоит прямо перед первой командой дефолта');
    assert.deepEqual([...patched.slice(0, at), ...patched.slice(at + 1)], plain, 'прочий порядок не изменился');

    const outcome = await cli(project, ['own-first']);
    assert.equal(outcome.code, ExitCode.ok);
    assert.equal(outcome.stdout, 'тело своей команды');
  });
});

/**
 * Каталог плагинов, названный идентификатором строки независимой команды
 * (находка ревью): защита строки от состава (`protectIndependentRows`,
 * `src/parts/pipeline/config/resolve.ts`) возвращает встроенную идентичность тому месту,
 * которое строка занимает, — а каталожная строка стоит в дереве отдельно,
 * своим отказом и своим путём, ровно как у прочих двадцати двух команд.
 */
describe('cli-commands-as-rows: каталог, названный идентификатором строки команды', () => {
  async function pluginsOutputFor(id: string): Promise<{ readonly project: Project; readonly outcome: Outcome }> {
    const project = makeProject({});
    mkdirSync(join(project.root, '.stepcast', 'plugins', id), { recursive: true });
    return { project, outcome: await cli(project, ['plugins']) };
  }

  it('защищённая строка: отказывает каталог своим текстом и своим путём, а не защитой строки', async () => {
    const { project, outcome } = await pluginsOutputFor('command-init');

    const lines = outcome.stdout.split('\n').filter((line) => line.includes('command-init'));
    const directoryLine = lines.find((line) => line.includes(join(project.root, '.stepcast', 'plugins', 'command-init')));
    assert.ok(directoryLine !== undefined, `каталожная строка обязана быть напечатана: ${outcome.stdout}`);
    assert.match(directoryLine, /отказ: Каталог плагина command-init назван идентификатором встроенной строки/);
    assert.doesNotMatch(directoryLine, /не распоряжается/);

    // Встроенная строка на месте и действует: каталог её не тронул.
    const builtinLine = lines.find((line) => line.includes('stepcast:command-init'));
    assert.ok(builtinLine !== undefined, `встроенная строка обязана остаться: ${outcome.stdout}`);
    assert.match(builtinLine, /встроенный/);
    assert.match(builtinLine, /действует$/);
  });

  it('незащищённая строка отказывает тем же текстом — поведение между командами не расходится', async () => {
    const { project, outcome } = await pluginsOutputFor('command-run');

    const directoryLine = outcome.stdout
      .split('\n')
      .find((line) => line.includes(join(project.root, '.stepcast', 'plugins', 'command-run')));
    assert.ok(directoryLine !== undefined, `каталожная строка обязана быть напечатана: ${outcome.stdout}`);
    assert.match(directoryLine, /отказ: Каталог плагина command-run назван идентификатором встроенной строки/);
  });

  it('сама независимая команда при таком каталоге исполняется прежним образом', async () => {
    const { project } = await pluginsOutputFor('command-init');

    const outcome = await cli(project, ['init']);
    assert.equal(outcome.code, ExitCode.ok);
  });
});
