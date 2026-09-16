import { resolveConfig } from '../core/config/resolve.js';
import { ExitCode, isStepcastError, StepcastError, type ExitCodeValue } from '../core/errors.js';
import { parseArgs, type CliIo, type CommandSpec } from './args.js';
import type { CommandContribution, CommandEnv } from '../core/plugins/contract.js';
import { kernelFromRegistry } from '../core/plugins/registry.js';
import { resolveWithPlugins } from '../parts/resolve.js';
import { reportError } from './output.js';
import { runApplyCommand } from './commands/apply.js';
import { runAssertCleanCommand } from './commands/assert-clean.js';
import { runBacklogCommand } from './commands/backlog.js';
import { runKnowledgeCommand } from './commands/knowledge.js';
import { runConfigCommand } from './commands/config.js';
import { runDataCommand } from './commands/data.js';
import { runDecideCommand } from './commands/decide.js';
import { runContextCommand } from './commands/context.js';
import { runDiffCommand } from './commands/diff.js';
import { runDownCommand } from './commands/down.js';
import { runGcCommand } from './commands/gc.js';
import { runInitCommand } from './commands/init.js';
import { runLintCommand } from './commands/lint.js';
import { runLogsCommand } from './commands/logs.js';
import { runMergeLanesCommand } from './commands/merge-lanes.js';
import {
  CACHED_REGISTRY_ATTRIBUTION,
  outcomeWithoutLoad,
  runPluginsCommand,
  runPluginsCommandAfterLoadFailure,
} from './commands/plugins.js';
import { runProjectCommand } from './commands/project.js';
import { runProposeCommand } from './commands/propose.js';
import { runWidgetsCommand } from './commands/widgets.js';
import { runResumeCommand } from './commands/resume.js';
import { runRunCommand } from './commands/run.js';
import { runSchemaCommand } from './commands/schema.js';
import { runStatusCommand } from './commands/status.js';
import { runUpCommand } from './commands/up.js';
import { runUsageCommand } from './commands/usage.js';

