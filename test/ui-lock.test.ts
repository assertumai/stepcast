import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { readLockJobs } from '../src/core/pipeline/lockRead.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { serializeLock } from '../src/core/pipeline/lock.js';
import { makeProject } from './helpers.js';
import { tempDir } from './tmp.js';

const PIPELINE = `
version: 1
kind: pipeline
name: витрина

context:
  - text: "контекст пайплайна"

defaults:
  agent: claude

jobs:
  producer:
    description: Публикует выход
    output:
      from: think
    context:
      - text: "контекст работы"
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
`;

/** Лок, записанный тем же сериализатором, что пишет его движок при прогоне. */
function lockFile(): string {
  const project = makeProject({ 'stepcast.yml': PIPELINE });
  const expanded = expandPipeline({
    pipelinePath: project.path('stepcast.yml'),
    config: project.config,
  });
  const path = project.path('pipeline.lock.yml');
  writeFileSync(path, serializeLock(expanded.pipeline));
  return path;
}

describe('ui: мягкий разбор pipeline.lock.yml', () => {
  it('достаёт работы, их зависимости и признак публикуемого выхода', () => {
    const jobs = readLockJobs(lockFile());

    assert.deepEqual(
      jobs.map((job) => job.id),
      ['producer', 'consumer'],
    );

    const producer = jobs.find((job) => job.id === 'producer');
    assert.equal(producer?.publishesOutput, true);
    assert.equal(producer?.description, 'Публикует выход');
    assert.deepEqual(producer?.needs, []);

    const consumer = jobs.find((job) => job.id === 'consumer');
    assert.equal(consumer?.publishesOutput, false);
    assert.deepEqual(consumer?.needs, ['producer']);
  });

  it('различает агентский и командный шаг', () => {
    const jobs = readLockJobs(lockFile());

    const agent = jobs.find((job) => job.id === 'producer')?.steps[0];
    assert.equal(agent?.kind, 'agent');
    assert.equal(agent?.prompt, 'подумай');

    const command = jobs.find((job) => job.id === 'consumer')?.steps[0];
    assert.equal(command?.kind, 'run');
    assert.equal(command?.command, 'echo ok');
  });

  it('собирает подписи записей контекста', () => {
    const producer = readLockJobs(lockFile()).find((job) => job.id === 'producer');
    assert.equal(producer?.context.length, 1);
    assert.match(producer?.context[0] ?? '', /контекст работы/);
  });

  it('различает шаг script: путь, слой, раннер и argv', () => {
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
        args: ['--dry-run']
        input: { slug: bug-42 }
        output_schema: ./schema.json
`,
    });
    project.write('.stepcast/scripts/cleanup.sh', '#!/bin/sh\nexit 0\n');
    project.write('schema.json', JSON.stringify({ type: 'object' }));
    const expanded = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config });
    const path = project.path('pipeline.lock.yml');
    writeFileSync(path, serializeLock(expanded.pipeline));

    const step = readLockJobs(path).find((job) => job.id === 'build')?.steps[0];
    assert.equal(step?.kind, 'script');
    assert.equal(step?.scriptPath, 'cleanup.sh');
    assert.equal(step?.scriptRunner, 'sh');
    assert.equal(step?.hasScriptInput, true);
    assert.equal(step?.scriptOutputSchemaPath, project.path('schema.json'));
  });

  it('шаг script без входа и схемы выхода отличим от шага с контрактом', () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: витрина-script-без-контракта
jobs:
  build:
    steps:
      - id: cleanup
        script: cleanup.sh
`,
    });
    project.write('.stepcast/scripts/cleanup.sh', '#!/bin/sh\nexit 0\n');
    const expanded = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config });
    const path = project.path('pipeline.lock.yml');
    writeFileSync(path, serializeLock(expanded.pipeline));

    const step = readLockJobs(path).find((job) => job.id === 'build')?.steps[0];
    assert.equal(step?.hasScriptInput, false);
    assert.equal(step?.scriptOutputSchemaPath, undefined);
  });

  it('на отсутствующем и негодном файле отдаёт пустой список, а не падает', () => {
    const base = tempDir('lock-');

    assert.deepEqual(readLockJobs(join(base, 'нет-такого.yml')), []);

    const broken = join(base, 'broken.yml');
    writeFileSync(broken, ':\n  - не[ yaml');
    assert.deepEqual(readLockJobs(broken), []);

    const noJobs = join(base, 'nojobs.yml');
    writeFileSync(noJobs, 'version: 1\nkind: pipeline.lock\n');
    assert.deepEqual(readLockJobs(noJobs), []);
  });
});

const LANE_AND_GROUP_PIPELINE = `
version: 1
kind: pipeline
name: витрина

jobs:
  first:
    lane: a
    session_group: build
    steps:
      - id: one
        agent: claude
        prompt: "промпт"

  second:
    needs: [first]
    steps:
      - id: two
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
`;

function laneAndGroupLockFile(): string {
  const project = makeProject({ 'stepcast.yml': LANE_AND_GROUP_PIPELINE });
  const expanded = expandPipeline({
    pipelinePath: project.path('stepcast.yml'),
    config: project.config,
  });
  const path = project.path('pipeline.lock.yml');
  writeFileSync(path, serializeLock(expanded.pipeline));
  return path;
}

describe('ui: замок несёт объявленные дорожку и группу сессий', () => {
  it('работа с объявлениями отдаёт и дорожку, и группу', () => {
    const first = readLockJobs(laneAndGroupLockFile()).find((job) => job.id === 'first');
    assert.equal(first?.lane, 'a');
    assert.equal(first?.sessionGroup, 'build');
  });

  it('работа без объявлений не несёт ни дорожки, ни группы', () => {
    const second = readLockJobs(laneAndGroupLockFile()).find((job) => job.id === 'second');
    assert.equal(second?.lane, undefined);
    assert.equal(second?.sessionGroup, undefined);
  });
});
