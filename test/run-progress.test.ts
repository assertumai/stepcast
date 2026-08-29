import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createFakeBackend, initLine, resultLine } from '../src/core/backend/fake.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { runPipeline } from '../src/core/run/runner.js';

import { formatElapsed, renderProgressLine } from '../src/cli/progress.js';
import { runRunCommand } from '../src/cli/commands/run.js';
import { runLogsCommand } from '../src/cli/commands/logs.js';
import type { ParsedArgs } from '../src/cli/args.js';
import { readStatus, resolveRun } from '../src/core/journal/reader.js';
import type { Event, RunStatus } from '../src/core/journal/schema.js';
import type { UsageSnapshot } from '../src/core/budget/accumulator.js';
import { ExitCode } from '../src/core/errors.js';
import { makeProject, withHome } from './helpers.js';

const BASE = { ts: '2026-08-27T10:00:00.000Z', seq: 0 };

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
/** Признак управляющей последовательности в готовой строке ленты. */
const ANSI_OR_CR = new RegExp(`${ESC}|\\r`);

const ZERO_USAGE: UsageSnapshot = { tokens: 0, elapsedMs: 0, costUnreportedAttempts: 0 };

/** Непустой расход: строка исхода шага обязана назвать его величины. */
const SOME_USAGE: UsageSnapshot = {
  tokens: 12_000,
  costMicroUsd: 250_000,
  elapsedMs: 60_000,
  costUnreportedAttempts: 0,
};

/**
 * Одно событие каждого вида из закрытого перечня схемы — по образцу
 * test/journal.test.ts. Рядом с событием — то, что его строка обязана
 * сказать: проверка «строка вообще есть» пропустила бы потерю поля.
 */
const PRINTABLE: readonly { readonly event: Event; readonly says: readonly RegExp[] }[] = [
  {
    event: { ...BASE, kind: 'run.started', pipeline: 'demo', run_id: 'r1' },
    says: [/прогон:/, /demo/],
  },
  {
    event: { ...BASE, kind: 'run.finished', status: 'success', exit_code: 0 },
    says: [/прогон:/, /success/, /код 0/],
  },
  { event: { ...BASE, kind: 'job.started', job: 'build' }, says: [/build:/, /начата/] },
  {
    event: { ...BASE, kind: 'job.finished', job: 'build', status: 'failed', reason: 'предикат' },
    says: [/build:/, /failed/, /предикат/],
  },
  {
    event: { ...BASE, kind: 'job.errored', job: 'build', detail: 'бум' },
    says: [/build:/, /ошибкой/, /бум/],
  },
  {
    event: { ...BASE, kind: 'step.started', job: 'build', step: 'plan', attempt: 2 },
    says: [/build\/plan:/, /начат/, /попытка 2/],
  },
  {
    event: { ...BASE, kind: 'step.finished', job: 'build', step: 'plan', attempt: 1, status: 'success' },
    says: [/build\/plan:/, /success/, /попытка 1/, /токенов/],
  },
  {
    event: { ...BASE, kind: 'step.stalled', job: 'build', step: 'plan', silent_ms: 300_000 },
    says: [/build\/plan:/, /тишина 300с/],
  },
  {
    event: { ...BASE, kind: 'iteration.started', job: 'build', iteration: 2 },
    says: [/build:/, /итерация 2/, /начата/],
  },
  {
    event: { ...BASE, kind: 'iteration.finished', job: 'build', iteration: 2, passed: false, reason: 'verify' },
    says: [/build:/, /итерация 2/, /не пройдена/, /verify/],
  },
  {
    event: {
      ...BASE,
      kind: 'expect.failed',
      job: 'build',
      step: 'plan',
      attempt: 3,
      predicate: 'exit_code',
      detail: 'ожидался 0, получен 1',
    },
    says: [/build\/plan:/, /exit_code/, /попытка 3/, /получен 1/],
  },
  {
    event: {
      ...BASE,
      kind: 'budget.warning',
      scope: 'пайплайн',
      dimension: 'tokens',
      used: 900_000,
      limit: 1_000_000,
    },
    says: [/прогон:/, /пайплайн/, /900k/, /1M/],
  },
  {
    event: {
      ...BASE,
      kind: 'budget.exceeded',
      scope: 'пайплайн',
      dimension: 'cost',
      used: 3_500_000,
      limit: 3_000_000,
    },
    says: [/исчерпан/, /\$3\.50/, /\$3\.00/],
  },
  {
    event: {
      ...BASE,
      kind: 'budget.waiting',
      scope: 'пайплайн',
      dimension: 'rate_limit',
      resets_at: 1_700_000_000_000,
      wait_ms: 60_000,
    },
    says: [/сон/, /1m/],
  },
  { event: { ...BASE, kind: 'budget.resumed', actual_ms: 60_050 }, says: [/пробуждение/] },
  {
    event: {
      ...BASE,
      kind: 'backend.refused',
      job: 'build',
      step: 'plan',
      attempt: 1,
      class: 'rate_limit',
      message: 'rate limited',
    },
    says: [/build\/plan:/, /rate_limit/, /rate limited/],
  },
  {
    event: {
      ...BASE,
      kind: 'permission.denied',
      job: 'build',
      step: 'plan',
      attempt: 1,
      tool: 'Bash',
      detail: '{"command":"touch marker.txt"}',
    },
    says: [/build\/plan:/, /отказ в разрешении/, /Bash/, /touch marker\.txt/],
  },
];