export const COMMANDS: Record<string, CommandSpec> = {
  run: {
    description: 'выполнить пайплайн',
    positional: ['pipeline'],
    flags: {
      input: { kind: 'keyValue', description: 'значение входа пайплайна: --input имя=значение' },
      'dry-run': { kind: 'boolean', description: 'только проверить, не запуская работы' },
      quiet: { kind: 'boolean', description: 'не печатать ход прогона' },
    },
  },
  lint: {
    description: 'статически проверить пайплайн, ничего не запуская',
    positional: ['pipeline'],
    flags: {
      input: { kind: 'keyValue', description: 'значение входа пайплайна: --input имя=значение' },
    },
  },
  status: {
    description: 'показать состояние прогона',
    flags: {
      run: { kind: 'string', description: 'идентификатор прогона, по умолчанию последний' },
      explain: {
        kind: 'boolean',
        description: 'объяснить по каждому шагу, будет ли он переиспользован при возобновлении',
      },
    },
  },
  logs: {
    description: 'показать логи прогона или шага',
    positional: ['run', 'job/step'],
    flags: {
      follow: { kind: 'boolean', description: 'продолжать показывать вывод по мере записи' },
    },
  },
  resume: {
    description: 'возобновить прогон, переиспользовав шаги с совпавшим ключом',
    positional: ['run'],
    flags: {
      from: { kind: 'string', description: 'начать заново с работы или шага: --from job[/step]' },
      set: { kind: 'keyValue', description: 'переопределить вход: --set имя=значение' },
      'dry-run': { kind: 'boolean', description: 'показать план, ничего не исполняя' },
    },
  },
  diff: {
    description: 'сравнить два прогона по ключам шагов, промптам, контексту и деревьям',
    positional: ['run-a', 'run-b'],
  },
  decide: {
    description: 'принять решение по ожиданию прогона: stepcast decide <run> <исход>',
    positional: ['run', 'outcome'],
    flags: {
      step: { kind: 'string', description: 'адрес ожидающего шага (job или job/step) — обязателен при нескольких ожиданиях' },
      reason: { kind: 'string', description: 'причина отклонения — обязательна для исхода с эффектом reject' },
      from: { kind: 'string', description: 'точка перезапуска job[/step] — обязательна для исхода с эффектом restart' },
    },
  },
  propose: {
    description:
      'предложить правку файла кабинета проекта: stepcast propose <цель> --from <файл> — единственный писатель очереди',
    positional: ['target'],
    flags: {
      from: { kind: 'string', description: 'файл с содержимым предложения — без него читается стандартный ввод' },
      reason: { kind: 'string', description: 'причина предложения, необязательна' },
    },
  },
  widgets: {
    description: 'печатать состав виджетов проекта: имя, файл, голые импорты и неразрешимые по действующей таблице',
    flags: {
      json: { kind: 'boolean', description: 'печатать тот же состав машинным JSON' },
    },
  },
  apply: {
    description: 'наложить результат изолированного прогона на текущее дерево',
    positional: ['run'],
    flags: {
      job: { kind: 'string', description: 'наложить только результат этой работы' },
      lane: { kind: 'string', description: 'наложить только результат этой дорожки, одним диффом' },
      force: {
        kind: 'boolean',
        description: 'снять отказ в повторном наложении дорожки, чей записанный исход — «сведена»',
      },
    },
  },
  config: {
    description: 'показать действующую конфигурацию и происхождение каждого значения',
    flags: {
      model: { kind: 'string', description: 'переопределить модель по умолчанию' },
      agent: { kind: 'string', description: 'переопределить бэкенд по умолчанию' },
    },
  },
  schema: {
    description:
      'записать в .stepcast/schema/ JSON Schema документов проекта, знающую предикаты загруженных плагинов',
    flags: {
      out: { kind: 'string', description: 'каталог вывода вместо .stepcast/schema/' },
    },
  },
  plugins: {
    description: 'печатать осмотр дерева плагинов: место, id, слой, модуль, состояние, сервисы и вклады',
    flags: {
      dump: {
        kind: 'boolean',
        description: 'то же самое — флаг ради совместимости, поведение команды от него не зависит',
      },
      json: {
        kind: 'boolean',
        description: 'печатать ту же модель осмотра машинным JSON, без единой строки сверх',
      },
    },
  },
  gc: {
    description:
      'уборка: две отдельные цели — файлы прогонов (умолчание) и записи хранилища расхода (--stats); без ключей только отчёт',
    flags: {
      'older-than': {
        kind: 'string',
        description: 'удалить прогоны (или, вместе с --stats, записи) старше этой длительности, например 30d',
      },
      stats: {
        kind: 'boolean',
        description: 'снять записи хранилища расхода вместо файлов прогонов; --failed и --project действуют только с ним',
      },
      failed: {
        kind: 'boolean',
        description: 'отбирать отказавшие прогоны — только вместе с --stats',
      },
      project: {
        kind: 'string',
        description: 'ограничить отбор ключом проекта — только вместе с --stats',
      },
    },
  },
  init: {
    description: 'создать stepcast.yml и пример работы в текущем каталоге',
    flags: {
      force: { kind: 'boolean', description: 'перезаписать существующий stepcast.yml' },
      knowledge: {
        kind: 'string',
        description: 'развернуть практику памяти вместо пайплайна: fs — встроенный источник',
      },
    },
  },
  up: {
    description: 'поднять витрину: наблюдение за всеми прогонами в браузере',
    flags: {
      foreground: {
        kind: 'boolean',
        description: 'держать сервер в текущем терминале, не отсоединяя его',
      },
    },
  },
  down: {
    description: 'остановить витрину',
  },
  context: {
    description: 'показать состав и размер контекста шага без запуска пайплайна',
    positional: ['pipeline'],
    flags: {
      job: { kind: 'string', description: 'работа, для которой считается контекст' },
      step: { kind: 'string', description: 'шаг, для которого считается контекст' },
      input: { kind: 'keyValue', description: 'значение входа пайплайна: --input имя=значение' },
    },
  },
  usage: {
    description: 'показать расход прогона по работам, шагам и попыткам',
    positional: ['run'],
  },
  knowledge: {
    description:
      'читать и проверять память репозитория: index|select|check|write, см. docs/knowledge.md',
    positional: ['action'],
    flags: {
      scope: { kind: 'string', description: 'select: области через запятую — src/**,test/**' },
      id: { kind: 'string', description: 'select: идентификаторы через запятую' },
      file: { kind: 'string', description: 'write: файл с описанием единицы знания' },
      stdin: { kind: 'boolean', description: 'write: читать описание со стандартного ввода' },
      json: { kind: 'boolean', description: 'вывести ответ источника как есть, машинным JSON' },
      publish: {
        kind: 'string',
        description:
          'check: опубликовать данными работы ключом true/false — есть ли среди нарушений index-overflow; только внутри шага прогона',
      },
      record: {
        kind: 'boolean',
        description:
          'check: датировать обнаруженные расхождения по якорям — без этого ключа check дерева не правит',
      },
    },
  },
  backlog: {
    description: 'вести очередь улучшений backlog.md: list|pick|finish|settle, см. docs/backlog.md',
    positional: ['action', 'slug'],
    flags: {
      file: { kind: 'string', description: 'путь к файлу очереди, по умолчанию backlog.md в рабочем каталоге' },
      slots: { kind: 'number', description: 'pick: сколько пунктов взять за раз, по умолчанию 1' },
      lanes: { kind: 'string', description: 'pick: раздать по дорожкам, имена через запятую — a,b' },
      only: {
        kind: 'string',
        description: 'pick: взять именно этот пункт по слагу, а не первый свободный по очерёдности',
      },
      'stale-hours': {
        kind: 'number',
        description: 'pick: порог давности зависшего in_progress в часах, по умолчанию 6',
      },
      'run-dir': {
        kind: 'string',
        description:
          'pick --lanes: каталог для файлов item-<дорожка>.json на каждую заполненную дорожку; settle: тот же каталог, обязателен',
      },
      status: { kind: 'string', description: 'finish: исход done либо failed' },
      reason: { kind: 'string', description: 'finish --status failed: причина отказа' },
    },
  },
  data: {
    description:
      'опубликовать данные работы, видимые в витрине и подстановкой ${jobs.<работа>.data.<ключ>}: set|merge|get',
    positional: ['action', 'key', 'value'],
    flags: {
      json: {
        kind: 'string',
        description: 'merge: объект вида {"ключ": "значение"}, дописываемый поверх опубликованного',
      },
    },
  },
  'merge-lanes': {
    description: 'свести названные дорожки прогона в дерево запуска: наложить, проверить, закоммитить зелёную',
    positional: ['run'],
    flags: {
      lanes: { kind: 'string', description: 'перечень дорожек через запятую, обязателен' },
      check: { kind: 'string', description: 'команда проверки объединённого дерева, обязателен' },
      file: { kind: 'string', description: 'путь к файлу очереди, по умолчанию backlog.md в рабочем каталоге' },
    },
  },
  'assert-clean': {
    description:
      'проверить чистоту каталога запуска и объявленных вложенных репозиториев (project.nested_repos), ничего не правя',
    flags: {
      allow: {
        kind: 'string',
        description: 'пути, правки которых чистоту не нарушают, через запятую',
      },
    },
  },
  project: {
    description:
      'repos: дополнить документ дорожек (backlog pick --lanes) объявлениями репозиториев конфигурации',
    positional: ['action'],
    flags: {
      file: {
        kind: 'string',
        description: 'repos: файл с документом дорожек вместо стандартного ввода',
      },
    },
  },
};

