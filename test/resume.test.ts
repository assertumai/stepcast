import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createAnchorer, detectAnchorKind, manifestStore } from '../src/core/anchor/index.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { findStepDir, readEvents, readStatus } from '../src/core/journal/reader.js';
import { serializeLock } from '../src/core/pipeline/lock.js';
import {
  buildResumePlan,
  changedSince,
  describePlan,
  finalAnchorOf,
  parseFrom,
  producedBy,
  readSourceRun,
  type ResumePlan,
} from '../src/core/run/resumePlan.js';
import { runPipeline, type RunResult } from '../src/core/run/runner.js';
import type { StepRecord } from '../src/core/journal/schema.js';
import { makeProject, type Project } from './helpers.js';

interface Bed {
  readonly project: Project;
  readonly runsRoot: string;
}

function bed(files: Readonly<Record<string, string>>, options: { git?: boolean } = {}): Bed {
  const project = makeProject(files);
  if (options.git === true) {
    const run = (...args: string[]): void => {
      execFileSync('git', ['-C', project.root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    };
    run('init', '--quiet', '--initial-branch=main');
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'Тест');
    run('add', '-A');
    run('commit', '--quiet', '-m', 'первый');
  }
  return { project, runsRoot: mkdtempSync(join(tmpdir(), 'stepcast-runs-')) };
}

function configOf(b: Bed) {
  return { ...b.project.config, runs: { ...b.project.config.runs, root: b.runsRoot } };
}

async function firstRun(b: Bed): Promise<RunResult> {
  return runPipeline({
    expanded: expandPipeline({ pipelinePath: b.project.path('stepcast.yml'), config: b.project.config }),
    config: configOf(b),
    projectRoot: b.project.root,
    cwd: b.project.root,
  });
}

/** Построить план так же, как это делает команда `stepcast resume`. */
function planFor(b: Bed, source: RunResult, from?: string): ResumePlan {
  const expanded = expandPipeline({
    pipelinePath: b.project.path('stepcast.yml'),
    config: b.project.config,
  });
  const anchorKind = detectAnchorKind(b.project.root);
  const stateDir = mkdtempSync(join(tmpdir(), 'stepcast-plan-'));
  const anchorer = createAnchorer({
    dir: b.project.root,
    stateDir,
    kind: anchorKind,
    scope: 'plan',
    readStores: [manifestStore(source.journal.paths.anchors)],
  });
  const sourceStatus = readSourceRun(source.journal.paths).status;
  const changed = changedSince(anchorer, finalAnchorOf(sourceStatus, anchorKind), anchorer.capture());

  const plan = buildResumePlan({
    expanded,
    config: b.project.config,
    source: readSourceRun(source.journal.paths),
    lockHash: createHash('sha256').update(serializeLock(expanded.pipeline)).digest('hex').slice(0, 16),
    changed,
    producedPaths: (step) => producedBy(anchorer, step),
    ...(from === undefined ? {} : { from: parseFrom(from) }),
  });
  anchorer.dispose();
  return plan;
}

async function resume(b: Bed, source: RunResult, from?: string): Promise<RunResult> {
  const plan = planFor(b, source, from);
  return runPipeline({
    expanded: expandPipeline({ pipelinePath: b.project.path('stepcast.yml'), config: b.project.config }),
    config: configOf(b),
    projectRoot: b.project.root,
    cwd: b.project.root,
    resume: { plan, source: readSourceRun(source.journal.paths) },
  });
}

function steps(result: RunResult): StepRecord[] {
  return readStatus(result.journal.paths).jobs.flatMap((job) => job.steps);
}

function decisions(plan: ResumePlan): Record<string, string> {
  return Object.fromEntries(
    plan.steps.map((item) => [`${item.job}/${item.step}`, item.decision.kind]),
  );
}

// Работа `первая` объявляет входы: без этого её шаги обесценивает любая
// правка дерева — заявленное умолчание, проверяемое отдельно ниже.
const TWO_JOBS = `
version: 1
kind: pipeline
name: возобновление
jobs:
  первая:
    session: per_step
    inputs: [сырьё.txt]
    steps:
      - id: a
        run: [sh, -c, 'echo a >> след.txt']
        expect: [{ exit_code: 0 }]
      - id: b
        run: [sh, -c, 'echo b >> след.txt']
        expect: [{ exit_code: 0 }]
  вторая:
    needs: [первая]
    session: per_step
    steps:
      - id: c
        run: [sh, -c, 'test -f маркер.txt']
        expect: [{ exit_code: 0 }]
`;

describe('run-resume: переиспользование по ключам', () => {
  // Сценарий: «Успешный шаг переиспользован» / «Упавший шаг переисполняется»
  it('переиспользует успевшие шаги и переисполняет упавший', async () => {
    const b = bed({ 'сырьё.txt': 'вход', 'stepcast.yml': TWO_JOBS });

    const first = await firstRun(b);
    assert.equal(first.status, 'failed', 'третий шаг падает: маркера нет');

    // Чиним причину так же, как это сделал бы человек.
    b.project.write('маркер.txt', 'теперь есть');

    const plan = planFor(b, first);
    assert.deepEqual(decisions(plan), {
      'первая/a': 'reuse',
      'первая/b': 'reuse',
      'вторая/c': 'rerun',
    });

    const second = await resume(b, first);
    assert.equal(second.status, 'success');

    const reused = steps(second).filter((step) => step.reused_from !== undefined);
    assert.deepEqual(reused.map((step) => step.id), ['a', 'b']);
  });

  // Сценарий: «Признак и источник»
  it('помечает переиспользованный шаг источником', async () => {
    const b = bed({ 'сырьё.txt': 'вход', 'маркер.txt': 'есть', 'stepcast.yml': TWO_JOBS });
    const first = await firstRun(b);
    assert.equal(first.status, 'success');

    const second = await resume(b, first, 'вторая');
    const a = steps(second).find((step) => step.id === 'a');

    assert.equal(a?.reused_from, first.journal.paths.runId);
  });

  // Сценарий: «Ссылка на исходный прогон» / «Исходный прогон неприкосновенен»
  it('создаёт новый прогон со ссылкой и не трогает исходный', async () => {
    const b = bed({ 'сырьё.txt': 'вход', 'маркер.txt': 'есть', 'stepcast.yml': TWO_JOBS });
    const first = await firstRun(b);
    const before = readFileSync(first.journal.paths.status, 'utf8');

    const second = await resume(b, first, 'вторая');

    assert.notEqual(second.journal.paths.runId, first.journal.paths.runId);
    const manifest = JSON.parse(readFileSync(second.journal.paths.manifest, 'utf8')) as {
      resumed_from?: string;
    };
    assert.equal(manifest.resumed_from, first.journal.paths.runId);
    assert.equal(readStatus(second.journal.paths).resumed_from, first.journal.paths.runId);
    assert.equal(readFileSync(first.journal.paths.status, 'utf8'), before);
  });

  // Сценарий: «Событие переиспользования»
  it('пишет событие переиспользования', async () => {
    const b = bed({ 'сырьё.txt': 'вход', 'маркер.txt': 'есть', 'stepcast.yml': TWO_JOBS });
    const first = await firstRun(b);
    const second = await resume(b, first, 'вторая');

    const events = readEvents(second.journal.paths).filter((event) => event.kind === 'step.reused');
    assert.ok(events.length > 0);
    assert.equal((events[0] as { source: string }).source, first.journal.paths.runId);
  });

  // Сценарий: «Изменение рабочего дерева обесценивает шаг»
  it('переисполняет шаг с объявленными входами, когда тронуты именно они', async () => {
    const b = bed({ 'сырьё.txt': 'вход', 'маркер.txt': 'есть', 'stepcast.yml': TWO_JOBS });
    const first = await firstRun(b);

    b.project.write('сырьё.txt', 'другой вход');
    const plan = planFor(b, first);

    assert.equal(plan.steps[0]?.decision.kind, 'rerun');
    assert.match(
      (plan.steps[0]?.decision as { reason: string }).reason,
      /изменились входы шага \(сырьё\.txt\)/,
    );
  });

  // Умолчание грубое сознательно: шаг без объявленных входов зависит от всего
  // дерева, и любая правка его обесценивает. Лишнее переисполнение стоит
  // денег, тихо устаревший результат — доверия ко всему инструменту.
  it('обесценивает шаг без объявленных входов любой правкой дерева', async () => {
    const b = bed({
      'посторонний.txt': 'ни при чём',
      'stepcast.yml': `
version: 1
kind: pipeline
name: широкий-отпечаток
jobs:
  работа:
    session: per_step
    steps:
      - id: шаг
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
`,
    });
    const first = await firstRun(b);

    b.project.write('посторонний.txt', 'правка, которой шаг не касается');
    const plan = planFor(b, first);

    assert.equal(plan.steps[0]?.decision.kind, 'rerun');
    assert.match(
      (plan.steps[0]?.decision as { reason: string }).reason,
      /дерево изменилось \(посторонний\.txt\)/,
    );
  });

  it('переиспользует всё, когда с прошлого прогона ничего не тронуто', async () => {
    const b = bed({ 'сырьё.txt': 'вход', 'маркер.txt': 'есть', 'stepcast.yml': TWO_JOBS });
    const first = await firstRun(b);
    assert.equal(first.status, 'success');

    const plan = planFor(b, first);
    assert.ok(plan.steps.every((item) => item.decision.kind === 'reuse'));
  });
});

describe('run-resume: гранулярность по режиму сессии', () => {
  // Сценарий: «Общая сессия повторяется целиком»
  it('огрубляет план до работы целиком при session: shared', async () => {
    const b = bed({
      'stepcast.yml': `
version: 1
kind: pipeline
name: общая-сессия
jobs:
  работа:
    session: shared
    inputs: [сырьё.txt]
    steps:
      - id: первый
        run: [echo, один]
        expect: [{ exit_code: 0 }]
      - id: второй
        run: [sh, -c, 'test -f маркер.txt']
        expect: [{ exit_code: 0 }]
`,
    });
    b.project.write('сырьё.txt', 'вход');

    const first = await firstRun(b);
    assert.equal(first.status, 'failed');
    b.project.write('маркер.txt', 'есть');

    const plan = planFor(b, first);
    assert.deepEqual(decisions(plan), {
      'работа/первый': 'rerun',
      'работа/второй': 'rerun',
    });

    // Сценарий: «Гранулярность объяснена»
    const reason = (plan.steps[0]?.decision as { reason: string }).reason;
    assert.match(reason, /session: shared/);
  });

  // Сценарий: «Пошаговая сессия повторяется с шага»
  it('переиспользует отдельные шаги при session: per_step', async () => {
    const b = bed({ 'сырьё.txt': 'вход', 'stepcast.yml': TWO_JOBS });
    const first = await firstRun(b);
    b.project.write('маркер.txt', 'есть');

    const plan = planFor(b, first);
    assert.equal(plan.steps[0]?.decision.kind, 'reuse');
  });
});

describe('run-resume: явная точка возобновления', () => {
  // Сценарий: «Возобновление с работы»
  it('переисполняет указанную работу и всё ниже по графу', async () => {
    const b = bed({ 'сырьё.txt': 'вход', 'маркер.txt': 'есть', 'stepcast.yml': TWO_JOBS });
    const first = await firstRun(b);

    const plan = planFor(b, first, 'первая');
    assert.deepEqual(decisions(plan), {
      'первая/a': 'rerun',
      'первая/b': 'rerun',
      'вторая/c': 'rerun',
    });
    assert.match((plan.steps[0]?.decision as { reason: string }).reason, /--from первая/);
  });

  // Сценарий: «Возобновление с шага»
  it('переиспользует шаги до указанного при пошаговой сессии', async () => {
    const b = bed({ 'сырьё.txt': 'вход', 'маркер.txt': 'есть', 'stepcast.yml': TWO_JOBS });
    const first = await firstRun(b);

    const plan = planFor(b, first, 'первая/b');
    assert.deepEqual(decisions(plan), {
      'первая/a': 'reuse',
      'первая/b': 'rerun',
      'вторая/c': 'rerun',
    });
  });
});

describe('run-resume: восстановление дерева', () => {
  // Сценарий: «Дерево восстановлено»
  it('приводит дерево к состоянию последнего переиспользованного шага', async () => {
    const b = bed(
      {
        'маркер.txt': 'есть',
        'stepcast.yml': `
version: 1
kind: pipeline
name: восстановление
jobs:
  первая:
    session: per_step
    inputs: [маркер.txt]
    steps:
      - id: пишет
        run: [sh, -c, 'printf "от первой\\n" > произведённый.txt']
        expect: [{ exit_code: 0 }]
  вторая:
    needs: [первая]
    session: per_step
    steps:
      - id: читает
        run: [sh, -c, 'test -f произведённый.txt']
        expect: [{ exit_code: 0 }]
`,
      },
      { git: true },
    );

    const first = await firstRun(b);
    assert.equal(first.status, 'success');

    // Пользователь снёс результат первой работы. Переиспользовать шаг, чей
    // результат правили руками, нельзя: он переисполняется и создаёт файл
    // заново. Восстанавливать поверх правки пользователя — недопустимо.
    rmSync(b.project.path('произведённый.txt'), { force: true });

    const plan = planFor(b, first);
    assert.equal(plan.steps[0]?.decision.kind, 'rerun');
    assert.match(
      (plan.steps[0]?.decision as { reason: string }).reason,
      /результат шага тронут после завершения прогона/,
    );

    const second = await resume(b, first);
    assert.equal(second.status, 'success');
    assert.equal(existsSync(b.project.path('произведённый.txt')), true);
  });

  // Восстановление трогает только пути, произведённые переиспользованными
  // шагами: правка пользователя, ради которой он и возобновляет, обязана
  // уцелеть.
  it('не стирает файлы, созданные пользователем после прогона', async () => {
    const b = bed(
      {
        'маркер.txt': 'есть',
        'stepcast.yml': `
version: 1
kind: pipeline
name: сохранность
jobs:
  первая:
    session: per_step
    inputs: [маркер.txt]
    steps:
      - id: пишет
        run: [sh, -c, 'printf "от первой\\n" > произведённый.txt']
        expect: [{ exit_code: 0 }]
  вторая:
    needs: [первая]
    session: per_step
    steps:
      - id: требует
        run: [sh, -c, 'test -f правка-пользователя.txt']
        expect: [{ exit_code: 0 }]
`,
      },
      { git: true },
    );

    const first = await firstRun(b);
    assert.equal(first.status, 'failed', 'второй работе не хватает файла пользователя');

    // Ровно та правка, ради которой возобновляют.
    b.project.write('правка-пользователя.txt', 'починил');

    const second = await resume(b, first);

    assert.equal(second.status, 'success');
    assert.equal(
      existsSync(b.project.path('правка-пользователя.txt')),
      true,
      'правка пользователя обязана уцелеть',
    );
    assert.ok(
      readEvents(second.journal.paths).some((event) => event.kind === 'tree.restored'),
      'восстановление произведённых путей должно попасть в журнал',
    );
  });

  // Сценарий: «Ни одно состояние не восстановимо»
  it('исполняет пайплайн с начала, когда переиспользовать нечего', async () => {
    const b = bed({ 'сырьё.txt': 'вход', 'маркер.txt': 'есть', 'stepcast.yml': TWO_JOBS });
    const first = await firstRun(b);

    // Стираем якоря: прогон выглядит как снятый до их введения.
    for (const job of readdirSync(first.journal.paths.jobs)) {
      const dir = findStepDir(first.journal.paths, job, 'a');
      if (dir === undefined) continue;
    }
    const status = readStatus(first.journal.paths);
    const stripped = {
      ...status,
      jobs: status.jobs.map((job) => ({
        ...job,
        steps: job.steps.map((step) => {
          const { tree_id: _t, ...rest } = step;
          return { ...rest, anchor_missing: 'снято до введения якоря' };
        }),
      })),
    };
    first.journal.writeStatus(stripped);

    const plan = planFor(b, first);
    assert.equal(plan.fromScratch, true);
    assert.ok(plan.steps.every((item) => item.decision.kind === 'rerun'));
    assert.ok(describePlan(plan).some((line) => line.includes('переиспользовать нечего')));

    const second = await resume(b, first);
    assert.equal(second.status, 'success');
  });
});

describe('run-resume: выдержка о прошлом отказе', () => {
  // Сценарий: «Выдержка подложена» / «Протокол попыток не переносится»
  it('подкладывает previous_failure первому переисполняемому шагу с контекстом', async () => {
    const b = bed({
      'stepcast.yml': `
version: 1
kind: pipeline
name: выдержка
jobs:
  работа:
    session: per_step
    steps:
      - id: падает
        run: [sh, -c, 'exit 7']
        expect: [{ exit_code: 0 }]
`,
    });

    const first = await firstRun(b);
    assert.equal(first.status, 'failed');

    const { buildPreviousFailure } = await import('../src/core/run/previousFailure.js');
    const note = buildPreviousFailure(first.journal.paths, readStatus(first.journal.paths));

    assert.ok(note !== undefined);
    assert.equal(note.job, 'работа');
    assert.equal(note.step, 'падает');
    assert.match(note.text, /Прошлый прогон не дошёл до конца/);
    assert.match(note.text, /exit_code/);
    assert.ok(!/попытка 1/i.test(note.text), 'протокол попыток не переносится');
  });

  it('не строит выдержку для успешного прогона', async () => {
    const b = bed({ 'маркер.txt': 'есть', 'stepcast.yml': TWO_JOBS });
    const first = await firstRun(b);

    const { buildPreviousFailure } = await import('../src/core/run/previousFailure.js');
    assert.equal(
      buildPreviousFailure(first.journal.paths, readStatus(first.journal.paths)),
      undefined,
    );
  });
});

describe('run-resume: объяснение и пробный запуск', () => {
  // Сценарий: «Отчёт о валидности»
  it('объясняет по каждому шагу, будет ли он переиспользован', async () => {
    const b = bed({ 'сырьё.txt': 'вход', 'stepcast.yml': TWO_JOBS });
    const first = await firstRun(b);
    b.project.write('маркер.txt', 'есть');

    const lines = describePlan(planFor(b, first));

    assert.ok(lines.some((line) => /первая\/a\s+переиспользуется/.test(line)));
    assert.ok(lines.some((line) => /вторая\/c\s+переисполняется — /.test(line)));
  });

  // Сценарий: «Пробный вызов ничего не исполняет»
  it('строит план, не создавая прогона и не трогая дерево', async () => {
    const b = bed({ 'сырьё.txt': 'вход', 'stepcast.yml': TWO_JOBS });
    const first = await firstRun(b);

    const before = readdirSync(first.journal.paths.projectDir).length;
    const traceBefore = readFileSync(b.project.path('след.txt'), 'utf8');

    planFor(b, first);

    assert.equal(readdirSync(first.journal.paths.projectDir).length, before);
    assert.equal(readFileSync(b.project.path('след.txt'), 'utf8'), traceBefore);
  });
});

describe('run-resume: переиспользование не тратит бюджет', () => {
  it('не учитывает расход переиспользованных шагов заново', async () => {
    const b = bed({ 'сырьё.txt': 'вход', 'маркер.txt': 'есть', 'stepcast.yml': TWO_JOBS });
    const first = await firstRun(b);
    const second = await resume(b, first, 'вторая');

    const status = readStatus(second.journal.paths);
    assert.equal(status.budget.tokens_used, 0, 'командные шаги токенов не тратят');

    const dir = findStepDir(second.journal.paths, 'первая', 'a');
    assert.ok(dir !== undefined);
    assert.equal(existsSync(join(dir, 'stdout.log')), false, 'шаг не исполнялся');
  });
});

describe('run-resume: --set переопределяет вход', () => {
  // Сценарий: «Изменённый вход» / «Вход, не затрагивающий работу»
  it('обесценивает шаги, зависящие от переопределённого входа', async () => {
    const b = bed({
      'сырьё.txt': 'вход',
      'stepcast.yml': `
version: 1
kind: pipeline
name: входы
inputs:
  режим: { type: string, default: обычный }
jobs:
  работа:
    session: per_step
    inputs: [сырьё.txt]
    steps:
      - id: печатает
        run: [echo, "\${inputs.режим}"]
        expect: [{ exit_code: 0 }]
`,
    });

    const first = await firstRun(b);
    assert.equal(first.status, 'success');

    // Тот же вход — шаг валиден.
    assert.equal(planWithInputs(b, first, {}).steps[0]?.decision.kind, 'reuse');

    // Другой вход меняет определение шага после подстановки, а значит и ключ.
    const changedPlan = planWithInputs(b, first, { 'режим': 'другой' });
    assert.equal(changedPlan.steps[0]?.decision.kind, 'rerun');
    assert.match(
      (changedPlan.steps[0]?.decision as { reason: string }).reason,
      /изменилось определение шага/,
    );
  });
});

/** План с переопределёнными входами: так работает `resume --set`. */
function planWithInputs(
  b: Bed,
  source: RunResult,
  overrides: Record<string, string>,
): ResumePlan {
  const sourceRun = readSourceRun(source.journal.paths);
  const inputs: Record<string, string> = {};
  for (const [name, value] of Object.entries(sourceRun.manifest.inputs)) {
    inputs[name] = String(value);
  }
  Object.assign(inputs, overrides);

  const expanded = expandPipeline({
    pipelinePath: b.project.path('stepcast.yml'),
    config: b.project.config,
    inputs,
  });
  const anchorKind = detectAnchorKind(b.project.root);
  const stateDir = mkdtempSync(join(tmpdir(), 'stepcast-plan-'));
  const anchorer = createAnchorer({
    dir: b.project.root,
    stateDir,
    kind: anchorKind,
    scope: 'plan',
    readStores: [manifestStore(source.journal.paths.anchors)],
  });
  const changed = changedSince(
    anchorer,
    finalAnchorOf(sourceRun.status, anchorKind),
    anchorer.capture(),
  );
  anchorer.dispose();

  return buildResumePlan({
    expanded,
    config: b.project.config,
    source: sourceRun,
    lockHash: createHash('sha256')
      .update(serializeLock(expanded.pipeline))
      .digest('hex')
      .slice(0, 16),
    changed,
  });
}
