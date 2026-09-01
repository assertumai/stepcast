import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { expandPipeline } from '../src/core/pipeline/expand.js';
import { runPipeline } from '../src/core/run/runner.js';
import type { Config } from '../src/core/config/resolve.js';
import { makeProject, type Project } from './helpers.js';

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

/** Единица знания с якорем в пустоту — красное нарушение по любому источнику. */
const BROKEN_UNIT = [
  '---',
  'id: broken',
  'title: Единица с якорем в пустоту',
  'scope:',
  '  - src/**',
  'anchors:',
  '  - path: src/нет.ts',
  '    rev: abc1234',
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
  const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
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
