import { ExitCode, type ExitCodeValue } from '../core/errors.js';
import { parseArgs, type CommandSpec } from './args.js';
import { reportError } from './output.js';
import { runConfigCommand } from './commands/config.js';

export const COMMANDS: Record<string, CommandSpec> = {
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

export function run(argv: readonly string[], io: CliIo): ExitCodeValue {
  try {
    const args = parseArgs(argv, COMMANDS);
    switch (args.command) {
      case 'config':
        return runConfigCommand(args, io.out, io.cwd);
      default:
        return ExitCode.configError;
    }
  } catch (error) {
    return reportError(error, io.err);
  }
}
