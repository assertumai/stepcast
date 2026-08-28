import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { StepcastError } from '../src/core/errors.js';
import { finishItem, oneLine, readBacklogFile, tailLine, REASON_LIMIT } from '../src/core/backlog/file.js';

/**
 * Файловая сторона очереди (`src/core/backlog/file.ts`): её пользуются и
 * `stepcast backlog`, и сведение дорожек, поэтому проверяется она здесь один
 * раз — временными файлами, в отличие от чистого ядра в `test/backlog.test.ts`.
 */

function backlog(status: string): string {
  return `## some-item\n\nstatus: ${status}\ntitle: Улучшение\nwhy: з\ndone_when: к\n`;
}

function makeFile(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'stepcast-backlog-file-'));
  const path = join(dir, 'backlog.md');
  writeFileSync(path, text);
  return path;
}

function fieldOf(text: string, name: string): string | undefined {
  return new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(text)?.[1];
}

describe('backlog file: finishItem', () => {
  it('проставляет исход пункту без исхода', () => {
    const path = makeFile(backlog('in_progress'));
    assert.equal(finishItem(path, 'some-item', 'done'), 'set');
    assert.equal(fieldOf(readFileSync(path, 'utf8'), 'status'), 'done');
  });

  it('уже проставленный исход не переписывается — ни другим статусом, ни причиной', () => {
    const path = makeFile(backlog('done'));
    const before = readFileSync(path, 'utf8');
    assert.equal(finishItem(path, 'some-item', 'failed', 'поздняя причина'), 'already-final');
    assert.equal(readFileSync(path, 'utf8'), before, 'файл обязан остаться байт в байт прежним');
  });

  it('многострочная причина сводится в одну строку и урезается', () => {
    const path = makeFile(backlog('in_progress'));
    finishItem(path, 'some-item', 'failed', `начало\n${'ы'.repeat(REASON_LIMIT * 2)}\nконец`);

    const reason = fieldOf(readFileSync(path, 'utf8'), 'reason') ?? '';
    assert.ok(!reason.includes('\n'));
    assert.ok(reason.length <= REASON_LIMIT, `причина длиной ${reason.length}`);
    assert.ok(reason.startsWith('начало'));
  });

  it('режим файла сохраняется', () => {
    const path = makeFile(backlog('in_progress'));
    chmodSync(path, 0o664);
    finishItem(path, 'some-item', 'done');
    assert.equal(statSync(path).mode & 0o777, 0o664);
  });

  it('отсутствующий пункт — отказ, называющий слаг и файл', () => {
    const path = makeFile(backlog('in_progress'));
    assert.throws(() => finishItem(path, 'нет-такого', 'done'), (error: unknown) => {
      assert.ok(error instanceof StepcastError);
      assert.match(error.message, /нет-такого/);
      assert.equal(error.file, path);
      return true;
    });
  });
});

describe('backlog file: сведение причины', () => {
  it('oneLine оставляет начало, tailLine — конец', () => {
    const long = `начало ${'ы'.repeat(REASON_LIMIT * 2)} конец`;
    assert.ok(oneLine(long).startsWith('начало'));
    assert.ok(tailLine(long, REASON_LIMIT).endsWith('конец'));
    assert.ok(tailLine(long, REASON_LIMIT).length <= REASON_LIMIT);
  });

  it('короткий текст проходит обе целиком, лишь сплющив пробелы', () => {
    assert.equal(oneLine(' две\nстроки '), 'две строки');
    assert.equal(tailLine(' две\nстроки ', REASON_LIMIT), 'две строки');
  });
});

describe('backlog file: readBacklogFile', () => {
  it('отсутствующий файл — отказ, называющий путь', () => {
    const path = join(tmpdir(), 'stepcast-нет-такой-очереди.md');
    assert.throws(() => readBacklogFile(path), (error: unknown) => {
      assert.ok(error instanceof StepcastError);
      assert.equal(error.file, path);
      return true;
    });
  });
});
