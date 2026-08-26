import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createAnchorer, detectAnchorKind, manifestStore } from '../src/core/anchor/index.js';
import { createFakeBackend, resultLine, toolUseLine } from '../src/core/backend/fake.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { findStepDir, readEvents, readStatus } from '../src/core/journal/reader.js';
import {
  buildResumePlan,
  changedSince,
  describePlan,
  finalAnchorOf,
  parseFrom,
  planResume,
  producedBy,
  readSourceRun,
  type ResumePlan,
} from '../src/core/run/resumePlan.js';
import type { BackendAdapter } from '../src/core/backend/types.js';
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

async function firstRun(
  b: Bed,
  adapterFor?: (name: string) => BackendAdapter,
): Promise<RunResult> {
  return runPipeline({
    expanded: expandPipeline({ pipelinePath: b.project.path('stepcast.yml'), config: b.project.config }),
    config: configOf(b),
    projectRoot: b.project.root,
    cwd: b.project.root,
    ...(adapterFor === undefined ? {} : { adapterFor }),
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
    changed,
    cwd: b.project.root,
    producedPaths: (step) => producedBy(anchorer, step),
    ...(from === undefined ? {} : { from: parseFrom(from) }),
  });
  anchorer.dispose();
  return plan;
}

async function resume(
  b: Bed,
  source: RunResult,
  from?: string,
  adapterFor?: (name: string) => BackendAdapter,
): Promise<RunResult> {
  const plan = planFor(b, source, from);
  return runPipeline({
    expanded: expandPipeline({ pipelinePath: b.project.path('stepcast.yml'), config: b.project.config }),
    config: configOf(b),
    projectRoot: b.project.root,
    cwd: b.project.root,
    resume: { plan, source: readSourceRun(source.journal.paths) },
    ...(adapterFor === undefined ? {} : { adapterFor }),
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
    changed,
    cwd: b.project.root,
  });
}

describe('run-resume: атрибуция изменений дерева', () => {
  // Сценарий: «Собственный вывод прогона не обесценивает его работы»
  it('переиспользует предыдущие работы, когда дерево изменено только собственным выводом прогона', async () => {
    const b = bed({
      'stepcast.yml': `
version: 1
kind: pipeline
name: атрибуция
jobs:
  первая:
    session: per_step
    steps:
      - id: a
        run: [echo, готово]
        expect: [{ exit_code: 0 }]
  вторая:
    needs: [первая]
    session: per_step
    steps:
      - id: b
        run: [sh, -c, 'echo первое > b-out.txt']
        expect: [{ exit_code: 0 }]
      - id: c
        run: [sh, -c, 'echo второе > результат.txt']
        expect: [{ exit_code: 0 }]
`,
    });

    const first = await firstRun(b);
    assert.equal(first.status, 'success');

    // Правка ровно того пути, который произвёл сам прогон (последний шаг
    // c), — не пользовательское изменение, а то, что появилось бы и при
    // непрерывном исполнении.
    b.project.write('результат.txt', 'второе\nдописано снаружи');

    const plan = planFor(b, first);
    assert.equal(plan.steps.find((s) => s.job === 'первая' && s.step === 'a')?.decision.kind, 'reuse');
    assert.equal(plan.steps.find((s) => s.job === 'вторая' && s.step === 'b')?.decision.kind, 'reuse');

    // Шаг, чей собственный результат тронут, переисполняется — но не по
    // причине изменения входов, а по правилу о тронутом результате.
    const c = plan.steps.find((s) => s.job === 'вторая' && s.step === 'c');
    assert.equal(c?.decision.kind, 'rerun');
    assert.match((c?.decision as { reason: string }).reason, /результат шага тронут/);
  });

  // Сценарий: «Последующий вывод не обесценивает предшествующий шаг»
  it('изменение пути позднего шага не инвалидирует ранний, а раннего — инвалидирует поздний', async () => {
    const pipeline = `
version: 1
kind: pipeline
name: атрибуция-направление
jobs:
  работа:
    session: per_step
    steps:
      - id: ранний
        run: [sh, -c, 'echo ранний > ранний.txt']
        expect: [{ exit_code: 0 }]
      - id: поздний
        run: [sh, -c, 'echo поздний > поздний.txt']
        expect: [{ exit_code: 0 }]
`;

    {
      const b = bed({ 'stepcast.yml': pipeline });
      const first = await firstRun(b);
      assert.equal(first.status, 'success');
      b.project.write('поздний.txt', 'правка после прогона');

      const plan = planFor(b, first);
      assert.equal(plan.steps.find((s) => s.step === 'ранний')?.decision.kind, 'reuse');
    }

    {
      const b = bed({ 'stepcast.yml': pipeline });
      const first = await firstRun(b);
      assert.equal(first.status, 'success');
      b.project.write('ранний.txt', 'правка после прогона');

      const plan = planFor(b, first);
      // Правка пути раннего шага инвалидирует и его самого (правило о
      // тронутом результате), и, каскадом от него, поздний шаг — область
      // вычитания раннего в производимое позднего не входит, а произведённое
      // раннего в вычитание позднего не входит вовсе.
      const early = plan.steps.find((s) => s.step === 'ранний');
      assert.equal(early?.decision.kind, 'rerun');
      const later = plan.steps.find((s) => s.step === 'поздний');
      assert.equal(later?.decision.kind, 'rerun');
    }
  });
});

