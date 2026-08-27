import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { runUsageCommand } from '../src/cli/commands/usage.js';
import { runGcCommand } from '../src/cli/commands/gc.js';
import type { ParsedArgs } from '../src/cli/args.js';
import type { RunStatus, UsageReport } from '../src/core/journal/schema.js';
import { makeJournalBed, seedRun, withHome } from './helpers.js';

function args(positional: string[] = [], flags: ParsedArgs['flags'] = {}): ParsedArgs {
  return { command: 'usage', positional, flags };
}

function capture(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

/**
 * Ячейка названного столбца в строке, начинающейся с `rowPrefix`.
 *
 * Столбцы выровнены `formatColumns` по левому краю и одинаковой ширины во всех
 * строках, поэтому смещение столбца берётся из шапки. Без такой привязки
 * проверка вида «в выводе есть прочерк» проходит и на прочерке из соседнего
 * столбца — и молчит, когда в проверяемом напечатан ноль.
 */
function cell(lines: readonly string[], rowPrefix: string, column: string): string {
  const header = lines.find((line) => line.includes('бэкенд'));
  assert.ok(header !== undefined, 'шапка таблицы не найдена');
  const start = header.indexOf(column);
  assert.ok(start >= 0, `столбец «${column}» не найден в шапке`);
  const rest = header.slice(start + column.length);
  // Последний столбец тянется до конца строки; у прочих граница — начало следующего.
  const end =
    rest.trim() === '' ? undefined : start + column.length + (rest.length - rest.trimStart().length);
  const row = lines.find((line) => line.startsWith(rowPrefix));
  assert.ok(row !== undefined, `строка «${rowPrefix}» не найдена`);
  // Строка обрезана справа (`trimEnd`), поэтому конец столбца может выйти за её длину.
  return row.slice(start, end).trim();
}

const RETRIED_STEP: RunStatus['jobs'] = [
  {
    id: 'implement',
    status: 'success',
    steps: [
      {
        id: 'write-code',
        index: 1,
        kind: 'agent',
        key: 'k1',
        status: 'success',
        attempts: [
          {
            attempt: 1,
            status: 'failed',
            started_at: '2026-08-01T00:00:00.000Z',
            finished_at: '2026-08-01T00:01:00.000Z',
            usage: {
              backend: 'claude',
              model: 'sonnet',
              tokens_in: 100,
              tokens_out: 50,
              cache_read: 0,
              cache_write: 0,
              wallclock_ms: 60_000,
            },
          },
          {
            attempt: 2,
            status: 'success',
            started_at: '2026-08-01T00:01:00.000Z',
            finished_at: '2026-08-01T00:02:30.000Z',
            usage: {
              backend: 'claude',
              model: 'opus',
              tokens_in: 200,
              tokens_out: 80,
              cache_read: 0,
              cache_write: 0,
              wallclock_ms: 90_000,
              reported_cost_usd: 0.42,
            },
          },
        ],
      },
    ],
  },
];

const RETRIED_SUMMARY = (runId: string): UsageReport => ({
  run_id: runId,
  total: { tokens_in: 300, tokens_out: 130, cache_read: 0, cache_write: 0, billable_tokens: 430, wallclock_ms: 150_000 },
  unreported: [],
  jobs: {
    implement: {
      billable_tokens: 430,
      wallclock_ms: 150_000,
      steps: {
        'write-code': {
          billable_tokens: 430,
          wallclock_ms: 150_000,
          attempts: [
            { attempt: 1, backend: 'claude', model: 'sonnet', billable_tokens: 150, wallclock_ms: 60_000 },
            { attempt: 2, backend: 'claude', model: 'opus', billable_tokens: 280, wallclock_ms: 90_000 },
          ],
        },
      },
    },
  },
});

describe('CLI: stepcast usage', () => {
  // Сценарий: «Шаги, проходящие не с первой попытки»
  it('показывает обе попытки шага с их номерами, моделями и стоимостью', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, {
      jobs: RETRIED_STEP,
      usage: RETRIED_SUMMARY('r'),
    });

    const { lines, write } = capture();
    withHome(home, () => runUsageCommand(args([journal.paths.runId]), write, projectRoot));

    const text = lines.join('\n');
    assert.match(text, /#1/);
    assert.match(text, /#2/);
    assert.match(text, /sonnet/);
    assert.match(text, /opus/);
    assert.match(text, /\$0\.4200/);
  });

  // Сценарий: «Распределение моделей по работам»
  it('называет модель каждой попытки в строке попытки', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    const jobs: RunStatus['jobs'] = [
      {
        id: 'a',
        status: 'success',
        steps: [
          {
            id: 's',
            index: 1,
            kind: 'agent',
            key: 'k',
            status: 'success',
            attempts: [
              {
                attempt: 1,
                status: 'success',
                started_at: '2026-08-01T00:00:00.000Z',
                finished_at: '2026-08-01T00:00:30.000Z',
                usage: {
                  backend: 'claude',
                  model: 'haiku',
                  tokens_in: 10,
                  tokens_out: 5,
                  cache_read: 0,
                  cache_write: 0,
                  wallclock_ms: 30_000,
                },
              },
            ],
          },
        ],
      },
      {
        id: 'b',
        status: 'success',
        steps: [
          {
            id: 's',
            index: 1,
            kind: 'agent',
            key: 'k',
            status: 'success',
            attempts: [
              {
                attempt: 1,
                status: 'success',
                started_at: '2026-08-01T00:00:00.000Z',
                finished_at: '2026-08-01T00:00:30.000Z',
                usage: {
                  backend: 'claude',
                  model: 'opus',
                  tokens_in: 10,
                  tokens_out: 5,
                  cache_read: 0,
                  cache_write: 0,
                  wallclock_ms: 30_000,
                },
              },
            ],
          },
        ],
      },
    ];
    const journal = seedRun(runsRoot, projectRoot, { jobs });

    const { lines, write } = capture();
    withHome(home, () => runUsageCommand(args([journal.paths.runId]), write, projectRoot));

    const text = lines.join('\n');
    assert.match(text, /haiku/);
    assert.match(text, /opus/);
  });

  // Сценарий: «Неполный учёт помечен»
  it('печатает несообщённое измерение прочерком и перечисляет его в неполноте', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    const jobs: RunStatus['jobs'] = [
      {
        id: 'a',
        status: 'success',
        steps: [
          {
            id: 's',
            index: 1,
            kind: 'agent',
            key: 'k',
            status: 'success',
            attempts: [
              {
                attempt: 1,
                status: 'success',
                started_at: '2026-08-01T00:00:00.000Z',
                finished_at: '2026-08-01T00:00:30.000Z',
                usage: {
                  backend: 'codex',
                  tokens_in: 10,
                  tokens_out: null,
                  cache_read: 0,
                  cache_write: 0,
                  wallclock_ms: 30_000,
                },
              },
            ],
          },
        ],
      },
    ];
    const journal = seedRun(runsRoot, projectRoot, {
      jobs,
      usage: {
        run_id: 'r',
        total: { tokens_in: 10, tokens_out: 0, cache_read: 0, cache_write: 0, billable_tokens: 10, wallclock_ms: 30_000 },
        unreported: ['tokens_out'],
        jobs: {
          a: {
            billable_tokens: 10,
            wallclock_ms: 30_000,
            steps: { s: { billable_tokens: 10, wallclock_ms: 30_000, attempts: [{ attempt: 1, backend: 'codex', billable_tokens: 10, wallclock_ms: 30_000 }] } },
          },
        },
      },
    });

    const { lines, write } = capture();
    withHome(home, () => runUsageCommand(args([journal.paths.runId]), write, projectRoot));

    const text = lines.join('\n');
    assert.match(text, /—/);
    assert.match(text, /не сообщено.*tokens_out/);
  });

  // Сценарий: «Отчёт по убранному прогону»
  it('строится по прогону, убранному gc, и содержит разбивку по работам, шагам и попыткам', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, {
      jobs: RETRIED_STEP,
      usage: RETRIED_SUMMARY('r'),
      artifacts: { implement: { ok: true } },
      lock: 'version: 1\n',
    });

    withHome(home, () => runGcCommand({ command: 'gc', positional: [], flags: { 'older-than': '0s' } }, () => {}, projectRoot));

    const { lines, write } = capture();
    withHome(home, () => runUsageCommand(args([journal.paths.runId]), write, projectRoot));

    const text = lines.join('\n');
    assert.match(text, /implement/);
    assert.match(text, /write-code/);
    assert.match(text, /#1/);
    assert.match(text, /#2/);
  });

  // Сценарий: «Отчёт по идущему прогону»
  it('без usage.json строится по status.json и помечает агрегат неподведённым', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, {
      status: 'running',
      jobs: RETRIED_STEP,
      skipUsage: true,
    });

    const { lines, write } = capture();
    withHome(home, () => runUsageCommand(args([journal.paths.runId]), write, projectRoot));

    const text = lines.join('\n');
    assert.match(text, /ещё не записана/);
    assert.match(text, /#1/);
  });

  it('usage.json, не проходящий схему, не роняет команду и помечается непрочитанным', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, { jobs: RETRIED_STEP });
    writeFileSync(journal.paths.usage, JSON.stringify({ жанр: 'не сводка' }));

    const { lines, write } = capture();
    withHome(home, () => runUsageCommand(args([journal.paths.runId]), write, projectRoot));

    const text = lines.join('\n');
    assert.match(text, /не прочитана/);
  });

  // Спека stepcast-configuration: «Денежный столбец на всех уровнях»
  it('печатает денежный столбец у работы, шага и прогона из сводки', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    const summary: UsageReport = {
      ...RETRIED_SUMMARY('r'),
      total: { ...RETRIED_SUMMARY('r').total, cost_usd: 0.42 },
      jobs: {
        implement: {
          billable_tokens: 430,
          wallclock_ms: 150_000,
          cost_usd: 0.42,
          steps: {
            'write-code': {
              billable_tokens: 430,
              wallclock_ms: 150_000,
              cost_usd: 0.42,
              attempts: [
                { attempt: 1, backend: 'claude', model: 'sonnet', billable_tokens: 150, wallclock_ms: 60_000 },
                { attempt: 2, backend: 'claude', model: 'opus', billable_tokens: 280, wallclock_ms: 90_000, cost_usd: 0.42 },
              ],
            },
          },
        },
      },
    };
    const journal = seedRun(runsRoot, projectRoot, { jobs: RETRIED_STEP, usage: summary });

    const { lines, write } = capture();
    withHome(home, () => runUsageCommand(args([journal.paths.runId]), write, projectRoot));

    const text = lines.join('\n');
    // Заголовок отчёта, строка работы и строка шага — три отдельных «$0.42».
    assert.equal((text.match(/\$0\.4200/g) ?? []).length >= 3, true, text);
  });

  it('называет число попыток без цены отдельной строкой', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, {
      jobs: RETRIED_STEP,
      usage: RETRIED_SUMMARY('r'),
      budget: { tokens_used: 430, wallclock_ms: 150_000, cost_used_usd: 0, cost_unreported_attempts: 2 },
    });

    const { lines, write } = capture();
    withHome(home, () => runUsageCommand(args([journal.paths.runId]), write, projectRoot));

    const text = lines.join('\n');
    assert.match(text, /2 попытки без сообщённой цены/);
  });

  // Спека run-journal: «Пик виден рядом с трафиком»
  it('печатает столбец пика в строке шага и попытки', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    const jobs: RunStatus['jobs'] = [
      {
        id: 'implement',
        status: 'success',
        steps: [
          {
            id: 'write-code',
            index: 1,
            kind: 'agent',
            key: 'k1',
            status: 'success',
            attempts: [
              {
                attempt: 1,
                status: 'success',
                started_at: '2026-08-01T00:00:00.000Z',
                finished_at: '2026-08-01T00:01:00.000Z',
                usage: {
                  backend: 'claude',
                  model: 'sonnet',
                  tokens_in: 5_000_000,
                  tokens_out: 100,
                  cache_read: 4_900_000,
                  cache_write: 0,
                  wallclock_ms: 60_000,
                  peak_prefix_tokens: 340_000,
                },
              },
            ],
          },
        ],
      },
    ];
    const summary: UsageReport = {
      run_id: 'r',
      total: { tokens_in: 5_000_000, tokens_out: 100, cache_read: 4_900_000, cache_write: 0, billable_tokens: 5_000_100, wallclock_ms: 60_000 },
      unreported: [],
      jobs: {
        implement: {
          billable_tokens: 5_000_100,
          wallclock_ms: 60_000,
          steps: {
            'write-code': {
              billable_tokens: 5_000_100,
              wallclock_ms: 60_000,
              peak_prefix_tokens: 340_000,
              attempts: [{ attempt: 1, backend: 'claude', model: 'sonnet', billable_tokens: 5_000_100, wallclock_ms: 60_000, peak_prefix_tokens: 340_000 }],
            },
          },
        },
      },
    };
    const journal = seedRun(runsRoot, projectRoot, { jobs, usage: summary });

    const { lines, write } = capture();
    withHome(home, () => runUsageCommand(args([journal.paths.runId]), write, projectRoot));

    // Пик и трафик расходятся на порядок — оба должны быть видны в отчёте.
    assert.equal(cell(lines, '    write-code', 'пик'), '340k');
    assert.equal(cell(lines, '      #1', 'пик'), '340k');
    assert.equal(cell(lines, '    write-code', 'списано'), '5.0M');
  });

  // Пик попытки в сводке уже с максимумом по вызванному шагом судье
  // (`runner.ts` складывает расход шага и судьи через `sumUsage`), а в
  // status.json попытки лежит пик одного агента. Строка шага берёт максимум по
  // попыткам из сводки — строка попытки обязана брать оттуда же, иначе шаг
  // покажет пик больше, чем любая его попытка.
  it('пик строки попытки берётся из сводки, а не из агентского пика status.json', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    const summary = RETRIED_SUMMARY('r');
    const step = summary.jobs.implement?.steps['write-code'];
    assert.ok(step !== undefined);
    const withPeak: UsageReport = {
      ...summary,
      jobs: {
        implement: {
          ...summary.jobs.implement!,
          steps: {
            'write-code': {
              ...step,
              peak_prefix_tokens: 900,
              attempts: step.attempts.map((attempt) => ({ ...attempt, peak_prefix_tokens: 900 })),
            },
          },
        },
      },
    };
    // В status.json обеих попыток пик агента меньше судейского.
    const jobs: RunStatus['jobs'] = RETRIED_STEP.map((job) => ({
      ...job,
      steps: job.steps.map((step_) => ({
        ...step_,
        attempts: step_.attempts.map((attempt) => ({
          ...attempt,
          usage: attempt.usage === undefined ? undefined : { ...attempt.usage, peak_prefix_tokens: 120 },
        })),
      })),
    })) as RunStatus['jobs'];
    const journal = seedRun(runsRoot, projectRoot, { jobs, usage: withPeak });

    const { lines, write } = capture();
    withHome(home, () => runUsageCommand(args([journal.paths.runId]), write, projectRoot));

    assert.equal(cell(lines, '      #1', 'пик'), '900');
    assert.equal(cell(lines, '      #2', 'пик'), '900');
    assert.equal(cell(lines, '    write-code', 'пик'), '900');
  });

  it('без сводки пик попытки берётся из status.json — он переживает gc', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    const jobs = RETRIED_STEP.map((job) => ({
      ...job,
      steps: job.steps.map((step_) => ({
        ...step_,
        attempts: step_.attempts.map((attempt) => ({
          ...attempt,
          usage: attempt.usage === undefined ? undefined : { ...attempt.usage, peak_prefix_tokens: 120 },
        })),
      })),
    })) as RunStatus['jobs'];
    const journal = seedRun(runsRoot, projectRoot, { jobs });

    const { lines, write } = capture();
    withHome(home, () => runUsageCommand(args([journal.paths.runId]), write, projectRoot));

    assert.equal(cell(lines, '      #1', 'пик'), '120');
  });

  it('пик неизвестен в сводке прежней формы — прочерк, не ноль', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, { jobs: RETRIED_STEP });
    // Форма до появления пика: поле в сводке отсутствует вовсе.
    writeFileSync(
      journal.paths.usage,
      JSON.stringify({
        run_id: journal.paths.runId,
        total: { tokens_in: 300, tokens_out: 130, cache_read: 0, cache_write: 0, billable_tokens: 430, wallclock_ms: 150_000 },
        unreported: [],
        jobs: {
          implement: {
            billable_tokens: 430,
            wallclock_ms: 150_000,
            steps: {
              'write-code': {
                billable_tokens: 430,
                wallclock_ms: 150_000,
                attempts: [
                  { attempt: 1, backend: 'claude', model: 'sonnet', billable_tokens: 150, wallclock_ms: 60_000 },
                  { attempt: 2, backend: 'claude', model: 'opus', billable_tokens: 280, wallclock_ms: 90_000 },
                ],
              },
            },
          },
        },
      }),
    );

    const { lines, write } = capture();
    withHome(home, () => runUsageCommand(args([journal.paths.runId]), write, projectRoot));

    const text = lines.join('\n');
    assert.doesNotMatch(text, /не прочитана/, 'сводка прежней формы обязана читаться');
    // Именно в столбце пика, а не где-нибудь в строке: прочерк есть и в
    // денежном столбце обеих попыток, и проверка по всему тексту прошла бы
    // даже на напечатанном нуле.
    assert.equal(cell(lines, '    write-code', 'пик'), '—', 'пик неизвестной сводки — прочерк');
    assert.equal(cell(lines, '      #1', 'пик'), '—');
  });

  it('число ячеек в строке попытки без расхода совпадает с числом столбцов у попытки с расходом', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    const jobs: RunStatus['jobs'] = [
      {
        id: 'a',
        status: 'running',
        steps: [
          {
            id: 's',
            index: 1,
            kind: 'agent',
            key: 'k',
            status: 'running',
            attempts: [
              // Попытка без расхода (#1, ещё не завершилась) и попытка с
              // расходом (#2) должны давать строки одинаковой ширины.
              { attempt: 1, status: 'running', started_at: '2026-08-01T00:00:00.000Z', finished_at: '' },
              {
                attempt: 2,
                status: 'success',
                started_at: '2026-08-01T00:00:00.000Z',
                finished_at: '2026-08-01T00:00:30.000Z',
                usage: {
                  backend: 'claude',
                  model: 'sonnet',
                  tokens_in: 10,
                  tokens_out: 5,
                  cache_read: 0,
                  cache_write: 0,
                  wallclock_ms: 30_000,
                },
              },
            ],
          },
        ],
      },
    ];
    const journal = seedRun(runsRoot, projectRoot, { status: 'running', jobs, skipUsage: true });

    const { lines, write } = capture();
    withHome(home, () => runUsageCommand(args([journal.paths.runId]), write, projectRoot));

    const attemptWithoutUsage = lines.find((line) => line.includes('#1'));
    const attemptWithUsage = lines.find((line) => line.includes('#2'));
    assert.ok(attemptWithoutUsage !== undefined && attemptWithUsage !== undefined);
    // Оба начинаются с непустого имени попытки, поэтому разделение по
    // пробельным разрывам честно считает число ячеек в каждой строке.
    const cellCount = (line: string): number => line.trim().split(/\s{2,}/).length;
    assert.equal(cellCount(attemptWithoutUsage!), cellCount(attemptWithUsage!));
  });

  // Сценарий: «Сводка прежней формы»
  it('сводка прежней формы читается: числовое attempts не обесценивает прогон', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, { jobs: RETRIED_STEP });
    // Форма до разбивки по попыткам: `attempts` — счётчик, а не список.
    writeFileSync(
      journal.paths.usage,
      JSON.stringify({
        run_id: journal.paths.runId,
        total: {
          tokens_in: 1,
          tokens_out: 2,
          cache_read: 3,
          cache_write: 4,
          billable_tokens: 430,
          wallclock_ms: 150_000,
        },
        unreported: [],
        jobs: {
          implement: {
            billable_tokens: 430,
            wallclock_ms: 150_000,
            steps: { 'write-code': { billable_tokens: 430, wallclock_ms: 150_000, attempts: 2 } },
          },
        },
      }),
    );

    const { lines, write } = capture();
    withHome(home, () => runUsageCommand(args([journal.paths.runId]), write, projectRoot));

    const text = lines.join('\n');
    assert.doesNotMatch(text, /не прочитана/, 'прежняя форма обязана читаться');
    assert.match(text, /430/, 'агрегаты старой сводки показываются');
  });

  // Спека pipeline-lanes: «Группировка расхода по дорожкам»
  const LANE_JOB = (id: string, lane: string | undefined): RunStatus['jobs'][number] => ({
    id,
    status: 'success',
    ...(lane === undefined ? {} : { lane }),
    steps: [
      {
        id: 'c',
        index: 1,
        kind: 'run',
        key: `k-${id}`,
        status: 'success',
        attempts: [
          {
            attempt: 1,
            status: 'success',
            started_at: '2026-08-01T00:00:00.000Z',
            finished_at: '2026-08-01T00:00:10.000Z',
          },
        ],
      },
    ],
  });

  it('печатает строку итога дорожки над работами, входящими в неё', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, {
      jobs: [LANE_JOB('propose', 'a'), LANE_JOB('plan', 'a')],
      usage: {
        run_id: 'r',
        total: { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, billable_tokens: 300, wallclock_ms: 30_000 },
        unreported: [],
        jobs: {
          propose: { billable_tokens: 100, wallclock_ms: 10_000, cost_usd: 0.1, steps: {} },
          plan: { billable_tokens: 200, wallclock_ms: 20_000, cost_usd: 0.2, steps: {} },
        },
      },
    });

    const { lines, write } = capture();
    withHome(home, () => runUsageCommand(args([journal.paths.runId]), write, projectRoot));

    assert.equal(cell(lines, 'a', 'списано'), '300');
    assert.equal(cell(lines, 'a', 'время'), '30s');
    // Строка итога стоит раньше первой работы дорожки.
    const laneIndex = lines.findIndex((line) => line.startsWith('a'));
    const jobIndex = lines.findIndex((line) => line.startsWith('  propose'));
    assert.ok(laneIndex >= 0 && jobIndex > laneIndex);
  });

  it('помечает несообщённую величину в итоге дорожки прочерком, а не нулём', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, {
      jobs: [LANE_JOB('propose', 'a'), LANE_JOB('plan', 'a')],
      usage: {
        run_id: 'r',
        total: { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, billable_tokens: 300, wallclock_ms: 30_000 },
        unreported: [],
        jobs: {
          propose: { billable_tokens: 100, wallclock_ms: 10_000, cost_usd: 0.1, steps: {} },
          plan: { billable_tokens: 200, wallclock_ms: 20_000, steps: {} },
        },
      },
    });

    const { lines, write } = capture();
    withHome(home, () => runUsageCommand(args([journal.paths.runId]), write, projectRoot));

    assert.equal(cell(lines, 'a', 'цена'), '—');
  });

  it('прогон без объявленных дорожек печатается без группировки', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, { jobs: [LANE_JOB('build', undefined)] });

    const { lines, write } = capture();
    withHome(home, () => runUsageCommand(args([journal.paths.runId]), write, projectRoot));

    assert.equal(lines.some((line) => line.startsWith('build')), false);
    assert.ok(lines.some((line) => line.startsWith('  build')));
  });
});
