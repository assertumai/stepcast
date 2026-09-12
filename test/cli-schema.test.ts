import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';

import type { CliIo } from '../src/cli/args.js';
import { run as runCli } from '../src/cli/main.js';
import { ExitCode, type ExitCodeValue } from '../src/core/errors.js';
import { makeProject, withHome, type Project } from './helpers.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

interface Outcome {
  readonly code: ExitCodeValue;
  readonly stdout: string;
  readonly stderr: string;
}

async function cli(project: Project, argv: readonly string[]): Promise<Outcome> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    cwd: project.root,
  };
  const code = await withHome(project.home, () => runCli(argv, io));
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

/** Плагин с одним предикатом — форма значения строкой. */
const PREDICATE_PLUGIN = `
export default {
  name: 'probe',
  predicates: [
    {
      name: 'text_has',
      schema: { type: 'string', minLength: 1 },
      evaluate: () => ({ predicate: 'text_has', passed: true, hard: true }),
    },
  ],
};
`;

/** Плагин, который вносит только бэкенд: предикатов у схемы не прибавляется. */
const BACKEND_PLUGIN = `
export default {
  name: 'probe',
  backends: {
    codex: { create: () => ({ run: async () => ({ ok: true }) }) },
  },
};
`;

const BROKEN_PLUGIN = `
это не модуль плагина
`;

/** Экранированный путь: сообщение команды ищется в выводе как есть. */
function pathPattern(path: string): RegExp {
  return new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

function withPlugin(body: string, config = 'plugins: ["./plugins/probe.mjs"]\n'): Project {
  const project = makeProject({ '.stepcast/config.yml': config });
  const path = join(project.root, '.stepcast', 'plugins', 'probe.mjs');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return project;
}

describe('stepcast schema: без плагинов', () => {
  it('пишет .stepcast/schema/*.json, побайтово равные поставляемым пакетом, и печатает оба пути', async () => {
    const project = makeProject({});

    const outcome = await cli(project, ['schema']);

    assert.equal(outcome.code, ExitCode.ok, outcome.stderr);

    const pipelinePath = project.path(join('.stepcast', 'schema', 'pipeline.schema.json'));
    const jobPath = project.path(join('.stepcast', 'schema', 'job.schema.json'));
    assert.match(outcome.stdout, pathPattern(pipelinePath));
    assert.match(outcome.stdout, pathPattern(jobPath));
    // Встроенный вид шага decision (`user-decision-steps`) всегда в дереве, но
    // отличием от поставляемой схемы он не является: она его знает, файлы
    // побайтово равны — и команда говорит именно это.
    assert.match(outcome.stdout, /нет: схема совпадает с поставляемой пакетом/);

    assert.equal(readFileSync(pipelinePath, 'utf8'), readFileSync(`${ROOT}schema/pipeline.schema.json`, 'utf8'));
    assert.equal(readFileSync(jobPath, 'utf8'), readFileSync(`${ROOT}schema/job.schema.json`, 'utf8'));
  });

  // Сценарий: «Плагин без предикатов». Побайтовое равенство держится не на
  // отсутствии плагинов, а на отсутствии плагинных предикатов (и видов шага).
  it('загруженный плагин без предикатов даёт файлы, побайтово равные поставляемым пакетом', async () => {
    const project = withPlugin(BACKEND_PLUGIN);

    const outcome = await cli(project, ['schema']);

    assert.equal(outcome.code, ExitCode.ok, outcome.stderr);

    const pipelinePath = project.path(join('.stepcast', 'schema', 'pipeline.schema.json'));
    const jobPath = project.path(join('.stepcast', 'schema', 'job.schema.json'));
    assert.equal(readFileSync(pipelinePath, 'utf8'), readFileSync(`${ROOT}schema/pipeline.schema.json`, 'utf8'));
    assert.equal(readFileSync(jobPath, 'utf8'), readFileSync(`${ROOT}schema/job.schema.json`, 'utf8'));
  });

  // Ветвь шага script: печатаемая схема принимает и отклоняет те же
  // документы, что и разбор движка (`toStep` в `src/core/pipeline/expand.ts`).
  it('печатаемая схема пайплайна признаёт шаг script и отклоняет script вместе с run', async () => {
    const project = makeProject({});
    const outcome = await cli(project, ['schema']);
    assert.equal(outcome.code, ExitCode.ok, outcome.stderr);

    const pipelinePath = project.path(join('.stepcast', 'schema', 'pipeline.schema.json'));
    const schema = JSON.parse(readFileSync(pipelinePath, 'utf8')) as object;
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

    const valid = {
      version: 1,
      kind: 'pipeline',
      jobs: { build: { steps: [{ id: 'c', script: 'cleanup.py', args: ['--dry-run'] }] } },
    };
    assert.equal(validate(valid), true, JSON.stringify(validate.errors));

    const invalid = {
      version: 1,
      kind: 'pipeline',
      jobs: { build: { steps: [{ id: 'c', script: 'cleanup.py', run: ['echo', 'hi'] }] } },
    };
    assert.equal(validate(invalid), false);
  });
});

describe('stepcast schema: проект с плагином', () => {
  it('признаёт ключ плагинного предиката в записанной схеме', async () => {
    const project = withPlugin(PREDICATE_PLUGIN);

    const outcome = await cli(project, ['schema']);

    assert.equal(outcome.code, ExitCode.ok, outcome.stderr);

    const jobPath = project.path(join('.stepcast', 'schema', 'job.schema.json'));
    const job = JSON.parse(readFileSync(jobPath, 'utf8')) as unknown;
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(job as object);

    const document = {
      version: 1,
      kind: 'job',
      steps: [{ id: 'say', run: ['echo', 'ok'], expect: [{ text_has: 'ok' }] }],
    };
    assert.equal(validate(document), true);
  });

  it('--out кладёт файлы в названный каталог и называет именно эти пути', async () => {
    const project = withPlugin(PREDICATE_PLUGIN);

    const outcome = await cli(project, ['schema', '--out', 'schemas']);

    assert.equal(outcome.code, ExitCode.ok, outcome.stderr);
    const pipelinePath = project.path(join('schemas', 'pipeline.schema.json'));
    const jobPath = project.path(join('schemas', 'job.schema.json'));
    assert.ok(existsSync(pipelinePath));
    assert.ok(existsSync(jobPath));
    assert.ok(!existsSync(project.path(join('.stepcast', 'schema', 'pipeline.schema.json'))));

    assert.match(outcome.stdout, pathPattern(pipelinePath));
    assert.match(outcome.stdout, pathPattern(jobPath));
    assert.ok(!outcome.stdout.includes(join('.stepcast', 'schema')), outcome.stdout);
  });

  it('плагин, который не импортируется, отказывает конфигурационной ошибкой и не пишет ни одного файла', async () => {
    const project = withPlugin(BROKEN_PLUGIN);

    const outcome = await cli(project, ['schema']);

    assert.equal(outcome.code, ExitCode.configError);
    assert.ok(!existsSync(project.path(join('.stepcast', 'schema'))));
  });
});
