/**
 * Разбор потока `stream-json` бэкенда Claude Code в записи хода агентского шага.
 *
 * Модуль общий с демоном не потому, что демон его зовёт, а потому, что правило
 * здесь — чистая функция от текста, и только так её достаёт обычный тест
 * (`test/ui-transcript.test.ts`): браузерного окружения в проекте нет. Тот же
 * приём, что уже применён к `routes.ts`, `grouping.ts` и `format.ts` — ни
 * одного импорта `node:*`.
 *
 * Второе, независимое чтение того же потока, что уже разбирает
 * `adapter.parseLine` (`src/core/backend/claude.ts`) — не переиспользование:
 * адаптер живёт в Node и отвечает на вопросы движка (расход, отказ, входы
 * читающих инструментов), а здесь нужен ответ на вопрос читателя — что модель
 * говорила и чем ответил инструмент. Цена названа в design.md (Decision 3):
 * форма потока известна в двух местах, и расхождение с бэкендом должно быть
 * видно как сырые строки на экране, а не как отказ разбора или потерянная
 * строка — отсюда правило «незнакомое не отбрасывается» ниже.
 */

export interface ToolOutcome {
  readonly content: unknown;
  readonly isError: boolean;
}

/** Начало сессии: конверт `system`/`init` целиком — записи не решают, что в нём важно. */
export interface SessionEntry {
  readonly kind: 'session';
  readonly data: Readonly<Record<string, unknown>>;
}

/** Реплика модели: текстовый блок или блок размышления, помеченный отдельно. */
export interface ReplyEntry {
  readonly kind: 'reply';
  readonly text: string;
  readonly thinking: boolean;
}

/**
 * Вызов инструмента. `outcome` появляется у записи, сведённой со своим
 * результатом (Решение 7 в design.md); вызов, оставшийся без результата в
 * пределах разобранного текста, эту запись не получает вовсе — это
 * наблюдаемый факт, а не пробел разбора.
 */
export interface ToolCallEntry {
  readonly kind: 'tool_call';
  readonly callId: string;
  readonly name: string;
  readonly input: unknown;
  readonly outcome?: ToolOutcome;
}

/** Результат вызова, оставшийся без пары: вызов был за краем разобранного окна. */
export interface ToolResultEntry {
  readonly kind: 'tool_result';
  readonly callId: string;
  readonly outcome: ToolOutcome;
}

/** Итоговый ответ шага — конверт `result`. */
export interface ResultEntry {
  readonly kind: 'result';
  readonly text?: string;
}

/**
 * Строка, которую не удалось узнать: не-JSON, JSON незнакомого вида, обрубок
 * на краю окна усечённого вывода. Хранится как есть — Решение 6 в design.md
 * требует не терять её, а не подбирать для неё представление.
 */
export interface RawEntry {
  readonly kind: 'raw';
  readonly line: string;
}

export type TranscriptEntry =
  | SessionEntry
  | ReplyEntry
  | ToolCallEntry
  | ToolResultEntry
  | ResultEntry
  | RawEntry;

export interface ParsedTranscript {
  readonly entries: readonly TranscriptEntry[];
  /**
   * Незавершённая последняя строка текста — без строки не разобрать, JSON она
   * или нет. Вызывающая сторона дописывает её следующим куском и разбирает
   * заново, тем же приёмом, что `follow()` в `journal/reader.ts` и `consume`
   * в `agentStep.ts`.
   */
  readonly carry: string;
}

/**
 * Разобрать текст (кусок потока или поток целиком) в записи хода.
 *
 * Деление построчное; последняя строка без завершающего `\n` не разбирается,
 * а возвращается остатком — она могла оборваться на середине записи, если
 * бэкенд ещё пишет.
 */
export function parseTranscript(text: string): ParsedTranscript {
  const lines = text.split('\n');
  const carry = lines.pop() ?? '';

  const entries: TranscriptEntry[] = [];
  for (const line of lines) entries.push(...parseLine(line));

  return { entries, carry };
}

/**
 * Свести вызовы инструментов с их исходами по `tool_use_id` (Решение 7).
 *
 * Чистая функция над уже разобранным списком, а не частью `parseTranscript`:
 * вызов и его исход могут прийти в разных кусках потока (витрина дописывает
 * вывод по смещению), и свести их можно только над накопленным списком
 * записей, а не заново перечитывая текст с начала на каждый опрос.
 *
 * Непарные вызов и исход остаются отдельными записями на своих местах — это
 * наблюдаемые факты (шаг оборван на середине вызова; исход вызова, ушедшего
 * за край окна), и скрывать их нельзя.
 */
export function mergeToolOutcomes(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  const merged: TranscriptEntry[] = [];
  const callIndex = new Map<string, number>();

  for (const entry of entries) {
    if (entry.kind === 'tool_call') {
      callIndex.set(entry.callId, merged.length);
      merged.push(entry);
      continue;
    }

    if (entry.kind === 'tool_result') {
      const index = callIndex.get(entry.callId);
      const call = index === undefined ? undefined : merged[index];
      if (call?.kind === 'tool_call' && call.outcome === undefined) {
        merged[index as number] = { ...call, outcome: entry.outcome };
        continue;
      }
      merged.push(entry);
      continue;
    }

    merged.push(entry);
  }

  return merged;
}

function parseLine(rawLine: string): TranscriptEntry[] {
  const trimmed = rawLine.trim();
  if (trimmed === '') return [];

  let record: Record<string, unknown>;
  try {
    record = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [{ kind: 'raw', line: rawLine }];
  }

  if (record.type === 'system' && record.subtype === 'init') {
    return [{ kind: 'session', data: record }];
  }

  if (record.type === 'assistant') {
    const entries = parseAssistantContent(record);
    return entries.length > 0 ? entries : [{ kind: 'raw', line: rawLine }];
  }

  if (record.type === 'user') {
    const entries = parseUserContent(record);
    return entries.length > 0 ? entries : [{ kind: 'raw', line: rawLine }];
  }

  if (record.type === 'result') {
    return [
      {
        kind: 'result',
        ...(typeof record.result === 'string' ? { text: record.result } : {}),
      },
    ];
  }

  // Служебные подвиды `system`, кроме `init`, сюда же — они редки, коротки и
  // лучше видны как есть, чем спрятаны за правилом «незнакомое не показываем»
  // (design.md, Решение 6).
  return [{ kind: 'raw', line: rawLine }];
}

function parseAssistantContent(record: Record<string, unknown>): TranscriptEntry[] {
  const message = record.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return [];

  const entries: TranscriptEntry[] = [];
  for (const block of content) {
    const item = block as Record<string, unknown>;
    if (item.type === 'text' && typeof item.text === 'string') {
      entries.push({ kind: 'reply', text: item.text, thinking: false });
    } else if (item.type === 'thinking' && typeof item.thinking === 'string') {
      entries.push({ kind: 'reply', text: item.thinking, thinking: true });
    } else if (item.type === 'tool_use' && typeof item.id === 'string' && typeof item.name === 'string') {
      entries.push({ kind: 'tool_call', callId: item.id, name: item.name, input: item.input });
    }
  }
  return entries;
}

function parseUserContent(record: Record<string, unknown>): TranscriptEntry[] {
  const message = record.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return [];

  const entries: TranscriptEntry[] = [];
  for (const block of content) {
    const item = block as Record<string, unknown>;
    if (item.type === 'tool_result' && typeof item.tool_use_id === 'string') {
      entries.push({
        kind: 'tool_result',
        callId: item.tool_use_id,
        outcome: { content: item.content, isError: item.is_error === true },
      });
    }
  }
  return entries;
}
