import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { CliIo } from '../src/cli/args.js';
import { run as runCli } from '../src/cli/main.js';
import { ExitCode, type ExitCodeValue } from '../src/core/errors.js';
import { makeProject, withHome, type Project } from './helpers.js';

/**
 * Команда осмотра дерева плагинов (`plugin-tree`, design.md, Решение 8):
 * `stepcast plugins` печатает итоговый состав вместе со слоями и переживает
 * отказ загрузки одной из строк — единственная команда с этим свойством.
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

function withHomePatch(project: Project, body: string): void {
  writeFileSync(join(project.home, '.stepcast', 'plugins.patch.yml'), body);
}

function withProjectPatch(project: Project, body: string): void {
  mkdirSync(join(project.root, '.stepcast'), { recursive: true });
  writeFileSync(join(project.root, '.stepcast', 'plugins.patch.yml'), body);
}

/** Минимальный плагин без вкладов — достаточен, чтобы модуль загрузился и прошёл контракт. */
const EMPTY_PLUGIN = (name: string): string => `export default { name: ${JSON.stringify(name)} };\n`;

describe('plugin-tree: stepcast plugins печатает дерево со слоями', () => {
  it('называет каждую строку с id, модулем и слоем; файловые слои — путями своих файлов', async () => {
    const project = makeProject({});
    writeFileSync(join(project.home, '.stepcast', 'home-extra.mjs'), EMPTY_PLUGIN('home-extra'));
    withHomePatch(project, 'version: 1\nkind: plugins-patch\nplugins:\n  - id: home-extra\n    use: ./home-extra.mjs\n');
    mkdirSync(join(project.root, '.stepcast'), { recursive: true });
    writeFileSync(join(project.root, '.stepcast', 'project-extra.mjs'), EMPTY_PLUGIN('project-extra'));
    withProjectPatch(
      project,
      'version: 1\nkind: plugins-patch\nplugins:\n  - id: project-extra\n    use: ./project-extra.mjs\n    after: home-extra\n',
    );

    const outcome = await cli(project, ['plugins']);

    assert.equal(outcome.code, ExitCode.ok);
    const lines = outcome.stdout.split('\n');
    assert.equal(lines.length, 3);
    assert.match(lines[0] ?? '', /^1\s+backend-claude\s+встроенный\s+stepcast:backend-claude\s+действует$/);
    assert.match(
      lines[1] ?? '',
      new RegExp(`^2\\s+home-extra\\s+${escapeRegExp(join(project.home, '.stepcast', 'plugins.patch.yml'))}\\s+\\./home-extra\\.mjs\\s+действует$`),
    );
    assert.match(
      lines[2] ?? '',
      new RegExp(`^3\\s+project-extra\\s+${escapeRegExp(join(project.root, '.stepcast', 'plugins.patch.yml'))}\\s+\\./project-extra\\.mjs\\s+действует$`),
    );
  });

  it('отключённая строка видна и называет файл, который её отключил', async () => {
    const project = makeProject({});
    withProjectPatch(project, 'version: 1\nkind: plugins-patch\nplugins:\n  - id: backend-claude\n    use: stepcast:backend-claude\n    enabled: false\n');

    const outcome = await cli(project, ['plugins']);

    assert.equal(outcome.code, ExitCode.ok);
    const line = outcome.stdout.split('\n').find((entry) => entry.includes('backend-claude'));
    assert.match(line ?? '', /отключена/);
    assert.match(line ?? '', new RegExp(escapeRegExp(join(project.root, '.stepcast', 'plugins.patch.yml'))));
  });

  it('--dump печатает то же самое', async () => {
    const project = makeProject({});

    const plain = await cli(project, ['plugins']);
    const dumped = await cli(project, ['plugins', '--dump']);

    assert.equal(dumped.code, ExitCode.ok);
    assert.equal(dumped.stdout, plain.stdout);
  });
});

describe('plugin-tree: отказ загрузки не заслоняет дерево', () => {
  it('дерево напечатано целиком, строка-виновница несёт причину, соседи ниже — «не загружалась», код возврата — ошибка конфигурации', async () => {
    const project = makeProject({ '.stepcast/config.yml': 'plugins: ["./plugins/нет.mjs", "./plugins/тоже-нет.mjs"]\n' });

    const outcome = await cli(project, ['plugins']);

    assert.equal(outcome.code, ExitCode.configError);
    const lines = outcome.stdout.split('\n');
    assert.equal(lines.length, 3);
    assert.match(lines[0] ?? '', /действует/); // встроенная строка загрузилась раньше отказавшей
    assert.match(lines[1] ?? '', /отказ:/);
    assert.match(lines[1] ?? '', /не загружается/);
    assert.match(lines[2] ?? '', /не загружалась/);
  });

  it('отказ о незакрытом внедрении тоже назван: строка-виновница несёт причину, а не числится действующей', async () => {
    // Плагин ждёт сервис, которого никто не регистрирует. Такой отказ рождается
    // не на строке, а после успокоения контекста, — и без успокоения команда
    // осмотра напечатала бы все строки действующими, вернув при этом код
    // ошибки (`plugin-tree`: строка-виновница называется вместе с причиной).
    const project = makeProject({ '.stepcast/config.yml': 'plugins: ["./plugins/ждун.mjs"]\n' });
    mkdirSync(join(project.root, '.stepcast', 'plugins'), { recursive: true });
    writeFileSync(
      join(project.root, '.stepcast', 'plugins', 'ждун.mjs'),
      'export default { name: "ждун", inject: ["нет-такого-сервиса"], apply() {} };\n',
    );

    const outcome = await cli(project, ['plugins']);

    assert.equal(outcome.code, ExitCode.configError);
    const line = outcome.stdout.split('\n').find((entry) => entry.includes('ждун.mjs'));
    assert.match(line ?? '', /отказ:/);
    assert.match(line ?? '', /нет-такого-сервиса/);
  });

  it('для прочих команд поведение прежнее: отказ загрузки прекращает команду до диспетчеризации', async () => {
    const project = makeProject({ '.stepcast/config.yml': 'plugins: ["./plugins/нет.mjs"]\n' });

    const outcome = await cli(project, ['config']);

    assert.equal(outcome.code, ExitCode.configError);
    assert.equal(outcome.stdout, '');
  });

  it('отказ разбора самой конфигурации по-прежнему валит команду plugins обычным путём', async () => {
    const project = makeProject({ '.stepcast/config.yml': 'plugins: [нет закрывающей\n' });

    const outcome = await cli(project, ['plugins']);

    assert.equal(outcome.code, ExitCode.configError);
    assert.equal(outcome.stdout, '');
    assert.match(outcome.stderr, /\.stepcast[/\\]config\.yml/);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
