import { estimateTokens } from '../context/assemble.js';
import type { PredicateResult } from '../journal/schema.js';

/**
 * Выдержка о непройденной проверке предыдущей итерации, уложенная в
 * объявленный предел размера. Каркас записи (заголовок, имена предикатов,
 * закрывающая фраза) не усекается — он короче любого разумного предела и
 * несёт больше смысла на токен, чем вывод предиката.
 */

export interface IterationNoteTruncation {
  readonly originalTokens: number;
  readonly finalTokens: number;
  readonly droppedLines: number;
}

export interface IterationNoteResult {
  readonly text: string;
  readonly truncation?: IterationNoteTruncation;
}

const HEADER = '# Проверка предыдущей итерации не прошла';
const CLOSING = 'Это та же работа, следующий заход. Почини причину.';

/**
 * Меньше этого показывать бессмысленно: доля, в которую влезает только пометка
 * об усечении и обрывок в пару слов, не сообщает ничего о причине отказа.
 * Предикат с такой долей лучше не показывать вовсе — место достанется тем,
 * чей вывод ещё можно прочитать.
 */
const MIN_DETAIL_TOKENS = 4;

interface NoteItem {
  readonly prefix: string;
  readonly detail: string;
}

function omissionLine(count: number): string {
  return `- […ещё непрошедших предикатов: ${count}…]`;
}

function renderNote(items: readonly NoteItem[], omitted: number): string {
  const lines = items.map((item) => `${item.prefix}${item.detail}`);
  if (omitted > 0) lines.push(omissionLine(omitted));
  return [HEADER, '', ...lines, '', CLOSING].join('\n');
}

function countLines(text: string): number {
  return text.split('\n').length;
}

/** Наибольший суффикс строки, укладывающийся в предел токенов. Хвост важнее начала. */
function suffixWithinBudget(text: string, budgetTokens: number): string {
  const chars = [...text];
  let ascii = 0;
  let other = 0;
  let start = chars.length;

  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const char = chars[i] as string;
    const isAscii = char.charCodeAt(0) < 128;
    const nextAscii = ascii + (isAscii ? 1 : 0);
    const nextOther = other + (isAscii ? 0 : 1);
    if (Math.ceil(nextAscii / 4 + nextOther / 2) > budgetTokens) break;
    ascii = nextAscii;
    other = nextOther;
    start = i;
  }

  return chars.slice(start).join('');
}

/**
 * Пометка на месте отброшенного. Отдельно отмечается обрезанная строка: без
 * этого «отброшено строк: 0» стояло бы над обрывком, выглядящим целым.
 */
function markerFor(dropped: number, cutLine: boolean): string {
  return cutLine
    ? `[…отброшено строк: ${dropped}, начало строки обрезано…]`
    : `[…отброшено строк: ${dropped}…]`;
}

/**
 * Место, которое пометка об усечении заберёт у доли предиката. Считается по
 * худшему случаю — все строки отброшены, последняя обрезана: настоящая
 * пометка не длиннее.
 */
function markerTokens(detail: string): number {
  return estimateTokens(`${markerFor(countLines(detail), true)}\n`);
}

/** Доля, ниже которой вывод предиката показывать нечем: только пометка и обрывок. */
function minViableShare(detail: string): number {
  return markerTokens(detail) + MIN_DETAIL_TOKENS;
}

/**
 * Уложить вывод одного непрошедшего предиката в свою долю предела: строки
 * отбрасываются с начала, конец вывода сохраняется. Пометка с числом
 * отброшенных строк съедает часть той же доли — иначе итоговый размер
 * незаметно превысил бы отведённое.
 */
function truncateDetail(detail: string, budgetTokens: number): { text: string; droppedLines: number } {
  const lines = detail.split('\n');
  const contentBudget = Math.max(0, budgetTokens - markerTokens(detail));

  let kept: string[] = [];
  let usedTokens = 0;
  let cursor = lines.length - 1;
  for (; cursor >= 0; cursor -= 1) {
    const line = lines[cursor] as string;
    const lineTokens = estimateTokens(kept.length === 0 ? line : `${line}\n`);
    if (usedTokens + lineTokens > contentBudget) break;
    kept.unshift(line);
    usedTokens += lineTokens;
  }

  let droppedLines = cursor + 1;
  let cutLine = false;

  if (kept.length === 0) {
    // Даже последняя строка одна не влезает в долю — усекается сама, с
    // сохранением своего конца.
    const lastLine = lines[lines.length - 1] as string;
    kept = [suffixWithinBudget(lastLine, contentBudget)];
    droppedLines = lines.length - 1;
    cutLine = true;
  }

  return { text: `${markerFor(droppedLines, cutLine)}\n${kept.join('\n')}`, droppedLines };
}

