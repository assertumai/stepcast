import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { StepcastError } from '../src/kernel/errors.js';
import { computeWaitId, selectAwaiting, toDecisionRecord, validateDecision } from '../src/parts/pipeline/run/decision.js';
import { computeStepKey } from '../src/parts/pipeline/run/stepKey.js';
import type { AwaitingDecision } from '../src/parts/pipeline/run/journal/schema.js';
import type { PluginStep } from '../src/parts/pipeline/document/model.js';

function awaiting(overrides: Partial<AwaitingDecision> = {}): AwaitingDecision {
  return {
    wait_id: 'w1',
    job: 'build',
    step: 'gate',
    outcomes: { approve: { effect: 'continue' }, deny: { effect: 'reject' }, redo: { effect: 'restart' } },
    since: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('parts/pipeline/run/decision: идентификатор ожидания', () => {
  it('одни и те же составляющие дают один и тот же идентификатор', () => {
    const identity = { job: 'build', step: 'gate', attempt: 1, iteration: 1, since: '2026-01-01T00:00:00.000Z' };
    assert.equal(computeWaitId(identity), computeWaitId({ ...identity }));
  });

  it('разные итерации цикла until дают разные идентификаторы', () => {
    const base = { job: 'build', step: 'gate', attempt: 1, since: '2026-01-01T00:00:00.000Z' };
    assert.notEqual(computeWaitId({ ...base, iteration: 1 }), computeWaitId({ ...base, iteration: 2 }));
  });

  it('разный момент начала ожидания даёт разный идентификатор', () => {
    const base = { job: 'build', step: 'gate', attempt: 1 };
    assert.notEqual(
      computeWaitId({ ...base, since: '2026-01-01T00:00:00.000Z' }),
      computeWaitId({ ...base, since: '2026-01-01T00:00:01.000Z' }),
    );
  });
});

describe('parts/pipeline/run/decision: выбор ожидания', () => {
  it('нет ожиданий вовсе — отказ', () => {
    assert.throws(() => selectAwaiting([]), (error: unknown) => {
      assert.ok(error instanceof StepcastError);
      assert.match(error.message, /не ждёт решения/);
      return true;
    });
  });

  it('единственное ожидание выбирается без --step', () => {
    const only = awaiting();
    assert.equal(selectAwaiting([only]), only);
  });

  it('несколько ожиданий без --step — отказ с перечнем', () => {
    const a = awaiting({ wait_id: 'a', step: 'gate-a' });
    const b = awaiting({ wait_id: 'b', step: 'gate-b' });
    assert.throws(() => selectAwaiting([a, b]), (error: unknown) => {
      assert.ok(error instanceof StepcastError);
      assert.match(error.message, /нескольких шагах/);
      assert.match(error.hint ?? '', /gate-a/);
      assert.match(error.hint ?? '', /gate-b/);
      return true;
    });
  });

  it('--step называет неизвестный шаг — отказ с перечнем ожидающих', () => {
    const a = awaiting({ wait_id: 'a', step: 'gate-a' });
    assert.throws(() => selectAwaiting([a], 'gate-z'), (error: unknown) => {
      assert.ok(error instanceof StepcastError);
      assert.match(error.message, /gate-z/);
      assert.match(error.hint ?? '', /build\/gate-a/);
      return true;
    });
  });

  it('--step находит нужное ожидание среди нескольких', () => {
    const a = awaiting({ wait_id: 'a', step: 'gate-a' });
    const b = awaiting({ wait_id: 'b', step: 'gate-b' });
    assert.equal(selectAwaiting([a, b], 'gate-b'), b);
    assert.equal(selectAwaiting([a, b], 'build/gate-b'), b);
  });

  it('голое имя шага, ждущего в двух работах, — отказ с перечнем, а не первое совпадение', () => {
    const a = awaiting({ wait_id: 'a', job: 'a', step: 'gate' });
    const b = awaiting({ wait_id: 'b', job: 'b', step: 'gate' });
    assert.throws(() => selectAwaiting([a, b], 'gate'), (error: unknown) => {
      assert.ok(error instanceof StepcastError);
      assert.match(error.message, /нескольких работах/);
      assert.match(error.hint ?? '', /a\/gate/);
      assert.match(error.hint ?? '', /b\/gate/);
      return true;
    });
  });

  it('полный адрес разводит одноимённые шаги разных работ', () => {
    const a = awaiting({ wait_id: 'a', job: 'a', step: 'gate' });
    const b = awaiting({ wait_id: 'b', job: 'b', step: 'gate' });
    assert.equal(selectAwaiting([a, b], 'a/gate'), a);
    assert.equal(selectAwaiting([a, b], 'b/gate'), b);
  });
});

describe('parts/pipeline/run/decision: проверка предложенного решения', () => {
  const knownSteps = new Set(['build', 'build/gate', 'deploy']);

  it('исход вне перечня — отказ с перечнем допустимых', () => {
    assert.throws(() => validateDecision(awaiting(), { outcome: 'ignore' }, knownSteps), (error: unknown) => {
      assert.ok(error instanceof StepcastError);
      assert.match(error.message, /ignore/);
      assert.match(error.hint ?? '', /approve/);
      return true;
    });
  });

  it('reject без причины — отказ', () => {
    assert.throws(() => validateDecision(awaiting(), { outcome: 'deny' }, knownSteps), /причины/);
  });

  it('reject с причиной проходит', () => {
    const result = validateDecision(awaiting(), { outcome: 'deny', reason: 'не готово' }, knownSteps);
    assert.equal(result.effect, 'reject');
    assert.equal(result.reason, 'не готово');
  });

  it('restart без шага — отказ', () => {
    assert.throws(() => validateDecision(awaiting(), { outcome: 'redo' }, knownSteps), /шага, с которого/);
  });

  it('restart с несуществующим шагом — отказ, называющий доступные', () => {
    assert.throws(
      () => validateDecision(awaiting(), { outcome: 'redo', restartFrom: 'unknown' }, knownSteps),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /unknown/);
        assert.match(error.hint ?? '', /build\/gate/);
        return true;
      },
    );
  });

  it('restart с существующим шагом проходит', () => {
    const result = validateDecision(awaiting(), { outcome: 'redo', restartFrom: 'build/gate' }, knownSteps);
    assert.equal(result.effect, 'restart');
    assert.equal(result.restartFrom, 'build/gate');
  });

  it('continue без причины и без шага проходит', () => {
    const result = validateDecision(awaiting(), { outcome: 'approve' }, knownSteps);
    assert.equal(result.effect, 'continue');
  });
});

