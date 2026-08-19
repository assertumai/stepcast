import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { expandPipeline } from '../src/core/pipeline/expand.js';
import { findStepDir, readEvents, readStatus } from '../src/core/journal/reader.js';
import { runPipeline, type RunResult } from '../src/core/run/runner.js';
import { HALT_CAUSES, HaltCause } from '../src/core/run/halt.js';
import { ExitCode } from '../src/core/errors.js';
import type { StatusValue, StepRecord } from '../src/core/journal/schema.js';
import { makeProject, type Project } from './helpers.js';

/** Прогнать пайплайн проекта целиком, сложив журнал во временный корень. */
async function run(
  project: Project,
  options: { readonly signal?: AbortSignal; readonly breakAnchor?: boolean } = {},
): Promise<RunResult> {
  const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
  const expanded = expandPipeline({
    pipelinePath: project.path('stepcast.yml'),
    config: project.config,
  });

  return runPipeline({
    expanded,
    config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
    projectRoot: project.root,
    cwd: project.root,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.breakAnchor === true ? { anchorerFor: brokenAnchorer } : {}),
  });
}

/** Якорь, который не умеет ничего: подставляется, чтобы проверить границы. */
function brokenAnchorer(): never {
  throw new Error('фиксация состояния недоступна');
}

/** Все записи шагов прогона одним списком: проверять статусы удобнее плоско. */
function steps(result: RunResult): StepRecord[] {
  const status = readStatus(result.journal.paths);
  return status.jobs.flatMap((job) => job.steps);
}

const THREE_STEPS = `
version: 1
kind: pipeline
name: три-шага
jobs:
  first:
    steps:
      - id: one
        run: [echo, один]
        expect: [{ exit_code: 0 }]
      - id: two
        run: [echo, два]
        expect: [{ exit_code: 0 }]
  second:
    needs: [first]
    steps:
      - id: three
        run: [echo, три]
        expect: [{ exit_code: 0 }]
`;

describe('pipeline-execution: границы отказа', () => {
  // Сценарий: «Остановка по объявленному условию»
  it('останавливается, когда объявленный предикат не прошёл', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: тесты-должны-проходить
jobs:
  tests:
    steps:
      - id: run-tests
        run: [sh, -c, 'exit 3']
        expect: [{ exit_code: 0 }]
  after:
    needs: [tests]
    steps:
      - id: never
        run: [echo, нет]
        expect: [{ exit_code: 0 }]
`,
    });

    const result = await run(project);
    assert.equal(result.status, 'failed');
    assert.equal(result.exitCode, ExitCode.jobFailed);

    const status = readStatus(result.journal.paths);
    const tests = status.jobs.find((job) => job.id === 'tests');
    assert.equal(tests?.status, 'failed');
    assert.equal(tests?.cause, HaltCause.expectFailed);
    assert.equal(status.jobs.find((job) => job.id === 'after')?.status, 'skipped');
  });

  // Сценарий: «Причина остановки называется пользователю»
  it('называет причину из закрытого перечня и указывает работу и шаг', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: причина
jobs:
  build:
    steps:
      - id: compile
        run: [sh, -c, 'exit 1']
        expect: [{ exit_code: 0 }]
`,
    });

    const result = await run(project);
    const status = readStatus(result.journal.paths);
    const job = status.jobs.find((item) => item.id === 'build');

    assert.equal(job?.cause, HaltCause.expectFailed);
    assert.ok(job?.reason?.includes('compile'), 'причина работы должна называть шаг');
    const step = job?.steps.find((item) => item.id === 'compile');
    assert.equal(step?.cause, HaltCause.expectFailed);
  });

  // Сценарий: «Неисполнимость выявляется заранее»
  it('отклоняет неподготавливаемый режим рабочей директории до первой работы', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: изоляция
workspace: { mode: worktree }
jobs:
  build:
    steps:
      - id: compile
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
`,
    });

    await assert.rejects(
      () => run(project),
      (error: Error) => {
        assert.match(error.message, /worktree/);
        return true;
      },
    );
  });

  // Сценарий: «Процесс шага не удалось запустить»
  it('различает незапустившийся процесс и непройденный предикат', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: нет-команды
jobs:
  build:
    steps:
      - id: missing
        run: [этой-команды-точно-нет-в-системе]
        expect: [{ exit_code: 0 }]
`,
    });

    const result = await run(project);
    assert.equal(result.status, 'failed');
    assert.equal(steps(result)[0]?.cause, HaltCause.spawnFailed);
  });
});

