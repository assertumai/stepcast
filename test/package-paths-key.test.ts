import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { expandPipeline } from '../src/parts/pipeline/document/expand.js';
import { jobLockHash } from '../src/parts/pipeline/document/lock.js';
import type { Job, Pipeline } from '../src/parts/pipeline/document/model.js';
import {
  enginePackageRoot,
  normalizePackagePaths,
  portableForm,
} from '../src/parts/pipeline/document/packagePaths.js';
import { legacyPackageRoots, legacyStepKeys } from '../src/parts/pipeline/run/legacyKey.js';
import { computeStepKey } from '../src/parts/pipeline/run/stepKey.js';
import { makeProject } from './helpers.js';
import { tempDir } from './tmp.js';

// Ключ шага и хеш работы не должны зависеть от места установки движка:
// каждый `scripts/release-local.sh` кладёт пакет в новый каталог
// `~/.stepcast/releases/<ts>-<sha>/`, и абсолютный путь схемы
// `stepcast:<имя>` в ключе пересчитывал бы весь граф после каждого выпуска.

const SCHEMA = join('schema', 'backlog-slots.schema.json');

const PIPELINE = `
version: 1
kind: pipeline
name: схема-поставки
jobs:
  slots:
    session: per_step
    steps:
      - id: раскладывает
        agent: fake
        prompt: "разложи"
        output_schema: stepcast:backlog-slots
        expect: [{ exit_code: 0 }]
`;

function expanded(): { pipeline: Pipeline; job: Job } {
  const project = makeProject({ 'stepcast.yml': PIPELINE });
  const { pipeline } = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config });
  const job = pipeline.jobs.find((item) => item.id === 'slots');
  assert.ok(job !== undefined);
  return { pipeline, job };
}

/** Корень «выпуска» с копией встроенной схемы — и с `package.json`, как у настоящего. */
function releaseRoot(schemaText?: string): string {
  const root = tempDir('release-');
  mkdirSync(join(root, 'schema'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{}');
  if (schemaText === undefined) copyFileSync(join(enginePackageRoot(), SCHEMA), join(root, SCHEMA));
  else writeFileSync(join(root, SCHEMA), schemaText);
  return root;
}

/** Работа, чьи пути поставки разрешены от корня `root`, — как её разрешил бы движок оттуда. */
function jobAt(job: Job, root: string): Job {
  return normalizePackagePaths(job, { kind: 'relocated', from: enginePackageRoot(), to: root });
}

function keyAt(pipeline: Pipeline, job: Job, root: string): string {
  const relocated = jobAt(job, root);
  const step = relocated.steps[0];
  assert.ok(step !== undefined);
  const form = portableForm(root);
  return computeStepKey({
    lockHash: jobLockHash(pipeline, relocated, form),
    jobId: relocated.id,
    step,
    inputsFingerprint: undefined,
    backendCommand: 'fake',
    upstream: [],
    packagePaths: form,
  });
}

describe('ключ шага: ресурсы поставки в переносимой форме', () => {
  it('разрешённая схема stepcast: лежит в шаге абсолютным путём корня пакета', () => {
    const { job } = expanded();
    const step = job.steps[0];
    assert.equal(step?.kind, 'agent');
    assert.equal(
      step.kind === 'agent' ? step.outputSchemaPath : undefined,
      join(enginePackageRoot(), SCHEMA),
    );
  });

  it('два корня пакета с одинаковой встроенной схемой дают один ключ шага', () => {
    const { pipeline, job } = expanded();
    const first = releaseRoot();
    const second = releaseRoot();
    assert.notEqual(first, second);

    assert.equal(keyAt(pipeline, job, first), keyAt(pipeline, job, second));
    assert.equal(
      jobLockHash(pipeline, jobAt(job, first), portableForm(first)),
      jobLockHash(pipeline, jobAt(job, second), portableForm(second)),
    );
  });

  it('изменённое содержимое встроенной схемы даёт другой ключ', () => {
    const { pipeline, job } = expanded();
    const original = releaseRoot();
    const text = readFileSync(join(original, SCHEMA), 'utf8');
    const edited = releaseRoot(text.replace(/\}\s*$/, ', "$comment": "правка" }'));

    assert.notEqual(keyAt(pipeline, job, original), keyAt(pipeline, job, edited));
  });
});

describe('ключ шага: записи прежних выпусков с абсолютными путями', () => {
  /** Ключ, каким его писал выпуск до переносимой формы: абсолютные пути от своего корня. */
  function oldKeyAt(pipeline: Pipeline, job: Job, root: string): string {
    const relocated = jobAt(job, root);
    const step = relocated.steps[0];
    assert.ok(step !== undefined);
    const raw = { kind: 'relocated', from: root, to: root } as const;
    return computeStepKey({
      lockHash: jobLockHash(pipeline, relocated, raw),
      jobId: relocated.id,
      step,
      inputsFingerprint: undefined,
      backendCommand: 'fake',
      upstream: [],
      packagePaths: raw,
    });
  }

  function lockMentioning(root: string): string {
    const path = join(tempDir('lock-'), 'pipeline.lock.yml');
    writeFileSync(path, `jobs:\n  - id: slots\n    output:\n      schemaPath: ${join(root, SCHEMA)}\n`);
    return path;
  }

  it('корень старого выпуска берётся из замка исходного прогона', () => {
    const old = releaseRoot();
    assert.deepEqual(legacyPackageRoots(lockMentioning(old)), [old]);
  });

  it('ключ старого формата сходится, если схема в старом и новом выпуске одинакова', () => {
    const { pipeline, job } = expanded();
    const old = releaseRoot();
    const current = releaseRoot();
    const relocated = jobAt(job, current);
    const step = relocated.steps[0];
    assert.ok(step !== undefined);

    const keys = legacyStepKeys(
      pipeline,
      relocated,
      { jobId: relocated.id, step, inputsFingerprint: undefined, backendCommand: 'fake', upstream: [] },
      legacyPackageRoots(lockMentioning(old)),
      current,
    );
    assert.deepEqual(keys, [oldKeyAt(pipeline, job, old)]);
  });

  it('ключ старого формата не сходится, если схема между выпусками изменилась', () => {
    const { pipeline, job } = expanded();
    const current = releaseRoot();
    const text = readFileSync(join(current, SCHEMA), 'utf8');
    const old = releaseRoot(text.replace(/\}\s*$/, ', "$comment": "старая" }'));
    const relocated = jobAt(job, current);
    const step = relocated.steps[0];
    assert.ok(step !== undefined);

    const keys = legacyStepKeys(
      pipeline,
      relocated,
      { jobId: relocated.id, step, inputsFingerprint: undefined, backendCommand: 'fake', upstream: [] },
      legacyPackageRoots(lockMentioning(old)),
      current,
    );
    assert.deepEqual(keys, []);
  });
});
