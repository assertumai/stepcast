import { fileURLToPath } from 'node:url';

import { resolveConfig } from '../../core/config/resolve.js';
import { ExitCode, type ExitCodeValue } from '../../core/errors.js';
import {
  daemonPaths,
  describeDaemon,
  isAddressInUse,
  portBusyError,
  runningDaemon,
  startDetached,
  writeRecord,
} from '../../ui/daemon.js';
import { createUiServer } from '../../ui/server.js';
import type { ParsedArgs } from '../args.js';

/** Точка входа CLI: её же демон запускает сам себя в фоне с --foreground. */
function binPath(): string {
  return fileURLToPath(new URL('../../bin.js', import.meta.url));
}

/**
 * `stepcast up` — поднять витрину.
 *
 * По умолчанию отсоединяется: смысл наблюдательного пункта в том, что он
 * поднят всегда, а команда, занимающая терминал, этому противоречит — её
 * закрывают вместе с окном.
 */
export async function runUpCommand(
  args: ParsedArgs,
  write: (line: string) => void,
  cwd: string,
): Promise<ExitCodeValue> {
  const { config } = resolveConfig({ cwd });
  const paths = daemonPaths();
  const port = config.ui.port;

  if (args.flags.foreground === true) {
    let server;
    try {
      server = await createUiServer({ runsRoot: config.runs.root, port });
    } catch (error) {
      if (isAddressInUse(error)) throw portBusyError(port, error);
      throw error;
    }

    write(`витрина: http://127.0.0.1:${server.port}`);
    write(`наблюдение за ${config.runs.root}`);
    // Процесс держится сервером и живёт до сигнала прерывания.
    return ExitCode.ok;
  }

  // Повторный запуск — не ошибка: человек хочет открыть дашборд, а не узнать,
  // что он уже открыт. Печатаются те же сведения, что дала бы команда о
  // состоянии демона, — поэтому отдельной такой команды и нет.
  const running = runningDaemon(paths);
  if (running !== undefined) {
    for (const line of describeDaemon(running)) write(line);
    return ExitCode.ok;
  }

  const pid = startDetached({ paths, argv: [binPath(), 'up', '--foreground'] });
  writeRecord(paths, { pid, port, started_at: new Date().toISOString() });

  write(`витрина: http://127.0.0.1:${port}`);
  write(`процесс: ${pid}`);
  write('остановить: stepcast down');
  return ExitCode.ok;
}
