import { ExitCode, type ExitCodeValue } from '../../core/errors.js';
import { daemonPaths, stopDaemon } from '../../ui/daemon.js';
import { commandRow } from '../commandRow.js';
import type { ParsedArgs } from '../args.js';

/**
 * `stepcast down` — остановить витрину.
 *
 * Отсутствие демона не ошибка: человек хотел, чтобы витрина не работала, и
 * она не работает. Отказ здесь заставлял бы писать проверку перед вызовом.
 */
export function runDownCommand(
  _args: ParsedArgs,
  write: (line: string) => void,
  _cwd: string,
): ExitCodeValue {
  const outcome = stopDaemon(daemonPaths());

  write(outcome === 'stopped' ? 'витрина остановлена' : 'витрина не запущена');
  return ExitCode.ok;
}

/**
 * Независима от конфигурации (design.md изменения `cli-commands-as-rows`,
 * Решение 4): останавливает демон витрины, не читая ни конфигурации, ни
 * реестра вкладов.
 */
export const row = commandRow(
  {
    name: 'down',
    spec: { description: 'остановить витрину' },
    run: (args, io, env) => runDownCommand(args, io.out, env.cwd),
  },
  { independent: true },
);
