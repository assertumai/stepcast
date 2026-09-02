import { ExitCode, type ExitCodeValue } from '../core/errors.js';
import { parseArgs, type CliIo, type CommandSpec } from './args.js';
import type { CommandContribution } from '../core/plugins/contract.js';
import { resolveWithPlugins } from '../core/plugins/resolve.js';
import { reportError } from './output.js';
import { runApplyCommand } from './commands/apply.js';
import { runAssertCleanCommand } from './commands/assert-clean.js';
import { runBacklogCommand } from './commands/backlog.js';
import { runKnowledgeCommand } from './commands/knowledge.js';
import { runConfigCommand } from './commands/config.js';
import { runDataCommand } from './commands/data.js';
import { runContextCommand } from './commands/context.js';
import { runDiffCommand } from './commands/diff.js';
import { runDownCommand } from './commands/down.js';
import { runGcCommand } from './commands/gc.js';
import { runInitCommand } from './commands/init.js';
import { runLintCommand } from './commands/lint.js';
import { runLogsCommand } from './commands/logs.js';
import { runMergeLanesCommand } from './commands/merge-lanes.js';
import { runProjectCommand } from './commands/project.js';
import { runResumeCommand } from './commands/resume.js';
import { runRunCommand } from './commands/run.js';
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
  apply: {
    description: 'наложить результат изолированного прогона на текущее дерево',
    positional: ['run'],
    flags: {
      job: { kind: 'string', description: 'наложить только результат этой работы' },
      lane: { kind: 'string', description: 'наложить только результат этой дорожки, одним диффом' },
    },
  },
  config: {
    description: 'показать действующую конфигурацию и происхождение каждого значения',
    flags: {
      model: { kind: 'string', description: 'переопределить модель по умолчанию' },
      agent: { kind: 'string', description: 'переопределить бэкенд по умолчанию' },
    },
  },
  gc: {
    description: 'убрать прогоны: без --older-than только отчёт, ничего не удаляя',
    flags: {
      'older-than': {
        kind: 'string',
        description: 'удалить прогоны старше этой длительности, например 30d',
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
    },
  },
  backlog: {
    description: 'вести очередь улучшений backlog.md: list|pick|finish|settle, см. docs/backlog.md',
    positional: ['action', 'slug'],
    flags: {
      file: { kind: 'string', description: 'путь к файлу очереди, по умолчанию backlog.md в рабочем каталоге' },
      slots: { kind: 'number', description: 'pick: сколько пунктов взять за раз, по умолчанию 1' },
      lanes: { kind: 'string', description: 'pick: раздать по дорожкам, имена через запятую — a,b' },
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
 * Встроенные команды как вклады: тот же контракт, что у команд плагина.
 * Описание аргументов остаётся в `COMMANDS`, исполнение — здесь; всё вместе
 * складывается в реестр, и диспетчеризация не знает, встроенная команда или
 * внесённая плагином.
 */
export const BUILTIN_COMMANDS: readonly CommandContribution[] = [
  {
    name: 'run',
    spec: COMMANDS['run'] as CommandSpec,
    run: (args, io, env) => runRunCommand(args, io.out, env.cwd, env.registry),
  },
  {
    name: 'resume',
    spec: COMMANDS['resume'] as CommandSpec,
    run: (args, io, env) => runResumeCommand(args, io.out, env.cwd, env.registry),
  },
  {
    name: 'diff',
    spec: COMMANDS['diff'] as CommandSpec,
    run: (args, io, env) => runDiffCommand(args, io.out, env.cwd),
  },
  {
    name: 'apply',
    spec: COMMANDS['apply'] as CommandSpec,
    run: (args, io, env) => runApplyCommand(args, io.out, env.cwd),
  },
  {
    name: 'lint',
    spec: COMMANDS['lint'] as CommandSpec,
    run: (args, io, env) => runLintCommand(args, io.out, env.cwd, env.registry),
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
    run: (args, io, env) => runBacklogCommand(args, io.out, env.cwd),
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

export async function run(argv: readonly string[], io: CliIo): Promise<ExitCodeValue> {
  try {
    // Плагины загружаются до разбора аргументов: команда плагина обязана
    // попасть в перечень раньше, чем разбор объявит её неизвестной.
    const { resolved, registry } = await resolveWithPlugins(
      { cwd: io.cwd },
      { builtinCommands: BUILTIN_COMMANDS },
    );

    const specs: Record<string, CommandSpec> = {};
    for (const [name, contribution] of registry.commands) specs[name] = contribution.spec;

    const args = parseArgs(argv, specs);
    const contribution = registry.commands.get(args.command);
    if (contribution === undefined) return ExitCode.configError;

    return await contribution.run(args, io, { cwd: io.cwd, config: resolved.config, registry });
  } catch (error) {
    return reportError(error, io.err);
  }
}
