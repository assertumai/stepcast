import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { expandPipeline } from '../src/core/pipeline/expand.js';
import { packagedSchemaPath } from '../src/core/package-schema.js';
import { makeProject } from './helpers.js';
import type { Job } from '../src/core/pipeline/model.js';

const SCHEMA = JSON.stringify({ type: 'object' });

const JOB_FILE = `
version: 1
kind: job
name: probe
until:
  max_iterations: 2
  check:
    - schema: ../schemas/probe.json
steps:
  - id: think
    agent: claude
    prompt: ok
    output_schema: ../schemas/probe.json
    expect:
      - schema: ../schemas/probe.json
      - file_exists: report.json
`;

const PIPELINE = `
version: 1
kind: pipeline
name: probe
jobs:
  probe:
    uses: ./.stepcast/jobs/probe.yml
`;

/** Проект, где файл работы лежит не в корне: только так основания различимы. */
function expandJob(): Job {
  const project = makeProject({
    'stepcast.yml': PIPELINE,
    '.stepcast/jobs/probe.yml': JOB_FILE,
    '.stepcast/schemas/probe.json': SCHEMA,
  });

  const { pipeline } = expandPipeline({
    pipelinePath: project.path('stepcast.yml'),
    config: project.config,
  });
  return pipeline.jobs[0] as Job;
}

describe('pipeline-definition: разрешение путей предикатов', () => {
  it('путь схемы предиката разрешается от файла работы', () => {
    const predicate = (expandJob().steps[0] as Job['steps'][number]).expect.find(
      (entry) => entry.kind === 'schema',
    );

    assert.equal(predicate?.kind, 'schema');
    assert.match(
      predicate.kind === 'schema' ? predicate.path : '',
      /[/\\]\.stepcast[/\\]schemas[/\\]probe\.json$/,
    );
  });

  it('путь схемы в условии сходимости разрешается так же', () => {
    const check = expandJob().until?.check.find((entry) => entry.kind === 'schema');

    assert.equal(check?.kind, 'schema');
    assert.match(
      check?.kind === 'schema' ? check.path : '',
      /[/\\]\.stepcast[/\\]schemas[/\\]probe\.json$/,
    );
  });

  it('схема предиката и output_schema шага дают один путь', () => {
    const step = expandJob().steps[0] as Job['steps'][number];
    const predicate = step.expect.find((entry) => entry.kind === 'schema');

    assert.equal(
      predicate?.kind === 'schema' ? predicate.path : undefined,
      step.kind === 'agent' ? step.outputSchemaPath : undefined,
    );
  });

  it('путь file_exists остаётся от корня рабочей директории', () => {
    const predicate = (expandJob().steps[0] as Job['steps'][number]).expect.find(
      (entry) => entry.kind === 'file_exists',
    );

    // Файл создаёт шаг, и появляется он в рабочей директории, а не рядом с
    // определением работы: путь обязан остаться сырым.
    assert.equal(predicate?.kind === 'file_exists' ? predicate.path : undefined, 'report.json');
  });
});

const STEPCAST_SCHEMA_JOB = `
version: 1
kind: job
name: probe
output:
  from: think
  schema: stepcast:backlog-slots
steps:
  - id: think
    agent: claude
    prompt: ok
    output_schema: stepcast:backlog-slots
    expect:
      - schema: stepcast:backlog-slots
`;

const STEPCAST_SCHEMA_PIPELINE = `
version: 1
kind: pipeline
name: probe
jobs:
  probe:
    uses: ./.stepcast/jobs/probe.yml
`;

describe('pipeline-definition: ссылка stepcast:<имя> в местах объявления схемы', () => {
  it('разрешается во всех трёх местах в один и тот же файл схемы пакета', () => {
    const project = makeProject({
      'stepcast.yml': STEPCAST_SCHEMA_PIPELINE,
      '.stepcast/jobs/probe.yml': STEPCAST_SCHEMA_JOB,
    });

    const { pipeline } = expandPipeline({
      pipelinePath: project.path('stepcast.yml'),
      config: project.config,
    });
    const job = pipeline.jobs[0]!;
    const step = job.steps[0] as Job['steps'][number];
    const predicate = step.expect.find((entry) => entry.kind === 'schema');

    const expected = packagedSchemaPath('backlog-slots');
    assert.equal(job.output?.schemaPath, expected);
    assert.equal(step.kind === 'agent' ? step.outputSchemaPath : undefined, expected);
    assert.equal(predicate?.kind === 'schema' ? predicate.path : undefined, expected);
  });

  it('until.check принимает ту же форму и разрешает тот же файл', () => {
    const project = makeProject({
      'stepcast.yml': STEPCAST_SCHEMA_PIPELINE,
      '.stepcast/jobs/probe.yml': `
version: 1
kind: job
name: probe
until:
  max_iterations: 2
  check:
    - schema: stepcast:backlog-slots
steps:
  - id: think
    agent: claude
    prompt: ok
`,
    });

    const { pipeline } = expandPipeline({
      pipelinePath: project.path('stepcast.yml'),
      config: project.config,
    });
    const check = pipeline.jobs[0]!.until?.check.find((entry) => entry.kind === 'schema');

    assert.equal(check?.kind === 'schema' ? check.path : undefined, packagedSchemaPath('backlog-slots'));
  });
});
