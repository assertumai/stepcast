import { runProcess, type ProcessResult } from '../exec/process.js';

/**
 * Потолок-предохранитель для команды проверки: у неё нет собственного
 * таймаута — время ограничивает шаг работы, которым вызвана `merge-lanes`
 * (`.stepcast/jobs/merge.yml`), и второй потолок внутри первого только
 * запутал бы разбор. `runProcess` требует значения, и этот час на порядок
 * щедрее любой разумной проверки.
 */
export const CHECK_TIMEOUT_MS = 60 * 60_000;

export interface CheckOptions {
  /** Строка, исполняемая оболочкой — тем же исполнителем, что и строковая форма `run`-шага. */
  readonly command: string;
  readonly cwd: string;
}

/** Окружение процесса без `undefined`: `ProcessOptions.env` требует `Record<string, string>`. */
function processEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * Исполнить объявленную команду проверки в дереве запуска, с окружением
 * процесса `merge-lanes` — иначе она не нашла бы ни `PATH`, ни своих
 * инструментов. Захваченный вывод возвращается вызывающему целиком.
 */
export function runCheck(options: CheckOptions): Promise<ProcessResult> {
  return runProcess({
    command: options.command,
    cwd: options.cwd,
    env: processEnv(),
    timeoutMs: CHECK_TIMEOUT_MS,
  });
}
