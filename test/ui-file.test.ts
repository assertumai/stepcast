import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { MAX_FILE_BYTES, readJournalFile, resolveJournalPath } from '../src/ui/file.js';
import { StepcastError } from '../src/core/errors.js';

function bed(): string {
  const base = mkdtempSync(join(tmpdir(), 'stepcast-uifile-'));
  const runDir = join(base, 'run');
  mkdirSync(join(runDir, 'jobs'), { recursive: true });
  writeFileSync(join(runDir, 'jobs', 'stdout.log'), 'строка журнала\n');
  writeFileSync(join(base, 'секрет.txt'), 'этого видеть нельзя');
  return runDir;
}

describe('ui-dashboard: чтение файла журнала', () => {
  it('читает файл внутри каталога прогона', () => {
    const runDir = bed();
    const file = readJournalFile(runDir, 'jobs/stdout.log');

    assert.equal(file.content, 'строка журнала\n');
    assert.equal(file.truncated, false);
    assert.equal(file.path, 'jobs/stdout.log');
  });

  // Сценарий: «Путь за пределы каталога прогона»
  it('отклоняет путь, ведущий за пределы каталога прогона', () => {
    const runDir = bed();

    assert.throws(() => resolveJournalPath(runDir, '../секрет.txt'), StepcastError);
    assert.throws(() => resolveJournalPath(runDir, 'jobs/../../секрет.txt'), StepcastError);
    assert.throws(() => resolveJournalPath(runDir, '/etc/passwd'), StepcastError);
  });

  it('не принимает каталог-сосед с общим префиксом за вложенный', () => {
    const runDir = bed();
    assert.throws(() => resolveJournalPath(runDir, '../run-other/файл'), StepcastError);
  });

  // Сценарий: «Крупный файл усечён»
  it('усекает файл крупнее потолка и помечает это', () => {
    const runDir = bed();
    const big = 'я'.repeat(MAX_FILE_BYTES);
    writeFileSync(join(runDir, 'big.log'), big);

    const file = readJournalFile(runDir, 'big.log');

    assert.equal(file.truncated, true);
    assert.ok(file.bytes > MAX_FILE_BYTES, 'кириллица занимает больше байта на символ');
    assert.ok(Buffer.byteLength(file.content, 'utf8') <= MAX_FILE_BYTES);
  });
});