describe('run-resume: файлы определения вне множества изменений', () => {
  // Сценарий: «Правка файла одной работы»
  it('переисполняет только шаги работы, чей файл определения изменился', async () => {
    const b = bed(
      {
        'stepcast.yml': `
kind: pipeline
name: определения
jobs:
  первая:
    uses: ./jobs/первая.yml
  вторая:
    needs: [первая]
    uses: ./jobs/вторая.yml
`,
        'jobs/первая.yml': `
kind: job
session: per_step
steps:
  - id: a
    run: [echo, готово]
    expect: [{ exit_code: 0 }]
`,
        'jobs/вторая.yml': `
kind: job
session: per_step
steps:
  - id: b
    run: [echo, готово]
    expect: [{ exit_code: 0 }]
`,
      },
      { git: true },
    );

    const first = await firstRun(b);
    assert.equal(first.status, 'success');

    // Правка файла работы «вторая» — изменение её определения, а не
    // пользовательская правка дерева.
    b.project.write(
      'jobs/вторая.yml',
      `
kind: job
session: per_step
steps:
  - id: b
    run: [echo, изменено]
    expect: [{ exit_code: 0 }]
`,
    );

    const plan = planFor(b, first);
    assert.equal(plan.steps.find((s) => s.job === 'первая')?.decision.kind, 'reuse');

    const changedJob = plan.steps.find((s) => s.job === 'вторая');
    assert.equal(changedJob?.decision.kind, 'rerun');
    assert.match((changedJob?.decision as { reason: string }).reason, /изменилось определение шага/);
  });
});

describe('run-resume: --from переиспользует верх графа', () => {
  const CHAIN = `
version: 1
kind: pipeline
name: цепочка
jobs:
  a:
    session: per_step
    inputs: [a.txt]
    steps:
      - id: шаг
        run: [echo, готово]
        expect: [{ exit_code: 0 }]
  b:
    needs: [a]
    session: per_step
    steps:
      - id: шаг
        run: [echo, готово]
        expect: [{ exit_code: 0 }]
  c:
    needs: [b]
    session: per_step
    steps:
      - id: шаг
        run: [echo, готово]
        expect: [{ exit_code: 0 }]
`;

  // Сценарий: «Верх графа переиспользуется поверх изменённого дерева»
  it('переиспользует работу выше точки, игнорируя и перечисляя чужую правку в её области', async () => {
    const b = bed({ 'a.txt': 'вход', 'stepcast.yml': CHAIN });
    const first = await firstRun(b);
    assert.equal(first.status, 'success');

    b.project.write('a.txt', 'чужая правка выше точки --from');

    const plan = planFor(b, first, 'b');

    assert.equal(plan.steps.find((s) => s.job === 'a')?.decision.kind, 'reuse');
    assert.ok(plan.ignoredEdits.includes('a.txt'));

    const bDecision = plan.steps.find((s) => s.job === 'b');
    assert.match((bDecision?.decision as { reason: string }).reason, /--from b/);
  });

  // Сценарий: «Невозможное переиспользование выше точки»
  it('не переиспользует шаг выше точки, если изменилось его определение', async () => {
    const b = bed(
      {
        'stepcast.yml': `
version: 1
kind: pipeline
name: цепочка-с-определением
jobs:
  a:
    uses: ./jobs/a.yml
  b:
    needs: [a]
    session: per_step
    steps:
      - id: шаг
        run: [echo, готово]
        expect: [{ exit_code: 0 }]
`,
        'jobs/a.yml': `
kind: job
session: per_step
steps:
  - id: шаг
    run: [echo, готово]
    expect: [{ exit_code: 0 }]
`,
      },
      { git: true },
    );

    const first = await firstRun(b);
    assert.equal(first.status, 'success');

    b.project.write(
      'jobs/a.yml',
      `
kind: job
session: per_step
steps:
  - id: шаг
    run: [echo, изменено]
    expect: [{ exit_code: 0 }]
`,
    );

    const plan = planFor(b, first, 'b');
    const aDecision = plan.steps.find((s) => s.job === 'a');
    assert.equal(aDecision?.decision.kind, 'rerun');
    assert.match((aDecision?.decision as { reason: string }).reason, /изменилось определение шага/);
  });
});

