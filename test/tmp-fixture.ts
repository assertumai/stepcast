import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withTempDir } from '../src/core/fs/tempDir.js';
import { tempDir } from './tmp.js';

/**
 * Дочерний процесс для `test/tmp.test.ts`: `node --test` даёт своё
 * поведение только внутри теста, а песочница проверяется свойствами целого
 * процесса — успехом, падением, исключением, сигналом. Проверить их можно
 * только со стороны, из процесса-родителя, отсюда отдельный исполняемый файл
 * вместо тела `it(...)`.
 */
const mode = process.argv[2];
const self = fileURLToPath(import.meta.url);

switch (mode) {
  case 'success': {
    console.log(process.env['TMPDIR']);
    console.log(tempDir('probe-'));
    break;
  }

  case 'assert-fail': {
    console.log(process.env['TMPDIR']);
    assert.ok(false, 'нарочно упавшее утверждение');
    break;
  }

  case 'throw': {
    console.log(process.env['TMPDIR']);
    throw new Error('нарочно брошенное исключение');
  }

  case 'signal-wait': {
    console.log(process.env['TMPDIR']);
    setInterval(() => {}, 1000);
    break;
  }

  // Код движка заводит временное состояние собственными средствами
  // (`withTempDir`), минуя `tempDir` теста, — и всё равно оказывается внутри
  // песочницы благодаря перехвату `TMPDIR`.
  case 'engine-tmpdir': {
    console.log(process.env['TMPDIR']);
    console.log(withTempDir('probe-', (dir) => dir));
    break;
  }

  // Дочерний процесс, унаследовавший окружение: его собственная песочница
  // заводится внутри уже перехваченного `TMPDIR` родителя.
  case 'spawn-parent': {
    console.log(process.env['TMPDIR']);
    const child = spawnSync(process.execPath, [self, 'spawn-child'], {
      encoding: 'utf8',
      env: process.env,
    });
    console.log(`CHILD:${child.stdout.trim()}`);
    break;
  }

  case 'spawn-child': {
    console.log(tempDir('child-'));
    break;
  }

  // Каталог, который щадящее рекурсивное снятие не осилит: вложенный каталог
  // без прав на чтение делает свои файлы недостижимыми для `rmSync`.
  case 'cleanup-fails': {
    console.log(process.env['TMPDIR']);
    const stuck = tempDir('stuck-');
    const blocked = join(stuck, 'blocked');
    mkdirSync(blocked);
    writeFileSync(join(blocked, 'file.txt'), 'x');
    chmodSync(blocked, 0o000);
    console.log(blocked);
    break;
  }

  default:
    throw new Error(`неизвестный режим фикстуры песочницы: ${mode}`);
}
