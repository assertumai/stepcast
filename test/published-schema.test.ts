import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';

import { buildPublishedSchemas, type PluginPredicateEntry } from '../src/core/pipeline/published-schema.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function readSchemaFile(file: string): string {
  return readFileSync(`${ROOT}${file}`, 'utf8');
}

function compileAny(schema: unknown) {
  return new Ajv2020({ allErrors: true, strict: false }).compile(schema as object);
}

/**
 * Три точки документа, где стоит перечень предикатов: `expect` командного
 * шага, `expect` агентского шага и `until.check`. Ветвей объединения в
 * напечатанной схеме ровно столько же, и вложение проверяется в каждой: точка
 * объявления на признание ключа влиять не должна.
 */
type Point = 'run' | 'agent' | 'until';

/** Тело работы с одним предикатом в названной точке. */
function jobBody(predicate: Record<string, unknown>, point: Point): Record<string, unknown> {
  switch (point) {
    case 'run':
      return { steps: [{ id: 'say', run: ['echo', 'ok'], expect: [predicate] }] };
    case 'agent':
      return { steps: [{ id: 'ask', prompt: 'спроси', expect: [predicate] }] };
    case 'until':
      return { until: { check: [predicate] }, steps: [{ id: 'say', run: ['echo', 'ok'] }] };
  }
}

/** Документ работы с одним предикатом в названной точке. */
function jobDocument(predicate: Record<string, unknown>, point: Point): unknown {
  return { version: 1, kind: 'job', ...jobBody(predicate, point) };
}

/** Документ пайплайна с тем же предикатом в той же точке — внутри работы. */
function pipelineDocument(predicate: Record<string, unknown>, point: Point): unknown {
  return {
    version: 1,
    kind: 'pipeline',
    name: 'проверка',
    jobs: { build: jobBody(predicate, point) },
  };
}

const POINTS: readonly Point[] = ['run', 'agent', 'until'];

/** Ожидание в обоих документах сразу: схемы печатаются одним кодом. */
function expectBoth(
  schemas: { pipeline: Record<string, unknown>; job: Record<string, unknown> },
  predicate: Record<string, unknown>,
  accepted: boolean,
): void {
  const validateJob = compileAny(schemas.job);
  const validatePipeline = compileAny(schemas.pipeline);
  for (const point of POINTS) {
    assert.equal(validateJob(jobDocument(predicate, point)), accepted, `работа, точка ${point}`);
    assert.equal(validatePipeline(pipelineDocument(predicate, point)), accepted, `пайплайн, точка ${point}`);
  }
}

describe('published-schema: печать при пустом перечне плагинных предикатов', () => {
  it('совпадает с schema/pipeline.schema.json и schema/job.schema.json побайтово', () => {
    const { pipeline, job, notes } = buildPublishedSchemas();

    assert.deepEqual(notes, []);

    const expectedPipelineText = readSchemaFile('schema/pipeline.schema.json');
    const expectedJobText = readSchemaFile('schema/job.schema.json');

    assert.deepEqual(pipeline, JSON.parse(expectedPipelineText));
    assert.deepEqual(job, JSON.parse(expectedJobText));

    // Побайтово, вместе с завершающим переводом строки — тем же форматом,
    // каким `generate-schema.ts` пишет файл.
    assert.equal(`${JSON.stringify(pipeline, null, 2)}\n`, expectedPipelineText);
    assert.equal(`${JSON.stringify(job, null, 2)}\n`, expectedJobText);
  });
});

describe('published-schema: вложение схемы значения плагинного предиката', () => {
  const textHas: PluginPredicateEntry = {
    name: 'text_has',
    schema: { type: 'string', minLength: 1 },
    owner: 'example',
  };

  it('признаёт плагинный предикат во всех трёх точках обоих документов', () => {
    const schemas = buildPublishedSchemas([textHas]);
    assert.deepEqual(schemas.notes, []);

    expectBoth(schemas, { text_has: 'ok' }, true);
  });

  it('отклоняет неверное значение и опечатку во всех трёх точках обоих документов', () => {
    const schemas = buildPublishedSchemas([textHas]);

    expectBoth(schemas, { text_has: 42 }, false);
    expectBoth(schemas, { exit_cod: 0 }, false);
  });

  it('называет предикат и внёсший его плагин в description корня', () => {
    const { pipeline, job } = buildPublishedSchemas([textHas]);

    assert.match(String(pipeline['description']), /text_has/);
    assert.match(String(pipeline['description']), /example/);
    assert.match(String(job['description']), /text_has/);
    assert.match(String(job['description']), /example/);
  });
});

