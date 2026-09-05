import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runStatusCommand } from '../src/cli/commands/status.js';
import { describeRefusal } from '../src/core/backend/types.js';
import { writeLaneMerge } from '../src/core/lanes/mergeRecord.js';
import type { ParsedArgs } from '../src/cli/args.js';
import { makeJournalBed, seedRun, withHome } from './helpers.js';

function args(flags: ParsedArgs['flags'] = {}): ParsedArgs {
  return { command: 'status', positional: [], flags };
}

function capture(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

describe('CLI: stepcast status', () => {
  // Спека stepcast-configuration: «Денежный расход и объявленный потолок»
  it('печатает потраченное и объявленный денежный потолок рядом с токенами', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, {
      budget: {
        tokens_used: 1000,
        tokens_limit: 5000,
        cost_used_usd: 2.5,
        cost_limit_usd: 10,
        wallclock_ms: 60_000,
      },
    });

    const { lines, write } = capture();
    withHome(home, () => runStatusCommand(args({ run: journal.paths.runId }), write, projectRoot));

    const text = lines.join('\n');
    assert.match(text, /\$2\.50 из \$10\.00/);
  });

  it('без объявленного потолка печатает прочерк вместо величины', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, {
      budget: { tokens_used: 0, wallclock_ms: 0 },
    });

    const { lines, write } = capture();
    withHome(home, () => runStatusCommand(args({ run: journal.paths.runId }), write, projectRoot));

    const text = lines.join('\n');
    assert.match(text, /\$0\.0000 из —/);
  });

  it('называет число попыток без сообщённой цены', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, {
      budget: {
        tokens_used: 100,
        wallclock_ms: 1000,
        cost_used_usd: 0,
        cost_limit_usd: 5,
        cost_unreported_attempts: 3,
      },
    });

    const { lines, write } = capture();
    withHome(home, () => runStatusCommand(args({ run: journal.paths.runId }), write, projectRoot));

    const text = lines.join('\n');
    assert.match(text, /3 попыток без сообщённой цены/);
  });

  // Requirement «Неустранимый отказ бэкенда виден без чтения лога шага»
  // (pipeline-execution/spec.md): причина остановки и сообщение бэкенда
  // видны в выводе команды напрямую, без отсылки к stdout.log.
  it('называет отказ аутентификации бэкенда и способ починки, не отсылая к stdout.log', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    const message = 'Failed to authenticate: OAuth session expired and could not be refreshed';
    // Причина берётся тем же кодом, что пишет её движок: выдуманный текст
    // проверял бы вывод по данным, которых на диске не бывает.
    const reason = describeRefusal({ class: 'unauthenticated', message });
    const journal = seedRun(runsRoot, projectRoot, {
      status: 'failed',
      jobs: [
        {
          id: 'build',
          status: 'failed',
          cause: 'backend_unauthenticated',
          reason,
          steps: [
            {
              id: 'plan',
              index: 1,
              kind: 'agent',
              key: 'k',
              status: 'failed',
              reason,
              attempts: [
                {
                  attempt: 1,
                  status: 'failed',
                  reason,
                  started_at: '2026-08-01T00:00:00.000Z',
                  finished_at: '2026-08-01T00:00:01.000Z',
                },
              ],
            },
          ],
        },
      ],
    });

    const { lines, write } = capture();
    withHome(home, () => runStatusCommand(args({ run: journal.paths.runId }), write, projectRoot));

    const text = lines.join('\n');
    assert.match(text, /отказ аутентификации бэкенда/);
    assert.match(text, /Failed to authenticate: OAuth session expired/);
    assert.match(text, /возобновите прогон командой stepcast resume/);
    assert.doesNotMatch(text, /stdout\.log/);
  });
});

describe('CLI: stepcast status — перейдённый потолок', () => {
  // Спека run-journal: «Причина остановки читается из состояния»
  it('называет область, измерение и адрес шага, на которых потолок сработал впервые', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, {
      status: 'budget_exceeded',
      budget: {
        tokens_used: 50,
        tokens_limit: 45,
        wallclock_ms: 1000,
        exceeded: {
          scope: 'пайплайн',
          dimension: 'tokens',
          used: 50,
          limit: 45,
          at: '2026-09-05T00:00:00.000Z',
          job: 'plan',
          step: 'p',
        },
      },
    });

    const { lines, write } = capture();
    withHome(home, () => runStatusCommand(args({ run: journal.paths.runId }), write, projectRoot));

    const text = lines.join('\n');
    assert.match(text, /потолок перейдён: пайплайн: передано .* при потолке .* \(plan\/p\)/);
  });
});

describe('CLI: stepcast status — исход сведения дорожек', () => {
  // Спека lane-merge: «Исход сведения дорожек читается из состояния прогона»
  // — различает по выводу прогон со сведённой дорожкой и прогон, где до
  // сведения дело не дошло, читая только каталог прогона, не git log.
  it('прогон budget_exceeded со сведённой дорожкой называет исход, слаг и коммиты', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, {
      status: 'budget_exceeded',
      jobs: [
        {
          id: 'work-a',
          status: 'success',
          lane: 'a',
          steps: [],
        },
      ],
    });
    writeLaneMerge(journal.paths.dir, {
      lane: 'a',
      kind: 'merged',
      slug: 'a-item',
      repos: ['.'],
      commits: { '.': 'deadbeef' },
      at: '2026-09-05T00:00:00.000Z',
    });

    const { lines, write } = capture();
    withHome(home, () => runStatusCommand(args({ run: journal.paths.runId }), write, projectRoot));

    const text = lines.join('\n');
    assert.match(text, /бюджет исчерпан/);
    assert.match(text, /дорожка a: сведена, пункт «a-item».*deadbeef/);
  });

  it('называет дорожку с записанным исходом, даже когда работ этой дорожки в состоянии нет', () => {
    // Запись пишет посторонний процесс (`merge-lanes`), и умолчать о
    // записанном исходе оттого, что состояние про дорожку не знает, значило бы
    // потерять ровно тот факт, ради которого запись заведена.
    const { runsRoot, projectRoot, home } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, {
      status: 'budget_exceeded',
      jobs: [{ id: 'work-a', status: 'success', lane: 'a', steps: [] }],
    });
    writeLaneMerge(journal.paths.dir, {
      lane: 'z',
      kind: 'not_reached',
      reason: 'обход прекращён на дорожке a',
      at: '2026-09-05T00:00:00.000Z',
    });

    const { lines, write } = capture();
    withHome(home, () => runStatusCommand(args({ run: journal.paths.runId }), write, projectRoot));

    const text = lines.join('\n');
    assert.match(text, /дорожка a: сведение не выполнялось/);
    assert.match(text, /дорожка z: не сведена, не пробована/);
  });

  it('прогон budget_exceeded без записи сведения называет дорожку как несведённую, не читая git', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, {
      status: 'budget_exceeded',
      jobs: [
        {
          id: 'work-b',
          status: 'budget_exceeded',
          lane: 'b',
          steps: [],
        },
      ],
    });

    const { lines, write } = capture();
    withHome(home, () => runStatusCommand(args({ run: journal.paths.runId }), write, projectRoot));

    const text = lines.join('\n');
    assert.match(text, /бюджет исчерпан/);
    assert.match(text, /дорожка b: сведение не выполнялось/);
  });
});
