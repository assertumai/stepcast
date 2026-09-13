import { StepcastError } from '../errors.js';
import { parse, type BacklogEntry } from './parse.js';
import { withFields } from './write.js';

/**
 * Перенос пункта внутри файла очереди и между двумя файлами — текстом, без
 * ввода-вывода: на входе содержимое, на выходе новое содержимое, тем же
 * разделением, что у `write.ts`.
 *
 * Порядок пунктов в файле — единственный приоритет внутри состояния
 * (`docs/backlog.md`), поэтому «поднять выше» и «перетащить в другую колонку»
 * — это одна и та же операция над текстом, а не две разные записи.
 *
 * Правится ровно тот кусок строк, который занимает пункт: файл не
 * перестраивается целиком и пустые строки соседей не трогаются. Иначе первый
 * же перенос давал бы диффом весь файл, а очередь ведёт человек в редакторе.
 */

/** Строки пункта: от заголовка до заголовка следующего (не включая его) либо до конца файла. */
interface Block {
  readonly start: number;
  readonly end: number;
}

function blockOf(entries: readonly BacklogEntry[], index: number, lineCount: number): Block {
  const entry = entries[index] as BacklogEntry;
  const next = entries[index + 1];
  return { start: entry.headingLine, end: next === undefined ? lineCount : next.headingLine };
}

function indexOfSlug(entries: readonly BacklogEntry[], slug: string, file: string): number {
  const index = entries.findIndex((entry) => entry.slug === slug);
  if (index < 0) throw new StepcastError(`пункт «${slug}» в очереди не найден`, { file, at: slug });
  return index;
}

/** Хвостовые пустые строки не принадлежат пункту: они — разделитель, и его ставит вставка. */
function trimTrailingBlank(lines: readonly string[]): readonly string[] {
  let end = lines.length;
  while (end > 0 && (lines[end - 1] as string).trim() === '') end -= 1;
  return lines.slice(0, end);
}

/**
 * Вставить строки пункта в текст перед пунктом `before`, а при его отсутствии
 * — в конец файла.
 *
 * Разделитель — одна пустая строка, и ставится он всегда: вставка в конец
 * файла, не заканчивающегося переводом строки, иначе приклеила бы заголовок к
 * последней строке предыдущего пункта, а разбор такой строки — отказ.
 */
function insertBlock(text: string, block: readonly string[], before: string | undefined, file: string): string {
  const lines = text.split('\n');
  const entries = parse(text);
  const body = trimTrailingBlank(block);
  if (body.length === 0) throw new StepcastError('перенос пустого пункта', { file });

  if (before === undefined) {
    // Пустой файл-получатель (архив, которого ещё не было) не получает
    // ведущей пустой строки: разделять там нечего.
    const tail = trimTrailingBlank(lines);
    return tail.length === 0 ? [...body, ''].join('\n') : [...tail, '', ...body, ''].join('\n');
  }

  const at = (entries[indexOfSlug(entries, before, file)] as BacklogEntry).headingLine;
  return [...lines.slice(0, at), ...body, '', ...lines.slice(at)].join('\n');
}

/** Вырезать строки пункта, вернув их и оставшийся текст. */
function cutBlock(text: string, slug: string, file: string): { readonly text: string; readonly block: readonly string[] } {
  const lines = text.split('\n');
  const entries = parse(text);
  const { start, end } = blockOf(entries, indexOfSlug(entries, slug, file), lines.length);
  return { text: [...lines.slice(0, start), ...lines.slice(end)].join('\n'), block: lines.slice(start, end) };
}

/**
 * Переставить пункт внутри одного файла: перед `before` либо в конец.
 *
 * Перестановка пункта перед самим собой — не отказ, а ничего: доска шлёт
 * положение, посчитанное по своей колонке, и проверять там же, что оно новое,
 * значило бы держать это знание в двух местах.
 */
export function moveWithin(text: string, slug: string, before: string | undefined, file: string): string {
  if (before === slug) return text;
  const cut = cutBlock(text, slug, file);
  return insertBlock(cut.text, cut.block, before, file);
}

/** Результат переноса между файлами: оба новых содержимого, писать их вызывающему. */
export interface MoveBetweenResult {
  readonly from: string;
  readonly to: string;
}

/**
 * Перенести пункт из одного файла очереди в другой, поставив его перед
 * `before` (в файле-получателе) либо в конец.
 *
 * Целевой файл может не существовать вовсе — архив заводится первым же
 * переносом: вызывающий передаёт пустую строку, и пункт становится её
 * единственным содержимым.
 */
export function moveBetween(
  fromText: string,
  toText: string,
  slug: string,
  before: string | undefined,
  fromFile: string,
  toFile: string,
): MoveBetweenResult {
  const cut = cutBlock(fromText, slug, fromFile);
  return { from: cut.text, to: insertBlock(toText, cut.block, before, toFile) };
}

/** Проставить пункту статус — тем же приёмом, что и прочие правки полей. */
export function withStatus(text: string, slug: string, status: string): string {
  return withFields(text, slug, { status });
}
