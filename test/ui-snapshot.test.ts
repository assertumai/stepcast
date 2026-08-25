import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { buildSnapshot } from '../src/ui/snapshot.js';
import { cleanupRun } from '../src/core/run/cleanup.js';
import { projectKey } from '../src/core/journal/paths.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { serializeLock } from '../src/core/pipeline/lock.js';
import type { RunStatus } from '../src/core/journal/schema.js';
import { makeJournalBed, makeProject, seedRun } from './helpers.js';

const PIPELINE = `
version: 1
kind: pipeline
name: витрина

defaults:
  agent: claude

jobs:
  producer:
    description: Публикует выход
    output:
      from: think
    steps:
      - id: think
        agent: claude
        prompt: "подумай"

  consumer:
    needs: [producer]
    steps:
      - id: check
        run: [echo, ok]
        expect: [{ exit_code: 0 }]

  later:
    needs: [consumer]
    steps:
      - id: never
        run: [echo, поздно]
        expect: [{ exit_code: 0 }]
`;

/** Лок, записанный тем же сериализатором, что пишет движок при прогоне. */
function lockText(): string {
  const project = makeProject({ 'stepcast.yml': PIPELINE });
  return serializeLock(
    expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }).pipeline,
  );
}

const JOBS: RunStatus['jobs'] = [
  {
    id: 'producer',
    status: 'success',
    steps: [
      {
        id: 'think',
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
          },
        ],
      },
    ],
  },
  {
    id: 'consumer',
    status: 'success',
    steps: [
      {
        id: 'check',
        index: 1,
        kind: 'run',
        key: 'k2',
        status: 'success',
        attempts: [
          {
            attempt: 1,
            status: 'success',
            started_at: '2026-08-01T00:01:00.000Z',
            finished_at: '2026-08-01T00:02:00.000Z',
          },
        ],
      },
    ],
  },
  { id: 'later', status: 'pending', steps: [] },
];

function seed() {
  const bed = makeJournalBed();
  const journal = seedRun(bed.runsRoot, bed.projectRoot, {
    runId: 'run-a',
    jobs: JOBS,
    lock: lockText(),
    artifacts: { producer: { факт: 'выход работы producer' } },
    usage: {
      run_id: 'run-a',
      total: { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, billable_tokens: 300, wallclock_ms: 120_000 },
      unreported: [],
      jobs: {
        producer: {
          billable_tokens: 300,
          wallclock_ms: 60_000,
          steps: { think: { billable_tokens: 300, wallclock_ms: 60_000, attempts: [{ attempt: 1, backend: 'claude', billable_tokens: 300, wallclock_ms: 60_000 }] } },
        },
      },
    },
  });
  return { bed, journal, key: projectKey(bed.projectRoot) };
}

