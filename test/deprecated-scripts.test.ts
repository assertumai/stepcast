import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { gitCommit, gitInit, makeProject } from './helpers.js';

/**
 * `scripts/merge-lanes.mjs` и `scripts/finalize.mjs` больше не несут логику
 * сведения/расчистки (см. `stepcast merge-lanes` и `stepcast backlog settle`,
 * покрытые соответственно `test/merge-lanes.test.ts` и
 * `describe('CLI: stepcast backlog settle', …)` в `test/cli-backlog.test.ts`)
 * — прямой запуск обязан немедленно отказывать, не подменяя их собой.
 */

const MERGE_LANES_SCRIPT = fileURLToPath(new URL('../../scripts/merge-lanes.mjs', import.meta.url));
const FINALIZE_SCRIPT = fileURLToPath(new URL('../../scripts/finalize.mjs', import.meta.url));

describe('scripts/merge-lanes.mjs — заглушка', () => {
  it('отказывает ненулевым кодом, называет замену, не трогает дерево и git', () => {
    const project = makeProject({ 'файл.txt': 'исходное\n' });
    gitInit(project.root);
    gitCommit(project.root, 'начальный');
    const headBefore = spawnSync('git', ['-C', project.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();

    const result = spawnSync(process.execPath, [MERGE_LANES_SCRIPT], { cwd: project.root, encoding: 'utf8' });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /stepcast merge-lanes/);
    assert.equal(readFileSync(project.path('файл.txt'), 'utf8'), 'исходное\n');
    assert.equal(
      spawnSync('git', ['-C', project.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
      headBefore,
    );
    assert.equal(spawnSync('git', ['-C', project.root, 'status', '--porcelain'], { encoding: 'utf8' }).stdout, '');
  });
});

describe('scripts/finalize.mjs — заглушка', () => {
  it('отказывает ненулевым кодом, называет замену, не трогает очередь и git', () => {
    const project = makeProject({ 'backlog.md': '# Очередь\n' });
    gitInit(project.root);
    gitCommit(project.root, 'начальный');
    const headBefore = spawnSync('git', ['-C', project.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();

    const result = spawnSync(process.execPath, [FINALIZE_SCRIPT], { cwd: project.root, encoding: 'utf8' });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /stepcast backlog settle/);
    assert.equal(readFileSync(project.path('backlog.md'), 'utf8'), '# Очередь\n');
    assert.equal(
      spawnSync('git', ['-C', project.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
      headBefore,
    );
    assert.equal(spawnSync('git', ['-C', project.root, 'status', '--porcelain'], { encoding: 'utf8' }).stdout, '');
  });
});
