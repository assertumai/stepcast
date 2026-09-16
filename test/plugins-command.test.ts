import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { CliIo } from '../src/cli/args.js';
import { CACHED_REGISTRY_ATTRIBUTION, outcomeWithoutLoad, runPluginsCommand } from '../src/cli/commands/plugins.js';
import { run as runCli } from '../src/cli/main.js';
import { ExitCode, type ExitCodeValue } from '../src/core/errors.js';
import { createBuiltinKernel } from '../src/parts/builtin.js';
import { BUILTIN_ROW_IDS } from '../src/parts/rows.js';
import type { TreeRow } from '../src/core/plugins/tree.js';
import { daemonPaths, writeRecord } from '../src/ui/daemon.js';
import { makeProject, MINIMAL_PIPELINE, withHome, type Project } from './helpers.js';

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
    // Пять колонок дерева — на прежних четырёх строках. Первой стоит строка
    // `pipeline` (design.md `pipeline-owns-services`, Решение 1) с объявленными
    // сервисами; каждая из семи строк-потребителей (`backend-claude`,
    // `predicates`, `step-run`, `step-uses`, `step-script`, `step-agent`,
    // `step-decision`) названа и запрошенным сервисом, и своим вкладом —
    // Решение 2. Раздел встроенного вне строк дерева сузился до сервиса
    // `commands`: служебные сервисы пайплайна переехали в строку `pipeline`.
    // Раздел витрины — двумя строками в конце, демон в этом тесте не поднят.
    assert.equal(lines.length, 30);
    assert.match(lines[0] ?? '', /^1\s+pipeline\s+встроенный\s+stepcast:pipeline\s+действует$/);
    assert.equal(lines[1], '    сервисы объявлены: backends, predicates, steps');
    assert.match(lines[2] ?? '', /^2\s+backend-claude\s+встроенный\s+stepcast:backend-claude\s+действует$/);
    assert.equal(lines[3], '    сервисы запрошены: backends (разрешён)');
    assert.equal(lines[4], '    вклады: backends: claude');
    assert.match(lines[5] ?? '', /^3\s+predicates\s+встроенный\s+stepcast:predicates\s+действует$/);
    assert.equal(lines[6], '    сервисы запрошены: predicates (разрешён)');
    assert.equal(
      lines[7],
      '    вклады: predicates: exit_code, file_exists, schema, matches, not_matches, changed_only, knowledge_valid, cmd, script, judge',
    );
    assert.match(lines[8] ?? '', /^4\s+step-run\s+встроенный\s+stepcast:step-run\s+действует$/);
    assert.equal(lines[9], '    сервисы запрошены: steps (разрешён)');
    assert.equal(lines[10], '    вклады: steps: run');
    assert.match(lines[11] ?? '', /^5\s+step-uses\s+встроенный\s+stepcast:step-uses\s+действует$/);
    assert.equal(lines[12], '    сервисы запрошены: steps (разрешён)');
    assert.equal(lines[13], '    вклады: steps: uses');
    assert.match(lines[14] ?? '', /^6\s+step-script\s+встроенный\s+stepcast:step-script\s+действует$/);
    assert.equal(lines[15], '    сервисы запрошены: steps (разрешён)');
    assert.equal(lines[16], '    вклады: steps: script');
    assert.match(lines[17] ?? '', /^7\s+step-agent\s+встроенный\s+stepcast:step-agent\s+действует$/);
    assert.equal(lines[18], '    сервисы запрошены: steps (разрешён)');
    assert.equal(lines[19], '    вклады: steps: agent');
    assert.match(lines[20] ?? '', /^8\s+step-decision\s+встроенный\s+stepcast:step-decision\s+действует$/);
    assert.equal(lines[21], '    сервисы запрошены: steps (разрешён)');
    assert.equal(lines[22], '    вклады: steps: decision');
    assert.match(
      lines[23] ?? '',
      new RegExp(`^9\\s+home-extra\\s+${escapeRegExp(join(project.home, '.stepcast', 'plugins.patch.yml'))}\\s+\\./home-extra\\.mjs\\s+действует$`),
    );
    assert.match(
      lines[24] ?? '',
      new RegExp(`^10\\s+project-extra\\s+${escapeRegExp(join(project.root, '.stepcast', 'plugins.patch.yml'))}\\s+\\./project-extra\\.mjs\\s+действует$`),
    );
    assert.equal(lines[25], 'встроенный (вне строк дерева):');
    assert.equal(lines[26], '    сервисы объявлены: commands');
    assert.match(lines[27] ?? '', /^ {4}вклады: commands: /);
    assert.doesNotMatch(lines[27] ?? '', /steps:/);
    assert.doesNotMatch(lines[27] ?? '', /predicates:/);
    assert.equal(lines[28], '');
    assert.equal(lines[29], 'витрина: демон витрины не запущен');
  });

  it('вклад, внесённый на корневой области вне строк дерева, назван встроенным и не приписан строке', async () => {
    const project = makeProject({});

    const outcome = await cli(project, ['plugins']);

    assert.equal(outcome.code, ExitCode.ok);
    const lines = outcome.stdout.split('\n');
    const builtinIndex = lines.findIndex((line) => line === 'встроенный (вне строк дерева):');
    assert.ok(builtinIndex !== -1, 'раздел встроенного вне строк дерева напечатан');
    const section = lines.slice(builtinIndex).join('\n');
    // Встроенные команды CLI регистрируются на корне до применения первой
    // строки — ни одной строке они не принадлежат и обязаны быть названы
    // встроенным владельцем (`plugin-introspection`, «Вклад без строки не
    // приписан наугад»). Служебные сервисы движка пайплайнов (`backends`,
    // `predicates`, `steps`) с этим разделом больше не связаны вовсе: их
    // заводит строка `pipeline`, а виды шага вносят строки `step-*`
    // (`pipeline-owns-services`, `builtin-step-kinds-as-rows`).
    assert.doesNotMatch(section, /steps:/);
    assert.doesNotMatch(section, /predicates:/);
    assert.match(section, /commands: /);
    // Вклад строки `backend-claude` остался за своей строкой: во встроенное вне
    // строк он не попал.
    assert.ok(!section.includes('backends: claude'), 'вклад строки не продублирован во встроенном');
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
    // Вклады соседних строк по-прежнему называются — отказ одной строки не
    // теряет их (`plugin-introspection`, «Осмотр после отказа загрузки»); за
    // строкой `pipeline` и семью строками-потребителями идёт раздел
    // встроенного вне строк дерева (три строки) и раздел витрины (две).
    assert.equal(lines.length, 30);
    assert.match(lines[0] ?? '', /действует/); // pipeline применилась раньше отказавшей
    assert.equal(lines[1], '    сервисы объявлены: backends, predicates, steps');
    assert.match(lines[2] ?? '', /действует/); // backend-claude загрузилась раньше отказавшей
    assert.equal(lines[3], '    сервисы запрошены: backends (разрешён)');
    assert.equal(lines[4], '    вклады: backends: claude');
    assert.match(lines[5] ?? '', /действует/); // predicates — тоже раньше отказавшей
    assert.match(lines[7] ?? '', /^ {4}вклады: predicates: /);
    assert.match(lines[8] ?? '', /действует/); // step-run
    assert.equal(lines[10], '    вклады: steps: run');
    assert.match(lines[11] ?? '', /действует/);
    assert.equal(lines[13], '    вклады: steps: uses');
    assert.match(lines[14] ?? '', /действует/);
    assert.equal(lines[16], '    вклады: steps: script');
    assert.match(lines[17] ?? '', /действует/);
    assert.equal(lines[19], '    вклады: steps: agent');
    assert.match(lines[20] ?? '', /действует/);
    assert.equal(lines[22], '    вклады: steps: decision');
    assert.match(lines[23] ?? '', /отказ:/);
    assert.match(lines[23] ?? '', /не загружается/);
    assert.match(lines[24] ?? '', /не загружалась/);
    assert.equal(lines[25], 'встроенный (вне строк дерева):');
    assert.equal(lines[28], '');
    assert.equal(lines[29], 'витрина: демон витрины не запущен');
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
    const lines = outcome.stdout.split('\n');
    const index = lines.findIndex((entry) => entry.includes('ждун.mjs'));
    assert.match(lines[index] ?? '', /отказ:/);
    assert.match(lines[index] ?? '', /нет-такого-сервиса/);
    // Неразрешённое имя видно моделью, а не одним текстом причины
    // (`plugin-introspection`, «Запрошенное и не разрешённое»): строка отказала,
    // но её область жива, и осмотр называет, чего она ждёт.
    assert.equal(lines[index + 1], '    сервисы запрошены: нет-такого-сервиса (не разрешён)');
  });

  it('незакрытое внедрение видно и в машинном выводе неразрешённым именем, а не только в тексте причины', async () => {
    const project = makeProject({ '.stepcast/config.yml': 'plugins: ["./plugins/ждун.mjs"]\n' });
    mkdirSync(join(project.root, '.stepcast', 'plugins'), { recursive: true });
    writeFileSync(
      join(project.root, '.stepcast', 'plugins', 'ждун.mjs'),
      'export default { name: "ждун", inject: ["нет-такого-сервиса"], apply() {} };\n',
    );

    const outcome = await cli(project, ['plugins', '--json']);

    assert.equal(outcome.code, ExitCode.configError);
    const payload = JSON.parse(outcome.stdout) as {
      own: {
        rows: readonly {
          use: string;
          state: { kind: string; reason?: string };
          requestedServices: readonly { name: string; resolved: boolean }[];
        }[];
      };
    };
    const row = payload.own.rows.find((candidate) => candidate.use === './plugins/ждун.mjs');
    assert.equal(row?.state.kind, 'failed');
    assert.deepEqual(row?.requestedServices, [{ name: 'нет-такого-сервиса', resolved: false }]);
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

describe('user-plugins: stepcast plugins печатает каталожные строки', () => {
  it('называет каталог и слой у строк обоих слоёв, а не «встроенный» и не путь файла', async () => {
    const project = makeProject({});
    // Заводим каталоги вручную — project.write ограничен корнем проекта.
    mkdirSync(join(project.home, '.stepcast', 'plugins', 'home-clock'), { recursive: true });
    writeFileSync(
      join(project.home, '.stepcast', 'plugins', 'home-clock', 'plugin.json'),
      JSON.stringify({ server: 'server.mjs' }),
    );
    writeFileSync(
      join(project.home, '.stepcast', 'plugins', 'home-clock', 'server.mjs'),
      EMPTY_PLUGIN('home-clock'),
    );
    mkdirSync(join(project.root, '.stepcast', 'plugins', 'project-clock'), { recursive: true });
    writeFileSync(
      join(project.root, '.stepcast', 'plugins', 'project-clock', 'plugin.json'),
      JSON.stringify({ server: 'server.mjs' }),
    );
    writeFileSync(
      join(project.root, '.stepcast', 'plugins', 'project-clock', 'server.mjs'),
      EMPTY_PLUGIN('project-clock'),
    );

    const outcome = await cli(project, ['plugins']);

    assert.equal(outcome.code, ExitCode.ok);
    const homeLine = outcome.stdout.split('\n').find((entry) => entry.includes('home-clock'));
    const projectLine = outcome.stdout.split('\n').find((entry) => entry.includes('project-clock'));
    assert.match(
      homeLine ?? '',
      new RegExp(`${escapeRegExp(join(project.home, '.stepcast', 'plugins', 'home-clock'))}.*\\(дом\\)`),
    );
    assert.match(
      projectLine ?? '',
      new RegExp(`${escapeRegExp(join(project.root, '.stepcast', 'plugins', 'project-clock'))}.*\\(проект\\)`),
    );
    assert.match(homeLine ?? '', /действует/);
    assert.match(projectLine ?? '', /действует/);
  });

  it('каталог, названный именем встроенной строки, напечатан отказавшим рядом с ней — и команда работает', async () => {
    const project = makeProject({});
    mkdirSync(join(project.home, '.stepcast', 'plugins', 'backend-claude'), { recursive: true });

    const outcome = await cli(project, ['plugins']);

    assert.equal(outcome.code, ExitCode.ok, 'чужая папка с неудачным именем не валит команду');
    const lines = outcome.stdout.split('\n').filter((entry) => entry.includes('backend-claude'));
    assert.equal(lines.length, 2, 'встроенная строка и отказавшая каталожная — обе на месте');
    assert.match(lines[0] ?? '', /встроенный/);
    assert.match(lines[0] ?? '', /действует/);
    assert.match(lines[1] ?? '', /\(дом\)/);
    assert.match(lines[1] ?? '', /отказ:.*встроенной строки/);
  });

  it('каталожная строка без манифеста показана отказавшей с причиной, а команда не прекращается', async () => {
    const project = makeProject({});
    mkdirSync(join(project.home, '.stepcast', 'plugins', 'broken'), { recursive: true });

    const outcome = await cli(project, ['plugins']);

    assert.equal(outcome.code, ExitCode.ok, 'мягкий отказ каталожной строки не меняет код возврата');
    const line = outcome.stdout.split('\n').find((entry) => entry.includes('broken'));
    assert.match(line ?? '', /отказ:/);
  });
});

/** Плагин контекста, объявляющий сервис `own-name` без вклада, — для проверки печати сервисов. */
const SERVICE_PROVIDER = `
export default function provider(ctx) {
  ctx.provide('published-service');
  ctx.set('published-service', {});
}
`;

const SERVICE_CONSUMER = `
export default function consumer(ctx) {}
consumer.inject = ['published-service'];
`;

describe('plugin-introspection: печать сервисов и вкладов строки', () => {
  it('первая строка названа со своим вкладом и объявленным сервисом, вторая — с запрошенным именем и признаком «разрешён»', async () => {
    const project = makeProject({
      '.stepcast/config.yml': 'plugins: ["./plugins/provider.mjs", "./plugins/consumer.mjs"]\n',
    });
    mkdirSync(join(project.root, '.stepcast', 'plugins'), { recursive: true });
    writeFileSync(join(project.root, '.stepcast', 'plugins', 'provider.mjs'), SERVICE_PROVIDER);
    writeFileSync(join(project.root, '.stepcast', 'plugins', 'consumer.mjs'), SERVICE_CONSUMER);

    const outcome = await cli(project, ['plugins']);

    assert.equal(outcome.code, ExitCode.ok);
    const lines = outcome.stdout.split('\n');
    const providerIndex = lines.findIndex((line) => line.includes('provider.mjs'));
    const consumerIndex = lines.findIndex((line) => line.includes('consumer.mjs'));
    assert.ok(providerIndex !== -1 && consumerIndex !== -1);
    assert.equal(lines[providerIndex + 1], '    сервисы объявлены: published-service');
    assert.equal(lines[consumerIndex + 1], '    сервисы запрошены: published-service (разрешён)');
  });

  it('слот отчёта — имя объявленного сервиса с префиксом slot: помечено «(слот)»', async () => {
    const project = makeProject({ '.stepcast/config.yml': 'plugins: ["./plugins/provider.mjs"]\n' });
    mkdirSync(join(project.root, '.stepcast', 'plugins'), { recursive: true });
    writeFileSync(
      join(project.root, '.stepcast', 'plugins', 'provider.mjs'),
      "export default function provider(ctx) { ctx.provide('slot:widgets'); ctx.set('slot:widgets', {}); }\n",
    );

    const outcome = await cli(project, ['plugins']);

    assert.equal(outcome.code, ExitCode.ok);
    const lines = outcome.stdout.split('\n');
    const providerIndex = lines.findIndex((entry) => entry.includes('provider.mjs'));
    assert.ok(providerIndex !== -1);
    assert.equal(lines[providerIndex + 1], '    сервисы объявлены: slot:widgets (слот)');
  });
});

describe('plugin-introspection: --json печатает ту же модель машинно', () => {
  it('вывод целиком разбирается как JSON, несёт version и покрывает состав вкладов и сервисов', async () => {
    const project = makeProject({
      '.stepcast/config.yml': 'plugins: ["./plugins/provider.mjs", "./plugins/consumer.mjs"]\n',
    });
    mkdirSync(join(project.root, '.stepcast', 'plugins'), { recursive: true });
    writeFileSync(join(project.root, '.stepcast', 'plugins', 'provider.mjs'), SERVICE_PROVIDER);
    writeFileSync(join(project.root, '.stepcast', 'plugins', 'consumer.mjs'), SERVICE_CONSUMER);

    const outcome = await cli(project, ['plugins', '--json']);

    assert.equal(outcome.code, ExitCode.ok);
    const payload = JSON.parse(outcome.stdout) as {
      own: {
        version: number;
        surface: string;
        rows: readonly Record<string, unknown>[];
        builtin: { owner: string; contributions: Record<string, readonly string[]> };
        attribution: { available: boolean };
      };
      daemon: { available: boolean };
    };
    assert.equal(payload.own.version, 2);
    assert.equal(payload.own.surface, 'cli');
    assert.equal(payload.daemon.available, false);
    // Встроенное вне строк дерева и признак приписывания — часть той же модели:
    // человеческий вывод выводим из неё целиком (`plugin-introspection`,
    // «Машинный формат … MUST совпадать с моделью осмотра по составу полей»).
    assert.equal(payload.own.builtin.owner, 'встроенный');
    // Виды шага и предикаты больше не встроенное вне строк — их сервисы
    // заводит строка `pipeline`, а вклады вносят строки-потребители
    // (`pipeline-owns-services`, `builtin-step-kinds-as-rows`): карта вкладов
    // не перечисляет их сервисы вовсе, а не пустыми списками.
    assert.equal(payload.own.builtin.contributions.steps, undefined);
    assert.equal(payload.own.builtin.contributions.predicates, undefined);
    const predicatesRow = payload.own.rows.find((row) => row.id === 'predicates') as
      | { contributions: Record<string, readonly string[]> }
      | undefined;
    assert.ok(predicatesRow !== undefined, 'строка predicates видна в машинном выводе');
    assert.ok((predicatesRow?.contributions.predicates?.length ?? 0) === 10);
    assert.deepEqual(payload.own.attribution, { available: true });

    const providerRow = payload.own.rows.find((row) => row.use === './plugins/provider.mjs') as
      | { declaredServices: readonly { name: string }[] }
      | undefined;
    const consumerRow = payload.own.rows.find((row) => row.use === './plugins/consumer.mjs') as
      | { requestedServices: readonly { name: string; resolved: boolean }[] }
      | undefined;
    assert.deepEqual(providerRow?.declaredServices, [{ name: 'published-service', slot: false }]);
    assert.deepEqual(consumerRow?.requestedServices, [{ name: 'published-service', resolved: true }]);
  });
});

describe('plugin-introspection: раздел витрины', () => {
  it('витрина не поднята: своё дерево напечатано целиком, раздел называет причину, код возврата прежний', async () => {
    const project = makeProject({});

    const outcome = await cli(project, ['plugins']);

    assert.equal(outcome.code, ExitCode.ok);
    assert.match(outcome.stdout, /витрина: демон витрины не запущен/);
  });

  it('демон поднят: печатаются два дерева, второе — названное чужим со своим портом', async () => {
    const project = makeProject({});

    const outcome = await withDaemon(project, DAEMON_INTROSPECTION, () => cli(project, ['plugins']));

    assert.equal(outcome.result.code, ExitCode.ok);
    assert.match(outcome.result.stdout, new RegExp(`витрина \\(демон на порту ${outcome.port}`));
    assert.match(outcome.result.stdout, /ui-shell/);
    // Дерево команды и дерево демона не слиты: их собственные встроенные
    // строки (`backend-claude` у команды, `ui-shell` у демона) обе на месте.
    assert.match(outcome.result.stdout, /backend-claude/);
  });

  it('ответ демона неполной формы: раздел называет причину, а команда не падает и кода возврата не меняет', async () => {
    const project = makeProject({});
    // Ответ сборки, у которой строки дерева другой формы: `contributions`,
    // `layer` и `state` отсутствуют. Прежняя проверка по одному корню пропустила
    // бы его в печать, и разыменование полей упало бы вне `try` запроса, сменив
    // код возврата (`plugin-introspection`: «неудача обращения любой природы
    // MUST NOT менять кода возврата»).
    const malformed = {
      version: 1,
      surface: 'daemon',
      rows: [{ place: 1, id: 'ui-shell', use: 'stepcast:ui-shell' }],
      builtin: DAEMON_INTROSPECTION.builtin,
      attribution: { available: true },
      browser: { available: false, reason: 'нет отчёта' },
    };

    const outcome = await withDaemon(project, malformed, () => cli(project, ['plugins']));

    assert.equal(outcome.result.code, ExitCode.ok);
    assert.match(outcome.result.stdout, /витрина: ответ демона не разобрался как осмотр/);
    // Своё дерево напечатано целиком.
    assert.match(outcome.result.stdout, /backend-claude/);
  });

  it('демон записан живым, но не отвечает: команда сдаётся по таймауту, названной причиной и прежним кодом возврата', async () => {
    const project = makeProject({});
    // Сервер принимает соединение и не отвечает вовсе: отказ соединения
    // вернулся бы мгновенно и ветвь `AbortController` не исполнилась бы.
    const sockets: { destroy: () => void }[] = [];
    const server: Server = createServer(() => {
      /* ответа нет: команда обязана сдаться по своему сроку, а не ждать */
    });
    server.on('connection', (socket) => sockets.push(socket));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = portOf(server);

    try {
      writeRecord(daemonPaths(project.home), { pid: process.pid, port, started_at: new Date().toISOString() });

      const started = Date.now();
      const outcome = await cli(project, ['plugins']);
      const elapsed = Date.now() - started;

      assert.equal(outcome.code, ExitCode.ok);
      assert.match(outcome.stdout, /витрина: демон не отвечает/);
      // Ровно свой срок: не мгновенный отказ соединения (иначе ветвь таймаута
      // не исполнялась бы) и не ожидание сверх названного срока.
      assert.ok(elapsed >= 500, `команда не ждала срока вовсе: ${elapsed} мс`);
      assert.ok(elapsed < 5000, `команда ждала дольше своего срока: ${elapsed} мс`);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

/** Осмотр, каким его отдаёт демон, — полной формы, иначе команда его не примет. */
const DAEMON_INTROSPECTION = {
  version: 2,
  surface: 'daemon',
  rows: [
    {
      place: 1,
      id: 'ui-shell',
      use: 'stepcast:ui-shell',
      layer: { kind: 'builtin' },
      state: { kind: 'active' },
      declaredServices: [],
      requestedServices: [],
      contributions: {},
    },
  ],
  builtin: {
    owner: 'встроенный',
    contributions: {},
    declaredServices: [],
  },
  attribution: { available: true },
  browser: { available: false, reason: 'осмотр не запрашивал состав браузерной половины' },
};

function portOf(server: Server): number {
  const address = server.address();
  return typeof address === 'object' && address !== null ? address.port : 0;
}

/**
 * Поднять подставной демон на петле, записать его порт в `ui.pid` домашнего
 * каталога проекта и выполнить тело — тем же путём, каким команда находит живой
 * демон (`runningDaemon`).
 */
async function withDaemon<T>(
  project: Project,
  body: unknown,
  run: (port: number) => Promise<T>,
): Promise<{ readonly port: number; readonly result: T }> {
  const server: Server = createServer((request, response) => {
    if (request.url === '/api/plugins') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = portOf(server);

  try {
    writeRecord(daemonPaths(project.home), { pid: process.pid, port, started_at: new Date().toISOString() });
    return { port, result: await run(port) };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('plugin-introspection: реестр пришёл готовым', () => {
  it('печать называет причину, по которой вклады и сервисы не разложены по строкам, а не выдаёт пустые перечни', async () => {
    const project = makeProject({});
    const rows: readonly TreeRow[] = [
      { id: 'backend-claude', use: 'stepcast:backend-claude', enabled: true, source: { kind: 'builtin' } },
    ];
    const stdout: string[] = [];
    const io: CliIo = { out: (line) => stdout.push(line), err: () => {}, cwd: project.root };

    // Путь вызова с готовым реестром (`resolveWithPlugins`, вариант `registry`):
    // итоги строк выведены из самих строк и областей не несут.
    const code = await withHome(project.home, () =>
      runPluginsCommand(
        { command: 'plugins', positional: [], flags: {} },
        io,
        rows.map((row) => outcomeWithoutLoad(row)),
        createBuiltinKernel(),
        CACHED_REGISTRY_ATTRIBUTION,
      ),
    );

    assert.equal(code, ExitCode.ok);
    const text = stdout.join('\n');
    assert.match(text, /^1\s+backend-claude/m);
    assert.match(text, /вклады и сервисы строкам не приписаны: реестр пришёл готовым/);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Патч, отключающий строку `pipeline` и всех её потребителей разом — состав
 * без единого сервиса пайплайна, но без единого незакрытого внедрения
 * (design.md изменения `pipeline-owns-services`, Решение 8, 9): загрузка
 * проходит целиком, а `Registry.missingServices` называет три имени.
 * Отключение одной только `pipeline` при включённых потребителях — другой,
 * прежний сценарий (отказ загрузки, `plugin-tree: отключение строки pipeline
 * при включённых потребителях`), здесь не проверяется.
 */
function disableAllPipelineRows(): string {
  const lines = ['version: 1', 'kind: plugins-patch', 'plugins:'];
  for (const id of BUILTIN_ROW_IDS) lines.push(`  - id: ${id}`, `    use: stepcast:${id}`, '    enabled: false');
  return `${lines.join('\n')}\n`;
}

describe('plugin-tree: команды в составе без единого сервиса пайплайна', () => {
  it('run отказывает названно кодом ошибки конфигурации, не доходя до разбора документа', async () => {
    const project = makeProject({ 'stepcast.yml': MINIMAL_PIPELINE });
    withProjectPatch(project, disableAllPipelineRows());

    const outcome = await cli(project, ['run', 'stepcast.yml']);

    assert.equal(outcome.code, ExitCode.configError);
    assert.match(outcome.stderr, /run/);
    assert.match(outcome.stderr, /backends|predicates|steps/);
    // Отказ до разбора документа: пайплайн синтаксически неверный дал бы
    // другой текст (об узнавании шага), а не о недостающем сервисе.
    assert.doesNotMatch(outcome.stderr, /неизвестен/);
  });

  it('stepcast plugins и stepcast config работают и печатают дерево целиком', async () => {
    const project = makeProject({});
    withProjectPatch(project, disableAllPipelineRows());

    const plugins = await cli(project, ['plugins']);
    assert.equal(plugins.code, ExitCode.ok);
    assert.match(plugins.stdout, /pipeline/);
    assert.match(plugins.stdout, /backend-claude/);
    for (const id of BUILTIN_ROW_IDS) assert.match(plugins.stdout, new RegExp(`${id}.*отключена`));

    const config = await cli(project, ['config']);
    assert.equal(config.code, ExitCode.ok);
    assert.match(config.stdout, /Сервисы пайплайна не заведены: backends, predicates, steps/);
  });
});

/**
 * Проверка `CommandContribution.inject` идёт по действующему контексту, а не
 * по перечню недостающих сервисов реестра (находка ревью): реестр знает
 * только свои четыре доменных имени, и команда плагина, объявившая
 * зависимость от чужого сервиса, осталась бы вовсе непроверенной — падала бы
 * в собственном теле там, где контракт обещает названный отказ до вызова.
 */
describe('plugin-tree: inject команды плагина проверяется по контексту', () => {
  const COMMAND_PLUGIN = (injectName: string): string =>
    'export default function ownCommand(ctx) {\n' +
    "  ctx.commands.register('own-cmd', {\n" +
    "    name: 'own-cmd',\n" +
    "    spec: { description: 'своя команда' },\n" +
    `    inject: [${JSON.stringify(injectName)}],\n` +
    "    run: (args, io) => { io.out('тело команды исполнено'); return 0; },\n" +
    '  });\n' +
    '}\n' +
    "ownCommand.inject = ['commands'];\n";

  it('команда, ждущая сервис, которого не заводит никто, отказывает названно и не доходит до тела', async () => {
    const project = makeProject({});
    writeFileSync(join(project.home, '.stepcast', 'own-command.mjs'), COMMAND_PLUGIN('нет-такого-сервиса'));
    withHomePatch(project, 'version: 1\nkind: plugins-patch\nplugins:\n  - id: own-command\n    use: ./own-command.mjs\n');

    const outcome = await cli(project, ['own-cmd']);

    assert.equal(outcome.code, ExitCode.configError);
    assert.match(outcome.stderr, /own-cmd/);
    assert.match(outcome.stderr, /нет-такого-сервиса/);
    assert.match(outcome.stderr, /stepcast plugins/);
    assert.equal(outcome.stdout, '', 'тело команды исполняться не должно');
  });

  it('команда, ждущая имеющийся сервис, исполняется как обычно', async () => {
    const project = makeProject({});
    // Имя, которое в составе есть: сервис заводит строка `pipeline`. Проверка
    // по контексту не должна отказывать там, где сервис на месте.
    writeFileSync(join(project.home, '.stepcast', 'own-command.mjs'), COMMAND_PLUGIN('backends'));
    withHomePatch(project, 'version: 1\nkind: plugins-patch\nplugins:\n  - id: own-command\n    use: ./own-command.mjs\n');

    const outcome = await cli(project, ['own-cmd']);

    assert.equal(outcome.code, ExitCode.ok);
    assert.match(outcome.stdout, /тело команды исполнено/);
  });
});