describe('pipeline-execution: перечень причин остановки', () => {
  // Перечень закрыт: изменение требует такого же обоснования, как изменение
  // кодов возврата, поэтому сверяется дословно.
  it('содержит прежние причины и добавляет только until_not_met', () => {
    const before = [
      'expect_failed',
      'timeout',
      'spawn_failed',
      'budget_exceeded',
      'canceled',
    ];

    assert.deepEqual([...HALT_CAUSES].sort(), [...before, 'until_not_met'].sort());
  });

  it('не заводит причин вне перечня', () => {
    const declared = new Set<string>(HALT_CAUSES);
    for (const value of Object.values(HaltCause)) {
      assert.ok(declared.has(value), `причина ${value} должна быть в перечне`);
    }
  });
});

describe('bookkeeping: неудача учёта не трогает статусы', () => {
  it('пишет событие и возвращает undefined', async () => {
    const project = makeProject({ 'stepcast.yml': THREE_STEPS });
    const result = await run(project);

    const { bookkeep } = await import('../src/core/run/bookkeeping.js');
    const value = bookkeep({ journal: result.journal, job: 'first', step: 'one' }, 'проба', () => {
      throw new Error('якорь не снялся');
    });

    assert.equal(value, undefined);
    const events = readEvents(result.journal.paths);
    const failure = events.find((event) => event.kind === 'bookkeeping.failed');
    assert.ok(failure, 'должно быть событие об отказе учёта');
    assert.equal((failure as { operation: string }).operation, 'проба');
    assert.match((failure as { detail: string }).detail, /якорь не снялся/);
  });

  it('пропускает успешный результат без следа в журнале', async () => {
    const project = makeProject({ 'stepcast.yml': THREE_STEPS });
    const result = await run(project);

    const { bookkeep } = await import('../src/core/run/bookkeeping.js');
    const value = bookkeep({ journal: result.journal }, 'проба', () => 42);

    assert.equal(value, 42);
    const events = readEvents(result.journal.paths);
    assert.equal(
      events.filter((event) => event.kind === 'bookkeeping.failed').length,
      0,
    );
  });
});

