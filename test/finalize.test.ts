import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const SCRIPT = fileURLToPath(new URL('../../scripts/finalize.mjs', import.meta.url));

interface Bed {
  readonly repo: string;
  readonly runDir: string;
}

function git(repo: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

/** Временный репозиторий с очередью из одного пункта, взятого в работу. */
function bed(): Bed {
  const base = mkdtempSync(join(tmpdir(), 'stepcast-finalize-'));
  const repo = join(base, 'repo');
  const runDir = join(base, 'run');
  mkdirSync(repo, { recursive: true });
  mkdirSync(runDir, { recursive: true });

  git(repo, ['init', '--quiet']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);

  writeFileSync(
    join(repo, 'backlog.md'),
    '# Очередь\n\n## some-item\n\nstatus: in_progress\ntitle: Улучшение\nwhy: з\ndone_when: к\n',
  );
  writeFileSync(join(repo, 'README.md'), 'исходное\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--quiet', '-m', 'исходный коммит']);

  return { repo, runDir };
}

function seedItem(runDir: string): void {
  writeFileSync(
    join(runDir, 'item.json'),
    JSON.stringify({ slug: 'some-item', title: 'Улучшение', why: 'з', done_when: 'к' }),
  );
}

function finalize(bed_: Bed, verifyStatus: string): { code: number; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, '--verify-status', verifyStatus], {
    cwd: bed_.repo,
    encoding: 'utf8',
    env: { ...process.env, STEPCAST_RUN_DIR: bed_.runDir },
  });
  return { code: result.status ?? -1, stderr: result.stderr };
}

function statusOf(repo: string): string | undefined {
  const text = readFileSync(join(repo, 'backlog.md'), 'utf8');
  return /^status:\s*(.*)$/m.exec(text)?.[1];
}

function commitCount(repo: string): number {
  return Number(git(repo, ['rev-list', '--count', 'HEAD']).trim());
}

describe('завершение захода петли', () => {
  it('ничего не делает, если пункт не брался', () => {
    const bed_ = bed();
    const result = finalize(bed_, 'success');

    assert.equal(result.code, 0);
    assert.equal(statusOf(bed_.repo), 'in_progress');
    assert.equal(commitCount(bed_.repo), 1);
  });

  it('при успехе помечает пункт done и коммитит одним коммитом', () => {
    const bed_ = bed();
    seedItem(bed_.runDir);
    writeFileSync(join(bed_.repo, 'README.md'), 'правка агента\n');

    const result = finalize(bed_, 'success');

    assert.equal(result.code, 0, result.stderr);
    assert.equal(statusOf(bed_.repo), 'done');
    assert.equal(commitCount(bed_.repo), 2);

    // Один коммит содержит и правку кода, и отметку исхода: git revert
    // снимает улучшение вместе с его бухгалтерией.
    const changed = git(bed_.repo, ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n');
    assert.deepEqual(changed.sort(), ['README.md', 'backlog.md']);
    assert.match(git(bed_.repo, ['log', '-1', '--format=%s']), /some-item/);
  });

  it('при отказе помечает пункт failed и не коммитит', () => {
    const bed_ = bed();
    seedItem(bed_.runDir);
    writeFileSync(join(bed_.repo, 'README.md'), 'сломанная правка\n');

    const result = finalize(bed_, 'failed');

    assert.equal(result.code, 0, result.stderr);
    assert.equal(statusOf(bed_.repo), 'failed');
    assert.equal(commitCount(bed_.repo), 1);
    assert.match(readFileSync(join(bed_.repo, 'backlog.md'), 'utf8'), /^reason:.*failed/m);
  });

  it('правки агента при отказе остаются в дереве нетронутыми', () => {
    const bed_ = bed();
    seedItem(bed_.runDir);
    writeFileSync(join(bed_.repo, 'README.md'), 'сломанная правка\n');

    finalize(bed_, 'failed');

    assert.equal(readFileSync(join(bed_.repo, 'README.md'), 'utf8'), 'сломанная правка\n');
  });

  it('пропущенная работа verify считается отказом', () => {
    const bed_ = bed();
    seedItem(bed_.runDir);

    const result = finalize(bed_, 'skipped');

    assert.equal(result.code, 0, result.stderr);
    assert.equal(statusOf(bed_.repo), 'failed');
    assert.equal(commitCount(bed_.repo), 1);
  });

  it('требует ключа --verify-status', () => {
    const bed_ = bed();
    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd: bed_.repo,
      encoding: 'utf8',
      env: { ...process.env, STEPCAST_RUN_DIR: bed_.runDir },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /verify-status/);
  });
});
