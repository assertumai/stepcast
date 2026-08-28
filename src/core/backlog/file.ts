import { chmodSync, readFileSync, statSync } from 'node:fs';

import { StepcastError, isStepcastError } from '../errors.js';
import { atomicWrite } from '../journal/writer.js';
import { parse, type BacklogEntry } from './parse.js';
import { withFields } from './write.js';

/**
 * Файл очереди улучшений как файл: чтение и разбор с приложенным путём,
 * запись, сохраняющая режим доступа, сведение чужого текста к однострочной
 * причине и проставление исхода пункту.
 *
 * Модуль общий для всех, кто правит очередь, — `stepcast backlog` и сведение
 * дорожек (`src/core/lanes/merge.ts`). Разошедшиеся копии этих операций уже
 * приводили к тому, что часть записей сужала права `backlog.md`, а часть нет.
 */

/**
 * Длина причины отказа, после которой она урезается.
 *
 * Причина приходит целым куском чужого вывода — например, хвостом `stderr`
 * красной проверки, который передаёт `stepcast merge-lanes`, — и в очередь,
 * которую читает человек, такой кусок целиком не нужен: полный текст
 * остаётся в логе шага того же прогона.
 */
export const REASON_LIMIT = 500;

export function readBacklogFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new StepcastError(
      code === 'ENOENT'
        ? `Файл очереди не найден: ${path}`
        : `Не удалось прочитать файл очереди: ${(error as Error).message}`,
      { file: path, cause: error },
    );
  }
}

/** Разбор с приложенным путём: разборщик сам о файле ничего не знает. */
export function parseBacklogFile(path: string, text: string): readonly BacklogEntry[] {
  try {
    return parse(text);
  } catch (error) {
    if (!isStepcastError(error)) throw error;
    throw new StepcastError(error.message, {
      file: path,
      ...(error.at === undefined ? {} : { at: error.at }),
      ...(error.hint === undefined ? {} : { hint: error.hint }),
      cause: error,
    });
  }
}

/**
 * Записать файл очереди, сохранив его исходный режим доступа.
 *
 * `atomicWrite` подменяет файл переименованием временного — временный
 * создаётся заново с режимом `0o600`, и без восстановления первый же `pick`
 * или `merge-lanes` сузил бы права `backlog.md` вопреки тому, что было в
 * рабочем дереве.
 */
export function writeBacklogFile(path: string, content: string): void {
  let mode: number | undefined;
  try {
    mode = statSync(path).mode;
  } catch {
    mode = undefined;
  }
  atomicWrite(path, content);
  if (mode !== undefined) chmodSync(path, mode & 0o777);
}

/**
 * Свести чужой текст к одной строке: поле очереди однострочно, и разборщик
 * значение с переводом строки отвергает (`withFields`). Сведение делается
 * здесь, на границе файла, а не в разборщике: без него бухгалтерия петли
 * отказывала бы ровно в том случае, ради которого заведена, — причина
 * красной проверки собирается из многострочного `stderr`.
 *
 * Урезка идёт с конца: причина, написанная для человека, начинается с сути.
 * Кому нужен хвост чужого вывода — берёт его `tailLine` до сборки причины.
 */
export function oneLine(value: string): string {
  const flat = value.replace(/\s+/gu, ' ').trim();
  return flat.length <= REASON_LIMIT ? flat : `${flat.slice(0, REASON_LIMIT - 1)}…`;
}

/**
 * Хвост чужого вывода в одну строку, не длиннее `limit`.
 *
 * Обратная `oneLine` сторона: у вывода упавшей команды суть оседает в
 * последних строках, и в причину идёт именно конец, а не начало. Вызывающий
 * выбирает `limit` так, чтобы приставка причины уместилась в `REASON_LIMIT`
 * вместе с хвостом и не попала под урезку `oneLine`.
 */
export function tailLine(value: string, limit: number): string {
  const flat = value.replace(/\s+/gu, ' ').trim();
  if (limit <= 1) return '';
  return flat.length <= limit ? flat : `…${flat.slice(flat.length - limit + 1)}`;
}

/** Исход попытки проставить пункту очереди его исход. */
export type FinishOutcome = 'set' | 'already-final';

/**
 * Проставить пункту исход, если он ещё не проставлен.
 *
 * Проставленный исход не переписывается: повторный заход (например, `settle`
 * после сведения дорожек или `finish` после отказа сети) не должен состязаться
 * за последнее слово — первый проставленный исход и есть окончательный.
 * Отсутствующий пункт — отказ: молча потерять бухгалтерию нельзя.
 */
export function finishItem(
  file: string,
  slug: string,
  status: 'done' | 'failed',
  reason?: string,
): FinishOutcome {
  const text = readBacklogFile(file);
  const entries = parseBacklogFile(file, text);
  const entry = entries.find((candidate) => candidate.slug === slug);
  if (entry === undefined) {
    throw new StepcastError(`пункт «${slug}» в очереди не найден`, { file, at: slug });
  }

  if (entry.data.status === 'done' || entry.data.status === 'failed') return 'already-final';

  const values = status === 'failed' ? { status, reason: oneLine(reason ?? '') } : { status };
  writeBacklogFile(file, withFields(text, slug, values));
  return 'set';
}