describe('published-schema: непригодная схема значения даёт заметку, а не отменяет печать', () => {
  const good: PluginPredicateEntry = {
    name: 'text_has',
    schema: { type: 'string', minLength: 1 },
    owner: 'example',
  };

  it('$ref на втором уровне: ключ признан, значение неограничено, есть заметка', () => {
    const withRef: PluginPredicateEntry = {
      name: 'http_ok',
      schema: { type: 'object', properties: { nested: { $ref: '#/definitions/foo' } } },
      owner: 'http-checks',
    };

    const schemas = buildPublishedSchemas([good, withRef]);

    assert.equal(schemas.notes.length, 1);
    assert.equal(schemas.notes[0]?.predicate, 'http_ok');
    assert.equal(schemas.notes[0]?.plugin, 'http-checks');
    assert.match(schemas.notes[0]?.reason ?? '', /\$ref/);

    // Ключ признан — любое значение проходит.
    expectBoth(schemas, { http_ok: { что: 'угодно' } }, true);
    // Соседний предикат по-прежнему вложен нормально.
    expectBoth(schemas, { text_has: 'ok' }, true);
    expectBoth(schemas, { text_has: 42 }, false);
  });

  it('$id в схеме значения — та же заметка', () => {
    const withId: PluginPredicateEntry = {
      name: 'http_ok',
      schema: { $id: 'https://example.com/schema', type: 'string' },
      owner: 'http-checks',
    };

    const { notes } = buildPublishedSchemas([good, withId]);

    assert.equal(notes.length, 1);
    assert.match(notes[0]?.reason ?? '', /\$id/);
  });

  it('$schema в схеме значения — та же заметка', () => {
    const withSchema: PluginPredicateEntry = {
      name: 'http_ok',
      schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'string' },
      owner: 'http-checks',
    };

    const { notes } = buildPublishedSchemas([good, withSchema]);

    assert.equal(notes.length, 1);
    assert.match(notes[0]?.reason ?? '', /\$schema/);
  });

  it('схема, которую ajv не компилирует, — заметка, а остальные предикаты вложены нормально', () => {
    const broken: PluginPredicateEntry = {
      name: 'http_ok',
      schema: { type: 'string', minLength: 'не число' },
      owner: 'http-checks',
    };

    const schemas = buildPublishedSchemas([good, broken]);

    assert.equal(schemas.notes.length, 1);
    assert.equal(schemas.notes[0]?.predicate, 'http_ok');
    assert.equal(schemas.notes[0]?.plugin, 'http-checks');

    expectBoth(schemas, { text_has: 'ok' }, true);
    expectBoth(schemas, { text_has: 42 }, false);
    expectBoth(schemas, { http_ok: 'что угодно' }, true);
  });

  // Автономно такая схема компилируется, а в документе разрешалась бы от
  // чужого корня — либо не разрешалась бы вовсе.
  for (const [key, schema] of [
    ['$anchor', { $anchor: 'значение', type: 'string' }],
    ['$dynamicAnchor', { $dynamicAnchor: 'значение', type: 'string' }],
    ['$dynamicRef', { type: 'array', items: { $dynamicRef: '#значение' } }],
    ['$recursiveAnchor', { $recursiveAnchor: true, type: 'string' }],
  ] as const) {
    it(`${key} в схеме значения — та же заметка, а схема документа всё равно компилируется`, () => {
      const withKey: PluginPredicateEntry = { name: 'http_ok', schema, owner: 'http-checks' };

      const schemas = buildPublishedSchemas([good, withKey]);

      assert.equal(schemas.notes.length, 1);
      assert.equal(schemas.notes[0]?.predicate, 'http_ok');
      assert.match(schemas.notes[0]?.reason ?? '', new RegExp(`\\${key}`));

      expectBoth(schemas, { http_ok: 'что угодно' }, true);
      expectBoth(schemas, { text_has: 42 }, false);
    });
  }

  it('собранная схема документа компилируется при любых объявленных схемах значений', () => {
    const zoo: PluginPredicateEntry[] = [
      good,
      { name: 'http_ok', schema: { $ref: '#/$defs/чужое' }, owner: 'http-checks' },
      { name: 'port_open', schema: { $dynamicRef: '#нет-такого' }, owner: 'net' },
      { name: 'log_clean', schema: { type: 'object', additionalProperties: { $anchor: 'a' } }, owner: 'logs' },
      { name: 'file_size', schema: { type: 'integer', minimum: 'не число' }, owner: 'files' },
    ];

    const schemas = buildPublishedSchemas(zoo);

    assert.equal(schemas.notes.length, 4);
    // Все четыре ключа признаны — проверки значения нет, подсказка есть.
    for (const name of ['http_ok', 'port_open', 'log_clean', 'file_size']) {
      expectBoth(schemas, { [name]: 'что угодно' }, true);
    }
    expectBoth(schemas, { text_has: 42 }, false);
  });
});
