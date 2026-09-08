import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';

import { createFakeBackend, initLine, resultLine } from '../src/core/backend/fake.js';
import { lintPipeline } from '../src/core/lint.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { jobLockHash, pipelineLockHash, serializeLock } from '../src/core/pipeline/lock.js';
import type { Job, Pipeline } from '../src/core/pipeline/model.js';
import { computeStepKey } from '../src/core/run/stepKey.js';
import { runPipeline } from '../src/core/run/runner.js';
import { makeProject, type Project } from './helpers.js';
import { tempDir } from './tmp.js';

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
  const runsRoot = tempDir('runs-');

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

  it('два агента с одним псевдонимом не продолжают сессию друг друга', async () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  work:
    steps:
      - id: claude
        agent: claude
        prompt: первый
      - id: codex
        agent: codex
        prompt: второй
`,
      '.stepcast/config.yml': `
backends:
  codex:
    command: codex
    sessions: true
    structured_output: true
`,
    });
    const claude = createFakeBackend({ lines: () => [initLine(), resultLine({ text: 'claude' })] });
    const codex = createFakeBackend({ lines: () => [initLine(), resultLine({ text: 'codex' })] });
    const result = await runPipeline({
      expanded: expand(project),
      config: { ...project.config, runs: { ...project.config.runs, root: tempDir('runs-') } },
      projectRoot: project.root,
      cwd: project.root,
      adapterFor: (name) => (name === 'claude' ? claude.adapter : codex.adapter),
    });

    assert.equal(result.status, 'success');
    assert.equal(claude.invocations[0]?.resumeSession, false);
    assert.equal(codex.invocations[0]?.resumeSession, false);
    assert.notEqual(codex.invocations[0]?.sessionId, claude.invocations[0]?.sessionId);
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

/** Пайплайн с одной работой, объявляющей группу — или не объявляющей вовсе. */
function soloJob(group?: string): string {
  const decl = group === undefined ? '' : `    session_group: ${group}\n`;
  return `
kind: pipeline
name: probe
jobs:
  solo:
${decl}    steps:
      - id: one
        agent: claude
        prompt: промпт
`;
}

/** Две работы: `first` может объявить группу, `second` — никогда. */
function firstOnlyGroup(group: string): string {
  return `
kind: pipeline
name: probe
jobs:
  first:
    session_group: ${group}
    steps:
      - id: one
        agent: claude
        prompt: промпт один
  second:
    needs: [first]
    steps:
      - id: two
        agent: claude
        prompt: промпт два
`;
}

const FIVE_JOBS_TWO_GROUPS = `
kind: pipeline
name: probe
jobs:
  j1:
    session_group: grpA
    steps:
      - id: s
        agent: claude
        prompt: p
  j2:
    needs: [j1]
    session_group: grpA
    steps:
      - id: s
        agent: claude
        prompt: p
  j3:
    needs: [j2]
    session_group: grpA
    steps:
      - id: s
        agent: claude
        prompt: p
  j4:
    needs: [j3]
    session_group: grpB
    steps:
      - id: s
        agent: claude
        prompt: p
  j5:
    needs: [j4]
    session_group: grpB
    steps:
      - id: s
        agent: claude
        prompt: p
`;

/** Раскладка двух работ по группам: какая из них объявляет группу `x`. */
function twoJobLayout(options: { readonly firstGroup?: string; readonly secondGroup?: string }): string {
  const firstDecl = options.firstGroup === undefined ? '' : `    session_group: ${options.firstGroup}\n`;
  const secondDecl = options.secondGroup === undefined ? '' : `    session_group: ${options.secondGroup}\n`;
  return `
kind: pipeline
name: probe
jobs:
  first:
${firstDecl}    steps:
      - id: one
        agent: claude
        prompt: промпт один
  second:
    needs: [first]
${secondDecl}    steps:
      - id: two
        agent: claude
        prompt: промпт два
`;
}

function hashesFor(project: Project): { readonly lockHash: string; readonly stepKey: string } {
  const pipeline = expand(project).pipeline;
  const job = pipeline.jobs.find((candidate) => candidate.id === 'solo');
  assert.ok(job !== undefined, 'работа solo обязана быть в пайплайне');
  const lockHash = jobLockHash(pipeline, job);
  const stepKey = computeStepKey({
    lockHash,
    jobId: job.id,
    step: job.steps[0]!,
    inputsFingerprint: undefined,
    backendCommand: undefined,
    upstream: [],
  });
  return { lockHash, stepKey };
}

/**
 * Модель, собранная напрямую, а не через `expandPipeline`: путь к временному
 * проекту случаен между прогонами тестов, и `jobLockHash`/`serializeLock`
 * несут его в себе. Только так значение, снятое один раз на неисправленном
 * коде, остаётся сравнимым в любом следующем прогоне.
 */
const FIXED_STEP = {
  kind: 'agent' as const,
  id: 'one',
  index: 1,
  env: {},
  context: [],
  contextInherit: true,
  contextExclude: [],
  timeoutMs: 1_800_000,
  expect: [],
  attempts: { max: 1, escalation: [] },
  agent: 'claude',
  session: 'default',
  prompt: 'промпт один',
};

const FIXED_JOB: Job = {
  id: 'first',
  source: '/fixed/project/stepcast.yml',
  needs: [],
  on: 'success',
  session: 'shared',
  workspace: { mode: 'cwd' },
  env: {},
  context: [],
  contextUpstream: 'all',
  inputs: [],
  data: [],
  steps: [FIXED_STEP],
};

const FIXED_PIPELINE: Pipeline = {
  name: 'baseline',
  file: '/fixed/project/stepcast.yml',
  knowledge: {
    provider: undefined,
    command: undefined,
    dir: undefined,
    rules: undefined,
    indexMaxTokens: 8000,
    specIndexMaxTokens: 2000,
    unitMaxTokens: 1000,
    staleAfterMs: 0,
    timeoutMs: 0,
  },
  inputs: {},
  workspace: { mode: 'cwd' },
  env: {},
  envFiles: [],
  envDeny: [],
  context: [],
  contextUpstream: 'all',
  concurrency: 1,
  failFast: true,
  jobs: [FIXED_JOB],
};

const FIXED_SERIALIZED =
  'version: 1\n' +
  'kind: pipeline.lock\n' +
  'name: baseline\n' +
  'file: /fixed/project/stepcast.yml\n' +
  'inputs: {}\n' +
  'workspace:\n' +
  '  mode: cwd\n' +
  'env_deny: []\n' +
  'context_upstream: all\n' +
  'concurrency: 1\n' +
  'fail_fast: true\n' +
  'jobs:\n' +
  '  - id: first\n' +
  '    source: /fixed/project/stepcast.yml\n' +
  '    needs: []\n' +
  '    on: success\n' +
  '    session: shared\n' +
  '    workspace:\n' +
  '      mode: cwd\n' +
  '    context_upstream: all\n' +
  '    steps:\n' +
  '      - id: one\n' +
  '        index: 1\n' +
  '        timeout: 30m\n' +
  '        attempts:\n' +
  '          max: 1\n' +
  '        agent: claude\n' +
  '        session: default\n' +
  '        prompt: промпт один\n';

describe('session_group: попадает в замок и в ключ', () => {
  it('объявленная группа записывается в запись работы замка', () => {
    const project = makeProject({ 'stepcast.yml': firstOnlyGroup('build') });
    const parsed = parseYaml(serializeLock(expand(project).pipeline)) as {
      jobs: readonly Record<string, unknown>[];
    };
    const first = parsed.jobs.find((job) => job['id'] === 'first');
    assert.equal(first?.['session_group'], 'build');
  });

  it('работа без объявленной группы не несёт ключа session_group вовсе', () => {
    const project = makeProject({ 'stepcast.yml': firstOnlyGroup('build') });
    const parsed = parseYaml(serializeLock(expand(project).pipeline)) as {
      jobs: readonly Record<string, unknown>[];
    };
    const second = parsed.jobs.find((job) => job['id'] === 'second');
    assert.ok(second !== undefined);
    assert.equal('session_group' in (second as Record<string, unknown>), false);
  });

  it('пять работ двух групп восстанавливаются из разобранного замка без обращения к записям шагов', () => {
    const project = makeProject({ 'stepcast.yml': FIVE_JOBS_TWO_GROUPS });
    const parsed = parseYaml(serializeLock(expand(project).pipeline)) as {
      jobs: readonly Record<string, unknown>[];
    };

    const groups = new Map<string, string[]>();
    for (const job of parsed.jobs) {
      const group = job['session_group'];
      if (typeof group !== 'string') continue;
      const members = groups.get(group) ?? [];
      members.push(job['id'] as string);
      groups.set(group, members);
    }

    assert.deepEqual(groups.get('grpA'), ['j1', 'j2', 'j3']);
    assert.deepEqual(groups.get('grpB'), ['j4', 'j5']);
  });

  it('группа меняет jobLockHash и ключ шага; переименование и снятие возвращают их к прежним', () => {
    const project = makeProject({ 'stepcast.yml': soloJob() });
    const withoutGroup = hashesFor(project);

    project.write('stepcast.yml', soloJob('g1'));
    const withG1 = hashesFor(project);

    project.write('stepcast.yml', soloJob('g2'));
    const withG2 = hashesFor(project);

    project.write('stepcast.yml', soloJob());
    const removed = hashesFor(project);

    assert.notEqual(withG1.lockHash, withoutGroup.lockHash);
    assert.notEqual(withG1.stepKey, withoutGroup.stepKey);
    assert.notEqual(withG1.lockHash, withG2.lockHash, 'переименование группы обязано менять хеш');
    assert.notEqual(withG1.stepKey, withG2.stepKey);
    assert.equal(removed.lockHash, withoutGroup.lockHash, 'снятие объявления возвращает прежний хеш');
    assert.equal(removed.stepKey, withoutGroup.stepKey);
  });

  it('пайплайн без единой группы даёт тот же jobLockHash и ту же сериализацию, что и до правки', () => {
    assert.equal(jobLockHash(FIXED_PIPELINE, FIXED_JOB), 'fc8660e348462efc');
    assert.equal(serializeLock(FIXED_PIPELINE), FIXED_SERIALIZED);
  });

  it('раскладка работ по группам меняет pipelineLockHash', () => {
    const project = makeProject({ 'stepcast.yml': twoJobLayout({ firstGroup: 'x' }) });
    const hashA = pipelineLockHash(expand(project).pipeline);

    project.write('stepcast.yml', twoJobLayout({ secondGroup: 'x' }));
    const hashB = pipelineLockHash(expand(project).pipeline);

    assert.notEqual(hashA, hashB);
  });
});
