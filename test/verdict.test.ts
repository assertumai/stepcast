import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';

import { judgeVerdictSchemaPath, parseVerdict } from '../src/core/expect/verdict.js';

describe('agent-backend: схема вердикта судьи', () => {
  it('резолвится в существующий файл', () => {
    const path = judgeVerdictSchemaPath();
    assert.ok(existsSync(path), `схема не найдена: ${path}`);
  });

  it('разбирает вердикт по схеме', () => {
    const verdict = parseVerdict({ pass: true, reason: 'план покрывает требования' });
    assert.deepEqual(verdict, { pass: true, reason: 'план покрывает требования' });
  });

  it('не толкует отсутствие структурированного вывода', () => {
    assert.equal(parseVerdict(undefined), undefined);
  });

  it('не толкует ответ не по схеме', () => {
    assert.equal(parseVerdict({ ok: true }), undefined);
    assert.equal(parseVerdict({ pass: 'да', reason: 'нет' }), undefined);
    assert.equal(parseVerdict('да'), undefined);
  });
});
