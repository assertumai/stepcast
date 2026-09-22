import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';

import { StepcastError } from '../../kernel/errors.js';
import { describeSchemaFailure } from '../../kernel/schema-failure.js';
import { DEFAULT_BOARD_COLUMNS, columnsProblem, type BoardColumnSpec } from './scrumView.js';

/**
 * Раскладка колонок доски проекта — файл `.stepcast/board.yml`.
 *
 * Модуль демона: он один читает и пишет диск. Модель колонок и её проверка —
 * в `scrumView.ts`, общем демону и браузеру.
 *
 * Файл лежит в проекте, а не в домашнем каталоге: колонка заводится под
 * статус, который пишут в `backlog.md` этого проекта, и видеть её должен
 * каждый, кто открывает его очередь. Отсутствие файла — встроенные четыре
 * колонки; первый добавленный статус заводит файл со всей раскладкой, чтобы
 * порядок колонок читался из одного места.
 *
 * ```yaml
 * columns:
 *   - id: todo
 *   - id: postponed
 *     title: Отложено
 *   - id: in_progress
 *   - id: done
 *   - id: archive
 * ```
 */

const BoardColumnSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1).optional(),
  })
  .strict();

const BoardDocumentSchema = z
  .object({
    columns: z.array(BoardColumnSchema),
  })
  .strict();

/** Путь файла относительно корня проекта — им же отказ подписывается на экранах. */
export const BOARD_FILE = '.stepcast/board.yml';

export function boardFilePath(projectRoot: string): string {
  return join(projectRoot, BOARD_FILE);
}

export function readBoardColumns(projectRoot: string): readonly BoardColumnSpec[] {
  const path = boardFilePath(projectRoot);
  if (!existsSync(path)) return DEFAULT_BOARD_COLUMNS;

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new StepcastError(`Board columns file is not valid YAML: ${(error as Error).message}`, {
      file: path,
      cause: error,
    });
  }

  const parsed = BoardDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    const failure = describeSchemaFailure(parsed.error);
    throw new StepcastError(`Board columns file does not match the format: ${failure.message}`, {
      file: path,
      ...(failure.at === undefined ? {} : { at: failure.at }),
    });
  }

  const columns = parsed.data.columns.map((column) =>
    column.title === undefined ? { id: column.id } : { id: column.id, title: column.title },
  );
  const problem = columnsProblem(columns);
  if (problem !== undefined) {
    throw new StepcastError(`Board columns file: ${problem}`, { file: path });
  }
  return columns;
}

export function writeBoardColumns(projectRoot: string, columns: readonly BoardColumnSpec[]): void {
  const problem = columnsProblem(columns);
  if (problem !== undefined) throw new StepcastError(`Column layout not written: ${problem}`);

  const path = boardFilePath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  const document = {
    columns: columns.map((column) => (column.title === undefined ? { id: column.id } : { ...column })),
  };
  // Через временный файл: наблюдатель очереди перечитывает раскладку на каждом
  // такте, и половина файла дала бы ему отказ разбора вместо старой доски.
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, stringifyYaml(document), 'utf8');
  renameSync(temporary, path);
}
