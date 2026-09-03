import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mergeToolOutcomes, parseTranscript, type TranscriptEntry } from '../src/ui/transcript.js';

/**
 * Образцы строк — той же формы, что пишет `adapter.parseLine`
 * (`src/core/backend/claude.ts`): `system`/`init`, `assistant` с текстом и с
 * `tool_use`, `user` с `tool_result`, `result`.
 */
const INIT_LINE = JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: 'sess-1',
  model: 'claude-x',
});

const REPLY_LINE = JSON.stringify({
  type: 'assistant',
  message: { id: 'msg-1', content: [{ type: 'text', text: 'Читаю файл.' }] },
});

const THINKING_LINE = JSON.stringify({
  type: 'assistant',
  message: { id: 'msg-2', content: [{ type: 'thinking', thinking: 'Сначала гляну на структуру.' }] },
});

const TOOL_USE_LINE = JSON.stringify({
  type: 'assistant',
  message: {
    id: 'msg-3',
    content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: 'a.txt' } }],
  },
});

const TOOL_RESULT_LINE = JSON.stringify({
  type: 'user',
  message: {
    content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'содержимое файла', is_error: false }],
  },
});

const TOOL_RESULT_ERROR_LINE = JSON.stringify({
  type: 'user',
  message: {
    content: [{ type: 'tool_result', tool_use_id: 'call-2', content: 'файл не найден', is_error: true }],
  },
});

const RESULT_LINE = JSON.stringify({
  type: 'result',
  subtype: 'success',
  result: 'Готово.',
  is_error: false,
});

function stream(lines: readonly string[]): string {
  return lines.map((line) => `${line}\n`).join('');
}

describe('ui-transcript: разбор потока в ход шага', () => {
  it('поток init → реплика → вызов → результат → result даёт записи хода по порядку', () => {
    const text = stream([INIT_LINE, REPLY_LINE, TOOL_USE_LINE, TOOL_RESULT_LINE, RESULT_LINE]);
    const { entries, carry } = parseTranscript(text);
    const merged = mergeToolOutcomes(entries);

    assert.equal(carry, '');
    assert.deepEqual(
      merged.map((entry) => entry.kind),
      ['session', 'reply', 'tool_call', 'result'],
    );

    const call = merged[2];
    assert.equal(call?.kind, 'tool_call');
    if (call?.kind === 'tool_call') {
      assert.equal(call.name, 'Read');
      assert.deepEqual(call.input, { file_path: 'a.txt' });
      assert.equal(call.outcome?.isError, false);
      assert.equal(call.outcome?.content, 'содержимое файла');
    }

    const result = merged[3];
    assert.equal(result?.kind, 'result');
    if (result?.kind === 'result') assert.equal(result.text, 'Готово.');
  });

  it('размышление разбирается отдельной репликой, помеченной как размышление', () => {
    const { entries } = parseTranscript(stream([THINKING_LINE, REPLY_LINE]));

    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], { kind: 'reply', text: 'Сначала гляну на структуру.', thinking: true });
    assert.deepEqual(entries[1], { kind: 'reply', text: 'Читаю файл.', thinking: false });
  });

  it('строка не-JSON, запись незнакомого вида и обрубок строки становятся записями «как есть», ничего не теряя', () => {
    const notJson = 'это не json вовсе';
    const unknownRecord = JSON.stringify({ type: 'system', subtype: 'compact_boundary' });
    // Обрубок первой строки окна: усечение режет запись `assistant` посередине.
    const truncatedFirstLine = REPLY_LINE.slice(20);

    const text = [truncatedFirstLine, notJson, unknownRecord, RESULT_LINE].map((l) => `${l}\n`).join('');
    const { entries } = parseTranscript(text);

    assert.deepEqual(entries, [
      { kind: 'raw', line: truncatedFirstLine },
      { kind: 'raw', line: notJson },
      { kind: 'raw', line: unknownRecord },
      { kind: 'result', text: 'Готово.' },
    ]);
  });

  it('результат вызова без своего вызова и вызов без результата остаются отдельными записями', () => {
    const { entries } = parseTranscript(stream([TOOL_USE_LINE, TOOL_RESULT_ERROR_LINE]));
    const merged = mergeToolOutcomes(entries);

    assert.deepEqual(
      merged.map((entry) => entry.kind),
      ['tool_call', 'tool_result'],
    );

    const unpairedCall = merged[0];
    assert.equal(unpairedCall?.kind, 'tool_call');
    if (unpairedCall?.kind === 'tool_call') assert.equal(unpairedCall.outcome, undefined);

    const unpairedResult = merged[1];
    assert.equal(unpairedResult?.kind, 'tool_result');
    if (unpairedResult?.kind === 'tool_result') {
      assert.equal(unpairedResult.callId, 'call-2');
      assert.equal(unpairedResult.outcome.isError, true);
    }
  });

  it('is_error отличает исход-ошибку от исхода-успеха', () => {
    const text = stream([TOOL_USE_LINE, TOOL_RESULT_LINE]);
    const merged = mergeToolOutcomes(parseTranscript(text).entries);
    const call = merged[0];
    assert.equal(call?.kind, 'tool_call');
    if (call?.kind === 'tool_call') assert.equal(call.outcome?.isError, false);
  });

  it('недописанная последняя строка возвращается остатком, а не разбирается', () => {
    const whole = stream([INIT_LINE, REPLY_LINE]);
    const partialLine = TOOL_USE_LINE.slice(0, 10);
    const chunk = whole + partialLine; // без завершающего \n

    const first = parseTranscript(chunk);
    assert.deepEqual(
      first.entries.map((e) => e.kind),
      ['session', 'reply'],
    );
    assert.equal(first.carry, partialLine);

    // Кусок дописан следующим — вызывающая сторона склеивает остаток с новым текстом.
    const rest = TOOL_USE_LINE.slice(10) + '\n';
    const second = parseTranscript(first.carry + rest);
    assert.deepEqual(
      second.entries.map((e) => e.kind),
      ['tool_call'],
    );
    assert.equal(second.carry, '');
  });

  it('пустые строки потока не порождают записей', () => {
    const { entries } = parseTranscript(`${INIT_LINE}\n\n\n${RESULT_LINE}\n`);
    assert.deepEqual(
      entries.map((e) => e.kind),
      ['session', 'result'],
    );
  });
});

describe('ui-transcript: сведение вызова с исходом', () => {
  it('вызов и исход из разных кусков потока сводятся при объединении накопленного списка', () => {
    const firstChunk = parseTranscript(stream([TOOL_USE_LINE]));
    const secondChunk = parseTranscript(stream([TOOL_RESULT_LINE]));
    const all: TranscriptEntry[] = [...firstChunk.entries, ...secondChunk.entries];

    const merged = mergeToolOutcomes(all);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.kind, 'tool_call');
    if (merged[0]?.kind === 'tool_call') assert.equal(merged[0].outcome?.isError, false);
  });
});
