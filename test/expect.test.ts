import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { evaluatePredicates } from '../src/core/expect/evaluate.js';
import { UsageAccumulator, describeExceeded } from '../src/core/budget/accumulator.js';
import { ScarpError } from '../src/core/errors.js';
import type { Predicate } from '../src/core/pipeline/model.js';
import type { Usage } from '../src/core/journal/schema.js';

function workdir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'scarp-expect-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

function run(predicates: readonly Predicate[], overrides: Partial<Parameters<typeof evaluatePredicates>[1]> = {}) {
  return evaluatePredicates(predicates, {
    exitCode: 0,
    text: '',
    structured: undefined,
    cwd: overrides.cwd ?? workdir(),
    env: { PATH: process.env.PATH ?? '' },
    ...overrides,
  });
}

const PLAN_SCHEMA = JSON.stringify({
  type: 'object',
  required: ['tasks'],
  properties: { tasks: { type: 'array', items: { type: 'string' } } },
});

describe('result-contract: предикаты', () => {
  // Сценарий: «Все предикаты вычисляются»
  it('вычисляет все предикаты, даже если первый не прошёл', () => {
    const dir = workdir({ 'есть.txt': 'x' });
    const results = run(
      [
        { kind: 'exit_code', value: 0 },
        { kind: 'file_exists', path: 'нет.txt' },
        { kind: 'file_exists', path: 'есть.txt' },
      ],
      { cwd: dir, exitCode: 2 },
    );

    assert.equal(results.length, 3);
    assert.deepEqual(
      results.map((item) => item.passed),
      [false, false, true],
    );
  });

  // Сценарий: «Шаг без предикатов»
  it('без предикатов проверяет нулевой код возврата', () => {
    assert.equal(run([], { exitCode: 0 })[0]?.passed, true);
    assert.equal(run([], { exitCode: 1 })[0]?.passed, false);
  });

  // Сценарий: «Неожиданный код»
  it('сообщает ожидаемое и фактическое значение кода возврата', () => {
    const [result] = run([{ kind: 'exit_code', value: 0 }], { exitCode: 2 });
    assert.equal(result?.expected, 0);
    assert.equal(result?.actual, 2);
    assert.match(result?.detail ?? '', /2 вместо 0/);
  });

  // Сценарий: «Файл отсутствует»
  it('указывает проверявшийся путь, когда файла нет', () => {
    const [result] = run([{ kind: 'file_exists', path: 'reports/plan.json' }]);
    assert.equal(result?.passed, false);
    assert.match(result?.detail ?? '', /reports\/plan\.json/);
  });

  // Сценарий: «Вывод соответствует схеме»
  it('проверяет структурированный вывод по схеме', () => {
    const dir = workdir({ 'plan.json': PLAN_SCHEMA });
    const passed = run([{ kind: 'schema', path: 'plan.json' }], {
      cwd: dir,
      structured: { tasks: ['a'] },
    });
    assert.equal(passed[0]?.passed, true);
  });

  // Сценарий: «Вывод нарушает схему»
  it('перечисляет нарушения схемы с путями к полям', () => {
    const dir = workdir({ 'plan.json': PLAN_SCHEMA });
    const [result] = run([{ kind: 'schema', path: 'plan.json' }], {
      cwd: dir,
      structured: { tasks: [42] },
    });
    assert.equal(result?.passed, false);
    assert.match(result?.detail ?? '', /tasks\/0/);
  });

  // Сценарий: «Структурированного вывода нет»
  it('не проходит, когда структурированного вывода нет вовсе', () => {
    const dir = workdir({ 'plan.json': PLAN_SCHEMA });
    const [result] = run([{ kind: 'schema', path: 'plan.json' }], { cwd: dir });
    assert.equal(result?.passed, false);
    assert.match(result?.detail ?? '', /не произвёл структурированного вывода/);
  });

  // Сценарии: «Ожидаемая подстрока» и «Запрещённая подстрока»
  it('применяет регулярные выражения к текстовому результату', () => {
    assert.equal(run([{ kind: 'matches', pattern: 'готово' }], { text: 'всё готово' })[0]?.passed, true);
    assert.equal(run([{ kind: 'matches', pattern: '/^ГОТОВО$/i' }], { text: 'готово' })[0]?.passed, true);
    assert.equal(
      run([{ kind: 'not_matches', pattern: 'ошибка' }], { text: 'была ошибка' })[0]?.passed,
      false,
    );
  });

  // Сценарий: «Проверка сборкой»
  it('исполняет внешнюю команду и сохраняет её вывод при отказе', () => {
    const dir = workdir();
    assert.equal(run([{ kind: 'cmd', command: 'true' }], { cwd: dir })[0]?.passed, true);

    const [failed] = run([{ kind: 'cmd', command: 'echo сломалось 1>&2; exit 3' }], { cwd: dir });
    assert.equal(failed?.passed, false);
    assert.match(failed?.detail ?? '', /сломалось/);
  });

  it('нереализованные предикаты дают внятный отказ', () => {
    assert.throws(() => run([{ kind: 'judge', claim: 'хорошо', hard: true }]), ScarpError);
    assert.throws(() => run([{ kind: 'changed_only', globs: ['src/**'] }]), ScarpError);
  });
});

