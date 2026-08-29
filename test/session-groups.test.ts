import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createFakeBackend, initLine, resultLine } from '../src/core/backend/fake.js';
import { lintPipeline } from '../src/core/lint.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { runPipeline } from '../src/core/run/runner.js';
import { makeProject, type Project } from './helpers.js';

/**
 * `session_group` — объявление обвязки: работы с одинаковым именем продолжают
 * один диалог агента. До него сессия жила ровно одну работу, потому что
 * реестр сессий создавался в её исполнении, и пайплайн из пяти работ означал
 * пять чтений репозитория с нуля.
 */

function expand(project: Project) {
  return expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config });
}

function errorsOf(project: Project): string[] {
  const expanded = expand(project);
  return lintPipeline(expanded, { config: project.config, cwd: project.root })
    .filter((item) => item.severity === 'error')
    .map((item) => item.message);
}

/** Пайплайн из двух последовательных агентских работ; группа объявляется вызывающим. */
function twoJobs(options: { readonly group?: string } = {}): string {
  const group = options.group === undefined ? '' : `    session_group: ${options.group}\n`;
  return `
kind: pipeline
name: probe
context:
  - text: свод правил пайплайна
jobs:
  first:
${group}    context:
      - text: контекст первой работы
    steps:
      - id: one
        agent: claude
        prompt: промпт один
  second:
    needs: [first]
${group}    context_upstream: none
    context:
      - text: контекст второй работы
    steps:
      - id: two
        agent: claude
        prompt: промпт два
`;
}

async function runTwoJobs(source: string) {
  const project = makeProject({ 'stepcast.yml': source });
  const backend = createFakeBackend({ lines: () => [initLine(), resultLine({ text: 'ок' })] });
  const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));

  const result = await runPipeline({
    expanded: expand(project),
    config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
    projectRoot: project.root,
    cwd: project.root,
    adapterFor: () => backend.adapter,
  });

  assert.equal(result.status, 'success');
  assert.equal(backend.invocations.length, 2);
  return backend.invocations;
}

describe('session_group: диалог живёт дольше работы', () => {
  it('работы одной группы продолжают одну сессию', async () => {
    const [first, second] = await runTwoJobs(twoJobs({ group: 'together' }));

    assert.equal(first?.resumeSession, false);
    assert.equal(second?.resumeSession, true);
    assert.equal(second?.sessionId, first?.sessionId);
  });

  it('без объявления группы у каждой работы своя сессия — как прежде', async () => {
    const [first, second] = await runTwoJobs(twoJobs());

    assert.equal(first?.resumeSession, false);
    assert.equal(second?.resumeSession, false);
    assert.notEqual(second?.sessionId, first?.sessionId);
  });

  /**
   * Свод правил пайплайна агент читает один раз на диалог, а собственный
   * контекст второй работы — новое знание: умолчать о нём потому, что диалог
   * уже начат, значило бы отправить её работать по пустому месту.
   */
  it('контекст пайплайна уходит один раз на диалог, контекст работы — каждой', async () => {
    const [first, second] = await runTwoJobs(twoJobs({ group: 'together' }));

    assert.match(first?.prompt ?? '', /свод правил пайплайна/);
    assert.match(first?.prompt ?? '', /контекст первой работы/);

    assert.doesNotMatch(second?.prompt ?? '', /свод правил пайплайна/);
    assert.match(second?.prompt ?? '', /контекст второй работы/);
  });

  it('без группы контекст пайплайна уходит каждой работе', async () => {
    const [, second] = await runTwoJobs(twoJobs());

    assert.match(second?.prompt ?? '', /свод правил пайплайна/);
  });
});

describe('session_group: линт стережёт исполнимость группы', () => {
  it('работа с циклом until в группе отклоняется', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
name: probe
jobs:
  first:
    session_group: g
    steps:
      - id: one
        agent: claude
        prompt: ok
  second:
    needs: [first]
    session_group: g
    until:
      max_iterations: 2
      check:
        - cmd: "true"
    steps:
      - id: two
        agent: claude
        prompt: ok
`,
    });

    assert.deepEqual(
      errorsOf(project).filter((message) => message.includes('until')),
      ['Работа second объявляет цикл until и состоит в группе сессий g'],
    );
  });

  it('две неупорядоченные работы одной группы отклоняются', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
name: probe
jobs:
  first:
    session_group: g
    steps:
      - id: one
        agent: claude
        prompt: ok
  second:
    session_group: g
    steps:
      - id: two
        agent: claude
        prompt: ok
`,
    });

    assert.deepEqual(
      errorsOf(project).filter((message) => message.includes('не упорядочены')),
      ['Работы first и second состоят в группе сессий g, но не упорядочены зависимостями'],
    );
  });

  it('работа группы, заводящая своё рабочее дерево, отклоняется', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
name: probe
workspace: { mode: worktree }
jobs:
  first:
    session_group: g
    steps:
      - id: one
        agent: claude
        prompt: ok
  second:
    needs: [first]
    session_group: g
    workspace: { inherit: none }
    steps:
      - id: two
        agent: claude
        prompt: ok
`,
    });

    assert.deepEqual(
      errorsOf(project).filter((message) => message.includes('своё рабочее дерево')),
      ['Работа second в группе сессий g заводит своё рабочее дерево'],
    );
  });

  it('разные режимы рабочего дерева внутри группы отклоняются', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
name: probe
workspace: { mode: worktree }
jobs:
  first:
    session_group: g
    steps:
      - id: one
        agent: claude
        prompt: ok
  second:
    needs: [first]
    session_group: g
    workspace: { mode: cwd }
    steps:
      - id: two
        agent: claude
        prompt: ok
`,
    });

    assert.deepEqual(
      errorsOf(project).filter((message) => message.includes('разные режимы')),
      [
        'Работы группы сессий g объявляют разные режимы рабочего дерева: first — worktree, second — cwd',
      ],
    );
  });
});

describe('session_group: ключ обвязки, а не поле работы', () => {
  it('объявление внутри файла работы отклоняется разбором', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
name: probe
jobs:
  first:
    uses: ./job.yml
`,
      'job.yml': `
kind: job
name: job
session_group: g
steps:
  - id: one
    agent: claude
    prompt: ok
`,
    });

    assert.throws(
      () => expand(project),
      (error: unknown) => {
        assert.match((error as Error).message, /session_group недопустим внутри файла работы/);
        return true;
      },
    );
  });
});
