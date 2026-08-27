import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/**
 * `merge-lanes.mjs` — обычный `.mjs` без сборки, зовётся отдельным процессом,
 * как это делает пайплайн. Путь к `stepcast` заменяется на фальшивый
 * исполняемый скрипт: настоящее наложение дифов проверено в `workspace.test.ts`
 * (`apply --lane`), а здесь важно поведение сведения — порядок дорожек, откат
 * при красной проверке, остановка при конфликте.
 */
const SCRIPT = fileURLToPath(new URL('../../scripts/merge-lanes.mjs', import.meta.url));

interface Result {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function gitInit(dir: string): void {
  const run = (...args: string[]): void => {
    execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  };
  run('init', '--quiet', '--initial-branch=main');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Тест');
}

function commit(dir: string, message: string): void {
  execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['-C', dir, 'commit', '--quiet', '-m', message], { stdio: ['ignore', 'pipe', 'pipe'] });
}

function commitCount(dir: string): number {
  return Number(
    execFileSync('git', ['-C', dir, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim(),
  );
}

/**
 * Фальшивый `stepcast`: `apply --lane <lane> <runId>` — либо создаёт файл
 * дорожки (успех), либо отказывает кодом 1 (конфликт), смотря по
 * `FAKE_APPLY_FAIL`.
 */
const FAKE_STEPCAST = `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const [, , cmd, flag, lane] = process.argv;
if (cmd === 'apply' && flag === '--lane') {
  if (process.env.FAKE_APPLY_FAIL === lane) {
    process.stderr.write('дорожка ' + lane + ' не сошлась с текущим деревом\\n');
    process.exit(1);
  }
  writeFileSync(lane + '.txt', 'от дорожки ' + lane + '\\n');
  process.exit(0);
}
process.exit(1);
`;

interface Fixture {
  readonly projectDir: string;
  readonly runDir: string;
  readonly stepcastBin: string;
}

/** Дерево проекта: git-репозиторий с быстрой командой check. */
function makeFixture(checkScript: string): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'stepcast-merge-'));
  const projectDir = join(base, 'project');
  const runDir = join(base, 'run');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(runDir, { recursive: true });

  writeFileSync(
    join(projectDir, 'package.json'),
    JSON.stringify({ name: 'p', scripts: { check: checkScript } }, null, 2),
  );
  gitInit(projectDir);
  commit(projectDir, 'начальный коммит');

  const stepcastBin = join(base, 'fake-stepcast.mjs');
  writeFileSync(stepcastBin, FAKE_STEPCAST);
  chmodSync(stepcastBin, 0o755);

  return { projectDir, runDir, stepcastBin };
}

function writeStatus(runDir: string, jobs: readonly Record<string, unknown>[]): void {
  writeFileSync(join(runDir, 'status.json'), JSON.stringify({ jobs }));
}

function writeItem(runDir: string, lane: string, slug: string, title: string): void {
  writeFileSync(join(runDir, `item-${lane}.json`), JSON.stringify({ slug, title }));
}

function verifyJob(lane: string, status: string): Record<string, unknown> {
  return { id: 'verify', lane, status, workspace: { mode: 'worktree', path: `/tmp/worktree-${lane}` } };
}

function backlogItem(slug: string): string {
  return `## ${slug}\n\nstatus: in_progress\ntitle: т\nwhy: з\ndone_when: к\n`;
}

