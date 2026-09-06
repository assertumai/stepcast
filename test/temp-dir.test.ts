import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { withTempDir } from '../src/core/fs/tempDir.js';
// Песочница процесса: без неё каталоги помощника ушли бы в настоящий $TMPDIR
// и пережили бы прогон.
import './tmp.js';

/** Каталог, который щадящее рекурсивное снятие не осилит: вложенный каталог без прав. */
function blockCleanup(dir: string): string {
  const blocked = join(dir, 'blocked');
  mkdirSync(blocked);
  writeFileSync(join(blocked, 'file.txt'), 'x');
  chmodSync(blocked, 0o000);
  return blocked;
}

/**
 * Вернуть права и снять оставленное. Зовётся из `finally` целиком охватывающего
 * тело теста: каталог без прав переживает и уборку песочницы, поэтому
 * неожиданное падение самой проверки не должно оставлять его на диске.
 */
function unblock(state: { blocked: string; seen: string }): void {
  if (state.blocked !== '') chmodSync(state.blocked, 0o700);
  if (state.seen !== '') rmSync(state.seen, { recursive: true, force: true });
}

/** Собрать написанное в поток ошибок за время вызова. */
function captureStderr(fn: () => void): string {
  const original = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    captured += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

describe('workspace-anchor: временный каталог движка', () => {
  it('снимается после успешного вызова', () => {
    let seen = '';
    const value = withTempDir('stepcast-проба-', (dir) => {
      seen = dir;
      writeFileSync(join(dir, 'состояние.txt'), 'x');
      assert.equal(existsSync(dir), true);
      return 'готово';
    });
    assert.equal(value, 'готово');
    assert.equal(existsSync(seen), false, `каталог ${seen} обязан быть снят`);
  });

  it('снимается и когда тело бросило, а исключение уходит наружу', () => {
    let seen = '';
    assert.throws(
      () =>
        withTempDir('stepcast-проба-', (dir) => {
          seen = dir;
          throw new Error('отказ по существу');
        }),
      /отказ по существу/,
    );
    assert.equal(existsSync(seen), false, `каталог ${seen} обязан быть снят и при исключении`);
  });

  // Отказ уборки — не исход вызова: иначе он подменил бы собой и возвращённое
  // значение, и исключение, ради которого `finally` исполняется.
  it('отказ уборки не роняет успешный вызов и называет путь', () => {
    const state = { blocked: '', seen: '' };
    try {
      let value = '';
      const stderr = captureStderr(() => {
        value = withTempDir('stepcast-проба-', (dir) => {
          state.seen = dir;
          state.blocked = blockCleanup(dir);
          return 'готово';
        });
      });
      assert.equal(value, 'готово');
      assert.ok(stderr.includes(state.seen), `неснятый путь обязан быть назван в потоке ошибок: ${stderr}`);
    } finally {
      unblock(state);
    }
  });

  it('отказ уборки не подменяет собой исключение тела', () => {
    const state = { blocked: '', seen: '' };
    try {
      captureStderr(() => {
        assert.throws(
          () =>
            withTempDir('stepcast-проба-', (dir) => {
              state.seen = dir;
              state.blocked = blockCleanup(dir);
              throw new Error('отказ по существу');
            }),
          /отказ по существу/,
        );
      });
    } finally {
      unblock(state);
    }
  });
});