const PRINTABLE_EVENTS: readonly Event[] = PRINTABLE.map((item) => item.event);

/** Всё, что лента не печатает: разбор постфактум, а не ход прогона. */
const SILENT_EVENTS: readonly Event[] = [
  { ...BASE, kind: 'env.denied', name: 'GH_TOKEN', pattern: '*_TOKEN', scope: 'jobs.build' },
  { ...BASE, kind: 'context.denied', path: 'секрет.txt', pattern: '*.secret' },
  { ...BASE, kind: 'context.downgraded', job: 'build', step: 'plan', path: 'a.ts', tokens: 10 },
  { ...BASE, kind: 'context.note_truncated', job: 'build', step: 'plan', original_tokens: 900, final_tokens: 400 },
  { ...BASE, kind: 'budget.cost_unreported', job: 'build', step: 'plan', attempt: 1 },
  { ...BASE, kind: 'backend.degraded', backend: 'claude', capability: 'sessions', detail: 'per_step' },
  { ...BASE, kind: 'backend.unparsed', job: 'build', step: 'plan', line: 'не json' },
  { ...BASE, kind: 'step.reused', job: 'build', step: 'plan', source: 'run-1' },
  { ...BASE, kind: 'tree.restored', anchor: 'abc', path: '/tmp/x' },
  { ...BASE, kind: 'workspace.inherited', job: 'build', source: 'plan', via: 'seed' },
  { ...BASE, kind: 'run_dir.carried', path: '/tmp/run', source: 'run-1' },
  { ...BASE, kind: 'bookkeeping.failed', operation: 'снятие якоря', detail: 'бум' },
  { ...BASE, kind: 'resume.note_undelivered', detail: 'адресата нет' },
];

