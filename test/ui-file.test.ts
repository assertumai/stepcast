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

  it('не помечает усечённым файл меньше потолка и отдаёт его целиком', () => {
    const runDir = bed();
    const whole = 'строка\n'.repeat(1000);
    writeFileSync(join(runDir, 'small.log'), whole);

    const file = readJournalFile(runDir, 'small.log');

    assert.equal(file.truncated, false);
    assert.equal(file.content, whole);
    assert.equal(file.side, 'head');
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

  // Сценарий: «Хвост крупного лога виден»
  it('по умолчанию отдаёт конец крупного файла, а не начало', () => {
    const runDir = bed();
    const tail = 'причина отказа в самом конце\n';
    writeFileSync(join(runDir, 'stdout.log'), `начало потока\n${'я'.repeat(MAX_FILE_BYTES)}${tail}`);

    const file = readJournalFile(runDir, 'stdout.log');

    assert.equal(file.truncated, true);
    assert.equal(file.side, 'tail');
    assert.ok(file.content.endsWith(tail), 'хвост должен быть виден целиком');
    assert.ok(!file.content.includes('начало потока'));
  });

  it('по запросу отдаёт начало крупного файла', () => {
    const runDir = bed();
    writeFileSync(join(runDir, 'big.json'), `{"первое поле": "${'я'.repeat(MAX_FILE_BYTES)}"}`);

    const file = readJournalFile(runDir, 'big.json', 'head');

    assert.equal(file.side, 'head');
    assert.ok(file.content.startsWith('{"первое поле"'));
  });

  // Сценарий: «Многобайтовый символ на границе окна»
  it('не оставляет обрубка многобайтового символа ни на одном крае окна', () => {
    const runDir = bed();
    // Нечётный сдвиг гарантирует, что граница окна придётся на середину
    // двухбайтовой кириллицы с обоих концов.
    writeFileSync(join(runDir, 'края.log'), `x${'я'.repeat(MAX_FILE_BYTES)}x`);

    const tail = readJournalFile(runDir, 'края.log', 'tail');
    const head = readJournalFile(runDir, 'края.log', 'head');

    assert.ok(!tail.content.includes('�'), 'хвост не должен начинаться с обрубка');
    assert.ok(!head.content.includes('�'), 'начало не должно кончаться обрубком');
    assert.ok(tail.content.endsWith('x'));
    assert.ok(head.content.startsWith('x'));
  });
});