// Статусы работ, не относящиеся к отказу, причиной не сопровождаются: пропуск
// по условию — это исход, а не остановка.
describe('pipeline-execution: пропуск не является остановкой', () => {
  it('не приписывает причину пропущенной работе', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: пропуск
inputs:
  skip: { type: bool, default: true }
jobs:
  optional:
    if: "not inputs.skip"
    steps:
      - id: never
        run: [echo, нет]
        expect: [{ exit_code: 0 }]
`,
    });

    const result = await run(project);
    const status: StatusValue = result.status;
    assert.equal(status, 'success');

    const job = readStatus(result.journal.paths).jobs.find((item) => item.id === 'optional');
    assert.equal(job?.status, 'skipped');
    assert.equal(job?.cause, undefined);
  });
});

describe('workspace-anchor: якорь в журнале шага', () => {
  // Сценарий: «Якорь записан у успешного шага»
  it('записывает якорь и отпечаток входов каждому шагу', async () => {
    const project = makeProject({ 'stepcast.yml': THREE_STEPS });
    const result = await run(project);

    for (const step of steps(result)) {
      assert.ok(step.tree_id !== undefined, `у шага ${step.id} должен быть якорь`);
      assert.equal(step.anchor_kind, 'manifest');
      assert.ok(step.inputs_fingerprint !== undefined, `у шага ${step.id} должен быть отпечаток`);
      assert.equal(step.inputs_origin, 'tree');
      assert.equal(step.anchor_missing, undefined);
    }
  });

  // Сценарий: «Якорь записан у упавшего шага»
  it('записывает якорь и у шага, завершившегося отказом', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: отказ
jobs:
  build:
    steps:
      - id: fail
        run: [sh, -c, 'echo побочный > побочный.txt; exit 1']
        expect: [{ exit_code: 0 }]
`,
    });

    const result = await run(project);
    assert.equal(result.status, 'failed');

    const step = steps(result)[0];
    assert.ok(step?.tree_id !== undefined, 'якорь снимается независимо от исхода');
    assert.ok(step?.tree_before !== undefined);
    assert.notEqual(step?.tree_id, step?.tree_before, 'шаг изменил дерево');
  });

  // Сценарий: «Способ фиксации выбирается один раз на прогон»
  it('пишет способ фиксации в манифест прогона', async () => {
    const project = makeProject({ 'stepcast.yml': THREE_STEPS });
    const result = await run(project);

    const manifest = JSON.parse(readFileSync(result.journal.paths.manifest, 'utf8')) as {
      anchor_kind?: string;
    };
    assert.equal(manifest.anchor_kind, 'manifest');
  });

  // Сценарий: «Шаг ничего не изменил» / «Шаг изменил дерево»
  it('пишет diff.patch только когда шаг изменил дерево', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: диффы
jobs:
  build:
    steps:
      - id: quiet
        run: [echo, ничего-не-меняю]
        expect: [{ exit_code: 0 }]
`,
    });

    const result = await run(project);
    const dir = findStepDir(result.journal.paths, 'build', 'quiet');
    assert.ok(dir !== undefined);
    assert.equal(
      existsSync(join(dir, 'diff.patch')),
      false,
      'совпавшие якоря патча не дают',
    );
  });

  // Сценарий: «Отпечаток без объявлений» / «Явное объявление уже умолчания»
  it('считает отпечаток по объявленным входам работы, когда они есть', async () => {
    const project = makeProject({
      'следят.txt': 'исходное',
      'не-следят.txt': 'исходное',
      'stepcast.yml': `
version: 1
kind: pipeline
name: объявленные-входы
jobs:
  build:
    inputs: [следят.txt]
    steps:
      - id: look
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
`,
    });

    const first = await run(project);
    const before = steps(first)[0]?.inputs_fingerprint;
    assert.equal(steps(first)[0]?.inputs_origin, 'declared');

    project.write('не-следят.txt', 'изменено вне объявленных входов');
    const second = await run(project);
    assert.equal(steps(second)[0]?.inputs_fingerprint, before, 'отпечаток не должен измениться');

    project.write('следят.txt', 'изменено внутри объявленных входов');
    const third = await run(project);
    assert.notEqual(steps(third)[0]?.inputs_fingerprint, before);
  });
});

describe('run-journal: ключ шага', () => {
  // Сценарий: «Одинаковые условия дают одинаковый ключ»
  it('даёт одинаковый ключ на неизменном дереве с теми же входами', async () => {
    const project = makeProject({ 'stepcast.yml': THREE_STEPS, 'src/a.ts': 'код' });

    const first = await run(project);
    const second = await run(project);

    assert.deepEqual(
      steps(second).map((step) => step.key),
      steps(first).map((step) => step.key),
    );
  });

  // Сценарий: «Изменение рабочего дерева меняет ключ»
  it('меняет ключ, когда изменилось дерево', async () => {
    const project = makeProject({ 'stepcast.yml': THREE_STEPS, 'src/a.ts': 'код' });
    const before = steps(await run(project)).map((step) => step.key);

    project.write('src/a.ts', 'другой код');
    const after = steps(await run(project)).map((step) => step.key);

    assert.notEqual(after[0], before[0], 'первый шаг видит изменившееся дерево');
  });

  // Сценарий: «Изменение промпта меняет ключ»
  it('меняет ключ, когда изменилось определение шага', async () => {
    const project = makeProject({ 'stepcast.yml': THREE_STEPS });
    const before = steps(await run(project)).map((step) => step.key);

    project.write('stepcast.yml', THREE_STEPS.replace('echo, один', 'echo, другой'));
    const after = steps(await run(project)).map((step) => step.key);

    assert.notEqual(after[0], before[0]);
  });
});

describe('bookkeeping: отказ фиксации якоря не роняет прогон', () => {
  // Сценарий: «Фиксация не удалась» / «Последствие ограничено возобновлением»
  it('доводит прогон до конца с теми же статусами, что и без отказов', async () => {
    const project = makeProject({ 'stepcast.yml': THREE_STEPS });

    const clean = await run(project);
    const broken = await run(project, { breakAnchor: true });

    assert.equal(broken.status, clean.status);
    assert.equal(broken.exitCode, clean.exitCode);
    assert.deepEqual(
      steps(broken).map((step) => `${step.id}:${step.status}`),
      steps(clean).map((step) => `${step.id}:${step.status}`),
    );

    for (const step of steps(broken)) {
      assert.equal(step.tree_id, undefined, 'якоря быть не должно');
      assert.ok(step.anchor_missing !== undefined, `шаг ${step.id} помечен как непригодный`);
    }

    const failures = readEvents(broken.journal.paths).filter(
      (event) => event.kind === 'bookkeeping.failed',
    );
    assert.ok(failures.length > 0, 'отказ учёта должен быть записан в журнал');
  });
});