export type { CliIo } from './args.js';

/**
 * Команды, независимые от конфигурации: их исполнение не читает ни одного
 * значения действующей конфигурации и ни одного вклада реестра. Правило
 * проверяется чтением кода самой команды, а не удобством — это ровно три
 * встроенные команды сегодня; все прочие зовут `resolveConfig` внутри себя
 * либо читают `env.config`/`env.registry`, и остаются зависимыми.
 */
export const CONFIG_INDEPENDENT_COMMANDS: ReadonlySet<string> = new Set(['data', 'down', 'init']);

/**
 * Встроенные команды как вклады: тот же контракт, что у команд плагина.
 * Описание аргументов остаётся в `COMMANDS`, исполнение — здесь; всё вместе
 * складывается в реестр, и диспетчеризация не знает, встроенная команда или
 * внесённая плагином.
 */
export const BUILTIN_COMMANDS: readonly CommandContribution[] = [
  {
    name: 'run',
    spec: COMMANDS['run'] as CommandSpec,
    run: (args, io, env) => runRunCommand(args, io.out, env.cwd, env.registry, env.config),
  },
  {
    name: 'resume',
    spec: COMMANDS['resume'] as CommandSpec,
    run: (args, io, env) => runResumeCommand(args, io.out, env.cwd, env.registry, env.config),
  },
  {
    name: 'diff',
    spec: COMMANDS['diff'] as CommandSpec,
    run: (args, io, env) => runDiffCommand(args, io.out, env.cwd),
  },
  {
    // Встроенная, а не вклад строки (design.md изменения `user-decision-steps`,
    // решение 10): команда читает состояние прогона и пишет в его каталог, а
    // читатель журнала и его раскладка плагинам не опубликованы — публиковать
    // их ради одной команды значило бы обещать плагинам формат журнала.
    name: 'decide',
    spec: COMMANDS['decide'] as CommandSpec,
    run: (args, io, env) => runDecideCommand(args, io.out, env.cwd, env.registry, env.config),
  },
  {
    // Встроенная, тем же приёмом, что `decide` (`ui-proposals`, design.md
    // изменения `agent-edits-widgets`, Решение 2): единственный писатель
    // очереди читает `STEPCAST_RUN_DIR`/`STEPCAST_JOB`/`STEPCAST_STEP` из
    // окружения шага напрямую, публиковать их плагинам ради одной команды
    // незачем.
    name: 'propose',
    spec: COMMANDS['propose'] as CommandSpec,
    run: (args, io) => runProposeCommand(args, io.out, io.cwd, io.readStdin),
  },
  {
    name: 'widgets',
    spec: COMMANDS['widgets'] as CommandSpec,
    run: (args, io, env) => runWidgetsCommand(args, io.out, env.cwd),
  },
  {
    name: 'apply',
    spec: COMMANDS['apply'] as CommandSpec,
    run: (args, io, env) => runApplyCommand(args, io.out, env.cwd),
  },
  {
    name: 'lint',
    spec: COMMANDS['lint'] as CommandSpec,
    run: (args, io, env) => runLintCommand(args, io.out, env.cwd, env.registry, env.config),
  },
  {
    name: 'status',
    spec: COMMANDS['status'] as CommandSpec,
    run: (args, io, env) => runStatusCommand(args, io.out, env.cwd),
  },
  {
    name: 'logs',
    spec: COMMANDS['logs'] as CommandSpec,
    run: (args, io, env) => runLogsCommand(args, io.out, env.cwd),
  },
  {
    name: 'config',
    spec: COMMANDS['config'] as CommandSpec,
    run: (args, io, env) => runConfigCommand(args, io.out, env.cwd, env.registry),
  },
  {
    name: 'schema',
    spec: COMMANDS['schema'] as CommandSpec,
    run: (args, io, env) => runSchemaCommand(args, io.out, env.cwd, env.registry),
  },
  {
    name: 'plugins',
    spec: COMMANDS['plugins'] as CommandSpec,
    run: (args, io, env) =>
      runPluginsCommand(
        args,
        io,
        // Точка входа всегда загружает плагины заново для этой команды — итоги
        // определены. `undefined` остаётся на случай вызова с кешированным
        // реестром (`resolveWithPlugins`, вариант `registry`): тогда состояние
        // строки выводится из неё самой — заведомый отказ (`TreeRow.failure`)
        // со своей причиной, иначе `enabled`, как и до появления каталогов.
        env.pluginOutcomes ?? env.pluginTree.map((row) => outcomeWithoutLoad(row)),
        kernelFromRegistry(env.registry),
        // Выведенный из строк итог областей не несёт, и вклады с сервисами по
        // строкам не раскладываются. Это названная причина, а не пустые
        // перечни: ядро живо, а приписывать его вклады строкам по совпадению
        // имён осмотр не вправе (`plugin-introspection`, «Неизвестное осмотру
        // называется причиной, а не пустотой»).
        env.pluginOutcomes === undefined ? CACHED_REGISTRY_ATTRIBUTION : { available: true },
      ),
  },
  {
    name: 'gc',
    spec: COMMANDS['gc'] as CommandSpec,
    run: (args, io, env) => runGcCommand(args, io.out, env.cwd),
  },
  {
    name: 'init',
    spec: COMMANDS['init'] as CommandSpec,
    run: (args, io, env) => runInitCommand(args, io.out, env.cwd),
  },
  {
    name: 'context',
    spec: COMMANDS['context'] as CommandSpec,
    run: (args, io, env) => runContextCommand(args, io.out, env.cwd, env.registry),
  },
  {
    name: 'up',
    spec: COMMANDS['up'] as CommandSpec,
    run: (args, io, env) => runUpCommand(args, io.out, env.cwd),
  },
  {
    name: 'down',
    spec: COMMANDS['down'] as CommandSpec,
    run: (args, io, env) => runDownCommand(args, io.out, env.cwd),
  },
  {
    name: 'usage',
    spec: COMMANDS['usage'] as CommandSpec,
    run: (args, io, env) => runUsageCommand(args, io.out, env.cwd),
  },
  {
    name: 'backlog',
    spec: COMMANDS['backlog'] as CommandSpec,
    run: (args, io, env) => runBacklogCommand(args, io.out, env.cwd, io.err),
  },
  {
    name: 'knowledge',
    spec: COMMANDS['knowledge'] as CommandSpec,
    run: (args, io, env) => runKnowledgeCommand(args, io.out, env.cwd),
  },
  {
    name: 'data',
    spec: COMMANDS['data'] as CommandSpec,
    run: (args, io) => runDataCommand(args, io.out),
  },
  {
    name: 'merge-lanes',
    spec: COMMANDS['merge-lanes'] as CommandSpec,
    run: (args, io, env) => runMergeLanesCommand(args, io.out, env.cwd),
  },
  {
    name: 'assert-clean',
    spec: COMMANDS['assert-clean'] as CommandSpec,
    run: (args, io, env) => runAssertCleanCommand(args, env.cwd),
  },
  {
    name: 'project',
    spec: COMMANDS['project'] as CommandSpec,
    run: (args, io, env) => runProjectCommand(args, io.out, env.cwd, io.readStdin),
  },
];

