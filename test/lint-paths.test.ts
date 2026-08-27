import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { expandPipeline } from '../src/core/pipeline/expand.js';
import { lintPipeline, type Diagnostic } from '../src/core/lint.js';
import { makeProject } from './helpers.js';

const SCHEMA = JSON.stringify({ type: 'object' });

const PIPELINE = `
version: 1
kind: pipeline
name: probe
budget: { tokens: 100k }
jobs:
  probe:
    uses: ./.stepcast/jobs/probe.yml
`;

/** Пропустить пайплайн с указанным телом работы через линт. */
function lint(jobBody: string, files: Readonly<Record<string, string>> = {}): Diagnostic[] {
  const project = makeProject({
    'stepcast.yml': PIPELINE,
    '.stepcast/jobs/probe.yml': `
version: 1
kind: job
name: probe
${jobBody}
`,
    '.stepcast/schemas/real.json': SCHEMA,
    'real-context.md': 'текст',
    ...files,
  });

  return lintPipeline(
    expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
    { config: project.config },
  );
}

function errors(diagnostics: readonly Diagnostic[]): readonly Diagnostic[] {
  return diagnostics.filter((entry) => entry.severity === 'error');
}

const AGENT_STEP = `steps:
  - id: think
    agent: claude
    prompt: ok`;

describe('pipeline-definition: линт проверяет объявленные пути', () => {
  it('отсутствующая схема предиката — ошибка', () => {
    const found = errors(
      lint(`steps:
  - id: think
    agent: claude
    prompt: ok
    expect:
      - schema: ../schemas/no-such.json`),
    );

    assert.equal(found.length, 1);
    assert.match(found[0]?.message ?? '', /Файл схемы не найден/);
    assert.match(found[0]?.at ?? '', /expect\.0\.schema/);
  });

  it('отсутствующая схема в until.check — ошибка', () => {
    const found = errors(
      lint(`until:
  max_iterations: 2
  check:
    - schema: ../schemas/no-such.json
${AGENT_STEP}`),
    );

    assert.equal(found.length, 1);
    assert.match(found[0]?.at ?? '', /until\.check\.0\.schema/);
  });

  it('существующая схема предиката ошибки не даёт', () => {
    const found = errors(
      lint(`steps:
  - id: think
    agent: claude
    prompt: ok
    expect:
      - schema: ../schemas/real.json`),
    );

    assert.deepEqual(found, []);
  });

  it('отсутствующий путь контекста работы — ошибка', () => {
    const found = errors(
      lint(`context:
  - no-such-context.md
${AGENT_STEP}`),
    );

    assert.equal(found.length, 1);
    assert.match(found[0]?.message ?? '', /Файл контекста не найден/);
  });

  it('отсутствующий путь контекста шага — ошибка', () => {
    const found = errors(
      lint(`steps:
  - id: think
    agent: claude
    prompt: ok
    context:
      - no-such-context.md`),
    );

    assert.equal(found.length, 1);
    assert.match(found[0]?.at ?? '', /steps\.0\.context\.0/);
  });

  it('отсутствующий путь контекста пайплайна — ошибка', () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: probe
budget: { tokens: 100k }
context:
  - no-such-context.md
jobs:
  probe:
    steps:
      - id: think
        agent: claude
        prompt: ok
`,
    });

    const found = errors(
      lintPipeline(
        expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
        { config: project.config },
      ),
    );

    assert.equal(found.length, 1);
    assert.equal(found[0]?.at, 'context.0');
  });

  it('существующий путь контекста ошибки не даёт', () => {
    assert.deepEqual(
      errors(
        lint(`context:
  - real-context.md
${AGENT_STEP}`),
      ),
      [],
    );
  });

  it('глоб пропускается, даже если совпадений нет', () => {
    assert.deepEqual(
      errors(
        lint(`context:
  - "src/**/*.kt"
${AGENT_STEP}`),
      ),
      [],
    );
  });

  it('путь с отложенной подстановкой пропускается', () => {
    assert.deepEqual(
      errors(
        lint(`context:
  - "changes/\${jobs.probe.output.slug}/proposal.md"
${AGENT_STEP}`),
      ),
      [],
    );
  });

  it('запись контекста в объектной форме тоже проверяется', () => {
    const found = errors(
      lint(`context:
  - path: no-such-context.md
    mode: inline
${AGENT_STEP}`),
    );

    assert.equal(found.length, 1);
    assert.match(found[0]?.message ?? '', /Файл контекста не найден/);
  });

  it('file_exists не проверяется: файл создаёт сам шаг', () => {
    assert.deepEqual(
      errors(
        lint(`steps:
  - id: think
    agent: claude
    prompt: ok
    expect:
      - file_exists: report-not-yet.json`),
      ),
      [],
    );
  });

  it('контекст считается от корня проекта, а не от каталога пайплайна', () => {
    // Пайплайн в подкаталоге: только так видно, что основанием взят корень.
    // С каталогом пайплайна `docs/status.md` искался бы в
    // `.stepcast/pipelines/docs/status.md`.
    const project = makeProject({
      '.stepcast/pipelines/nested.yml': `
version: 1
kind: pipeline
name: nested
budget: { tokens: 100k }
context:
  - real-context.md
jobs:
  probe:
    steps:
      - id: think
        agent: claude
        prompt: ok
`,
      'real-context.md': 'текст',
    });

    const diagnostics = lintPipeline(
      expandPipeline({
        pipelinePath: project.path('.stepcast/pipelines/nested.yml'),
        config: project.config,
      }),
      { config: project.config, cwd: project.root },
    );

    assert.deepEqual(errors(diagnostics), []);
  });

  it('текстовая запись контекста путём не считается', () => {
    assert.deepEqual(
      errors(
        lint(`context:
  - text: |
      просто текст, а не путь
${AGENT_STEP}`),
      ),
      [],
    );
  });
});