describe('run-progress: рендеринг строк ленты', () => {
  for (const { event, says } of PRINTABLE) {
    it(`печатает строку для ${event.kind} и называет в ней существо события`, () => {
      const rendered = renderProgressLine(event, SOME_USAGE, 0);
      assert.notEqual(rendered, undefined, `${event.kind} должен давать строку`);
      for (const pattern of says) {
        assert.match(rendered ?? '', pattern, `${event.kind}: строка должна содержать ${pattern}`);
      }
    });
  }

  for (const event of SILENT_EVENTS) {
    it(`молчит на ${event.kind}`, () => {
      assert.equal(renderProgressLine(event, ZERO_USAGE, 0), undefined);
    });
  }

  it('строка работы называет её адрес', () => {
    const rendered = renderProgressLine(
      { ...BASE, kind: 'job.started', job: 'implement' },
      ZERO_USAGE,
      0,
    );
    assert.match(rendered ?? '', /implement/);
  });

  it('строка шага называет работу и шаг', () => {
    const rendered = renderProgressLine(
      { ...BASE, kind: 'step.started', job: 'implement', step: 'write-code', attempt: 1 },
      ZERO_USAGE,
      0,
    );
    assert.match(rendered ?? '', /implement\/write-code/);
    assert.match(rendered ?? '', /попытка 1/);
  });

  it('строка исхода шага несёт накопленный расход', () => {
    const usage: UsageSnapshot = { tokens: 42_100, costMicroUsd: 310_000, elapsedMs: 271_000, costUnreportedAttempts: 0 };
    const rendered = renderProgressLine(
      { ...BASE, kind: 'step.finished', job: 'build', step: 'plan', attempt: 1, status: 'success' },
      usage,
      0,
    );
    assert.match(rendered ?? '', /42\.1k/);
    assert.match(rendered ?? '', /\$0\.31/);
  });

  it('несообщённая цена печатается прочерком, а не нулём', () => {
    const usage: UsageSnapshot = { tokens: 100, elapsedMs: 0, costUnreportedAttempts: 1 };
    const rendered = renderProgressLine(
      { ...BASE, kind: 'step.finished', job: 'build', step: 'plan', attempt: 1, status: 'success' },
      usage,
      0,
    );
    assert.match(rendered ?? '', /—/);
    assert.doesNotMatch(rendered ?? '', /\$0\.00/);
  });

  it('прогон называет себя прогоном, а не работой', () => {
    const rendered = renderProgressLine(
      { ...BASE, kind: 'run.started', pipeline: 'demo', run_id: 'r1' },
      ZERO_USAGE,
      0,
    );
    assert.match(rendered ?? '', /^\+0:00:00 {2}прогон:/);
  });

  it('время считается от старта прогона собственным форматом ч:мм:сс', () => {
    assert.equal(formatElapsed(0), '+0:00:00');
    assert.equal(formatElapsed(271_000), '+0:04:31');
    assert.equal(formatElapsed(3_661_000), '+1:01:01');
  });

  it('многострочная раскрашенная деталь предиката сворачивается в одну чистую строку', () => {
    // Ровно то, что кладёт в событие предикат `cmd`: команда, двоеточие,
    // перевод строки и раскрашенный вывод (src/core/expect/evaluate.ts).
    const detail = `npm test:\n${ESC}[31mFAIL${ESC}[39m test/a.test.ts\r\n  ${ESC}[2mожидалось 1${ESC}[22m\n`;
    const rendered =
      renderProgressLine(
        { ...BASE, kind: 'expect.failed', job: 'build', step: 'plan', attempt: 1, predicate: 'cmd', detail },
        ZERO_USAGE,
        0,
      ) ?? '';

    assert.equal(rendered.includes('\n'), false, 'строка ленты не должна содержать перевода строки');
    assert.doesNotMatch(rendered, ANSI_OR_CR);
    assert.match(rendered, /npm test/);
    assert.match(rendered, /FAIL test\/a\.test\.ts/);
  });

  it('длинная деталь обрезается, а не выливается в терминал целиком', () => {
    const rendered =
      renderProgressLine(
        { ...BASE, kind: 'job.errored', job: 'build', detail: 'я'.repeat(5_000) },
        ZERO_USAGE,
        0,
      ) ?? '';

    assert.ok(rendered.length < 400, `строка не должна быть простынёй: ${rendered.length}`);
    assert.match(rendered, /…$/);
  });

  it('раскрашенное сообщение отказа бэкенда приходит в ленту без последовательностей', () => {
    const rendered =
      renderProgressLine(
        {
          ...BASE,
          kind: 'backend.refused',
          job: 'build',
          step: 'plan',
          attempt: 1,
          class: 'unauthenticated',
          message: `${ESC}]0;title${BEL}${ESC}[1mтокен истёк${ESC}[0m`,
        },
        ZERO_USAGE,
        0,
      ) ?? '';

    assert.doesNotMatch(rendered, ANSI_OR_CR);
    assert.match(rendered, /токен истёк/);
    assert.doesNotMatch(rendered, /title/, 'заголовок окна из OSC не должен просачиваться текстом');
  });

  it('величины бюджета печатаются в единицах своего измерения, а не голыми числами', () => {
    const cost = renderProgressLine(
      { ...BASE, kind: 'budget.exceeded', scope: 'прогон', dimension: 'cost', used: 3_500_000, limit: 3_000_000 },
      ZERO_USAGE,
      0,
    );
    assert.match(cost ?? '', /\$3\.50/);
    assert.doesNotMatch(cost ?? '', /3500000/, 'микродоллары не печатаются сырым числом');

    const wallclock = renderProgressLine(
      { ...BASE, kind: 'budget.exceeded', scope: 'прогон', dimension: 'wallclock', used: 3_600_000, limit: 1_800_000 },
      ZERO_USAGE,
      0,
    );
    assert.match(wallclock ?? '', /1h/);
    assert.match(wallclock ?? '', /30m/);

    const rate = renderProgressLine(
      { ...BASE, kind: 'budget.warning', scope: 'прогон', dimension: 'rate_limit', used: 95, limit: 90 },
      ZERO_USAGE,
      0,
    );
    assert.match(rate ?? '', /95% при потолке 90%/);
  });

  it('журнал без измерения бюджета печатается прежней дробью, а не падает', () => {
    const rendered = renderProgressLine(
      { ...BASE, kind: 'budget.exceeded', scope: 'прогон', used: 110, limit: 100 },
      ZERO_USAGE,
      0,
    );
    assert.match(rendered ?? '', /110\/100/);
  });

  it('ни одна строка на всём перечне печатаемых видов не содержит ANSI-последовательностей или \\r', () => {
    for (const event of PRINTABLE_EVENTS) {
      const rendered = renderProgressLine(event, ZERO_USAGE, 0);
      assert.doesNotMatch(rendered ?? '', ANSI_OR_CR, `${event.kind}: строка не должна содержать управляющих символов`);
    }
  });
});