/** Найти вклад встроенной команды по имени — без обращения к реестру плагинов. */
function findBuiltinCommand(name: string): CommandContribution | undefined {
  return BUILTIN_COMMANDS.find((contribution) => contribution.name === name);
}

/**
 * `CommandEnv` ранней ветки: настоящих `config` и `registry` в ней нет,
 * потому что она их не разрешает. Чтение любого из двух свойств — признак
 * того, что перечень независимых команд назвал команду неверно, и это
 * StepcastError с объяснением, а не встроенные умолчания: подставленное
 * умолчание превратило бы ошибку разметки в тихое неверное поведение.
 */
export function buildIndependentCommandEnv(name: string, cwd: string): CommandEnv {
  function readForbidden(): never {
    throw new StepcastError(
      `Команда ${name} объявлена независимой от конфигурации и не вправе читать её`,
    );
  }
  return {
    cwd,
    get config() {
      return readForbidden();
    },
    get registry() {
      return readForbidden();
    },
    get ctx() {
      return readForbidden();
    },
    get pluginTree() {
      return readForbidden();
    },
    get pluginOutcomes() {
      return readForbidden();
    },
  };
}

export async function run(argv: readonly string[], io: CliIo): Promise<ExitCodeValue> {
  try {
    const commandName = argv[0];
    if (commandName !== undefined && CONFIG_INDEPENDENT_COMMANDS.has(commandName)) {
      const contribution = findBuiltinCommand(commandName);
      // Перечень называет только имена встроенных команд — их вклад в
      // BUILTIN_COMMANDS обязан существовать. Отсутствие здесь — дефект
      // самого перечня, а не рантайм-случай, который стоит проглатывать.
      if (contribution === undefined) {
        throw new StepcastError(`Команда ${commandName} названа независимой, но не встроена`);
      }

      const args = parseArgs(argv, { [commandName]: contribution.spec });
      return await contribution.run(args, io, buildIndependentCommandEnv(commandName, io.cwd));
    }

    // Плагины загружаются до разбора аргументов: команда плагина обязана
    // попасть в перечень раньше, чем разбор объявит её неизвестной.
    let resolution: Awaited<ReturnType<typeof resolveWithPlugins>>;
    try {
      resolution = await resolveWithPlugins({ cwd: io.cwd }, { builtinCommands: BUILTIN_COMMANDS });
    } catch (error) {
      // Отказ загрузки одной из строк не заслоняет команду осмотра дерева
      // (design.md, Решение 8): для неё дерево печатается всё равно, а
      // строка-виновница несёт причину. Для прочих команд поведение прежнее —
      // отказ прекращает команду до диспетчеризации.
      if (commandName !== 'plugins' || !isStepcastError(error)) throw error;
      // Повторный разбор конфигурации без загрузки: если он тоже кинет, это
      // отказ разбора (а не загрузки), и команда обязана прекратиться как
      // прежде — исключение не перехватывается здесь второй раз.
      const resolved = resolveConfig({ cwd: io.cwd });
      const failureArgs = parseArgs(argv, { plugins: COMMANDS['plugins'] as CommandSpec }); // тот же разбор флагов, что и на обычном пути — неизвестный флаг отказывает так же.
      return await runPluginsCommandAfterLoadFailure(failureArgs, io, resolved, {
        projectRoot: io.cwd,
        builtinCommands: BUILTIN_COMMANDS,
      });
    }
    const { resolved, registry, ctx, outcomes } = resolution;

    const specs: Record<string, CommandSpec> = {};
    for (const [name, contribution] of registry.commands) specs[name] = contribution.spec;

    const args = parseArgs(argv, specs);
    const contribution = registry.commands.get(args.command);
    if (contribution === undefined) return ExitCode.configError;

    return await contribution.run(args, io, {
      cwd: io.cwd,
      config: resolved.config,
      registry,
      ctx,
      pluginTree: resolved.pluginTree,
      pluginOutcomes: outcomes,
    });
  } catch (error) {
    return reportError(error, io.err);
  }
}
