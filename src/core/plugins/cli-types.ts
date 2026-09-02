/**
 * Форма описания команды и её ввода-вывода.
 *
 * Живёт в ядре, а не в `src/cli`, потому что этим описанием пользуется
 * контракт плагина: команда — такой же вклад, как бэкенд и предикат, и
 * ссылаться на поверхность из ядра запрещено границей репозитория. Сам разбор
 * аргументов остаётся в `src/cli/args.ts` — здесь только типы.
 */

export type FlagKind = 'string' | 'number' | 'boolean' | 'keyValue';

export interface FlagSpec {
  readonly kind: FlagKind;
  readonly description: string;
}

export interface CommandSpec {
  readonly description: string;
  readonly positional?: readonly string[];
  readonly flags?: Readonly<Record<string, FlagSpec>>;
}

export interface ParsedArgs {
  readonly command: string;
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string | number | boolean | Record<string, string>>>;
}

/** Ввод-вывод команды. */
export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly cwd: string;
  /**
   * Чтение стандартного ввода целиком. Единственный потребитель сегодня —
   * `project repos`, которая читает конвейером `backlog pick --lanes | …`;
   * необязательное поле, а не обязанность каждого `CliIo`, — большинству
   * команд стандартный ввод не нужен вовсе, и заставлять их фиктивную
   * реализацию тестов притворяться читателем нечем оправдать.
   */
  readonly readStdin?: () => Promise<string>;
}
