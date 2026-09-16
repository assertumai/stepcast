import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { diffLines } from '../src/parts/pipeline/domain/textDiff.js';

describe('textDiff: построчный LCS', () => {
  it('правка в середине несёт same вокруг removed/added', () => {
    const before = 'a\nb\nc\n';
    const after = 'a\nX\nc\n';
    const diff = diffLines(before, after);
    assert.deepEqual(
      diff.map((line) => [line.kind, line.text]),
      [
        ['same', 'a'],
        ['removed', 'b'],
        ['added', 'X'],
        ['same', 'c'],
        ['same', ''],
      ],
    );
  });

  it('создание файла целиком — пустая база даёт все строки added', () => {
    const diff = diffLines('', 'a\nb\n');
    assert.ok(diff.every((line) => line.kind === 'added'));
    assert.deepEqual(diff.map((line) => line.text), ['a', 'b', '']);
  });

  it('совпавшие тексты дают пустой диф изменений — только same', () => {
    const text = 'a\nb\nc\n';
    const diff = diffLines(text, text);
    assert.ok(diff.every((line) => line.kind === 'same'));
  });

  it('файл без завершающего перевода строки не добавляет лишнюю пустую строку', () => {
    const diff = diffLines('a\nb', 'a\nb');
    assert.deepEqual(
      diff.map((line) => line.text),
      ['a', 'b'],
    );
  });
});
