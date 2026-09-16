import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { describe, it } from 'node:test';

import { runPaths } from '../src/parts/pipeline/run/journal/paths.js';
import { atomicWrite } from '../src/parts/pipeline/run/journal/writer.js';
import { decisionRecordPath } from '../src/parts/pipeline/run/journal/paths.js';
import type { AwaitingDecision } from '../src/parts/pipeline/run/journal/schema.js';
import { waitForDecision } from '../src/parts/pipeline/run/decisionWait.js';
import { tempDir } from './tmp.js';

function paths() {
  const runsRoot = tempDir('runs-');
  return runPaths(runsRoot, 'project', 'run-1');
}

function awaiting(overrides: Partial<AwaitingDecision> = {}): AwaitingDecision {
  return {
    wait_id: 'w1',
    job: 'build',
    step: 'gate',
    outcomes: { approve: { effect: 'continue' }, deny: { effect: 'reject' }, redo: { effect: 'restart' } },
    since: new Date().toISOString(),
    ...overrides,
  };
}

describe('parts/pipeline/run/decisionWait: опрос каталога решений', () => {
  it('решение, лежавшее на диске до начала ожидания, применяется первым же тактом', async () => {
    const p = paths();
    mkdirSync(p.decisions, { recursive: true });
    atomicWrite(decisionRecordPath(p, 'w1'), JSON.stringify({ outcome: 'approve' }));

    const started = Date.now();
    const outcome = await waitForDecision({
      paths: p,
      waitId: 'w1',
      awaiting: awaiting(),
      knownSteps: new Set(['build', 'build/gate']),
      onRefused: () => assert.fail('решение с диска не должно отвергаться'),
      pollIntervalMs: 10_000,
    });

    assert.ok(Date.now() - started < 1000, 'не ждало полного интервала опроса');
    assert.deepEqual(outcome, { kind: 'decided', decision: { outcome: 'approve', effect: 'continue' }, by: 'user' });
  });

  it('истёкший срок даёт объявленный исход по истечении', async () => {
    const p = paths();
    const outcome = await waitForDecision({
      paths: p,
      waitId: 'w2',
      awaiting: awaiting({ wait_id: 'w2', deadline: new Date(Date.now() - 1).toISOString(), on_expire: 'approve' }),
      knownSteps: new Set(['build', 'build/gate']),
      onRefused: () => assert.fail('срок не должен отвергаться'),
      pollIntervalMs: 10_000,
    });

    assert.deepEqual(outcome, { kind: 'decided', decision: { outcome: 'approve', effect: 'continue' }, by: 'deadline' });
  });

  it('истёкший срок с исходом reject несёт причину, названную самим сроком', async () => {
    const p = paths();
    const deadline = new Date(Date.now() - 1).toISOString();
    const outcome = await waitForDecision({
      paths: p,
      waitId: 'w2r',
      awaiting: awaiting({ wait_id: 'w2r', deadline, on_expire: 'deny' }),
      knownSteps: new Set(['build', 'build/gate']),
      onRefused: (detail) => assert.fail(`срок не должен отвергаться: ${detail}`),
      pollIntervalMs: 10_000,
    });

    assert.equal(outcome.kind, 'decided');
    if (outcome.kind !== 'decided') return;
    assert.equal(outcome.by, 'deadline');
    assert.equal(outcome.decision.effect, 'reject');
    // Причина у отклонения обязательна — и у решения человека, и у срока:
    // иначе прогон останавливался бы текстом с висящим тире вместо причины.
    assert.match(outcome.decision.reason ?? '', /срок ожидания истёк/);
    assert.ok((outcome.decision.reason ?? '').includes(deadline));
  });

  it('негодный исход по истечении отвергается один раз, а ожидание продолжается', async () => {
    const p = paths();
    const refusals: string[] = [];
    const controller = new AbortController();
    const promise = waitForDecision({
      paths: p,
      waitId: 'w2x',
      awaiting: awaiting({
        wait_id: 'w2x',
        outcomes: { redo: { effect: 'restart' } },
        deadline: new Date(Date.now() - 1).toISOString(),
        on_expire: 'redo',
      }),
      knownSteps: new Set(['build', 'build/gate']),
      signal: controller.signal,
      onRefused: (detail) => refusals.push(detail),
      pollIntervalMs: 5,
    });

    await new Promise((resolve) => setTimeout(resolve, 80));
    controller.abort();
    const outcome = await promise;

    assert.equal(outcome.kind, 'canceled', 'ожидание продолжалось, пока его не отменили');
    assert.equal(refusals.length, 1, JSON.stringify(refusals));
    assert.match(refusals[0] as string, /redo/);
  });

  it('запись с исходом вне перечня отвергается событием, ожидание продолжается', async () => {
    const p = paths();
    mkdirSync(p.decisions, { recursive: true });
    atomicWrite(decisionRecordPath(p, 'w3'), JSON.stringify({ outcome: 'nope' }));

    let refused: string | undefined;
    const controller = new AbortController();
    const promise = waitForDecision({
      paths: p,
      waitId: 'w3',
      awaiting: awaiting({ wait_id: 'w3' }),
      knownSteps: new Set(['build', 'build/gate']),
      signal: controller.signal,
      onRefused: (detail) => {
        refused = detail;
        controller.abort();
      },
      pollIntervalMs: 5,
    });

    const outcome = await promise;
    assert.equal(outcome.kind, 'canceled');
    assert.match(refused ?? '', /nope/);
  });

  it('негодная запись отвергается один раз, а не каждым тактом опроса', async () => {
    const p = paths();
    mkdirSync(p.decisions, { recursive: true });
    atomicWrite(decisionRecordPath(p, 'w3s'), JSON.stringify({ outcome: 'nope' }));

    const refusals: string[] = [];
    const controller = new AbortController();
    const promise = waitForDecision({
      paths: p,
      waitId: 'w3s',
      awaiting: awaiting({ wait_id: 'w3s' }),
      knownSteps: new Set(['build', 'build/gate']),
      signal: controller.signal,
      onRefused: (detail) => refusals.push(detail),
      pollIntervalMs: 5,
    });

    // Полтора десятка тактов опроса по одной и той же негодной записи: событие
    // об отказе обязано быть одно, иначе ожидание длиной в часы раздувало бы
    // events.jsonl отказом в секунду.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(refusals.length, 1, JSON.stringify(refusals));

    // Исправленная запись рассматривается заново, а не считается уже
    // отвергнутой: сравнивается текст записи, а не сам факт отказа.
    atomicWrite(decisionRecordPath(p, 'w3s'), JSON.stringify({ outcome: 'approve' }));
    const outcome = await promise;
    controller.abort();
    assert.deepEqual(outcome, { kind: 'decided', decision: { outcome: 'approve', effect: 'continue' }, by: 'user' });
  });

  it('перенесённое решение применяется первым тактом и снимается после применения', async () => {
    const p = paths();
    let applied = 0;
    const outcome = await waitForDecision({
      paths: p,
      waitId: 'w5',
      awaiting: awaiting({ wait_id: 'w5' }),
      knownSteps: new Set(['build', 'build/gate']),
      onRefused: (detail) => assert.fail(`перенесённое решение не должно отвергаться: ${detail}`),
      pollIntervalMs: 10_000,
      carried: { record: { outcome: 'approve' }, source: 'abc123', onApplied: () => (applied += 1) },
    });

    assert.deepEqual(outcome, { kind: 'decided', decision: { outcome: 'approve', effect: 'continue' }, by: 'user' });
    assert.equal(applied, 1, 'перенос снимается ровно один раз');
  });

  it('негодное перенесённое решение отвергается, и ожидание продолжается', async () => {
    const p = paths();
    const refusals: string[] = [];
    const controller = new AbortController();
    const promise = waitForDecision({
      paths: p,
      waitId: 'w6',
      awaiting: awaiting({ wait_id: 'w6' }),
      knownSteps: new Set(['build', 'build/gate']),
      signal: controller.signal,
      onRefused: (detail) => refusals.push(detail),
      pollIntervalMs: 5,
      carried: { record: { outcome: 'nope' }, source: 'abc123', onApplied: () => undefined },
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    controller.abort();
    const outcome = await promise;

    assert.equal(outcome.kind, 'canceled');
    assert.equal(refusals.length, 1, JSON.stringify(refusals));
    assert.match(refusals[0] as string, /abc123/);
  });

  it('сигнал отмены снимает ожидание немедленно, не дожидаясь такта опроса', async () => {
    const p = paths();
    const controller = new AbortController();
    const promise = waitForDecision({
      paths: p,
      waitId: 'w4',
      awaiting: awaiting({ wait_id: 'w4' }),
      knownSteps: new Set(['build', 'build/gate']),
      signal: controller.signal,
      onRefused: () => assert.fail('нечего отвергать'),
      pollIntervalMs: 10_000,
    });

    const started = Date.now();
    controller.abort();
    const outcome = await promise;
    assert.ok(Date.now() - started < 1000);
    assert.deepEqual(outcome, { kind: 'canceled' });
  });
});
