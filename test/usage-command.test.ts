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
});