describe('run-journal: расход и бюджет', () => {
  const usageOf = (overrides: Partial<Usage>): Usage => ({
    backend: 'claude',
    tokens_in: 100,
    tokens_out: 50,
    cache_read: 1_000,
    cache_write: 200,
    wallclock_ms: 1_000,
    ...overrides,
  });

  // Сценарий: «Чтение кеша учитывается с весом»
  it('засчитывает чтение кеша с весом, а исходное значение сохраняет', () => {
    const accumulator = new UsageAccumulator(() => 0.1);
    accumulator.record('build', 'compile', 1, usageOf({}));

    // 100 + 50 + 200 + 1000 * 0.1 = 450
    assert.equal(accumulator.runTokens(), 450);
    assert.equal(accumulator.report('r').total.cache_read, 1_000);
  });

  // Сценарий: «Учёт до завершения шага»
  it('обновляет расход нарастающим итогом, не удваивая его', () => {
    const accumulator = new UsageAccumulator(() => 0);
    accumulator.record('build', 'compile', 1, usageOf({ tokens_in: 100, cache_read: 0, cache_write: 0, tokens_out: 0 }));
    accumulator.record('build', 'compile', 1, usageOf({ tokens_in: 300, cache_read: 0, cache_write: 0, tokens_out: 0 }));

    assert.equal(accumulator.runTokens(), 300, 'вторая запись заменяет первую, а не складывается');
  });

  // Сценарий: «Неполный учёт помечен»
  it('помечает измерения, которых бэкенд не сообщил', () => {
    const accumulator = new UsageAccumulator(() => 0.1);
    accumulator.record('build', 'compile', 1, usageOf({ cache_write: null }));
    assert.deepEqual(accumulator.report('r').unreported, ['cache_write']);
  });

  // Сценарий: «Превышение бюджета шага»
  it('связывает тот потолок, который упёрся первым', () => {
    const accumulator = new UsageAccumulator(() => 0);
    accumulator.record('build', 'compile', 1, usageOf({ tokens_in: 900, tokens_out: 0, cache_read: 0, cache_write: 0 }));

    const exceeded = accumulator.check([
      {
        kind: 'step',
        name: 'build/compile',
        jobId: 'build',
        stepId: 'compile',
        budget: { tokens: 500, onExceed: 'stop' },
      },
      { kind: 'run', name: 'пайплайн', budget: { tokens: 100, onExceed: 'stop' } },
    ]);

    assert.equal(exceeded?.scope, 'build/compile', 'ближний потолок проверяется первым');
    assert.match(describeExceeded(exceeded!), /900/);
  });

  it('потолок шага учитывает все его попытки', () => {
    const accumulator = new UsageAccumulator(() => 0);
    const plain = { tokens_out: 0, cache_read: 0, cache_write: 0 };
    accumulator.record('build', 'test', 1, usageOf({ tokens_in: 300, ...plain }));
    accumulator.record('build', 'test', 2, usageOf({ tokens_in: 300, ...plain }));

    const exceeded = accumulator.check([
      {
        kind: 'step',
        name: 'build/test',
        jobId: 'build',
        stepId: 'test',
        budget: { tokens: 500, onExceed: 'stop' },
      },
    ]);
    assert.equal(exceeded?.used, 600, 'иначе повторы обходили бы потолок шага');
  });

  // Сценарий: «Накопление по прогону»
  it('накапливает расход по всему прогону', () => {
    const accumulator = new UsageAccumulator(() => 0);
    const plain = { tokens_out: 0, cache_read: 0, cache_write: 0 };
    accumulator.record('a', 's', 1, usageOf({ tokens_in: 400, ...plain }));
    accumulator.record('b', 's', 1, usageOf({ tokens_in: 400, ...plain }));

    assert.equal(accumulator.runTokens(), 800);
    assert.equal(
      accumulator.check([{ kind: 'run', name: 'пайплайн', budget: { tokens: 700, onExceed: 'stop' } }])?.dimension,
      'tokens',
    );
  });

  it('ловит превышение окна лимитов', () => {
    const accumulator = new UsageAccumulator(() => 0);
    const usage = usageOf({ rate_limits: { seven_day: { used_pct: 85 } } });
    accumulator.record('a', 's', 1, usage);

    const exceeded = accumulator.check(
      [{ kind: 'run', name: 'пайплайн', budget: { rateLimitPct: 80, onExceed: 'stop' } }],
      usage,
    );
    assert.equal(exceeded?.dimension, 'rate_limit');
    assert.match(describeExceeded(exceeded!), /85%/);
  });

  // Сценарий: «Бюджет не объявлен»
  it('без бюджета ничего не ограничивает', () => {
    const accumulator = new UsageAccumulator(() => 0);
    accumulator.record('a', 's', 1, usageOf({}));
    assert.equal(accumulator.check([{ kind: 'run', name: 'пайплайн', budget: undefined }]), undefined);
  });

  // Сценарий: «Агрегация»
  it('собирает сводку по попыткам, шагам, работам и прогону', () => {
    const accumulator = new UsageAccumulator(() => 0);
    const plain = { tokens_out: 0, cache_read: 0, cache_write: 0 };
    accumulator.record('build', 'test', 1, usageOf({ tokens_in: 100, ...plain }));
    accumulator.record('build', 'test', 2, usageOf({ tokens_in: 150, ...plain }));

    const report = accumulator.report('r1');
    assert.equal(report.total.billable_tokens, 250);
    assert.equal(report.jobs.build?.steps.test?.attempts, 2);
    assert.equal(report.jobs.build?.steps.test?.billable_tokens, 250);
  });
});
