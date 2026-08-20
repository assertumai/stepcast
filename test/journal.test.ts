import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { RunJournal } from '../src/core/journal/writer.js';
import { cleanupRun } from '../src/core/run/cleanup.js';
import {
  findStepDir,
  follow,
  listRuns,
  readEvents,
  readStatus,
  resolveRun,
} from '../src/core/journal/reader.js';
import {
  findProjectRoot,
  makeRunId,
  parseStepDirName,
  projectKey,
  shortRunId,
  stepDirName,
} from '../src/core/journal/paths.js';
import { RunStatusSchema, type RunStatus } from '../src/core/journal/schema.js';
import { StepcastError } from '../src/core/errors.js';

interface Bed {
  readonly runsRoot: string;
  readonly projectRoot: string;
}

function bed(): Bed {
  const base = mkdtempSync(join(tmpdir(), 'stepcast-journal-'));
  const runsRoot = join(base, 'runs');
  const projectRoot = join(base, 'project');
  mkdirSync(runsRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  return { runsRoot, projectRoot };
}

function sampleStatus(runId: string, overrides: Partial<RunStatus> = {}): RunStatus {
  return {
    run_id: runId,
    pipeline: 'demo',
    lock_hash: 'abc',
    status: 'failed',
    workspace: { mode: 'cwd' },
    inputs: { change: 'foo' },
    jobs: [
      { id: 'plan', status: 'success', steps: [] },
      {
        id: 'build',
        status: 'failed',
        steps: [
          {
            id: 'compile',
            index: 1,
            kind: 'run',
            key: 'k',
            status: 'failed',
            attempts: [
              {
                attempt: 1,
                status: 'failed',
                reason: 'exit_code 2',
                started_at: '2026-08-16T10:00:00.000Z',
                finished_at: '2026-08-16T10:00:01.000Z',
                exit_code: 2,
              },
            ],
          },
        ],
      },
    ],
    budget: { tokens_used: 1200, tokens_limit: 100000, wallclock_ms: 5000 },
    resume: { command: `stepcast resume ${shortRunId(runId)} --from build`, blocked_by: 'build' },
    updated_at: '2026-08-16T10:00:01.000Z',
    ...overrides,
  };
}

function sampleManifest(runId: string): Parameters<RunJournal['writeManifest']>[0] {
  return {
    run_id: runId,
    pipeline: 'demo',
    pipeline_file: '/tmp/stepcast.yml',
    lock_hash: 'abc',
    project_root: '/tmp/project',
    workspace: { mode: 'cwd' },
    inputs: {},
    git: {},
    backends: {},
    started_at: '2026-08-16T10:00:00.000Z',
    finished_at: '2026-08-16T10:05:00.000Z',
  };
}

describe('run-journal: раскладка и состояние', () => {
  // Сценарий: «Изоляция прогонов разных проектов»
  it('раскладывает прогоны разных проектов под разными ключами', () => {
    const first = bed();
    const second = bed();

    RunJournal.create({ runsRoot: first.runsRoot, projectRoot: first.projectRoot });
    RunJournal.create({ runsRoot: first.runsRoot, projectRoot: second.projectRoot });

    assert.notEqual(projectKey(first.projectRoot), projectKey(second.projectRoot));
    assert.equal(listRuns(first.runsRoot, first.projectRoot).length, 1);
    assert.equal(listRuns(first.runsRoot, second.projectRoot).length, 1);
  });

  // Сценарий: «Указатель на проект»
  it('ведёт указатель соответствия ключа и пути', () => {
    const { runsRoot, projectRoot } = bed();
    RunJournal.create({ runsRoot, projectRoot });

    const index = JSON.parse(readFileSync(join(runsRoot, 'projects.json'), 'utf8')) as Record<
      string,
      { path: string }
    >;
    assert.equal(index[projectKey(projectRoot)]?.path, projectRoot);
  });

  // Сценарий: «Права доступа»
  it('ограничивает права каталога прогона владельцем', () => {
    const { runsRoot, projectRoot } = bed();
    const journal = RunJournal.create({ runsRoot, projectRoot });
    journal.writeStatus(sampleStatus(journal.paths.runId));

    assert.equal(statSync(journal.paths.dir).mode & 0o777, 0o700);
    assert.equal(statSync(journal.paths.status).mode & 0o777, 0o600);
  });

  it('ставит ярлык на последний прогон', () => {
    const { runsRoot, projectRoot } = bed();
    RunJournal.create({ runsRoot, projectRoot, runId: 'older' });
    const latest = RunJournal.create({ runsRoot, projectRoot, runId: 'newer' });

    const link = join(latest.paths.projectDir, 'latest');
    assert.ok(existsSync(link));
    assert.ok(lstatSync(link).isSymbolicLink());
  });

  // Сценарий: «Раскладка шага»
  it('создаёт каталоги работ и шагов с числовым префиксом', () => {
    const { runsRoot, projectRoot } = bed();
    const journal = RunJournal.create({ runsRoot, projectRoot });

    const dir = journal.prepareStep('implement', 2, 'write-code');
    assert.ok(dir.endsWith(join('implement', 'steps', '02-write-code')));

    journal.writeStepFile(dir, 'stdout.log', 'вывод\n');
    journal.writeStepJson(dir, 'step.json', { id: 'write-code' });
    assert.ok(existsSync(join(dir, 'stdout.log')));
    assert.equal(statSync(join(dir, 'stdout.log')).mode & 0o777, 0o600);
  });

  // Сценарий: «Нумерация и адресация шагов»
  it('адресует шаг по идентификатору, не зная его номера', () => {
    const { runsRoot, projectRoot } = bed();
    const journal = RunJournal.create({ runsRoot, projectRoot });
    journal.prepareStep('implement', 7, 'write-code');

    const found = findStepDir(journal.paths, 'implement', 'write-code');
    assert.ok(found !== undefined);
    assert.ok(found.endsWith('07-write-code'));
    assert.equal(findStepDir(journal.paths, 'implement', 'нет-такого'), undefined);
  });

  it('преобразует имя каталога шага туда и обратно', () => {
    assert.equal(stepDirName(3, 'review-diff'), '03-review-diff');
    assert.deepEqual(parseStepDirName('03-review-diff'), { index: 3, stepId: 'review-diff' });
    assert.deepEqual(parseStepDirName('review-diff'), undefined);
  });

  // Сценарий: «Отказ описан полностью»
  it('состояние позволяет назвать упавший шаг и путь к логу', () => {
    const { runsRoot, projectRoot } = bed();
    const journal = RunJournal.create({ runsRoot, projectRoot });
    journal.writeStatus(sampleStatus(journal.paths.runId));

    const status = readStatus(journal.paths);
    const failed = status.jobs.find((job) => job.status === 'failed');
    assert.ok(failed !== undefined);
    assert.equal(failed.steps[0]?.id, 'compile');
    assert.equal(failed.steps[0]?.attempts[0]?.exit_code, 2);
    assert.match(status.resume?.command ?? '', /stepcast resume/);
  });

  it('состояние проходит собственную схему', () => {
    const { runsRoot, projectRoot } = bed();
    const journal = RunJournal.create({ runsRoot, projectRoot });
    journal.writeStatus(sampleStatus(journal.paths.runId));
    assert.equal(RunStatusSchema.safeParse(readStatus(journal.paths)).success, true);
  });

  it('замена состояния атомарна: временных файлов не остаётся', () => {
    const { runsRoot, projectRoot } = bed();
    const journal = RunJournal.create({ runsRoot, projectRoot });

    for (let index = 0; index < 5; index += 1) {
      journal.writeStatus(sampleStatus(journal.paths.runId, { status: 'running' }));
    }

    const leftovers = execFileSync('ls', [journal.paths.dir])
      .toString()
      .split('\n')
      .filter((name) => name.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
  });

  // Сценарий: «Запись об исключении по запрету»
  it('пишет события построчно, включая исключения по запретам', () => {
    const { runsRoot, projectRoot } = bed();
    const journal = RunJournal.create({ runsRoot, projectRoot });

    journal.event({ kind: 'run.started', pipeline: 'demo', run_id: journal.paths.runId });
    journal.event({ kind: 'env.denied', name: 'GH_TOKEN', pattern: '*_TOKEN', scope: 'jobs.build' });
    journal.event({ kind: 'job.started', job: 'build' });

    const events = readEvents(journal.paths);
    assert.equal(events.length, 3);
    assert.deepEqual(
      events.map((event) => event.seq),
      [0, 1, 2],
    );

    const denied = events.find((event) => event.kind === 'env.denied');
    assert.ok(denied !== undefined && denied.kind === 'env.denied');
    assert.equal(denied.name, 'GH_TOKEN');
    assert.equal(denied.pattern, '*_TOKEN');
  });

  it('находит прогон по короткому идентификатору и по умолчанию берёт последний', () => {
    const { runsRoot, projectRoot } = bed();
    RunJournal.create({ runsRoot, projectRoot, runId: makeRunId(new Date('2026-08-16T10:00:00Z'), 'aaaaaa') });
    const newer = RunJournal.create({
      runsRoot,
      projectRoot,
      runId: makeRunId(new Date('2026-08-16T12:00:00Z'), 'bbbbbb'),
    });

    assert.equal(resolveRun(runsRoot, projectRoot).runId, newer.paths.runId);
    assert.equal(resolveRun(runsRoot, projectRoot, 'aaaaaa').runId.endsWith('aaaaaa'), true);
    // Ярлык называется latest, и это же имя пользователь набирает в командах.
    assert.equal(resolveRun(runsRoot, projectRoot, 'latest').runId, newer.paths.runId);
    assert.throws(() => resolveRun(runsRoot, projectRoot, 'нет'), StepcastError);
  });

  it('сообщает понятно, когда прогонов ещё не было', () => {
    const { runsRoot, projectRoot } = bed();
    assert.throws(
      () => resolveRun(runsRoot, projectRoot),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /Прогонов ещё не было/);
        return true;
      },
    );
  });

  it('определяет корень проекта по каталогу с .git', () => {
    const { projectRoot } = bed();
    const nested = join(projectRoot, 'src', 'deep');
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(projectRoot, '.git'), { recursive: true });

    assert.equal(findProjectRoot(nested), findProjectRoot(projectRoot));
  });

  // Сценарий: «Минимум переживает уборку»
  it('уборка сохраняет run.json, status.json и usage.json', () => {
    const { runsRoot, projectRoot } = bed();
    const journal = RunJournal.create({ runsRoot, projectRoot });
    journal.writeManifest(sampleManifest(journal.paths.runId));
    journal.writeStatus(sampleStatus(journal.paths.runId));
    journal.writeUsage({
      run_id: journal.paths.runId,
      total: { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, billable_tokens: 0, wallclock_ms: 0 },
      unreported: [],
      jobs: {},
    });
    journal.prepareStep('build', 1, 'compile');
    journal.writeArtifact('build', { ok: true });

    cleanupRun(journal.paths);

    assert.equal(readStatus(journal.paths).run_id, journal.paths.runId);
    assert.ok(existsSync(journal.paths.manifest));
    assert.ok(existsSync(journal.paths.usage));
    assert.ok(!existsSync(journal.paths.jobs));
    assert.ok(!existsSync(journal.paths.artifacts));
  });

  // Сценарий: «Чтение на лету»
  it('отдаёт дописанные строки читателю с сопровождением', async () => {
    const { runsRoot, projectRoot } = bed();
    const journal = RunJournal.create({ runsRoot, projectRoot });
    journal.event({ kind: 'job.started', job: 'first' });

    const controller = new AbortController();
    const received: string[] = [];

    const reading = (async () => {
      for await (const line of follow(journal.paths.events, {
        intervalMs: 10,
        signal: controller.signal,
      })) {
        received.push(line);
        if (received.length === 2) controller.abort();
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 30));
    journal.event({ kind: 'job.started', job: 'second' });
    await reading;

    assert.equal(received.length, 2);
    assert.match(received[0] as string, /"job":"first"/);
    assert.match(received[1] as string, /"job":"second"/);
  });
});