const TWO_AGENT_STEPS = `
version: 1
kind: pipeline
name: расход-растёт
jobs:
  build:
    steps:
      - id: plan
        agent: fake
        prompt: "Сделай план"
        expect: [{ exit_code: 0 }]
      - id: apply
        agent: fake
        prompt: "Сделай дело"
        expect: [{ exit_code: 0 }]
`;

// Сценарий спеки «Расход растёт по ходу прогона»: не только время, но и
// токены с ценой — потеря поля в снимке иначе прошла бы мимо теста.
describe('run-progress: расход в снимке растёт от шага к шагу', () => {
  it('токены и цена во втором исходе шага больше, чем в первом', async () => {
    const project = makeProject({ 'stepcast.yml': TWO_AGENT_STEPS });
    const fake = createFakeBackend({
      lines: [initLine(), resultLine({ text: 'готово', tokensIn: 100, tokensOut: 20, costUsd: 0.25 })],
    });
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
    const snapshots: UsageSnapshot[] = [];

    await runPipeline({
      expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
      config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
      adapterFor: () => fake.adapter,
      onEvent: (event, usage) => {
        if (event.kind === 'step.finished') snapshots.push(usage);
      },
    });

    const [first, second] = snapshots;
    assert.ok(first !== undefined && second !== undefined, 'нужны снимки двух завершившихся шагов');
    assert.ok(first.tokens > 0, `в первом снимке нет токенов: ${first.tokens}`);
    assert.ok(second.tokens > first.tokens, `${second.tokens} должно быть больше ${first.tokens}`);
    assert.ok(first.costMicroUsd !== undefined && second.costMicroUsd !== undefined, 'цена сообщена');
    assert.ok((second.costMicroUsd ?? 0) > (first.costMicroUsd ?? 0));

    // Та же пара снимков в строках ленты: расход виден и после рендеринга.
    const firstLine = renderProgressLine(
      { ...BASE, kind: 'step.finished', job: 'build', step: 'plan', attempt: 1, status: 'success' },
      first,
      0,
    );
    assert.match(firstLine ?? '', /\$0\.25/);
  });
});

/**
 * Работа с одним долгим шагом: пока шаг идёт, о ходе работы говорит только
 * запись самой работы — записи шага на диске ещё нет, она пишется по его
 * завершении целиком.
 */
const SLOW_STEP = `
version: 1
kind: pipeline
name: долгий-шаг
jobs:
  build:
    steps:
      - id: slow
        run: [${JSON.stringify(process.execPath)}, '-e', 'setTimeout(() => {}, 300)']
        expect: [{ exit_code: 0 }]
`;

// Сценарий спеки «Идущая работа видна снаружи»: витрина и планировщик читают
// состояние с диска, и у работы с одним долгим агентским шагом между её
// началом и первой записью проходят десятки минут.
describe('run-progress: состояние на диске знает об идущей работе', () => {
  it('показывает работу running со started_at, пока её шаг ещё идёт', async () => {
    const project = makeProject({ 'stepcast.yml': SLOW_STEP });
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
    let onStepStart: RunStatus | undefined;

    const result = await runPipeline({
      expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
      config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
      onEvent: (event) => {
        // Момент запуска шага: он ещё не завершился и записи о себе не
        // оставил, а состояние работы обязано быть на диске уже сейчас.
        if (event.kind === 'step.started') onStepStart = readStatus(resolveRun(runsRoot, project.root));
      },
    });

    const job = onStepStart?.jobs.find((item) => item.id === 'build');
    assert.ok(job !== undefined, 'состояние на диске должно знать о работе');
    assert.equal(job.status, 'running');
    assert.ok(job.started_at !== undefined, 'у идущей работы должно быть начало');
    assert.deepEqual(job.steps, [], 'запись шага появляется по его завершении, а не в начале');

    // И тот же прогон доходит до конца: сброс состояния в начале работы не
    // подменяет собой исход.
    assert.equal(result.status, 'success');
    assert.equal(readStatus(result.journal.paths).jobs[0]?.status, 'success');
  });
});

function args(positional: string[] = [], flags: ParsedArgs['flags'] = {}): ParsedArgs {
  return { command: 'run', positional, flags };
}