describe('ui-dashboard: детальный снимок прогона', () => {
  // Сценарий: «Выход предшественника виден как вход зависимой работы»
  it('показывает выход предшественника входом зависимой работы', () => {
    const { journal, key } = seed();
    const snapshot = buildSnapshot(journal.paths, key);

    const consumer = snapshot.jobs.find((job) => job.id === 'consumer');
    assert.equal(consumer?.inputs.length, 1);
    assert.equal(consumer?.inputs[0]?.path, 'artifacts/producer.json');
    assert.ok((consumer?.inputs[0]?.bytes ?? 0) > 0);
  });

  it('показывает опубликованный выход работы', () => {
    const { journal, key } = seed();
    const producer = buildSnapshot(journal.paths, key).jobs.find((job) => job.id === 'producer');

    assert.equal(producer?.outputDeclared, true);
    assert.equal(producer?.output?.path, 'artifacts/producer.json');
  });

  // Сценарий: «Работа без объявленного output»
  it('не выдумывает выход работе, которая его не объявляет', () => {
    const { journal, key } = seed();
    const consumer = buildSnapshot(journal.paths, key).jobs.find((job) => job.id === 'consumer');

    assert.equal(consumer?.outputDeclared, false);
    assert.equal(consumer?.output, undefined);
  });

  // Сценарий: «Работа, которая ещё не исполнялась»
  it('показывает определение работы, которая ещё не исполнялась', () => {
    const { journal, key } = seed();
    const later = buildSnapshot(journal.paths, key).jobs.find((job) => job.id === 'later');

    assert.equal(later?.status, 'pending');
    assert.deepEqual(later?.needs, ['consumer']);
    assert.equal(later?.steps.length, 1, 'шаг виден из лока, хотя не исполнялся');
    assert.equal(later?.steps[0]?.id, 'never');
    assert.equal(later?.output, undefined);
  });

  it('различает агентский и командный шаг и показывает промпт и команду', () => {
    const { journal, key } = seed();
    const snapshot = buildSnapshot(journal.paths, key);

    const think = snapshot.jobs.find((job) => job.id === 'producer')?.steps[0];
    assert.equal(think?.kind, 'agent');
    assert.equal(think?.prompt, 'подумай');

    const check = snapshot.jobs.find((job) => job.id === 'consumer')?.steps[0];
    assert.equal(check?.kind, 'run');
    assert.equal(check?.command, 'echo ok');
  });

  // Сценарий: «Разрез контекста агентского шага»
  it('разбирает context.json агентского шага по четырём уровням', () => {
    const { journal, key } = seed();
    const dir = journal.prepareStep('producer', 1, 'think');
    journal.writeContextReport(dir, {
      entries: [
        { origin: 'upstream', kind: 'path', path: 'artifacts/producer.json', mode: 'inline', tokens: 10 },
        { origin: 'pipeline', kind: 'text', mode: 'inline', tokens: 20 },
        { origin: 'job', kind: 'text', mode: 'inline', tokens: 30 },
        { origin: 'step', kind: 'text', mode: 'inline', tokens: 40 },
      ],
      total_tokens: 100,
    });

    const think = buildSnapshot(journal.paths, key).jobs.find((j) => j.id === 'producer')?.steps[0];

    assert.deepEqual(think?.contextBreakdown?.levels, {
      upstream: 10,
      pipeline: 20,
      job: 30,
      step: 40,
    });
    assert.equal(think?.contextBreakdown?.total, 100);
  });

  it('перечисляет файлы шага относительными путями', () => {
    const { journal, key } = seed();
    const dir = journal.prepareStep('consumer', 1, 'check');
    journal.writeStepFile(dir, 'stdout.log', 'ok\n');

    const check = buildSnapshot(journal.paths, key).jobs.find((j) => j.id === 'consumer')?.steps[0];
    const log = check?.files.find((file) => file.name === 'stdout.log');

    assert.ok(log !== undefined);
    assert.equal(log.path, 'jobs/consumer/steps/01-check/stdout.log');
    assert.ok(!log.path.startsWith('/'), 'абсолютные пути наружу не отдаются');
  });

  // Сценарий: «Раскрытие убранного прогона»
  it('строит снимок убранного прогона с признаком, а не падает', () => {
    const { journal, key } = seed();
    cleanupRun(journal.paths);

    const snapshot = buildSnapshot(journal.paths, key);

    assert.equal(snapshot.swept, true);
    assert.equal(snapshot.status, 'success');
    // Лок убран вместе с остальным, но состояние помнит работы прогона.
    assert.deepEqual(
      snapshot.jobs.map((job) => job.id).sort(),
      ['consumer', 'later', 'producer'],
    );
    assert.deepEqual(snapshot.jobs.flatMap((job) => job.inputs), []);
  });

  it('переживает лок, испорченный после записи', () => {
    const { journal, key } = seed();
    writeFileSync(journal.paths.lock, ':\n  - не[ yaml');

    const snapshot = buildSnapshot(journal.paths, key);
    assert.ok(snapshot.jobs.length > 0, 'работы берутся из состояния, когда лок не читается');
  });

  it('не считает неубранный прогон убранным', () => {
    const { journal, key } = seed();
    journal.prepareJob('producer');
    assert.equal(buildSnapshot(journal.paths, key).swept, false);
    assert.ok(join(journal.paths.jobs, 'producer').length > 0);
  });

  // Сценарий: «Расход работы и шага»
  it('отдаёт расход работы и шага из сводки', () => {
    const { journal, key } = seed();
    const producer = buildSnapshot(journal.paths, key).jobs.find((job) => job.id === 'producer');

    assert.deepEqual(producer?.usage, { billableTokens: 300, wallclockMs: 60_000 });
    assert.deepEqual(producer?.steps[0]?.usage, { billableTokens: 300, wallclockMs: 60_000 });

    const consumer = buildSnapshot(journal.paths, key).jobs.find((job) => job.id === 'consumer');
    assert.deepEqual(consumer?.usage, { billableTokens: null, wallclockMs: null });
  });

  // Сценарий: «Расход убранного прогона»
  it('снимок убранного прогона по-прежнему содержит расход', () => {
    const { journal, key } = seed();
    cleanupRun(journal.paths);

    const producer = buildSnapshot(journal.paths, key).jobs.find((job) => job.id === 'producer');
    assert.deepEqual(producer?.usage, { billableTokens: 300, wallclockMs: 60_000 });
  });

  // Сценарий: «Прогон без записанной сводки»
  it('снимок идущего прогона без сводки не падает', () => {
    const bed = makeJournalBed();
    const journal = seedRun(bed.runsRoot, bed.projectRoot, {
      runId: 'run-going',
      status: 'running',
      jobs: JOBS,
      lock: lockText(),
      skipUsage: true,
    });

    const snapshot = buildSnapshot(journal.paths, projectKey(bed.projectRoot));
    const producer = snapshot.jobs.find((job) => job.id === 'producer');
    assert.deepEqual(producer?.usage, { billableTokens: null, wallclockMs: null });
  });
});
