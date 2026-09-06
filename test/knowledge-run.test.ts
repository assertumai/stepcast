import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { expandPipeline } from '../src/core/pipeline/expand.js';
import { readStatus } from '../src/core/journal/reader.js';
import { runPipeline, type RunResult } from '../src/core/run/runner.js';
import type { Config } from '../src/core/config/resolve.js';
import { anchorHash, makeProject, type Project } from './helpers.js';
import { tempDir } from './tmp.js';

/**
 * Источник знания заводится по рабочей директории **работы**, а не по каталогу
 * запуска.
 *
 * Проверяется на режиме `worktree`, потому что только там эти два каталога
 * расходятся. Источник, привязанный к каталогу запуска, отвечал бы на вопрос
 * про главное дерево: предикат `knowledge_valid` зеленел бы на памяти,
 * которую шаг только что сломал в своей копии, и краснел бы на чужой,
 * досведённой, — то есть был бы декорацией.
 */

function withKnowledge(project: Project): Config {
  return {
    ...project.config,
    project: {
      ...project.config.project,
      knowledge: { ...project.config.project.knowledge, provider: 'fs', dir: 'knowledge' },
    },
  };
}

function gitInit(project: Project): void {
  const run = (...args: string[]): void => {
    execFileSync('git', ['-C', project.root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  };
  run('init', '--quiet', '--initial-branch=main');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Тест');
  run('add', '-A');
  run('commit', '--quiet', '-m', 'первый');
}

function commit(project: Project, message: string): void {
  execFileSync('git', ['-C', project.root, 'add', '-A'], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['-C', project.root, 'commit', '--quiet', '-m', message], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Единица знания с якорем в пустоту — красное нарушение по любому источнику. */
const BROKEN_UNIT = [
  '---',
  'id: broken',
  'title: Единица с якорем в пустоту',
  'scope:',
  '  - src/**',
  'anchors:',
  '  - src/нет.ts',
  'status: active',
  '---',
  '',
  'Тело.',
  '',
].join('\n');

async function runWith(pipeline: string): Promise<Awaited<ReturnType<typeof runPipeline>>> {
  const project = makeProject({
    'stepcast.yml': pipeline,
    'knowledge/.keep': '',
    // Заготовка лежит вне каталога знания и попадает в коммит: шаг копирует
    // её внутрь уже в своей копии дерева, а главное дерево остаётся целым —
    // ровно та расстановка, на которой источник по каталогу запуска ошибся бы.
    'broken-unit.md': BROKEN_UNIT,
    'src/есть.ts': 'export const a = 1;\n',
  });
  gitInit(project);

  const config = withKnowledge(project);
  const runsRoot = tempDir('runs-');
  const expanded = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config });

  return runPipeline({
    expanded,
    config: { ...config, runs: { ...config.runs, root: runsRoot } },
    projectRoot: project.root,
    cwd: project.root,
  });
}

describe('knowledge-source: источник заводится по дереву работы', () => {
  it('предикат видит память, сломанную шагом в копии дерева, и валит его', async () => {
    const result = await runWith(`
version: 1
kind: pipeline
name: память
workspace: { mode: worktree }
jobs:
  ломает:
    steps:
      - id: write
        run: [cp, broken-unit.md, knowledge/broken.md]
        expect:
          - knowledge_valid: true
`);

    assert.equal(result.status, 'failed');
  });

  it('целая память той же копии предикат проходит', async () => {
    const result = await runWith(`
version: 1
kind: pipeline
name: память
workspace: { mode: worktree }
jobs:
  не-ломает:
    steps:
      - id: write
        run: [echo, ok]
        expect:
          - knowledge_valid: true
`);

    assert.equal(result.status, 'success');
  });

  it('отбор идёт по дереву работы: единица, заведённая шагом, видна следующему', async () => {
    const result = await runWith(`
version: 1
kind: pipeline
name: память
workspace: { mode: worktree }
jobs:
  ломает:
    steps:
      - id: write
        run: [cp, broken-unit.md, knowledge/broken.md]
        expect: [{ exit_code: 0 }]
      - id: check
        run: [echo, ok]
        expect:
          - knowledge_valid: true
`);

    // Второй шаг той же работы читает то же дерево — сломанное первым.
    assert.equal(result.status, 'failed');
  });
});

describe('knowledge-source: --record внутри шага прогона', () => {
  /** Шаг, зовущий настоящий CLI движка через `$STEPCAST_BIN` — так же, как это делает работа `merge`. */
  function pipelineCalling(record: boolean): string {
    return `
version: 1
kind: pipeline
name: датирование
workspace: { mode: worktree }
jobs:
  проверка:
    steps:
      - id: check
        run: 'node "$STEPCAST_BIN" knowledge check${record ? ' --record' : ''}'
        expect: [{ exit_code: 0 }]
`;
  }

  /** Дерево с одним недатированным расхождением по якорю, готовое к запуску пайплайна. */
  function staleProject(record: boolean): Project {
    const project = makeProject({
      '.stepcast/config.yml': 'project:\n  knowledge:\n    provider: fs\n    dir: knowledge\n',
      'src/a.ts': 'export const a = 1;\n',
      'stepcast.yml': pipelineCalling(record),
    });
    gitInit(project);
    const hash = anchorHash(project.path('src/a.ts'));

    project.write('src/a.ts', 'export const a = 2;\n');
    project.write(
      'knowledge/a.md',
      [
        '---',
        'id: a',
        'title: Первая',
        'scope:',
        '  - src/**',
        'anchors:',
        '  - path: src/a.ts',
        `    hash: '${hash}'`,
        'status: active',
        '---',
        '',
        'Тело.',
        '',
      ].join('\n'),
    );
    commit(project, 'второй');
    return project;
  }

  async function runOn(project: Project): Promise<{ result: RunResult; anchorText: string }> {
    const runsRoot = tempDir('runs-');
    const expanded = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config });
    const result = await runPipeline({
      expanded,
      config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
    });
    const workspace = readStatus(result.journal.paths).jobs.find((job) => job.id === 'проверка')?.workspace;
    assert.ok(workspace !== undefined, 'у работы «проверка» должна быть рабочая директория');
    return { result, anchorText: readFileSync(join(workspace.path, 'knowledge/a.md'), 'utf8') };
  }

  // Задача 4.11, первая половина
  it('stepcast knowledge check --record правит шапку единицы в дереве работы', async () => {
    const { result, anchorText } = await runOn(staleProject(true));

    assert.equal(result.status, 'success');
    assert.match(anchorText, /stale_since:/);
  });

  // Задача 4.11, вторая половина
  it('stepcast knowledge check без --record дерево работы не трогает', async () => {
    const { result, anchorText } = await runOn(staleProject(false));

    assert.equal(result.status, 'success');
    assert.doesNotMatch(anchorText, /stale_since:/);
  });
});