describe('run-resume: отчёт по работам', () => {
  it('называет частичное переисполнение и точку, с которой оно начинается', async () => {
    const b = bed({ 'сырьё.txt': 'вход', 'маркер.txt': 'есть', 'stepcast.yml': TWO_JOBS });
    const first = await firstRun(b);
    assert.equal(first.status, 'success');

    const plan = planFor(b, first, 'первая/b');
    const lines = describePlan(plan);

    assert.ok(lines.some((line) => /^первая\s+переисполняется частично, с шага b/.test(line)));
    assert.ok(lines.some((line) => /^вторая\s+переисполняется/.test(line)));
  });
});

describe('run-resume: выходы переиспользованных работ', () => {
  const OUTPUT_PIPELINE = `
version: 1
kind: pipeline
name: выходы
jobs:
  propose:
    output:
      from: думает
    session: per_step
    steps:
      - id: думает
        agent: fake
        prompt: "придумай"
        expect: [{ exit_code: 0 }]
      - id: логирует
        run: [echo, done]
        expect: [{ exit_code: 0 }]
  implement:
    needs: [propose]
    session: per_step
    steps:
      - id: c
        run: [sh, -c, 'echo "\${jobs.propose.output.slug}" > slug.txt']
        expect: [{ exit_code: 0 }]
`;

  function fakeAdapter(): (name: string) => BackendAdapter {
    const backend = createFakeBackend({
      lines: [resultLine({ text: 'ок', structured: { slug: 'add-oauth' } })],
    });
    return () => backend.adapter;
  }

  // Сценарий: «Артефакт переиспользованной работы существует» / «Нижележащая
  // работа видит выход»
  it('публикует артефакт полностью переиспользованной работы в новом прогоне', async () => {
    const b = bed({ 'stepcast.yml': OUTPUT_PIPELINE });
    const first = await firstRun(b, fakeAdapter());
    assert.equal(first.status, 'success');

    const second = await resume(b, first, 'implement', fakeAdapter());
    assert.equal(second.status, 'success');

    const artifactPath = join(second.journal.paths.artifacts, 'propose.json');
    assert.equal(existsSync(artifactPath), true);
    assert.deepEqual(JSON.parse(readFileSync(artifactPath, 'utf8')), { slug: 'add-oauth' });

    assert.equal(readFileSync(b.project.path('slug.txt'), 'utf8').trim(), 'add-oauth');
  });

  // Сценарий: «Частичное переиспользование работы с output.from»
  it('публикует выход переиспользованного шага при частичном переиспользовании работы', async () => {
    const b = bed({ 'stepcast.yml': OUTPUT_PIPELINE });
    const first = await firstRun(b, fakeAdapter());
    assert.equal(first.status, 'success');

    // «думает» переиспользуется, «логирует» переисполняется: работа
    // «propose» переиспользована лишь частично.
    const second = await resume(b, first, 'propose/логирует', fakeAdapter());
    assert.equal(second.status, 'success');

    assert.equal(readFileSync(b.project.path('slug.txt'), 'utf8').trim(), 'add-oauth');

    const proposeStep = steps(second).find((step) => step.id === 'думает');
    assert.equal(proposeStep?.reused_from, first.journal.paths.runId);
  });

  // Сценарий: «Выход восстановить нельзя»
  it('переисполняет работу, чей выход в источнике недоступен', async () => {
    const b = bed({ 'stepcast.yml': OUTPUT_PIPELINE });
    const first = await firstRun(b, fakeAdapter());
    assert.equal(first.status, 'success');

    rmSync(join(first.journal.paths.artifacts, 'propose.json'), { force: true });

    const plan = planFor(b, first);
    const step = plan.steps.find((s) => s.job === 'propose' && s.step === 'думает');
    assert.equal(step?.decision.kind, 'rerun');
    assert.match((step?.decision as { reason: string }).reason, /выход работы не восстановить/);
  });
});

