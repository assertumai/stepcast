import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { expandPipeline } from '../src/core/pipeline/expand.js';
import { readStatus } from '../src/core/journal/reader.js';
import { evaluatePredicates } from '../src/core/expect/evaluate.js';
import { runPipeline, type RunResult } from '../src/core/run/runner.js';
import { makeProject, type Project } from './helpers.js';

async function run(project: Project): Promise<RunResult> {
  const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
  return runPipeline({
    expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
    config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
    projectRoot: project.root,
    cwd: project.root,
  });
}

/** Пайплайн, в котором шаг пишет указанный файл и объявляет границы. */
function bounded(command: string, globs: string): string {
  return `
version: 1
kind: pipeline
name: границы
jobs:
  работа:
    steps:
      - id: пишет
        run: [sh, -c, '${command}']
        expect:
          - exit_code: 0
          - changed_only: ${globs}
`;
}

describe('result-contract: предикат границ изменений', () => {
  // Сценарий: «Изменения в границах»
  it('проходит, когда все изменения попали под шаблоны', async () => {
    const project = makeProject({ 'stepcast.yml': bounded('mkdir -p src && echo код > src/a.ts', '["src/**"]') });
    const result = await run(project);

    assert.equal(result.status, 'success');
  });

  // Сценарий: «Изменение за границей»
  it('не проходит и перечисляет вышедшие за границу пути', async () => {
    const project = makeProject({
      'stepcast.yml': bounded('mkdir -p src && echo код > src/a.ts && echo лишнее > package.json', '["src/**"]'),
    });
    const result = await run(project);

    assert.equal(result.status, 'failed');
    const step = readStatus(result.journal.paths).jobs[0]?.steps[0];
    assert.match(step?.reason ?? '', /package\.json/);
  });

  // Сценарий: «Шаг ничего не изменил»
  it('проходит для шага, не изменившего дерево', async () => {
    const project = makeProject({ 'stepcast.yml': bounded('true', '["src/**"]') });
    const result = await run(project);

    assert.equal(result.status, 'success');
  });

  // Сценарий: «Игнорируемые пути не учитываются»
  it('не учитывает пути, невидимые для правил игнорирования', async () => {
    const project = makeProject({
      '.gitignore': 'мусор/\n',
      'stepcast.yml': bounded('mkdir -p мусор && echo шум > мусор/файл.txt', '["src/**"]'),
    });
    const result = await run(project);

    assert.equal(result.status, 'success', 'игнорируемый путь границ не нарушает');
  });

  // Сценарий: «Якорь недоступен»
  it('помечается невычисленным, а не непройденным, когда состояние недоступно', () => {
    const results = evaluatePredicates(
      [{ kind: 'changed_only', globs: ['src/**'] }],
      {
        exitCode: 0,
        text: '',
        structured: undefined,
        cwd: process.cwd(),
        env: {},
        changedPaths: undefined,
      },
    );

    const predicate = results.find((item) => item.predicate === 'changed_only');
    assert.equal(predicate?.passed, true, 'неудача учёта не должна становиться отказом');
    assert.equal(predicate?.hard, false);
    assert.match(predicate?.detail ?? '', /не вычислен/);
  });
});

describe('result-contract: сопоставление путей с шаблонами', () => {
  const check = (globs: string[], paths: string[]) =>
    evaluatePredicates([{ kind: 'changed_only', globs }], {
      exitCode: 0,
      text: '',
      structured: undefined,
      cwd: process.cwd(),
      env: {},
      changedPaths: paths,
    })[0];

  it('`**` пересекает разделители, `*` — нет', () => {
    assert.equal(check(['src/**'], ['src/deep/nested/a.ts'])?.passed, true);
    assert.equal(check(['src/*'], ['src/deep/nested/a.ts'])?.passed, false);
    assert.equal(check(['src/*.ts'], ['src/a.ts'])?.passed, true);
  });

  it('перечисляет только вышедшие за границу пути', () => {
    const result = check(['src/**'], ['src/a.ts', 'docs/b.md', 'package.json']);
    assert.deepEqual(result?.actual, ['docs/b.md', 'package.json']);
  });
});