function mergeLanes(fixture: Fixture, lanes: string, backlogFile: string, extraEnv: Record<string, string> = {}): Result {
  const result = spawnSync(process.execPath, [SCRIPT, '--lanes', lanes, '--file', backlogFile], {
    cwd: fixture.projectDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      STEPCAST_RUN_ID: 'r1',
      STEPCAST_RUN_DIR: fixture.runDir,
      STEPCAST_BIN: fixture.stepcastBin,
      ...extraEnv,
    },
  });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe('merge-lanes: сведение дорожек', () => {
  it('обе дорожки сходятся: два коммита, оба пункта done', () => {
    const fixture = makeFixture('node -e "process.exit(0)"');
    writeStatus(fixture.runDir, [verifyJob('a', 'success'), verifyJob('b', 'success')]);
    writeItem(fixture.runDir, 'a', 'slug-a', 'Заголовок A');
    writeItem(fixture.runDir, 'b', 'slug-b', 'Заголовок B');
    const backlogFile = join(fixture.projectDir, 'backlog.md');
    writeFileSync(backlogFile, `${backlogItem('slug-a')}\n${backlogItem('slug-b')}`);

    const result = mergeLanes(fixture, 'a,b', backlogFile);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(commitCount(fixture.projectDir), 3);
    assert.ok(existsSync(join(fixture.projectDir, 'a.txt')));
    assert.ok(existsSync(join(fixture.projectDir, 'b.txt')));
    assert.match(readFileSync(backlogFile, 'utf8'), /slug-a[\s\S]*status: done/);
    assert.match(readFileSync(backlogFile, 'utf8'), /slug-b[\s\S]*status: done/);
  });

  it('дорожка с отказавшей verify пропускается, остальные сходятся', () => {
    const fixture = makeFixture('node -e "process.exit(0)"');
    writeStatus(fixture.runDir, [verifyJob('a', 'failed'), verifyJob('b', 'success')]);
    writeItem(fixture.runDir, 'b', 'slug-b', 'Заголовок B');
    const backlogFile = join(fixture.projectDir, 'backlog.md');
    writeFileSync(backlogFile, backlogItem('slug-b'));

    const result = mergeLanes(fixture, 'a,b', backlogFile);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /a.*пропущена/s);
    assert.equal(existsSync(join(fixture.projectDir, 'a.txt')), false);
    assert.ok(existsSync(join(fixture.projectDir, 'b.txt')));
    assert.equal(commitCount(fixture.projectDir), 2);
  });

  it('конфликт наложения останавливает сведение, называя дорожку и путь дерева', () => {
    const fixture = makeFixture('node -e "process.exit(0)"');
    writeStatus(fixture.runDir, [verifyJob('a', 'success'), verifyJob('b', 'success')]);
    writeItem(fixture.runDir, 'a', 'slug-a', 'Заголовок A');
    writeItem(fixture.runDir, 'b', 'slug-b', 'Заголовок B');
    const backlogFile = join(fixture.projectDir, 'backlog.md');
    writeFileSync(backlogFile, `${backlogItem('slug-a')}\n${backlogItem('slug-b')}`);

    const result = mergeLanes(fixture, 'a,b', backlogFile, { FAKE_APPLY_FAIL: 'a' });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /дорожка a/);
    assert.match(result.stderr, /worktree-a/);
    assert.equal(existsSync(join(fixture.projectDir, 'a.txt')), false);
    assert.equal(existsSync(join(fixture.projectDir, 'b.txt')), false);
    assert.equal(commitCount(fixture.projectDir), 1);
  });

  it('красная проверка после наложения откатывает дерево и останавливает сведение', () => {
    const fixture = makeFixture(
      'node -e "process.exit(require(\'node:fs\').existsSync(\'b.txt\') ? 1 : 0)"',
    );
    writeStatus(fixture.runDir, [verifyJob('a', 'success'), verifyJob('b', 'success')]);
    writeItem(fixture.runDir, 'a', 'slug-a', 'Заголовок A');
    writeItem(fixture.runDir, 'b', 'slug-b', 'Заголовок B');
    const backlogFile = join(fixture.projectDir, 'backlog.md');
    writeFileSync(backlogFile, `${backlogItem('slug-a')}\n${backlogItem('slug-b')}`);

    const result = mergeLanes(fixture, 'a,b', backlogFile);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /дорожка b/);
    assert.match(result.stderr, /worktree-b/);
    // Дорожка a уже сведена и закоммичена — остаётся на месте.
    assert.ok(existsSync(join(fixture.projectDir, 'a.txt')));
    // Дорожка b отклонена проверкой — откат снял её со сцены.
    assert.equal(existsSync(join(fixture.projectDir, 'b.txt')), false);
    assert.equal(commitCount(fixture.projectDir), 2);
  });
});
