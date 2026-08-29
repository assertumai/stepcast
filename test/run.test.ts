import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createFakeBackend, resultLine } from '../src/core/backend/fake.js';
import type { Config } from '../src/core/config/resolve.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { findStepDir, readEvents, readStatus } from '../src/core/journal/reader.js';
import { resolveExitCode, runPipeline, type RunResult } from '../src/core/run/runner.js';
import { HALT_CAUSES, HaltCause } from '../src/core/run/halt.js';
import { ExitCode } from '../src/core/errors.js';
import type { Event, StatusValue, StepRecord } from '../src/core/journal/schema.js';
import type { UsageSnapshot } from '../src/core/budget/accumulator.js';
import { gitCommit, gitInit, makeProject, type Project } from './helpers.js';

/** Прогнать пайплайн проекта целиком, сложив журнал во временный корень. */
async function run(
  project: Project,
  options: { readonly signal?: AbortSignal; readonly breakAnchor?: boolean } = {},
): Promise<RunResult> {
  return runWithConfig(project, project.config, options);
}

/** То же, что `run`, но с конфигурацией, объявляющей состав вложенных репозиториев. */
async function runWithConfig(
  project: Project,
  config: Config,
  options: { readonly signal?: AbortSignal; readonly breakAnchor?: boolean } = {},
): Promise<RunResult> {
  const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
  const expanded = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config });

  return runPipeline({
    expanded,
    config: { ...config, runs: { ...config.runs, root: runsRoot } },
    projectRoot: project.root,
    cwd: project.root,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.breakAnchor === true ? { anchorerFor: brokenAnchorer } : {}),
  });
}

/** Тот же проект, но с объявленным составом `project.nested_repos`, будто он объявлен в `.stepcast/config.yml`. */
function withNestedRepos(project: Project, nestedRepos: readonly string[]): Config {
  return { ...project.config, project: { ...project.config.project, nestedRepos } };
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
  it('содержит прежние причины и добавляет ровно три новые', () => {
    const before = [
      'expect_failed',
      'timeout',
      'spawn_failed',
      'budget_exceeded',
      'canceled',
    ];
    const added = ['until_not_met', 'backend_rate_limited', 'backend_unauthenticated'];

    assert.deepEqual([...HALT_CAUSES].sort(), [...before, ...added].sort());
  });

  it('не заводит причин вне перечня', () => {
    const declared = new Set<string>(HALT_CAUSES);
    for (const value of Object.values(HaltCause)) {
      assert.ok(declared.has(value), `причина ${value} должна быть в перечне`);
    }
  });
});