describe('run-resume: наблюдённые входы сужают область', () => {
  const OBSERVED_PIPELINE = `
version: 1
kind: pipeline
name: наблюдённые-входы
jobs:
  работа:
    session: per_step
    steps:
      - id: думает
        agent: fake
        prompt: "прочитай a.ts"
        expect: [{ exit_code: 0 }]
`;

  function readsA(): (name: string) => BackendAdapter {
    const backend = createFakeBackend({
      lines: [toolUseLine('Read', { file_path: 'a.ts' }), resultLine({ text: 'ок' })],
    });
    return () => backend.adapter;
  }

  // Сценарий: «Перечень сужает при отпечатке по дереву»
  it('изменение файла вне наблюдённых входов не инвалидирует шаг без объявленных inputs', async () => {
    const b = bed({ 'a.ts': 'вход', 'b.ts': 'посторонний', 'stepcast.yml': OBSERVED_PIPELINE });
    const first = await firstRun(b, readsA());
    assert.equal(first.status, 'success');

    const record = steps(first).find((step) => step.id === 'думает');
    assert.deepEqual(record?.observed_inputs, ['a.ts']);
    assert.equal(record?.inputs_origin, 'tree', 'отпечаток первого прогона снят по всему дереву');

    b.project.write('b.ts', 'правка вне наблюдённых входов');
    const untouched = planFor(b, first);
    assert.equal(untouched.steps[0]?.decision.kind, 'reuse');

    b.project.write('a.ts', 'правка наблюдённого входа');
    const touched = planFor(b, first);
    assert.equal(touched.steps[0]?.decision.kind, 'rerun');
    assert.match((touched.steps[0]?.decision as { reason: string }).reason, /изменились входы шага \(a\.ts\)/);
  });

  // Сценарий: «Объявленные входы старше наблюдённых»
  it('объявленные inputs работы имеют приоритет над наблюдёнными', async () => {
    const b = bed({
      'a.ts': 'вход',
      'declared.txt': 'вход',
      'stepcast.yml': `
version: 1
kind: pipeline
name: наблюдённые-против-объявленных
jobs:
  работа:
    session: per_step
    inputs: [declared.txt]
    steps:
      - id: думает
        agent: fake
        prompt: "прочитай a.ts"
        expect: [{ exit_code: 0 }]
`,
    });
    const first = await firstRun(b, readsA());
    assert.equal(first.status, 'success');

    // a.ts наблюдён, но объявленные inputs работы (declared.txt) главнее.
    b.project.write('a.ts', 'правка наблюдённого, но не объявленного входа');
    const plan = planFor(b, first);
    assert.equal(plan.steps[0]?.decision.kind, 'reuse');
  });
});

