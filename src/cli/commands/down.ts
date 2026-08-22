import { ExitCode, type ExitCodeValue } from '../../core/errors.js';
import { daemonPaths, stopDaemon } from '../../ui/daemon.js';
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