describe('run-exit-code: код возврата по статусу и причине', () => {
  it('отказ аутентификации переопределяет код возврата упавшего прогона', () => {
    assert.equal(
      resolveExitCode('failed', [{ cause: HaltCause.backendUnauthenticated }, {}]),
      ExitCode.backendUnavailable,
    );
  });

  it('отмена пользователем остаётся кодом 130, даже если работа упёрлась в отказ аутентификации', () => {
    // Отмена — самая внешняя причина: `overallStatus` ставит её выше отказа,
    // и код возврата не должен с ним расходиться.
    assert.equal(
      resolveExitCode('canceled', [{ cause: HaltCause.backendUnauthenticated }, { cause: HaltCause.canceled }]),
      ExitCode.canceled,
    );
  });

  it('прочие статусы сохраняют прежние коды', () => {
    assert.equal(resolveExitCode('success', []), ExitCode.ok);
    assert.equal(resolveExitCode('failed', [{ cause: HaltCause.expectFailed }]), ExitCode.jobFailed);
    assert.equal(
      resolveExitCode('budget_exceeded', [{ cause: HaltCause.backendRateLimited }]),
      ExitCode.budgetExceeded,
    );
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

describe('workspace-anchor: составной якорь работ и состав в манифесте', () => {
  // Задача 9 / Сценарий: объявленный состав даёт способ composite и записывает его в манифест.
  it('прогон в дереве с объявленным составом даёт anchor_kind composite и nested_repos в манифесте', async () => {
    const project = makeProject({ 'stepcast.yml': THREE_STEPS, 'public-site/.gitkeep': '' });
    gitInit(project.root);
    gitInit(project.path('public-site'));
    gitCommit(project.path('public-site'), 'начало части');
    gitCommit(project.root, 'первый');

    const result = await runWithConfig(project, withNestedRepos(project, ['public-site']));
    assert.equal(result.status, 'success');

    const manifest = JSON.parse(readFileSync(result.journal.paths.manifest, 'utf8')) as {
      anchor_kind?: string;
      nested_repos?: string[];
    };
    assert.equal(manifest.anchor_kind, 'composite');
    assert.deepEqual(manifest.nested_repos, ['public-site']);

    for (const step of steps(result)) {
      assert.equal(step.anchor_kind, 'composite');
    }
  });

  // Задача 9 / Сценарий: прогон без объявления не меняет форму записей.
  it('прогон без объявленного состава даёт прежний anchor_kind и манифест без nested_repos', async () => {
    const project = makeProject({ 'stepcast.yml': THREE_STEPS });
    gitInit(project.root);
    gitCommit(project.root, 'первый');

    const result = await run(project);
    assert.equal(result.status, 'success');

    const manifest = JSON.parse(readFileSync(result.journal.paths.manifest, 'utf8')) as {
      anchor_kind?: string;
      nested_repos?: string[];
    };
    assert.equal(manifest.anchor_kind, 'git');
    assert.equal(manifest.nested_repos, undefined);
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

  // Сценарий: «Ключ шага не зависит от параллелизма» — то же правило, что и у
  // блока контекста (см. `step-context: блок предшественников берётся по
  // графу` в этом же файле): состав, который видит шаг, определяется графом,
  // а не тем, кто успел завершиться, и от предела одновременности не зависит.
  it('не меняется при разном пределе одновременности', async () => {
    // Работы `a` и `b` независимы и публикуют выход агентским шагом; `c`
    // зависит от обеих, а порядок их завершения при параллельном исполнении
    // не гарантирован. Ключ шага `c` берёт выходы предшественников по графу
    // (см. `upstreamOutputs`), а не по порядку завершения, — иначе он
    // расходился бы с пределом одновременности.
    const pipeline = `
version: 1
kind: pipeline
name: ключ-под-параллелизмом
concurrency: 2
jobs:
  a:
    output:
      from: думает
    steps:
      - id: думает
        agent: fake
        prompt: придумай a
        expect: [{ exit_code: 0 }]
  b:
    output:
      from: думает
    steps:
      - id: думает
        agent: fake
        prompt: придумай b
        expect: [{ exit_code: 0 }]
  c:
    needs: [a, b]
    steps:
      - id: use
        run: [echo, готово]
        expect: [{ exit_code: 0 }]
`;

    const keysOf = (result: RunResult): string[] =>
      readStatus(result.journal.paths).jobs.flatMap((job) =>
        job.steps.map((step) => `${job.id}/${step.id}:${step.key}`),
      );

    // Один и тот же проект для обоих прогонов: разные временные каталоги
    // дали бы разные деревья git, и ключ разошёлся бы по вполне законной
    // причине — рабочее дерево изменилось, — заслонив собой то, что здесь
    // проверяется.
    const project = makeProject({ 'stepcast.yml': pipeline });
    const runOnce = async (concurrency: number): Promise<RunResult> => {
      const backend = createFakeBackend({ lines: [resultLine({ text: 'ок', structured: { slug: 'x' } })] });
      return runPipeline({
        expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
        config: {
          ...project.config,
          runs: { ...project.config.runs, root: mkdtempSync(join(tmpdir(), 'stepcast-runs-')) },
          limits: { ...project.config.limits, concurrency },
        },
        projectRoot: project.root,
        cwd: project.root,
        adapterFor: () => backend.adapter,
      });
    };

    assert.deepEqual(keysOf(await runOnce(2)), keysOf(await runOnce(1)));
  });
});

describe('step-context: блок предшественников берётся по графу', () => {
  // Спека step-context: «Работа вне графа предшественников в блок не входит».
  // `сосед` и `предок` идут одновременно и оба публикуют выход; в блок работы
  // `потребитель` обязан войти только выход её предшественника, независимо от
  // того, кто из двух завершился раньше.
  it('не пускает в блок выход одновременной работы, не входящей в предшественники', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: блок-по-графу
concurrency: 2
jobs:
  сосед:
    output:
      from: думает
    steps:
      - id: думает
        agent: альфа
        prompt: придумай
        expect: [{ exit_code: 0 }]
  предок:
    output:
      from: думает
    steps:
      - id: думает
        agent: бета
        prompt: придумай
        expect: [{ exit_code: 0 }]
  потребитель:
    needs: [предок]
    steps:
      - id: читает
        agent: гамма
        prompt: используй
        expect: [{ exit_code: 0 }]
`,
    });

    const backends: Record<string, ReturnType<typeof createFakeBackend>> = {
      альфа: createFakeBackend({ lines: [resultLine({ text: 'ок', structured: { slug: 'от-соседа' } })] }),
      бета: createFakeBackend({ lines: [resultLine({ text: 'ок', structured: { slug: 'от-предка' } })] }),
      гамма: createFakeBackend({ lines: [resultLine({ text: 'ок' })] }),
    };

    const result = await runPipeline({
      expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
      config: {
        ...project.config,
        runs: { ...project.config.runs, root: mkdtempSync(join(tmpdir(), 'stepcast-runs-')) },
      },
      projectRoot: project.root,
      cwd: project.root,
      adapterFor: (name) => {
        const backend = backends[name];
        assert.ok(backend !== undefined, `нет поддельного бэкенда для «${name}»`);
        return backend.adapter;
      },
    });

    assert.equal(result.status, 'success');

    const dir = findStepDir(result.journal.paths, 'потребитель', 'читает');
    assert.ok(dir !== undefined, 'каталог шага потребителя не найден');
    const prompt = readFileSync(join(dir, 'prompt.txt'), 'utf8');

    assert.match(prompt, /от-предка/, 'выход предшественника в блоке обязан быть');
    assert.doesNotMatch(prompt, /от-соседа/, 'выход работы вне предшественников в блок не входит');
  });
});

describe('pipeline-execution: журнал под параллелизмом', () => {
  const TWO_INDEPENDENT = `
version: 1
kind: pipeline
name: две-независимые
concurrency: 2
jobs:
  медленная:
    steps:
      - id: раз
        run: [sh, -c, 'sleep 0.15']
        expect: [{ exit_code: 0 }]
      - id: два
        run: [sh, -c, 'sleep 0.15']
        expect: [{ exit_code: 0 }]
  быстрая:
    steps:
      - id: раз
        run: [sh, -c, 'sleep 0.01']
        expect: [{ exit_code: 0 }]
      - id: два
        run: [sh, -c, 'sleep 0.01']
        expect: [{ exit_code: 0 }]
`;

  // Сценарий: «Чередующийся поток сохраняет причинный порядок» — задача 5.3
  it('порядковые номера возрастают без повторов, а поток каждой работы читается как её последовательность', async () => {
    const project = makeProject({ 'stepcast.yml': TWO_INDEPENDENT });
    const result = await run(project);
    const events = readEvents(result.journal.paths);

    assert.deepEqual(
      events.map((event) => event.seq),
      events.map((_, index) => index),
      'номера идут подряд с нуля, без повторов и пропусков',
    );

    for (const job of ['медленная', 'быстрая']) {
      const own = events.filter(
        (event): event is typeof event & { job: string } => 'job' in event && event.job === job,
      );
      const started = own.find((event) => event.kind === 'job.started');
      const finished = own.find((event) => event.kind === 'job.finished');
      assert.ok(started !== undefined && finished !== undefined);
      assert.ok(started.seq < finished.seq, `${job}: работа завершается после старта`);

      const stepsOf = own.filter(
        (event): event is typeof event & { step: string; attempt: number } =>
          (event.kind === 'step.started' || event.kind === 'step.finished') && 'step' in event,
      );
      for (const step of ['раз', 'два']) {
        const stepStarted = stepsOf.find((event) => event.kind === 'step.started' && event.step === step);
        const stepFinished = stepsOf.find((event) => event.kind === 'step.finished' && event.step === step);
        assert.ok(stepStarted !== undefined && stepFinished !== undefined);
        assert.ok(stepStarted.seq < stepFinished.seq, `${job}/${step}: начало раньше конца`);
      }
    }

    // Доказательство собственно чередования: событие быстрой работы попадает
    // между началом и концом медленной — иначе исполнение было бы
    // последовательным, а не параллельным.
    const slowStart = events.find((event) => event.kind === 'job.started' && event.job === 'медленная');
    const slowEnd = events.find((event) => event.kind === 'job.finished' && event.job === 'медленная');
    const fastEnd = events.find((event) => event.kind === 'job.finished' && event.job === 'быстрая');
    assert.ok(slowStart !== undefined && slowEnd !== undefined && fastEnd !== undefined);
    assert.ok(
      fastEnd.seq > slowStart.seq && fastEnd.seq < slowEnd.seq,
      'быстрая работа успевает завершиться, пока медленная ещё идёт',
    );
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

describe('pipeline-lanes: lane в записи работы', () => {
  it('запись работы с объявленной lane несёт её в status.json', async () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
name: p
jobs:
  build:
    lane: a
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
  other:
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
`,
    });

    const result = await run(project);
    assert.equal(result.status, 'success');

    const status = readStatus(result.journal.paths);
    assert.equal(status.jobs.find((job) => job.id === 'build')?.lane, 'a');
    assert.equal(status.jobs.find((job) => job.id === 'other')?.lane, undefined);
  });
});

describe('step-execution: STEPCAST_BIN', () => {
  it('указывает на исполняющий движок и не переопределяется объявленным env', async () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
name: p
jobs:
  probe:
    steps:
      - id: check
        run: 'test "$STEPCAST_BIN" = "${process.argv[1]}"'
        env: { STEPCAST_BIN: подделка }
        expect: [{ exit_code: 0 }]
`,
    });

    const result = await run(project);
    assert.equal(result.status, 'success');
  });
});

describe('step-execution: структурированный выход командного шага', () => {
  it('публикует выход командного шага через output.from', async () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
name: p
jobs:
  probe:
    output: { from: emit }
    steps:
      - id: emit
        run: [echo, '{"slug":"x"}']
        output_schema: schema.json
`,
      'schema.json': JSON.stringify({
        type: 'object',
        properties: { slug: { type: 'string' } },
        required: ['slug'],
      }),
    });

    const result = await run(project);
    assert.equal(result.status, 'success');

    const status = readStatus(result.journal.paths);
    const job = status.jobs.find((entry) => entry.id === 'probe');
    assert.ok(job?.output !== undefined, 'у работы должен быть путь к артефакту выхода');
    const published = JSON.parse(readFileSync(job!.output as string, 'utf8'));
    assert.deepEqual(published, { slug: 'x' });
  });

  it('предикат schema на командном шаге проверяет разобранный выход', async () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
name: p
jobs:
  probe:
    steps:
      - id: emit
        run: [echo, '{"slug":"x"}']
        output_schema: schema.json
        expect:
          - schema: schema.json
`,
      'schema.json': JSON.stringify({
        type: 'object',
        properties: { slug: { type: 'string' } },
        required: ['slug'],
      }),
    });

    const result = await run(project);
    assert.equal(result.status, 'success');
  });

  it('отказывает попытку с причиной, называющей шаг и неразбираемый вывод, и повторяет её', async () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
name: p
jobs:
  probe:
    steps:
      - id: emit
        run: [echo, 'не json']
        output_schema: schema.json
        attempts: { max: 2 }
`,
      'schema.json': JSON.stringify({ type: 'object' }),
    });

    const result = await run(project);
    assert.equal(result.status, 'failed');

    const status = readStatus(result.journal.paths);
    const step = status.jobs.flatMap((job) => job.steps).find((entry) => entry.id === 'emit');
    assert.equal(step?.attempts.length, 2);
    assert.match(step?.reason ?? '', /emit/);
    assert.match(step?.reason ?? '', /JSON/);
  });

  it('командный шаг без output_schema структурированного выхода не имеет', async () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
name: p
jobs:
  probe:
    output: { from: emit }
    steps:
      - id: emit
        run: [echo, '{"slug":"x"}']
`,
    });

    const result = await run(project);
    assert.equal(result.status, 'success');

    const status = readStatus(result.journal.paths);
    const job = status.jobs.find((entry) => entry.id === 'probe');
    assert.equal(job?.output, undefined);
  });
});

describe('run-progress: наблюдение onEvent в runPipeline', () => {
  async function runObserved(
    project: Project,
    onEvent: (event: Event, usage: UsageSnapshot) => void,
  ): Promise<RunResult> {
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
    const expanded = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config });
    return runPipeline({
      expanded,
      config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
      onEvent,
    });
  }

  it('наблюдатель получает run.started первым и run.finished последним', async () => {
    const project = makeProject({ 'stepcast.yml': THREE_STEPS });
    const received: Event[] = [];

    await runObserved(project, (event) => received.push(event));

    assert.equal(received[0]?.kind, 'run.started');
    assert.equal(received.at(-1)?.kind, 'run.finished');
  });

  it('последовательность доставленных событий совпадает с events.ndjson', async () => {
    const project = makeProject({ 'stepcast.yml': THREE_STEPS });
    const received: string[] = [];

    const result = await runObserved(project, (event) => received.push(event.kind));

    assert.deepEqual(
      received,
      readEvents(result.journal.paths).map((event) => event.kind),
    );
  });

  it('снимок расхода не убывает по ходу прогона (по времени, дошедшему до второго исхода шага)', async () => {
    const project = makeProject({ 'stepcast.yml': THREE_STEPS });
    const finishedSnapshots: UsageSnapshot[] = [];

    await runObserved(project, (event, usage) => {
      if (event.kind === 'step.finished') finishedSnapshots.push(usage);
    });

    assert.ok(finishedSnapshots.length >= 2);
    assert.ok((finishedSnapshots[1] as UsageSnapshot).elapsedMs >= (finishedSnapshots[0] as UsageSnapshot).elapsedMs);
  });

  it('прогон с бросающим наблюдателем даёт тот же статус, код возврата и записи работ, что и без него', async () => {
    const project = makeProject({ 'stepcast.yml': THREE_STEPS });

    const clean = await run(project);
    const observed = await runObserved(project, () => {
      throw new Error('наблюдатель сломан');
    });

    assert.equal(observed.status, clean.status);
    assert.equal(observed.exitCode, clean.exitCode);
    assert.deepEqual(steps(observed).map((step) => step.status), steps(clean).map((step) => step.status));
  });
});
