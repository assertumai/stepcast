import { ExitCode, type ExitCodeValue } from '../core/errors.js';
import { parseArgs, type CommandSpec } from './args.js';
import { reportError } from './output.js';
import { runConfigCommand } from './commands/config.js';
import { runLintCommand } from './commands/lint.js';
import { runLogsCommand } from './commands/logs.js';
import { runStatusCommand } from './commands/status.js';

export const COMMANDS: Record<string, CommandSpec> = {
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
    },
  },
  logs: {
    description: 'показать логи прогона или шага',
    positional: ['run', 'job/step'],
    flags: {
      follow: { kind: 'boolean', description: 'продолжать показывать вывод по мере записи' },
    },
  },
  config: {
    description: 'показать действующую конфигурацию и происхождение каждого значения',
    flags: {
      model: { kind: 'string', description: 'переопределить модель по умолчанию' },
      agent: { kind: 'string', description: 'переопределить бэкенд по умолчанию' },
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
      case 'lint':
        return runLintCommand(args, io.out, io.cwd);
      case 'status':
        return runStatusCommand(args, io.out, io.cwd);
      case 'logs':
        return await runLogsCommand(args, io.out, io.cwd);
      case 'config':
        return runConfigCommand(args, io.out, io.cwd);
      default:
        return ExitCode.configError;
    }
  } catch (error) {
    return reportError(error, io.err);
  }
}
