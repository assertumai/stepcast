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

/** Временный репозиторий с очередью, готовой принять пункты дорожек. */
function bed(items: readonly string[]): Bed {
  const base = mkdtempSync(join(tmpdir(), 'stepcast-finalize-'));
  const repo = join(base, 'repo');
  const runDir = join(base, 'run');
  mkdirSync(repo, { recursive: true });
  mkdirSync(runDir, { recursive: true });

  git(repo, ['init', '--quiet']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);

  writeFileSync(join(repo, 'backlog.md'), `# Очередь\n\n${items.join('\n')}`);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--quiet', '-m', 'исходный коммит']);

  return { repo, runDir };
}

function backlogItem(slug: string, status: string): string {
  return `## ${slug}\n\nstatus: ${status}\ntitle: Улучшение ${slug}\nwhy: з\ndone_when: к\n`;
}

function seedItemFile(runDir: string, lane: string, slug: string): void {
  writeFileSync(
    join(runDir, `item-${lane}.json`),
    JSON.stringify({ slug, title: `Улучшение ${slug}`, why: 'з', done_when: 'к' }),
  );
}

function seedMergeOutcome(runDir: string, lane: string, status: string, reason?: string): void {
  writeFileSync(join(runDir, `merge-${lane}.json`), JSON.stringify({ status, ...(reason === undefined ? {} : { reason }) }));
}

function finalize(bed_: Bed): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: bed_.repo,
    encoding: 'utf8',
    env: { ...process.env, STEPCAST_RUN_DIR: bed_.runDir },
  });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function statusOf(repo: string, slug: string): string | undefined {
  const section = readFileSync(join(repo, 'backlog.md'), 'utf8').split(`## ${slug}\n`)[1]?.split('\n## ')[0] ?? '';
  return /^status:\s*(.*)$/m.exec(section)?.[1];
}

function fieldOf(repo: string, slug: string, name: string): string | undefined {
  const section = readFileSync(join(repo, 'backlog.md'), 'utf8').split(`## ${slug}\n`)[1]?.split('\n## ')[0] ?? '';
  return new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(section)?.[1];
}

function commitCount(repo: string): number {
  return Number(git(repo, ['rev-list', '--count', 'HEAD']).trim());
}

describe('finalize: исход по всем взятым пунктам', () => {
  it('ничего не делает, если ни один пункт не брался', () => {
    const bed_ = bed([backlogItem('some-item', 'pending')]);
    const result = finalize(bed_);

    assert.equal(result.code, 0);
    assert.equal(statusOf(bed_.repo, 'some-item'), 'pending');
    assert.equal(commitCount(bed_.repo), 1, 'finalize коммитов не создаёт');
  });

  // Сценарий: «Отмена по сигналу» — merge не запускалась вовсе, файлов
  // merge-<lane>.json нет.
  it('отмена по сигналу до сведения: взятый пункт помечается failed без merge-файла', () => {
    const bed_ = bed([backlogItem('a-item', 'in_progress')]);
    seedItemFile(bed_.runDir, 'a', 'a-item');

    const result = finalize(bed_);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(statusOf(bed_.repo, 'a-item'), 'failed');
    assert.match(fieldOf(bed_.repo, 'a-item', 'reason') ?? '', /не дошло/);
    assert.equal(commitCount(bed_.repo), 1);
  });

  // Сценарий: «Останов по бюджету» — тот же случай снаружи: merge не
  // добежала до дорожки, файла нет.
  it('останов по бюджету до сведения: взятый пункт помечается failed', () => {
    const bed_ = bed([backlogItem('b-item', 'in_progress')]);
    seedItemFile(bed_.runDir, 'b', 'b-item');

    const result = finalize(bed_);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(statusOf(bed_.repo, 'b-item'), 'failed');
    assert.match(fieldOf(bed_.repo, 'b-item', 'reason') ?? '', /не дошло/);
  });

  it('одна дорожка свелась (done, не трогается), другая — нет (помечается failed)', () => {
    const bed_ = bed([backlogItem('a-item', 'done'), backlogItem('b-item', 'in_progress')]);
    seedItemFile(bed_.runDir, 'a', 'a-item');
    seedItemFile(bed_.runDir, 'b', 'b-item');
    seedMergeOutcome(bed_.runDir, 'a', 'merged');
    seedMergeOutcome(bed_.runDir, 'b', 'check_failed', 'проверка после наложения не прошла');

    const result = finalize(bed_);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(statusOf(bed_.repo, 'a-item'), 'done');
    assert.equal(fieldOf(bed_.repo, 'a-item', 'reason'), undefined);
    assert.equal(statusOf(bed_.repo, 'b-item'), 'failed');
    assert.match(fieldOf(bed_.repo, 'b-item', 'reason') ?? '', /красная|check_failed|наложения/);
  });

  it('дорожка, пропущенная verify, отражает причину из итога сведения', () => {
    const bed_ = bed([backlogItem('c-item', 'in_progress')]);
    seedItemFile(bed_.runDir, 'c', 'c-item');
    seedMergeOutcome(bed_.runDir, 'c', 'skipped_verify', 'у дорожки c работа verify завершилась статусом failed');

    const result = finalize(bed_);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(statusOf(bed_.repo, 'c-item'), 'failed');
    assert.match(fieldOf(bed_.repo, 'c-item', 'reason') ?? '', /verify/);
  });

  it('пустая дорожка (нет файла пункта) ничего не получает', () => {
    const bed_ = bed([backlogItem('a-item', 'in_progress')]);
    seedItemFile(bed_.runDir, 'a', 'a-item');
    // Дорожка b пуста: пункт не брался, файла item-b.json нет.

    const result = finalize(bed_);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(statusOf(bed_.repo, 'a-item'), 'failed');
    // Ничего лишнего в очередь не попало.
    assert.doesNotMatch(readFileSync(join(bed_.repo, 'backlog.md'), 'utf8'), /## b-item/);
  });

  it('не создаёт ни одного коммита', () => {
    const bed_ = bed([backlogItem('a-item', 'in_progress')]);
    seedItemFile(bed_.runDir, 'a', 'a-item');

    finalize(bed_);

    assert.equal(commitCount(bed_.repo), 1);
  });
});
