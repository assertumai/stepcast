import { ExitCode, type ExitCodeValue } from '../core/errors.js';
import { parseArgs, type CommandSpec } from './args.js';
import { reportError } from './output.js';
import { runApplyCommand } from './commands/apply.js';
import { runBacklogCommand } from './commands/backlog.js';
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
};

export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly cwd: string;
}

export async function run(argv: readonly string[], io: CliIo): Promise<ExitCodeValue> {
  try {
    const args = parseArgs(argv, COMMANDS);
    switch (args.command) {
      case 'run':
        return await runRunCommand(args, io.out, io.cwd);
      case 'resume':
        return await runResumeCommand(args, io.out, io.cwd);
      case 'diff':
        return runDiffCommand(args, io.out, io.cwd);
      case 'apply':
        return runApplyCommand(args, io.out, io.cwd);
      case 'lint':
        return runLintCommand(args, io.out, io.cwd);
      case 'status':
        return runStatusCommand(args, io.out, io.cwd);
      case 'logs':
        return await runLogsCommand(args, io.out, io.cwd);
      case 'config':
        return runConfigCommand(args, io.out, io.cwd);
      case 'gc':
        return runGcCommand(args, io.out, io.cwd);
      case 'init':
        return runInitCommand(args, io.out, io.cwd);
      case 'context':
        return runContextCommand(args, io.out, io.cwd);
      case 'up':
        return await runUpCommand(args, io.out, io.cwd);
      case 'down':
        return runDownCommand(args, io.out, io.cwd);
      case 'usage':
        return runUsageCommand(args, io.out, io.cwd);
      case 'backlog':
        return runBacklogCommand(args, io.out, io.cwd);
      case 'data':
        return runDataCommand(args, io.out);
      case 'merge-lanes':
        return await runMergeLanesCommand(args, io.out, io.cwd);
      default:
        return ExitCode.configError;
    }
  } catch (error) {
    return reportError(error, io.err);
  }
}