function capture(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

const ONE_STEP_PIPELINE = `
version: 1
kind: pipeline
name: одна-работа
budget:
  tokens: 1M
jobs:
  build:
    steps:
      - id: compile
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
`;

const TWO_PARALLEL_PIPELINE = `
version: 1
kind: pipeline
name: две-параллельные
concurrency: 2
budget:
  tokens: 1M
jobs:
  первая:
    steps:
      - id: шаг
        run: [sh, -c, 'sleep 0.05']
        expect: [{ exit_code: 0 }]
  вторая:
    steps:
      - id: шаг
        run: [sh, -c, 'sleep 0.05']
        expect: [{ exit_code: 0 }]
`;

describe('run-progress: команда run печатает ход', () => {
  it('ход виден до возврата команды: строки прогона, работы и шага собраны раньше строки итога', async () => {
    const project = makeProject({ 'stepcast.yml': ONE_STEP_PIPELINE });
    const { lines, write } = capture();

    const exitCode = await withHome(project.home, () =>
      runRunCommand(args(['stepcast.yml']), write, project.root),
    );

    assert.equal(exitCode, ExitCode.ok);
    const summaryIndex = lines.findIndex((line) => /^прогон .+: success$/.test(line));
    const jobIndex = lines.findIndex((line) => line.includes('build:'));
    const stepIndex = lines.findIndex((line) => line.includes('build/compile:'));
    assert.ok(summaryIndex >= 0, 'строка итога должна быть в выводе');
    assert.ok(jobIndex >= 0 && jobIndex < summaryIndex, 'строка о работе идёт раньше итога');
    assert.ok(stepIndex >= 0 && stepIndex < summaryIndex, 'строка о шаге идёт раньше итога');
  });

  it('идентификатор и путь к журналу напечатаны первыми строками и годятся для адресации', async () => {
    const project = makeProject({ 'stepcast.yml': ONE_STEP_PIPELINE });
    const { lines, write } = capture();

    await withHome(project.home, () => runRunCommand(args(['stepcast.yml']), write, project.root));

    const runIdLine = lines[0] ?? '';
    const journalLine = lines[1] ?? '';
    assert.match(runIdLine, /^прогон [0-9a-f]+$/);
    assert.match(journalLine, /^журнал: /);

    const shortId = runIdLine.replace('прогон ', '');
    const jobIndex = lines.findIndex((line) => line.includes('build:'));
    assert.ok(jobIndex > 1, 'строки о работе идут после идентификатора и пути к журналу');

    const logs = capture();
    const logsExit = await withHome(project.home, () =>
      runLogsCommand({ command: 'logs', positional: [shortId], flags: {} }, logs.write, project.root),
    );
    assert.equal(logsExit, ExitCode.ok);
    assert.ok(logs.lines.some((line) => line.includes('"kind":"run.started"')));
  });

  it('перемешанный поток двух параллельных работ читается по адресам', async () => {
    const project = makeProject({ 'stepcast.yml': TWO_PARALLEL_PIPELINE });
    const { lines, write } = capture();

    const exitCode = await withHome(project.home, () =>
      runRunCommand(args(['stepcast.yml']), write, project.root),
    );

    assert.equal(exitCode, ExitCode.ok);
    for (const job of ['первая', 'вторая']) {
      assert.ok(
        lines.some((line) => line.includes(`${job}:`) || line.includes(`${job}/шаг:`)),
        `строка работы ${job} должна быть различима по адресу`,
      );
    }
  });

  it('--quiet подавляет ход, но сохраняет итог, статус, путь к журналу и код возврата', async () => {
    const project = makeProject({ 'stepcast.yml': ONE_STEP_PIPELINE });
    const loud = capture();
    const quiet = capture();

    const loudExit = await withHome(project.home, () =>
      runRunCommand(args(['stepcast.yml']), loud.write, project.root),
    );
    const quietExit = await withHome(project.home, () =>
      runRunCommand(args(['stepcast.yml'], { quiet: true }), quiet.write, project.root),
    );

    assert.equal(quietExit, loudExit);
    assert.equal(quiet.lines.some((line) => line.includes('build:')), false, 'строк о работе быть не должно');
    assert.equal(quiet.lines.some((line) => line.includes('build/compile:')), false, 'строк о шаге быть не должно');
    assert.ok(quiet.lines.some((line) => /^прогон .+: success$/.test(line)), 'итог остаётся');
    assert.ok(quiet.lines.some((line) => /^журнал: /.test(line)), 'путь к журналу остаётся');
  });
});