describe('run-resume: точка возобновления не теряет чужую работу', () => {
  const PRODUCING = `
version: 1
kind: pipeline
name: производящая-цепочка
jobs:
  a:
    session: per_step
    inputs: [сырьё.txt]
    steps:
      - id: шаг
        run: [sh, -c, 'echo произведено > плод.txt']
        expect: [{ exit_code: 0 }]
  b:
    needs: [a]
    session: per_step
    steps:
      - id: шаг
        run: [echo, готово]
        expect: [{ exit_code: 0 }]
`;

  // Сценарий: «Чужая правка выше точки»
  it('не восстанавливает из якоря чужую правку, которую сама же обещала проигнорировать', async () => {
    const b = bed({ 'сырьё.txt': 'вход', 'stepcast.yml': PRODUCING }, { git: true });
    const first = await firstRun(b);
    assert.equal(first.status, 'success');

    b.project.write('плод.txt', 'правка пользователя');

    const plan = planFor(b, first, 'b');
    assert.ok(plan.ignoredEdits.includes('плод.txt'), 'правка обязана попасть в перечень игнорируемых');
    assert.equal(
      plan.restore?.paths.includes('плод.txt') ?? false,
      false,
      'и не должна попасть в список восстановления',
    );

    const second = await resume(b, first, 'b');
    assert.equal(second.status, 'success');
    assert.equal(
      readFileSync(b.project.path('плод.txt'), 'utf8').trim(),
      'правка пользователя',
      'возобновление не имеет права стирать правку, ради которой его и запускают',
    );
  });

  // Сценарий: «Каскад выше точки»
  it('гасит следующие шаги выше точки, когда предшественник переисполнен по существу', async () => {
    const b = bed(
      {
        'stepcast.yml': `
version: 1
kind: pipeline
name: каскад-выше-точки
jobs:
  a:
    uses: ./jobs/a.yml
  b:
    needs: [a]
    session: per_step
    steps:
      - id: шаг
        run: [echo, готово]
        expect: [{ exit_code: 0 }]
  c:
    needs: [b]
    session: per_step
    steps:
      - id: шаг
        run: [echo, готово]
        expect: [{ exit_code: 0 }]
`,
        'jobs/a.yml': `
kind: job
session: per_step
steps:
  - id: шаг
    run: [echo, готово]
    expect: [{ exit_code: 0 }]
`,
      },
      { git: true },
    );
    const first = await firstRun(b);
    assert.equal(first.status, 'success');

    // Определение работы `a` изменилось: она переисполнится не из-за дерева,
    // а по существу, и её новый вывод обесценивает `b` — хотя обе выше точки.
    b.project.write(
      'jobs/a.yml',
      `
kind: job
session: per_step
steps:
  - id: шаг
    run: [echo, иначе]
    expect: [{ exit_code: 0 }]
`,
    );

    const plan = planFor(b, first, 'c');
    const byJob = decisions(plan);
    assert.equal(byJob['a/шаг'], 'rerun', 'изменённое определение переисполняет работу');
    assert.equal(byJob['b/шаг'], 'rerun', 'следующая выше точки не может стоять на устаревшем входе');
  });
});

describe('run-resume: точка возобновления проверяется на существование', () => {
  const PAIR = `
version: 1
kind: pipeline
name: пара
jobs:
  a:
    session: per_step
    steps:
      - id: шаг
        run: [echo, готово]
        expect: [{ exit_code: 0 }]
  b:
    needs: [a]
    session: per_step
    steps:
      - id: шаг
        run: [echo, готово]
        expect: [{ exit_code: 0 }]
`;

  // Сценарий: «Неизвестная точка отвергается»
  it('отвергает работу, которой в пайплайне нет, вместо переиспользования всего', async () => {
    const b = bed({ 'stepcast.yml': PAIR }, { git: true });
    const first = await firstRun(b);

    // Точка, которая никогда не наступает, оставляла бы весь пайплайн «выше
    // точки»: дерево не судится нигде, всё переиспользуется, ничего не
    // исполняется — отказ, неотличимый от успеха.
    assert.throws(
      () =>
        planResume({
          cwd: b.project.root,
          config: configOf(b),
          source: readSourceRun(first.journal.paths),
          from: 'нет-такой',
        }),
      /Работа нет-такой в пайплайне не объявлена/,
    );
  });

  it('отвергает шаг, которого у названной работы нет', async () => {
    const b = bed({ 'stepcast.yml': PAIR }, { git: true });
    const first = await firstRun(b);

    assert.throws(
      () =>
        planResume({
          cwd: b.project.root,
          config: configOf(b),
          source: readSourceRun(first.journal.paths),
          from: 'a/нет-такого',
        }),
      /Работа a не объявляет шаг нет-такого/,
    );
  });
});
