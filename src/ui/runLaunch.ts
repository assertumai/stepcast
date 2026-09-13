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
  /**
   * Значения объявленных входов пайплайна — доезжают ключами `--input имя=значение`,
   * тем же порядком, каким их набрал бы человек в терминале.
   *
   * Ради доски: пункт, выбранный в колонке, передаётся запускаемому пайплайну
   * входом (`item=<слаг>`), а не угадывается им заново из очереди.
   */
  readonly inputs?: Readonly<Record<string, string>>;
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
  const argv = [binPath(), 'run', options.pipeline];
  for (const [name, value] of Object.entries(options.inputs ?? {})) argv.push('--input', `${name}=${value}`);

  const child = spawn(options.execPath ?? process.execPath, argv, {
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

export interface LaunchDecideOptions {
  /** Корень проекта — рабочий каталог дочернего процесса. */
  readonly cwd: string;
  readonly run: string;
  readonly outcome: string;
  readonly step?: string;
  readonly reason?: string;
  readonly from?: string;
  readonly execPath?: string;
  readonly onError?: (error: Error) => void;
}

export type LaunchDecideFn = (options: LaunchDecideOptions) => void;

/**
 * Породить `stepcast decide <run> <outcome>` отсоединённым процессом — тем же
 * приёмом, что `launchRun` (design.md изменения `user-decision-steps`,
 * решение 5): демон в файлы прогонов не пишет, единственный писатель решения
 * — бинарь. Проверка запроса — до порождения, в маршруте демона; здесь
 * порождается уже проверенная команда.
 */
export const launchDecide: LaunchDecideFn = (options) => {
  const argv = [binPath(), 'decide', options.run, options.outcome];
  if (options.step !== undefined) argv.push('--step', options.step);
  if (options.reason !== undefined) argv.push('--reason', options.reason);
  if (options.from !== undefined) argv.push('--from', options.from);

  const child = spawn(options.execPath ?? process.execPath, argv, {
    cwd: options.cwd,
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', (error) => {
    const report =
      options.onError ?? ((cause: Error) => process.stderr.write(`stepcast decide не запустился: ${cause.message}\n`));
    report(error);
  });
  child.unref();
};
