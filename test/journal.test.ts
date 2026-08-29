import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { RunJournal } from '../src/core/journal/writer.js';
import { cleanupRun } from '../src/core/run/cleanup.js';
import {
  findAliveRun,
  findStepDir,
  follow,
  isRunAlive,
  listProjects,
  listRuns,
  listRunsByKey,
  readEvents,
  readManifest,
  readResetHint,
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
import { AttemptRecordSchema, RunStatusSchema, type RunStatus } from '../src/core/journal/schema.js';
import { StepcastError } from '../src/core/errors.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { runPipeline } from '../src/core/run/runner.js';
import { createFakeBackend, resultLine } from '../src/core/backend/fake.js';
import type { Config } from '../src/core/config/resolve.js';
import {
  gitCommit,
  gitInit as gitInitDir,
  makeProject,
  MINIMAL_PIPELINE,
  type Project,
} from './helpers.js';

function gitInit(project: Project): void {
  const run = (...args: string[]): void => {
    execFileSync('git', ['-C', project.root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  };
  run('init', '--quiet', '--initial-branch=main');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Тест');
  run('add', '-A');
  run('commit', '--quiet', '-m', 'первый');
}

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

  // Спека pipeline-lanes: «Дорожка в записи работы состояния прогона»
  it('запись работы с объявленной lane несёт её, а запись без lane — нет', () => {
    const { runsRoot, projectRoot } = bed();
    const journal = RunJournal.create({ runsRoot, projectRoot });
    const status = sampleStatus(journal.paths.runId);
    journal.writeStatus({
      ...status,
      jobs: status.jobs.map((job, index) => (index === 0 ? { ...job, lane: 'a' } : job)),
    });

    const read = readStatus(journal.paths);
    assert.equal(read.jobs[0]?.lane, 'a');
    assert.equal(read.jobs[1]?.lane, undefined);
  });

  it('состояние прежней формы без lane у работ читается без ошибки', () => {
    const { runsRoot, projectRoot } = bed();
    const journal = RunJournal.create({ runsRoot, projectRoot });
    const status = sampleStatus(journal.paths.runId);
    journal.writeStatus(status);

    const read = readStatus(journal.paths);
    assert.ok(read.jobs.every((job) => job.lane === undefined));
    assert.equal(RunStatusSchema.safeParse(read).success, true);
  });

  it('состояние с моментом пробуждения читается во время ожидания', () => {
    const { runsRoot, projectRoot } = bed();
    const journal = RunJournal.create({ runsRoot, projectRoot });
    journal.writeStatus(
      sampleStatus(journal.paths.runId, { status: 'running', wake_at: '2026-08-23T22:00:00.000Z' }),
    );

    const status = readStatus(journal.paths);
    assert.equal(status.wake_at, '2026-08-23T22:00:00.000Z');
    assert.equal(RunStatusSchema.safeParse(status).success, true);
  });

  it('пишет события ожидания и пробуждения по бюджету', () => {
    const { runsRoot, projectRoot } = bed();
    const journal = RunJournal.create({ runsRoot, projectRoot });

    journal.event({
      kind: 'budget.waiting',
      scope: 'работа build/plan',
      dimension: 'rate_limit',
      threshold: 80,
      resets_at: 1_700_000_000_000,
      wait_ms: 60_000,
    });
    journal.event({ kind: 'budget.resumed', actual_ms: 60_050 });

    const events = readEvents(journal.paths);
    assert.equal(events.some((event) => event.kind === 'budget.waiting'), true);
    assert.equal(events.some((event) => event.kind === 'budget.resumed'), true);
  });

  // Сценарий: «Запись об усечении выдержки»
  it('пишет событие об усечении выдержки с исходным и итоговым размером', () => {
    const { runsRoot, projectRoot } = bed();
    const journal = RunJournal.create({ runsRoot, projectRoot });

    journal.event({
      kind: 'context.note_truncated',
      job: 'работа',
      step: 'думает',
      original_tokens: 9000,
      final_tokens: 4000,
    });

    const events = readEvents(journal.paths);
    const event = events.find((item) => item.kind === 'context.note_truncated');
    assert.ok(event !== undefined);
    assert.deepEqual(event, {
      ...event,
      job: 'работа',
      step: 'думает',
      original_tokens: 9000,
      final_tokens: 4000,
    });
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

  // Спека ui-dashboard: «Прогоны нескольких проектов в одном обзоре»
  it('перечисляет проекты корня прогонов и сопоставляет им пути', () => {
    const first = bed();
    const second = bed();

    RunJournal.create({ runsRoot: first.runsRoot, projectRoot: first.projectRoot });
    RunJournal.create({ runsRoot: first.runsRoot, projectRoot: second.projectRoot });

    const projects = listProjects(first.runsRoot);
    assert.equal(projects.length, 2);
    assert.deepEqual(
      projects.map((project) => project.path).sort(),
      [first.projectRoot, second.projectRoot].sort(),
    );
  });

  // Спека ui-dashboard: «Проект без записи в указателе»
  it('отдаёт проект без пути, если его нет в указателе', () => {
    const { runsRoot, projectRoot } = bed();
    RunJournal.create({ runsRoot, projectRoot });
    mkdirSync(join(runsRoot, 'ffffffffffff'), { recursive: true });

    const orphan = listProjects(runsRoot).find((project) => project.key === 'ffffffffffff');
    assert.ok(orphan !== undefined);
    assert.equal(orphan.path, undefined);
  });

  it('перечисляет каталоги проектов при повреждённом указателе', () => {
    const { runsRoot, projectRoot } = bed();
    RunJournal.create({ runsRoot, projectRoot });
    writeFileSync(join(runsRoot, 'projects.json'), 'не json');

    const projects = listProjects(runsRoot);
    assert.equal(projects.length, 1);
    assert.equal(projects[0]?.path, undefined);
    assert.equal(projects[0]?.key, projectKey(projectRoot));
  });

  it('на пустом и отсутствующем корне прогонов отдаёт пустой список', () => {
    const { runsRoot } = bed();
    assert.deepEqual(listProjects(runsRoot), []);
    assert.deepEqual(listProjects(join(runsRoot, 'нет-такого')), []);
  });

  it('перечисляет прогоны по ключу проекта, минуя ярлык latest', () => {
    const { runsRoot, projectRoot } = bed();
    RunJournal.create({ runsRoot, projectRoot, runId: 'older' });
    RunJournal.create({ runsRoot, projectRoot, runId: 'newer' });

    const runs = listRunsByKey(runsRoot, projectKey(projectRoot));
    assert.deepEqual(runs, ['older', 'newer'].sort().reverse());
    assert.ok(!runs.includes('latest'));
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

describe('run-journal: наблюдение за потоком событий', () => {
  it('доставляет событие наблюдателю после того, как оно уже в файле', () => {
    const { runsRoot, projectRoot } = bed();
    const delivered: string[] = [];
    let seenInFile: string[] = [];
    const journal = RunJournal.create({
      runsRoot,
      projectRoot,
      onEvent: (event) => {
        delivered.push(event.kind);
        seenInFile = readEvents(journal.paths).map((item) => item.kind);
      },
    });

    journal.event({ kind: 'job.started', job: 'build' });

    assert.deepEqual(delivered, ['job.started']);
    assert.deepEqual(seenInFile, ['job.started']);
  });

  it('последовательность и состав доставленного совпадают с файлом', () => {
    const { runsRoot, projectRoot } = bed();
    const delivered: string[] = [];
    const journal = RunJournal.create({
      runsRoot,
      projectRoot,
      onEvent: (event) => delivered.push(event.kind),
    });

    journal.event({ kind: 'run.started', pipeline: 'demo', run_id: journal.paths.runId });
    journal.event({ kind: 'job.started', job: 'build' });
    journal.event({ kind: 'job.finished', job: 'build', status: 'success' });

    assert.deepEqual(
      delivered,
      readEvents(journal.paths).map((event) => event.kind),
    );
  });

  it('исключение наблюдателя не прерывает прогон и попадает в журнал как bookkeeping.failed', () => {
    const { runsRoot, projectRoot } = bed();
    let calls = 0;
    const journal = RunJournal.create({
      runsRoot,
      projectRoot,
      onEvent: () => {
        calls += 1;
        throw new Error('вывод сломан');
      },
    });

    journal.event({ kind: 'job.started', job: 'build' });

    const events = readEvents(journal.paths);
    assert.equal(events.some((event) => event.kind === 'job.started'), true);
    const failure = events.find((event) => event.kind === 'bookkeeping.failed');
    assert.ok(failure !== undefined && failure.kind === 'bookkeeping.failed');
    assert.match(failure.operation, /наблюдение/);
    // Наблюдатель позвался ровно на исходное событие: запись о его же
    // неудаче рекурсии не вызывает.
    assert.equal(calls, 1);
  });

  it('устойчиво падающий наблюдатель отключается и перестаёт множить bookkeeping.failed', () => {
    const { runsRoot, projectRoot } = bed();
    let calls = 0;
    const journal = RunJournal.create({
      runsRoot,
      projectRoot,
      onEvent: () => {
        calls += 1;
        throw new Error('поток вывода закрыт');
      },
    });

    for (let index = 0; index < 10; index += 1) {
      journal.event({ kind: 'job.started', job: `job-${index}` });
    }

    // Наблюдатель отключён после третьего отказа подряд: дальше события идут
    // в файл, но печатать их некому.
    assert.equal(calls, 3);
    const events = readEvents(journal.paths);
    const failures = events.filter((event) => event.kind === 'bookkeeping.failed');
    assert.equal(failures.length, 3);
    const last = failures.at(-1);
    assert.ok(last !== undefined && last.kind === 'bookkeeping.failed');
    assert.match(last.operation, /отключено/);
    assert.equal(events.filter((event) => event.kind === 'job.started').length, 10);
  });

  it('удачная доставка обнуляет счёт отказов: наблюдатель, оживший после сбоя, не отключается', () => {
    const { runsRoot, projectRoot } = bed();
    let calls = 0;
    const journal = RunJournal.create({
      runsRoot,
      projectRoot,
      onEvent: () => {
        calls += 1;
        // Отказ на каждом втором вызове: подряд трёх не набирается.
        if (calls % 2 === 0) throw new Error('единичный сбой');
      },
    });

    for (let index = 0; index < 10; index += 1) {
      journal.event({ kind: 'job.started', job: `job-${index}` });
    }

    assert.equal(calls, 10);
  });

  it('прогон без объявленного наблюдателя ведёт журнал как прежде', () => {
    const { runsRoot, projectRoot } = bed();
    const journal = RunJournal.create({ runsRoot, projectRoot });

    assert.doesNotThrow(() => journal.event({ kind: 'job.started', job: 'build' }));
    assert.equal(readEvents(journal.paths).length, 1);
  });
});

/**
 * Начало прогона, который считается живым: живость сверяется с моментом
 * последней загрузки машины, поэтому прогон «из прошлого» живым не бывает.
 */
const RECENT = new Date().toISOString();

describe('run-journal: идентификатор процесса прогона', () => {
  // Сценарий: «Идущий прогон отличим от брошенного»
  it('пишет pid в манифест до запуска первой работы и переживает завершение прогона', async () => {
    const project = makeProject({ 'stepcast.yml': MINIMAL_PIPELINE });
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
    const expanded = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config });

    const result = await runPipeline({
      expanded,
      config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
    });

    const manifest = readManifest(result.journal.paths);
    assert.equal(manifest.pid, process.pid);
    assert.ok(manifest.finished_at !== undefined);
  });

  it('отличает живой прогон (свой процесс) от брошенного (несуществующий pid)', () => {
    const { runsRoot, projectRoot } = bed();

    const alive = RunJournal.create({ runsRoot, projectRoot, runId: 'alive' });
    alive.writeManifest({
      run_id: 'alive',
      pipeline: 'demo',
      pipeline_file: join(projectRoot, 'stepcast.yml'),
      lock_hash: 'abc',
      project_root: projectRoot,
      workspace: { mode: 'cwd' },
      inputs: {},
      git: {},
      backends: {},
      started_at: RECENT,
      pid: process.pid,
    });
    alive.writeStatus({
      run_id: 'alive',
      pipeline: 'demo',
      lock_hash: 'abc',
      status: 'running',
      workspace: { mode: 'cwd' },
      inputs: {},
      jobs: [],
      budget: { tokens_used: 0, wallclock_ms: 0 },
      updated_at: '2026-08-01T00:00:00.000Z',
    });

    const abandoned = RunJournal.create({ runsRoot, projectRoot, runId: 'abandoned' });
    abandoned.writeManifest({
      run_id: 'abandoned',
      pipeline: 'demo',
      pipeline_file: join(projectRoot, 'stepcast.yml'),
      lock_hash: 'abc',
      project_root: projectRoot,
      workspace: { mode: 'cwd' },
      inputs: {},
      git: {},
      backends: {},
      started_at: RECENT,
      pid: 999_999_999,
    });
    abandoned.writeStatus({
      run_id: 'abandoned',
      pipeline: 'demo',
      lock_hash: 'abc',
      status: 'running',
      workspace: { mode: 'cwd' },
      inputs: {},
      jobs: [],
      budget: { tokens_used: 0, wallclock_ms: 0 },
      updated_at: '2026-08-01T00:00:00.000Z',
    });

    assert.equal(isRunAlive(alive.paths), true);
    assert.equal(isRunAlive(abandoned.paths), false);
  });

  it('прогон, начатый до последней загрузки машины, живым не считается даже при существующем pid', () => {
    const { runsRoot, projectRoot } = bed();
    const journal = RunJournal.create({ runsRoot, projectRoot, runId: 'rebooted' });
    journal.writeManifest({
      run_id: 'rebooted',
      pipeline: 'demo',
      pipeline_file: join(projectRoot, 'stepcast.yml'),
      lock_hash: 'abc',
      project_root: projectRoot,
      workspace: { mode: 'cwd' },
      inputs: {},
      git: {},
      backends: {},
      // Заведомо раньше любой мыслимой загрузки этой машины, а pid — свой,
      // то есть существующий: ровно случай переиспользованного номера.
      started_at: '2001-01-01T00:00:00.000Z',
      pid: process.pid,
    });
    journal.writeStatus({
      run_id: 'rebooted',
      pipeline: 'demo',
      lock_hash: 'abc',
      status: 'running',
      workspace: { mode: 'cwd' },
      inputs: {},
      jobs: [],
      budget: { tokens_used: 0, wallclock_ms: 0 },
      updated_at: '2001-01-01T00:00:00.000Z',
    });

    assert.equal(isRunAlive(journal.paths), false);
    assert.equal(findAliveRun(runsRoot, projectRoot, join(projectRoot, 'stepcast.yml')), undefined);
  });

  // Сценарий: «Манифест прежней формы»
  it('манифест прежней формы (без pid) читается и даёт неживой прогон', () => {
    const { runsRoot, projectRoot } = bed();
    const journal = RunJournal.create({ runsRoot, projectRoot, runId: 'legacy' });
    journal.writeManifest({
      run_id: 'legacy',
      pipeline: 'demo',
      pipeline_file: join(projectRoot, 'stepcast.yml'),
      lock_hash: 'abc',
      project_root: projectRoot,
      workspace: { mode: 'cwd' },
      inputs: {},
      git: {},
      backends: {},
      started_at: RECENT,
    });
    journal.writeStatus({
      run_id: 'legacy',
      pipeline: 'demo',
      lock_hash: 'abc',
      status: 'running',
      workspace: { mode: 'cwd' },
      inputs: {},
      jobs: [],
      budget: { tokens_used: 0, wallclock_ms: 0 },
      updated_at: '2026-08-01T00:00:00.000Z',
    });

    assert.doesNotThrow(() => readManifest(journal.paths));
    assert.equal(isRunAlive(journal.paths), false);
  });

  // Сценарий: «Спящий прогон жив»
  it('спящий до сброса окна лимита прогон (running + wake_at) признаётся живым', () => {
    const { runsRoot, projectRoot } = bed();
    const journal = RunJournal.create({ runsRoot, projectRoot, runId: 'sleeping' });
    journal.writeManifest({
      run_id: 'sleeping',
      pipeline: 'demo',
      pipeline_file: join(projectRoot, 'stepcast.yml'),
      lock_hash: 'abc',
      project_root: projectRoot,
      workspace: { mode: 'cwd' },
      inputs: {},
      git: {},
      backends: {},
      started_at: RECENT,
      pid: process.pid,
    });
    journal.writeStatus({
      run_id: 'sleeping',
      pipeline: 'demo',
      lock_hash: 'abc',
      status: 'running',
      workspace: { mode: 'cwd' },
      inputs: {},
      jobs: [],
      budget: { tokens_used: 0, wallclock_ms: 0 },
      wake_at: '2026-08-01T04:00:00.000Z',
      updated_at: '2026-08-01T00:00:00.000Z',
    });

    assert.equal(isRunAlive(journal.paths), true);
  });

  // Сценарий: «Идёт прогон другого пайплайна»
  it('findAliveRun не находит живой прогон другого пайплайна', () => {
    const { runsRoot, projectRoot } = bed();
    const pipelineA = join(projectRoot, 'a.yml');
    const pipelineB = join(projectRoot, 'b.yml');

    const journal = RunJournal.create({ runsRoot, projectRoot, runId: 'other' });
    journal.writeManifest({
      run_id: 'other',
      pipeline: 'b',
      pipeline_file: pipelineB,
      lock_hash: 'abc',
      project_root: projectRoot,
      workspace: { mode: 'cwd' },
      inputs: {},
      git: {},
      backends: {},
      started_at: RECENT,
      pid: process.pid,
    });
    journal.writeStatus({
      run_id: 'other',
      pipeline: 'b',
      lock_hash: 'abc',
      status: 'running',
      workspace: { mode: 'cwd' },
      inputs: {},
      jobs: [],
      budget: { tokens_used: 0, wallclock_ms: 0 },
      updated_at: '2026-08-01T00:00:00.000Z',
    });

    assert.equal(findAliveRun(runsRoot, projectRoot, pipelineA), undefined);
    assert.notEqual(findAliveRun(runsRoot, projectRoot, pipelineB), undefined);
  });

  it('findAliveRun находит живой прогон того же пайплайна', () => {
    const { runsRoot, projectRoot } = bed();
    const pipelineFile = join(projectRoot, 'stepcast.yml');

    const journal = RunJournal.create({ runsRoot, projectRoot, runId: 'mine' });
    journal.writeManifest({
      run_id: 'mine',
      pipeline: 'demo',
      pipeline_file: pipelineFile,
      lock_hash: 'abc',
      project_root: projectRoot,
      workspace: { mode: 'cwd' },
      inputs: {},
      git: {},
      backends: {},
      started_at: RECENT,
      pid: process.pid,
    });
    journal.writeStatus({
      run_id: 'mine',
      pipeline: 'demo',
      lock_hash: 'abc',
      status: 'running',
      workspace: { mode: 'cwd' },
      inputs: {},
      jobs: [],
      budget: { tokens_used: 0, wallclock_ms: 0 },
      updated_at: '2026-08-01T00:00:00.000Z',
    });

    const found = findAliveRun(runsRoot, projectRoot, pipelineFile);
    assert.equal(found?.runId, 'mine');
  });
});

describe('dependent-job-workspace: источник наследования в журнале', () => {
  async function runChain(): Promise<Awaited<ReturnType<typeof runPipeline>>> {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: наследование
workspace: { mode: worktree }
jobs:
  a:
    steps: [{ id: c, run: [echo, a], expect: [{ exit_code: 0 }] }]
  b:
    needs: [a]
    steps: [{ id: c, run: [echo, b], expect: [{ exit_code: 0 }] }]
`,
    });
    gitInit(project);
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
    const expanded = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config });
    return runPipeline({
      expanded,
      config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
    });
  }

  it('запись наследующей работы несёт источник и признак продолженного каталога', async () => {
    const result = await runChain();
    const status = readStatus(result.journal.paths);
    const b = status.jobs.find((job) => job.id === 'b');
    assert.equal(b?.workspace?.inherited_from, 'a');
    assert.equal(b?.workspace?.continued, true);
  });

  it('запись работы без наследования не несёт источника', async () => {
    const result = await runChain();
    const status = readStatus(result.journal.paths);
    const a = status.jobs.find((job) => job.id === 'a');
    assert.equal(a?.workspace?.inherited_from, undefined);
    assert.equal(a?.workspace?.continued, undefined);
  });

  it('событие о наследовании дерева есть в потоке', async () => {
    const result = await runChain();
    const events = readEvents(result.journal.paths);
    const inherited = events.find((event) => event.kind === 'workspace.inherited');
    assert.ok(inherited !== undefined, 'событие workspace.inherited должно быть записано');
    assert.deepEqual(inherited, {
      ...inherited,
      job: 'b',
      source: 'a',
      via: 'continue',
    });
  });
});

describe('run-journal: перечень материализованных частей', () => {
  /** Тот же проект, но с объявленным составом `project.nested_repos`. */
  function withNestedRepos(project: Project, nestedRepos: readonly string[]): Config {
    return { ...project.config, project: { ...project.config.project, nestedRepos } };
  }

  async function runComposite(
    command = 'echo ok',
  ): Promise<Awaited<ReturnType<typeof runPipeline>>> {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: части
workspace: { mode: worktree }
jobs:
  build:
    steps: [{ id: c, run: [sh, -c, '${command}'], expect: [{ exit_code: 0 }] }]
`,
      'public-site/.gitkeep': '',
    });
    execFileSync('git', ['-C', project.root, 'init', '--quiet', '--initial-branch=main']);
    execFileSync('git', ['-C', project.root, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', project.root, 'config', 'user.name', 'Тест']);
    gitInitDir(project.path('public-site'));
    gitCommit(project.path('public-site'), 'начало части');
    execFileSync('git', ['-C', project.root, 'add', '-A']);
    execFileSync('git', ['-C', project.root, 'commit', '--quiet', '-m', 'первый']);

    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
    const config = withNestedRepos(project, ['public-site']);
    const expanded = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config });
    return runPipeline({
      expanded,
      config: { ...config, runs: { ...config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
    });
  }

  it('запись работы называет каждый материализованный каталог и его репозиторий', async () => {
    const result = await runComposite();
    const status = readStatus(result.journal.paths);
    const build = status.jobs.find((job) => job.id === 'build');
    assert.ok(build?.workspace?.nested !== undefined, 'workspace.nested должно быть записано');
    assert.equal(build.workspace.nested.length, 1);
    assert.equal(build.workspace.nested[0]?.dir, 'public-site');
    assert.match(build.workspace.nested[0]?.repo ?? '', /public-site$/);
  });

  // Сценарий «Перечень доступен после обрыва»: перечень пишется до первого
  // шага, а не по завершении работы, — на этом держится полнота уборки
  // прогона, до конца не дошедшего. Снимок состояния делает сам шаг: так
  // проверяется именно момент записи, а не её наличие в конце.
  it('перечень частей записан до первого шага и переживает обрыв работы', async () => {
    const result = await runComposite(
      'cp "$STEPCAST_RUN_DIR/status.json" "$STEPCAST_RUN_DIR/снимок.json"; exit 1',
    );
    assert.equal(result.status, 'failed');

    const snapshot = RunStatusSchema.parse(
      JSON.parse(readFileSync(join(result.journal.paths.dir, 'снимок.json'), 'utf8')),
    );
    const build = snapshot.jobs.find((job) => job.id === 'build');
    assert.equal(build?.status, 'running', 'снимок сделан до конца работы');
    assert.ok(build?.workspace?.nested !== undefined, 'перечень частей должен быть записан уже к первому шагу');
    assert.equal(build.workspace.nested[0]?.dir, 'public-site');
    assert.match(build.workspace.nested[0]?.repo ?? '', /public-site$/);
  });

  it('запись работы без объявленного состава поля nested не имеет', async () => {
    const project = makeProject({ 'stepcast.yml': MINIMAL_PIPELINE });
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
    const expanded = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config });
    const result = await runPipeline({
      expanded,
      config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
    });
    const status = readStatus(result.journal.paths);
    assert.equal(status.jobs.find((job) => job.id === 'build')?.workspace?.nested, undefined);
  });

  it('status.json прежней формы, без nested, читается схемой без ошибок', () => {
    const parsed = RunStatusSchema.parse({
      run_id: 'r',
      pipeline: 'p',
      lock_hash: 'h',
      status: 'success',
      workspace: { mode: 'cwd' },
      inputs: {},
      jobs: [
        {
          id: 'build',
          status: 'success',
          workspace: { mode: 'worktree', path: '/tmp/x' },
          steps: [],
        },
      ],
      budget: { tokens_used: 0, wallclock_ms: 0 },
      updated_at: '2026-08-01T00:00:00.000Z',
    });
    assert.equal(parsed.jobs[0]?.workspace?.nested, undefined);
  });
});

describe('run-journal: момент сброса окна лимита из последнего прогона', () => {
  it('возвращает resets_at последнего backend.refused завершённого прогона', () => {
    const { runsRoot, projectRoot } = bed();
    const pipelineFile = join(projectRoot, 'stepcast.yml');

    const journal = RunJournal.create({ runsRoot, projectRoot, runId: 'stopped' });
    journal.writeManifest({
      run_id: 'stopped',
      pipeline: 'demo',
      pipeline_file: pipelineFile,
      lock_hash: 'abc',
      project_root: projectRoot,
      workspace: { mode: 'cwd' },
      inputs: {},
      git: {},
      backends: {},
      started_at: '2026-08-01T00:00:00.000Z',
      finished_at: '2026-08-01T00:05:00.000Z',
      status: 'budget_exceeded',
      pid: 12_345,
    });
    journal.event({
      kind: 'backend.refused',
      job: 'build',
      step: 'compile',
      attempt: 1,
      class: 'rate_limit',
      message: 'rate limited',
      resets_at: 1_800_000_000_000,
    });

    const hint = readResetHint(runsRoot, projectRoot, pipelineFile);
    assert.equal(hint?.resetsAt, 1_800_000_000_000);
  });

  it('возвращает undefined, когда прогон не упирался в окно лимита', () => {
    const { runsRoot, projectRoot } = bed();
    const pipelineFile = join(projectRoot, 'stepcast.yml');

    const journal = RunJournal.create({ runsRoot, projectRoot, runId: 'clean' });
    journal.writeManifest({
      run_id: 'clean',
      pipeline: 'demo',
      pipeline_file: pipelineFile,
      lock_hash: 'abc',
      project_root: projectRoot,
      workspace: { mode: 'cwd' },
      inputs: {},
      git: {},
      backends: {},
      started_at: '2026-08-01T00:00:00.000Z',
      finished_at: '2026-08-01T00:05:00.000Z',
      status: 'success',
    });

    assert.equal(readResetHint(runsRoot, projectRoot, pipelineFile), undefined);
  });

  it('не откладывает срабатывание, если прогон дождался сброса и пошёл дальше', () => {
    const { runsRoot, projectRoot } = bed();
    const pipelineFile = join(projectRoot, 'stepcast.yml');

    const journal = RunJournal.create({ runsRoot, projectRoot, runId: 'waited' });
    journal.writeManifest({
      run_id: 'waited',
      pipeline: 'demo',
      pipeline_file: pipelineFile,
      lock_hash: 'abc',
      project_root: projectRoot,
      workspace: { mode: 'cwd' },
      inputs: {},
      git: {},
      backends: {},
      started_at: '2026-08-01T00:00:00.000Z',
      finished_at: '2026-08-01T02:05:00.000Z',
      status: 'success',
    });
    journal.event({
      kind: 'budget.waiting',
      scope: 'run',
      dimension: 'rate_limit',
      resets_at: 1_800_000_000_000,
      wait_ms: 1_000,
    });
    journal.event({ kind: 'budget.resumed', actual_ms: 1_000 });
    journal.event({ kind: 'run.finished', status: 'success', exit_code: 0 });

    assert.equal(readResetHint(runsRoot, projectRoot, pipelineFile), undefined);
  });

  it('не откладывает срабатывание, если после отказа шаг всё-таки прошёл', () => {
    const { runsRoot, projectRoot } = bed();
    const pipelineFile = join(projectRoot, 'stepcast.yml');

    const journal = RunJournal.create({ runsRoot, projectRoot, runId: 'retried' });
    journal.writeManifest({
      run_id: 'retried',
      pipeline: 'demo',
      pipeline_file: pipelineFile,
      lock_hash: 'abc',
      project_root: projectRoot,
      workspace: { mode: 'cwd' },
      inputs: {},
      git: {},
      backends: {},
      started_at: '2026-08-01T00:00:00.000Z',
      finished_at: '2026-08-01T00:05:00.000Z',
      status: 'failed',
    });
    journal.event({
      kind: 'backend.refused',
      job: 'build',
      step: 'compile',
      attempt: 1,
      class: 'rate_limit',
      message: 'rate limited',
      resets_at: 1_800_000_000_000,
    });
    journal.event({
      kind: 'step.finished',
      job: 'build',
      step: 'compile',
      attempt: 2,
      status: 'success',
    });

    assert.equal(readResetHint(runsRoot, projectRoot, pipelineFile), undefined);
  });

  it('игнорирует budget.exceeded (потолки tokens/cost/wallclock не откладывают срабатывание)', () => {
    const { runsRoot, projectRoot } = bed();
    const pipelineFile = join(projectRoot, 'stepcast.yml');

    const journal = RunJournal.create({ runsRoot, projectRoot, runId: 'over-budget' });
    journal.writeManifest({
      run_id: 'over-budget',
      pipeline: 'demo',
      pipeline_file: pipelineFile,
      lock_hash: 'abc',
      project_root: projectRoot,
      workspace: { mode: 'cwd' },
      inputs: {},
      git: {},
      backends: {},
      started_at: '2026-08-01T00:00:00.000Z',
      finished_at: '2026-08-01T00:05:00.000Z',
      status: 'budget_exceeded',
    });
    journal.event({ kind: 'budget.exceeded', scope: 'пайплайн', used: 100, limit: 50 });

    assert.equal(readResetHint(runsRoot, projectRoot, pipelineFile), undefined);
  });

  it('находит момент сброса по manifest.pipeline_file, минуя живой (незавершённый) прогон', () => {
    const { runsRoot, projectRoot } = bed();
    const pipelineFile = join(projectRoot, 'stepcast.yml');

    const finished = RunJournal.create({ runsRoot, projectRoot, runId: 'a-finished' });
    finished.writeManifest({
      run_id: 'a-finished',
      pipeline: 'demo',
      pipeline_file: pipelineFile,
      lock_hash: 'abc',
      project_root: projectRoot,
      workspace: { mode: 'cwd' },
      inputs: {},
      git: {},
      backends: {},
      started_at: '2026-08-01T00:00:00.000Z',
      finished_at: '2026-08-01T00:05:00.000Z',
      status: 'budget_exceeded',
    });
    finished.event({
      kind: 'budget.waiting',
      scope: 'run',
      dimension: 'rate_limit',
      resets_at: 1_900_000_000_000,
      wait_ms: 1_000,
    });

    const going = RunJournal.create({ runsRoot, projectRoot, runId: 'b-going' });
    going.writeManifest({
      run_id: 'b-going',
      pipeline: 'demo',
      pipeline_file: pipelineFile,
      lock_hash: 'abc',
      project_root: projectRoot,
      workspace: { mode: 'cwd' },
      inputs: {},
      git: {},
      backends: {},
      started_at: '2026-08-01T00:10:00.000Z',
      pid: process.pid,
    });

    const hint = readResetHint(runsRoot, projectRoot, pipelineFile);
    assert.equal(hint?.resetsAt, 1_900_000_000_000);
  });
});

describe('run-journal: отказ в разрешении', () => {
  const AGENT_PIPELINE = `
kind: pipeline
name: p
jobs:
  build:
    steps:
      - id: ask
        prompt: сделай
`;

  // Сценарий: «Запись об отказе в разрешении»
  it('пишет событие permission.denied с работой, шагом и именем инструмента', async () => {
    const project = makeProject({ 'stepcast.yml': AGENT_PIPELINE });
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
    const backend = createFakeBackend({
      lines: [
        resultLine({
          text: 'готово',
          permissionDenials: [{ tool: 'Bash', input: { command: 'touch marker.txt' } }],
        }),
      ],
    });

    const result = await runPipeline({
      expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
      config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
      adapterFor: () => backend.adapter,
    });

    const events = readEvents(result.journal.paths);
    const denied = events.find((event) => event.kind === 'permission.denied') as
      | { job: string; step: string; tool: string; detail?: string }
      | undefined;
    assert.ok(denied !== undefined, 'событие permission.denied должно быть в журнале');
    assert.equal(denied.job, 'build');
    assert.equal(denied.step, 'ask');
    assert.equal(denied.tool, 'Bash');
    assert.match(denied.detail ?? '', /touch marker\.txt/);
  });

  // Сценарий: «Деталь отказа обезврежена»
  it('сводит многострочную деталь отказа с управляющими последовательностями к одной строке', async () => {
    const project = makeProject({ 'stepcast.yml': AGENT_PIPELINE });
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
    const esc = String.fromCharCode(0x1b);
    const backend = createFakeBackend({
      lines: [
        resultLine({
          text: 'готово',
          permissionDenials: [
            { tool: 'Bash', input: { command: `line1\nline2${esc}[31m colored${esc}[0m` } },
          ],
        }),
      ],
    });

    const result = await runPipeline({
      expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
      config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
      adapterFor: () => backend.adapter,
    });

    const events = readEvents(result.journal.paths);
    const denied = events.find((event) => event.kind === 'permission.denied') as
      | { detail?: string }
      | undefined;
    assert.ok(denied?.detail !== undefined);
    assert.doesNotMatch(denied.detail, /\n/);
    assert.doesNotMatch(denied.detail, /\x1b/);
  });

  // Сценарий: «Отказы посчитаны»
  it('считает число отказов попытки в записи попытки', async () => {
    const project = makeProject({ 'stepcast.yml': AGENT_PIPELINE });
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
    const backend = createFakeBackend({
      lines: [
        resultLine({
          text: 'готово',
          permissionDenials: [
            { tool: 'Bash', input: { command: 'touch a' } },
            { tool: 'Write', input: { file_path: 'a.ts' } },
          ],
        }),
      ],
    });

    const result = await runPipeline({
      expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
      config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
      adapterFor: () => backend.adapter,
    });

    const status = readStatus(result.journal.paths);
    const step = status.jobs.find((job) => job.id === 'build')?.steps.find((item) => item.id === 'ask');
    assert.equal(step?.attempts[0]?.permission_denials, 2);
  });

  // Сценарий: «Отказ не проваливает попытку»
  it('успешный результат с отказами и без предикатов даёт успешный шаг', async () => {
    const project = makeProject({ 'stepcast.yml': AGENT_PIPELINE });
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
    const backend = createFakeBackend({
      lines: [
        resultLine({
          text: 'готово',
          permissionDenials: [{ tool: 'Bash', input: { command: 'touch a' } }],
        }),
      ],
    });

    const result = await runPipeline({
      expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
      config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
      adapterFor: () => backend.adapter,
    });

    const status = readStatus(result.journal.paths);
    const step = status.jobs.find((job) => job.id === 'build')?.steps.find((item) => item.id === 'ask');
    assert.equal(step?.status, 'success');
  });

  // Сценарий: «Журнал прежней формы»
  it('запись попытки без permission_denials разбирается штатно и не несёт числа отказов', () => {
    const oldAttemptRecord = {
      attempt: 1,
      status: 'success',
      started_at: '2026-08-01T00:00:00.000Z',
      finished_at: '2026-08-01T00:00:30.000Z',
    };
    const parsed = AttemptRecordSchema.safeParse(oldAttemptRecord);
    assert.equal(parsed.success, true);
    assert.equal(parsed.success ? parsed.data.permission_denials : undefined, undefined);
  });
});
