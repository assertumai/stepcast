import { ExitCode, isStepcastError, type ExitCodeValue } from '../core/errors.js';

/** Единая печать диагностики: всё, что видит пользователь при отказе. */
export function reportError(error: unknown, write: (line: string) => void): ExitCodeValue {
  if (isStepcastError(error)) {
    const location = error.location();
    write(`ошибка: ${error.message}`);
    if (location !== undefined) write(`  где: ${location}`);
    if (error.hint !== undefined) write(`  ${error.hint}`);
    return error.exitCode;
  }

  // Сюда попадает только то, чего движок не предвидел, — это дефект, и стек
  // здесь полезнее вежливой формулировки.
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  write(`внутренняя ошибка: ${message}`);
  return ExitCode.configError;
}

/** Выравнивание колонок для табличного вывода команд. */
export function formatColumns(rows: readonly (readonly string[])[]): string[] {
  if (rows.length === 0) return [];
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
      .join('  ')
      .trimEnd(),
  );
}