/**
 * Честно поделить бюджет между потребностями: тот, кому нужно меньше доли,
 * получает ровно свою потребность, а излишек уходит в общий котёл для
 * оставшихся — иначе один многословный предикат съедал бы место остальных.
 */
function fairShares(needs: readonly number[], budget: number): number[] {
  const shares = new Array<number>(needs.length).fill(0);
  const order = needs.map((_, index) => index).sort((a, b) => (needs[a] as number) - (needs[b] as number));

  let remainingBudget = budget;
  let remainingCount = needs.length;
  for (const index of order) {
    const share = Math.floor(remainingBudget / remainingCount);
    const give = Math.min(needs[index] as number, share);
    shares[index] = give;
    remainingBudget -= give;
    remainingCount -= 1;
  }

  return shares;
}

interface Layout {
  readonly text: string;
  readonly droppedLines: number;
}

/**
 * Разложить выдержку по пределу: показываем столько предикатов, скольким
 * достаётся читаемая доля, остальные сворачиваем в одну строку с их числом.
 * Предикаты дробятся с конца: раньше объявленные важнее — их непрохождение,
 * как правило, и есть причина остальных.
 */
function layout(items: readonly NoteItem[], limitTokens: number): Layout | undefined {
  for (let shown = items.length; shown >= 1; shown -= 1) {
    const kept = items.slice(0, shown);
    const omitted = items.length - shown;
    const skeletonTokens = estimateTokens(renderNote(kept.map((item) => ({ ...item, detail: '' })), omitted));
    if (skeletonTokens >= limitTokens) continue;

    const needs = kept.map((item) => estimateTokens(item.detail));
    const shares = fairShares(needs, limitTokens - skeletonTokens);
    const readable = kept.every(
      (item, index) =>
        (needs[index] as number) <= (shares[index] as number) ||
        (shares[index] as number) >= minViableShare(item.detail),
    );
    if (!readable) continue;

    let droppedLines = items
      .slice(shown)
      .reduce((sum, item) => sum + countLines(item.detail), 0);
    const rendered = kept.map((item, index) => {
      if ((needs[index] as number) <= (shares[index] as number)) return item;
      const cut = truncateDetail(item.detail, shares[index] as number);
      droppedLines += cut.droppedLines;
      return { prefix: item.prefix, detail: cut.text };
    });

    return { text: renderNote(rendered, omitted), droppedLines };
  }

  return undefined;
}

/**
 * Собрать выдержку о непройденных предикатах предыдущей итерации, уложенную
 * в `limitTokens`. Возвращает выдержку без изменений, если она и так в
 * пределе — усечение и его отчёт появляются только когда это необходимо.
 */
export function buildIterationNote(
  failed: readonly PredicateResult[],
  limitTokens: number,
): IterationNoteResult {
  const items: NoteItem[] = failed.map((item) => ({
    prefix: `- \`${item.predicate}\`: `,
    detail: item.detail ?? 'не пройдена',
  }));

  const fullText = renderNote(items, 0);
  const originalTokens = estimateTokens(fullText);
  if (originalTokens <= limitTokens) return { text: fullText };

  const laid = layout(items, limitTokens);
  let text = laid?.text ?? renderNote([], items.length);
  let droppedLines = laid?.droppedLines ?? items.reduce((sum, item) => sum + countLines(item.detail), 0);

  // Последний рубеж: предел так мал, что в него не влезает даже каркас из
  // заголовка и закрывающей фразы. Выдержка обязана уложиться в объявленный
  // предел — иначе она сорвёт сборку контекста тем самым отказом, который это
  // усечение и должно предотвращать, — поэтому режем текст по хвосту.
  if (estimateTokens(text) > limitTokens) {
    text = suffixWithinBudget(text, limitTokens);
    droppedLines = Math.max(0, countLines(fullText) - countLines(text));
  }

  return {
    text,
    truncation: { originalTokens, finalTokens: estimateTokens(text), droppedLines },
  };
}