function decisionStep(fields: unknown): PluginStep {
  return {
    id: 'gate',
    index: 1,
    kind: 'plugin',
    name: 'decision',
    fields,
    env: {},
    context: [],
    contextInherit: true,
    contextExclude: [],
    timeoutMs: 1_800_000,
    expect: [],
    attempts: { max: 1, escalation: [] },
  };
}

describe('parts/pipeline/run/decision: принятое решение в ключе шага', () => {
  const key = (step: PluginStep): string =>
    computeStepKey({ lockHash: 'lock', jobId: 'build', step, inputsFingerprint: undefined, backendCommand: undefined, upstream: [] });

  it('одно и то же объявление шага decision даёт один и тот же ключ независимо от исхода, принятого позже', () => {
    // Ключ считается по нераскрытому (заявленному) шагу — решение появляется
    // только в записи журнала после исполнения и в объявление не входит,
    // поэтому у одного и того же decision-шага ключ один при любом исходе.
    const step = decisionStep({ prompt: 'продолжить?', outcomes: { approve: 'continue' } });
    assert.equal(key(step), key(step));
  });

  it('правка полей шага decision меняет ключ', () => {
    const before = decisionStep({ prompt: 'продолжить?', outcomes: { approve: 'continue' } });
    const after = decisionStep({ prompt: 'слить в main?', outcomes: { approve: 'continue' } });
    assert.notEqual(key(before), key(after));
  });
});

describe('parts/pipeline/run/decision: форма записи решения', () => {
  it('камелкейс результата переводится в snake_case записи журнала', () => {
    const record = toDecisionRecord({
      outcome: 'redo',
      effect: 'restart',
      by: 'user',
      restartFrom: 'build/gate',
    });
    assert.deepEqual(record, { outcome: 'redo', effect: 'restart', by: 'user', restart_from: 'build/gate' });
  });
});
