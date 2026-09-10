import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
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
    started_at: '2026-08-01T00:00:00.000Z',
    finished_at: '2026-08-01T00:01:30.000Z',
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
    started_at: '2026-08-01T00:01:30.000Z',
    finished_at: '2026-08-01T00:02:00.000Z',
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

  it('показывает путь и раннер шага script', () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: витрина-script
jobs:
  build:
    steps:
      - id: cleanup
        script: cleanup.sh
`,
    });
    project.write('.stepcast/scripts/cleanup.sh', '#!/bin/sh\nexit 0\n');
    const lock = serializeLock(
      expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }).pipeline,
    );

    const bed = makeJournalBed();
    const journal = seedRun(bed.runsRoot, bed.projectRoot, {
      runId: 'run-script',
      lock,
      jobs: [
        {
          id: 'build',
          status: 'success',
          steps: [{ id: 'cleanup', index: 1, kind: 'script', key: 'k1', status: 'success', attempts: [] }],
        },
      ],
    });

    const snapshot = buildSnapshot(journal.paths, projectKey(bed.projectRoot));
    const step = snapshot.jobs.find((job) => job.id === 'build')?.steps[0];
    assert.equal(step?.kind, 'script');
    assert.equal(step?.scriptPath, 'cleanup.sh');
    assert.equal(step?.scriptRunner, 'sh');
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

  // Сценарий: «Длительность работы и шага видна на идущем прогоне». Времена
  // берутся из состояния, а не из сводки расхода: сводка пишется по концу
  // прогона, и на идущем её просто нет.
  it('несёт времена работы и её шага', () => {
    const { journal, key } = seed();
    const producer = buildSnapshot(journal.paths, key).jobs.find((job) => job.id === 'producer');

    assert.equal(producer?.startedAt, '2026-08-01T00:00:00.000Z');
    assert.equal(producer?.finishedAt, '2026-08-01T00:01:30.000Z');
    // У шага собственных времён нет — отрезок собирается по его попыткам.
    assert.equal(producer?.steps[0]?.startedAt, '2026-08-01T00:00:00.000Z');
    assert.equal(producer?.steps[0]?.finishedAt, '2026-08-01T00:01:00.000Z');
  });

  it('у идущей работы есть начало и нет конца', () => {
    const bed = makeJournalBed();
    const journal = seedRun(bed.runsRoot, bed.projectRoot, {
      runId: 'run-live',
      status: 'running',
      jobs: [
        { id: 'producer', status: 'running', started_at: '2026-08-01T00:00:00.000Z', steps: [] },
      ],
      lock: lockText(),
      skipUsage: true,
    });

    const producer = buildSnapshot(journal.paths, projectKey(bed.projectRoot)).jobs.find(
      (job) => job.id === 'producer',
    );

    assert.equal(producer?.status, 'running');
    assert.equal(producer?.startedAt, '2026-08-01T00:00:00.000Z');
    assert.equal(producer?.finishedAt, undefined, 'конца у идущей работы быть не должно');
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

  it('несёт объявленные дорожку и группу сессий у работы', () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: витрина-раскладки

jobs:
  первая:
    lane: a
    session_group: build
    steps:
      - id: один
        agent: claude
        prompt: "промпт"

  вторая:
    needs: [первая]
    steps:
      - id: два
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
`,
    });
    const lockText = serializeLock(
      expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }).pipeline,
    );

    const bed = makeJournalBed();
    const journal = seedRun(bed.runsRoot, bed.projectRoot, {
      runId: 'run-layout',
      jobs: [
        { id: 'первая', status: 'success', steps: [] },
        { id: 'вторая', status: 'pending', steps: [] },
      ],
      lock: lockText,
      skipUsage: true,
    });

    const snapshot = buildSnapshot(journal.paths, projectKey(bed.projectRoot));
    const first = snapshot.jobs.find((job) => job.id === 'первая');
    const second = snapshot.jobs.find((job) => job.id === 'вторая');

    assert.equal(first?.lane, 'a');
    assert.equal(first?.sessionGroup, 'build');
    assert.equal(second?.lane, undefined);
    assert.equal(second?.sessionGroup, undefined);
  });

  it('прогон без pipeline.lock.yml раскрывается без дорожки и группы, а не отказывает', () => {
    const { journal, key } = seed();
    cleanupRun(journal.paths);

    const snapshot = buildSnapshot(journal.paths, key);
    for (const job of snapshot.jobs) {
      assert.equal(job.lane, undefined);
      assert.equal(job.sessionGroup, undefined);
    }
  });

  it('не считает неубранный прогон убранным', () => {
    const { journal, key } = seed();
    journal.prepareJob('producer');
    assert.equal(buildSnapshot(journal.paths, key).swept, false);
    assert.ok(join(journal.paths.jobs, 'producer').length > 0);
  });

  // Сценарий: «Страница нечитаемого прогона»
  it('снимок прогона с нечитаемым состоянием несёт диагноз вместо пустых полей', () => {
    const { journal, key } = seed();
    writeFileSync(journal.paths.status, '{ "run_id": "x",');

    const snapshot = buildSnapshot(journal.paths, key);

    assert.equal(snapshot.pipeline, '');
    assert.equal(snapshot.status, undefined);
    assert.equal(snapshot.problem?.kind, 'malformed');
    assert.equal(snapshot.problem?.file, 'status.json');
  });

  /**
   * Найдено ревью: беда `run.json` — тот самый случай с незнакомым полем, —
   * названная в строке обзора, обязана объясняться и на странице прогона:
   * иначе перешедший за подробностями не находит их.
   */
  it('снимок несёт диагноз манифеста, а не только состояния', () => {
    const { journal, key } = seed();

    const raw = JSON.parse(readFileSync(journal.paths.manifest, 'utf8')) as Record<string, unknown>;
    raw.bogus_field = 'x';
    writeFileSync(journal.paths.manifest, `${JSON.stringify(raw, null, 2)}\n`);

    const snapshot = buildSnapshot(journal.paths, key);

    assert.equal(snapshot.problem?.kind, 'version-skew');
    assert.equal(snapshot.problem?.file, 'run.json');
    assert.match(snapshot.problem?.detail ?? '', /bogus_field/);
  });

  // Сценарий: «Расход работы и шага»
  it('отдаёт расход работы и шага из сводки', () => {
    const { journal, key } = seed();
    const producer = buildSnapshot(journal.paths, key).jobs.find((job) => job.id === 'producer');

    assert.deepEqual(producer?.usage, { billableTokens: 300, wallclockMs: 60_000, costUsd: null });
    assert.deepEqual(producer?.steps[0]?.usage, { billableTokens: 300, wallclockMs: 60_000, costUsd: null });

    const consumer = buildSnapshot(journal.paths, key).jobs.find((job) => job.id === 'consumer');
    assert.deepEqual(consumer?.usage, { billableTokens: null, wallclockMs: null, costUsd: null });
  });

  // Сценарий: «Расход работы и шага до конца прогона» (usage-live-progress)
  it('показывает расход работы и шага идущего прогона из незаконченной сводки', () => {
    const bed = makeJournalBed();
    const journal = seedRun(bed.runsRoot, bed.projectRoot, {
      runId: 'run-live',
      status: 'running',
      jobs: JOBS,
      lock: lockText(),
      usage: {
        run_id: 'run-live',
        partial: true,
        total: { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, billable_tokens: 300, wallclock_ms: 60_000 },
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

    const snapshot = buildSnapshot(journal.paths, projectKey(bed.projectRoot));
    const producer = snapshot.jobs.find((job) => job.id === 'producer');

    // Прогон идёт, а расход завершившейся работы и её шага уже показан —
    // прочерк на этом месте и был бедой, ради которой сводка пишется по ходу.
    assert.deepEqual(producer?.usage, { billableTokens: 300, wallclockMs: 60_000, costUsd: null });
    assert.deepEqual(producer?.steps[0]?.usage, { billableTokens: 300, wallclockMs: 60_000, costUsd: null });
    // Работа, которая ещё не исполнялась, остаётся с прочерком, а не с нулём.
    const consumer = snapshot.jobs.find((job) => job.id === 'consumer');
    assert.deepEqual(consumer?.usage, { billableTokens: null, wallclockMs: null, costUsd: null });
  });

  // Сценарий: «Расход убранного прогона»
  it('снимок убранного прогона по-прежнему содержит расход', () => {
    const { journal, key } = seed();
    cleanupRun(journal.paths);

    const producer = buildSnapshot(journal.paths, key).jobs.find((job) => job.id === 'producer');
    assert.deepEqual(producer?.usage, { billableTokens: 300, wallclockMs: 60_000, costUsd: null });
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
    assert.deepEqual(producer?.usage, { billableTokens: null, wallclockMs: null, costUsd: null });
  });
});

describe('ui-dashboard: модель попытки из сводки', () => {
  const PIPELINE_MODEL = `
version: 1
kind: pipeline
name: витрина модели

jobs:
  producer:
    output:
      from: think
    steps:
      - id: think
        agent: claude
        model: opus
        prompt: "подумай"
`;

  function lockTextWithModel(): string {
    const project = makeProject({ 'stepcast.yml': PIPELINE_MODEL });
    return serializeLock(
      expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }).pipeline,
    );
  }

  const JOBS_MODEL: RunStatus['jobs'] = [
    {
      id: 'producer',
      status: 'success',
      started_at: '2026-08-01T00:00:00.000Z',
      finished_at: '2026-08-01T00:02:00.000Z',
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
              status: 'failed',
              started_at: '2026-08-01T00:00:00.000Z',
              finished_at: '2026-08-01T00:01:00.000Z',
            },
            {
              attempt: 2,
              status: 'success',
              started_at: '2026-08-01T00:01:00.000Z',
              finished_at: '2026-08-01T00:02:00.000Z',
            },
          ],
        },
      ],
    },
  ];

  it('несёт модель попытки, взятую из сводки, рядом с объявленной', () => {
    const bed = makeJournalBed();
    const journal = seedRun(bed.runsRoot, bed.projectRoot, {
      runId: 'run-model',
      jobs: [JOBS_MODEL[0]!].map((job) => ({ ...job, steps: [job.steps[0]!] })),
      lock: lockTextWithModel(),
      usage: {
        run_id: 'run-model',
        total: { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, billable_tokens: 300, wallclock_ms: 60_000 },
        unreported: [],
        jobs: {
          producer: {
            billable_tokens: 300,
            wallclock_ms: 60_000,
            steps: {
              think: {
                billable_tokens: 300,
                wallclock_ms: 60_000,
                attempts: [{ attempt: 1, backend: 'claude', model: 'opus', billable_tokens: 300, wallclock_ms: 60_000 }],
              },
            },
          },
        },
      },
    });

    const think = buildSnapshot(journal.paths, projectKey(bed.projectRoot)).jobs.find(
      (job) => job.id === 'producer',
    )?.steps[0];
    assert.equal(think?.model, 'opus');
    assert.deepEqual(think?.attemptModels, [{ attempt: 1, model: 'opus' }]);
  });

  it('эскалация со сменой модели: попытки несут разные модели', () => {
    const bed = makeJournalBed();
    const journal = seedRun(bed.runsRoot, bed.projectRoot, {
      runId: 'run-escalation',
      jobs: JOBS_MODEL,
      lock: lockTextWithModel(),
      usage: {
        run_id: 'run-escalation',
        total: { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, billable_tokens: 600, wallclock_ms: 120_000 },
        unreported: [],
        jobs: {
          producer: {
            billable_tokens: 600,
            wallclock_ms: 120_000,
            steps: {
              think: {
                billable_tokens: 600,
                wallclock_ms: 120_000,
                attempts: [
                  { attempt: 1, backend: 'claude', model: 'opus', billable_tokens: 300, wallclock_ms: 60_000 },
                  { attempt: 2, backend: 'claude', model: 'sonnet', billable_tokens: 300, wallclock_ms: 60_000 },
                ],
              },
            },
          },
        },
      },
    });

    const think = buildSnapshot(journal.paths, projectKey(bed.projectRoot)).jobs.find(
      (job) => job.id === 'producer',
    )?.steps[0];
    // Объявленная модель — из лока, у попыток каждая своя: ступень эскалации
    // сменила модель между первой и второй.
    assert.equal(think?.model, 'opus');
    assert.deepEqual(think?.attemptModels, [
      { attempt: 1, model: 'opus' },
      { attempt: 2, model: 'sonnet' },
    ]);
  });

  it('попытка без назначенной модели не подменяется объявленной', () => {
    const bed = makeJournalBed();
    const journal = seedRun(bed.runsRoot, bed.projectRoot, {
      runId: 'run-no-model',
      jobs: [{ ...JOBS_MODEL[0]!, steps: [JOBS_MODEL[0]!.steps[0]!] }],
      lock: lockTextWithModel(),
      usage: {
        run_id: 'run-no-model',
        total: { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, billable_tokens: 300, wallclock_ms: 60_000 },
        unreported: [],
        jobs: {
          producer: {
            billable_tokens: 300,
            wallclock_ms: 60_000,
            steps: {
              // Бэкенду не передавали --model вовсе: движок не подменяет её
              // объявленной задним числом.
              think: {
                billable_tokens: 300,
                wallclock_ms: 60_000,
                attempts: [{ attempt: 1, backend: 'claude', billable_tokens: 300, wallclock_ms: 60_000 }],
              },
            },
          },
        },
      },
    });

    const think = buildSnapshot(journal.paths, projectKey(bed.projectRoot)).jobs.find(
      (job) => job.id === 'producer',
    )?.steps[0];
    assert.equal(think?.model, 'opus');
    assert.deepEqual(think?.attemptModels, [{ attempt: 1 }]);
  });

  it('прогон без сводки не несёт моделей попыток, но не отказывает', () => {
    const bed = makeJournalBed();
    const journal = seedRun(bed.runsRoot, bed.projectRoot, {
      runId: 'run-no-summary',
      status: 'running',
      jobs: [{ ...JOBS_MODEL[0]!, status: 'running', steps: [JOBS_MODEL[0]!.steps[0]!] }],
      lock: lockTextWithModel(),
      skipUsage: true,
    });

    const think = buildSnapshot(journal.paths, projectKey(bed.projectRoot)).jobs.find(
      (job) => job.id === 'producer',
    )?.steps[0];
    assert.equal(think?.model, 'opus');
    assert.deepEqual(think?.attemptModels, []);
  });

  it('сводка прежней формы (attempts числом) не несёт моделей попыток', () => {
    const bed = makeJournalBed();
    const journal = seedRun(bed.runsRoot, bed.projectRoot, {
      runId: 'run-legacy',
      jobs: [{ ...JOBS_MODEL[0]!, steps: [JOBS_MODEL[0]!.steps[0]!] }],
      lock: lockTextWithModel(),
      usage: {
        run_id: 'run-legacy',
        total: { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, billable_tokens: 300, wallclock_ms: 60_000 },
        unreported: [],
        jobs: {
          producer: {
            billable_tokens: 300,
            wallclock_ms: 60_000,
            // Прежняя форма: число попыток, а не их перечень.
            steps: { think: { billable_tokens: 300, wallclock_ms: 60_000, attempts: 1 } as never },
          },
        },
      },
    });

    const think = buildSnapshot(journal.paths, projectKey(bed.projectRoot)).jobs.find(
      (job) => job.id === 'producer',
    )?.steps[0];
    assert.equal(think?.model, 'opus');
    assert.deepEqual(think?.attemptModels, []);
  });

  it('убранный прогон без лока сохраняет модели исполнявшихся попыток', () => {
    const bed = makeJournalBed();
    const journal = seedRun(bed.runsRoot, bed.projectRoot, {
      runId: 'run-swept',
      jobs: [{ ...JOBS_MODEL[0]!, steps: [JOBS_MODEL[0]!.steps[0]!] }],
      lock: lockTextWithModel(),
      usage: {
        run_id: 'run-swept',
        total: { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, billable_tokens: 300, wallclock_ms: 60_000 },
        unreported: [],
        jobs: {
          producer: {
            billable_tokens: 300,
            wallclock_ms: 60_000,
            steps: {
              think: {
                billable_tokens: 300,
                wallclock_ms: 60_000,
                attempts: [{ attempt: 1, backend: 'claude', model: 'opus', billable_tokens: 300, wallclock_ms: 60_000 }],
              },
            },
          },
        },
      },
    });
    cleanupRun(journal.paths);

    const snapshot = buildSnapshot(journal.paths, projectKey(bed.projectRoot));
    assert.equal(snapshot.swept, true);
    const think = snapshot.jobs.find((job) => job.id === 'producer')?.steps[0];
    // Лок убран вместе с остальным — объявленной модели больше нет, но
    // `usage.json` переживает уборку, и исполнявшаяся модель остаётся видна.
    assert.equal(think?.model, undefined);
    assert.deepEqual(think?.attemptModels, [{ attempt: 1, model: 'opus' }]);
  });
});
