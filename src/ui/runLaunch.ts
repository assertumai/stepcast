import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Запуск прогона отсоединённым дочерним процессом (`ui-daemon`, design.md
 * Решение 13). Демон сам прогон не исполняет: `stepcast run` порождается тем
 * же приёмом, что и отсоединённый подъём демона (`startDetached`,
 * `src/ui/daemon.ts`), но без pid-файла и без своего лога — журналом прогона
 * распоряжается сам дочерний процесс, как и при запуске из терминала.
 */

function binPath(): string {
  return fileURLToPath(new URL('../bin.js', import.meta.url));
}

export interface LaunchRunOptions {
  /** Корень проекта — рабочий каталог дочернего процесса. */
  readonly cwd: string;
  /** Файл пайплайна относительно `cwd`, тем же именем, что видит `PipelineView.file`. */
  readonly pipeline: string;
  readonly execPath?: string;
  /** Куда сказать об отказе самого порождения. По умолчанию — журнал демона (`stderr`). */
  readonly onError?: (error: Error) => void;
}

export type LaunchRunFn = (options: LaunchRunOptions) => void;

/**
 * Породить `stepcast run <pipeline>` отсоединённым процессом. Вывод никуда не
 * читается демоном (`stdio: 'ignore'`): прогон пишет свой журнал сам, а
 * дочерний процесс не должен держать открытым ни файловый дескриптор демона,
 * ни его собственный.
 */
export const launchRun: LaunchRunFn = (options) => {
  const child = spawn(options.execPath ?? process.execPath, [binPath(), 'run', options.pipeline], {
    cwd: options.cwd,
    detached: true,
    stdio: 'ignore',
  });
  // Отказ самого порождения (ENOENT, EACCES, недоступный `cwd`) приходит
  // событием уже после возврата `spawn` — то есть после того, как `POST
  // /api/run` ответил 202. Без слушателя это необработанное исключение, и оно
  // роняет демон целиком: витрина гасла бы от одной неудачной кнопки запуска.
  child.on('error', (error) => {
    const report = options.onError ?? ((cause: Error) => process.stderr.write(`stepcast run не запустился: ${cause.message}\n`));
    report(error);
  });
  child.unref();
};
