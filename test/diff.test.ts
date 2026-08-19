import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createAnchorer, detectAnchorKind, manifestStore } from '../src/core/anchor/index.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { resolveRun } from '../src/core/journal/reader.js';
import { describeComparison, diffRuns, lineDiff } from '../src/core/run/diff.js';
import { runPipeline, type RunResult } from '../src/core/run/runner.js';
import { StepcastError } from '../src/core/errors.js';
import { makeProject, type Project } from './helpers.js';

interface Bed {
  readonly project: Project;
  readonly runsRoot: string;
}

function bed(files: Readonly<Record<string, string>>): Bed {
  return { project: makeProject(files), runsRoot: mkdtempSync(join(tmpdir(), 'stepcast-runs-')) };
}

async function run(b: Bed): Promise<RunResult> {
  return runPipeline({
    expanded: expandPipeline({ pipelinePath: b.project.path('stepcast.yml'), config: b.project.config }),
    config: { ...b.project.config, runs: { ...b.project.config.runs, root: b.runsRoot } },
    projectRoot: b.project.root,
    cwd: b.project.root,
  });
}

function compare(b: Bed, a: RunResult, c: RunResult) {
  const anchorKind = detectAnchorKind(b.project.root);
  const stateDir = mkdtempSync(join(tmpdir(), 'stepcast-diff-'));
  const anchorer = createAnchorer({
    dir: b.project.root,
    stateDir,
    kind: anchorKind,
    scope: 'diff',
    readStores: [manifestStore(a.journal.paths.anchors), manifestStore(c.journal.paths.anchors)],
  });
  try {
    return diffRuns({ a: a.journal.paths, b: c.journal.paths, anchorer });
  } finally {
    anchorer.dispose();
  }
}

const PIPELINE = `
version: 1
kind: pipeline
name: сравнение
jobs:
  работа:
    session: per_step
    inputs: [сырьё.txt]
    steps:
      - id: шаг
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
`;

describe('run-diff: сопоставление по ключам', () => {
  // Сценарий: «Идентичные прогоны»
  it('сообщает об отсутствии различий для совпавших прогонов', async () => {
    const b = bed({ 'сырьё.txt': 'вход', 'stepcast.yml': PIPELINE });
    const first = await run(b);
    const second = await run(b);

    const comparison = compare(b, first, second);
    assert.equal(comparison.identical, true);
    assert.ok(describeComparison(comparison).some((line) => line.includes('различий нет')));
  });

  // Сценарий: «Шаг изменился»
  it('относит шаг с разошедшимся ключом к различающимся', async () => {
    const b = bed({ 'сырьё.txt': 'вход', 'stepcast.yml': PIPELINE });
    const first = await run(b);

    b.project.write('сырьё.txt', 'другой вход');
    const second = await run(b);

    const comparison = compare(b, first, second);
    assert.equal(comparison.identical, false);
    assert.equal(comparison.steps[0]?.category, 'changed');
  });

  // Сценарий: «Шаг есть только в одном прогоне»
  it('различает шаги, появившиеся только в одном прогоне', async () => {
    const b = bed({ 'сырьё.txt': 'вход', 'stepcast.yml': PIPELINE });
    const first = await run(b);

    b.project.write(
      'stepcast.yml',
      PIPELINE.replace(
        '        expect: [{ exit_code: 0 }]',
        `        expect: [{ exit_code: 0 }]
      - id: добавленный
        run: [echo, новый]
        expect: [{ exit_code: 0 }]`,
      ),
    );
    const second = await run(b);

    const comparison = compare(b, first, second);
    const added = comparison.steps.find((step) => step.step === 'добавленный');
    assert.equal(added?.category, 'only-b');
    assert.ok(
      describeComparison(comparison).some((line) => line.includes('есть только в')),
    );
  });

  // Сценарий: «Порядок вывода»
  it('выводит шаги в порядке исполнения', async () => {
    const b = bed({
      'сырьё.txt': 'вход',
      'stepcast.yml': `
version: 1
kind: pipeline
name: порядок
jobs:
  первая:
    steps:
      - id: a
        run: [echo, a]
        expect: [{ exit_code: 0 }]
  вторая:
    needs: [первая]
    steps:
      - id: b
        run: [echo, b]
        expect: [{ exit_code: 0 }]
`,
    });
    const first = await run(b);
    const second = await run(b);

    const comparison = compare(b, first, second);
    assert.deepEqual(
      comparison.steps.map((step) => `${step.job}/${step.step}`),
      ['первая/a', 'вторая/b'],
    );
  });
});

describe('run-diff: чем именно различаются шаги', () => {
  // Сценарий: «Шаг команды без контекста»
  it('помечает отсутствующий источник отсутствующим, а не пустым', async () => {
    const b = bed({ 'сырьё.txt': 'вход', 'stepcast.yml': PIPELINE });
    const first = await run(b);
    b.project.write('сырьё.txt', 'другой вход');
    const second = await run(b);

    const step = compare(b, first, second).steps[0];
    const prompt = step?.sources.find((source) => source.source === 'промпт');

    assert.equal(prompt?.missing, 'both', 'у командного шага промпта нет вовсе');
    assert.deepEqual(prompt?.lines, []);
  });

  // Сценарий: «Разошлись деревья»
  it('перечисляет различающиеся пути деревьев', async () => {
    const b = bed({
      'сырьё.txt': 'вход',
      'stepcast.yml': `
version: 1
kind: pipeline
name: деревья
jobs:
  работа:
    steps:
      - id: пишет
        run: [sh, -c, 'cat сырьё.txt > произведённый.txt']
        expect: [{ exit_code: 0 }]
`,
    });
    const first = await run(b);

    b.project.write('сырьё.txt', 'другой вход');
    const second = await run(b);

    const step = compare(b, first, second).steps[0];
    const tree = step?.sources.find((source) => source.source === 'дерево');

    assert.ok(tree !== undefined);
    assert.ok(
      tree.lines.some((line) => line.includes('произведённый.txt')),
      `ожидались изменившиеся пути, получено: ${JSON.stringify(tree.lines)}`,
    );
  });

  // Совпавший источник не выводится вовсе: показывать «проверки: без
  // изменений» значит топить настоящее различие в шуме.
  it('группирует различия по источнику и молчит о совпавших', async () => {
    const b = bed({ 'сырьё.txt': 'вход', 'stepcast.yml': PIPELINE });
    const first = await run(b);
    b.project.write('сырьё.txt', 'другой');
    const second = await run(b);

    const sources = compare(b, first, second).steps[0]?.sources ?? [];
    const names = sources.map((item) => item.source);

    assert.equal(new Set(names).size, names.length, 'источник не должен повторяться');
    assert.ok(names.every((name) => ['промпт', 'контекст', 'проверки', 'дерево'].includes(name)));
    assert.ok(
      !names.includes('проверки'),
      'результаты предикатов совпали и в выводе не участвуют',
    );
    assert.ok(names.includes('дерево'));
  });
});

describe('run-diff: несравнимые прогоны', () => {
  // Сценарий: «Разные проекты»
  it('отклоняет сравнение прогонов разных проектов', async () => {
    const one = bed({ 'сырьё.txt': 'вход', 'stepcast.yml': PIPELINE });
    const two = bed({ 'сырьё.txt': 'вход', 'stepcast.yml': PIPELINE });

    const a = await run(one);
    const c = await run(two);

    assert.throws(
      () => diffRuns({ a: a.journal.paths, b: c.journal.paths }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /разным проектам/);
        return true;
      },
    );
  });

  // Сценарий: «Разные пайплайны»
  it('сравнивает прогоны разных пайплайнов, отмечая несовпадение', async () => {
    const b = bed({ 'сырьё.txt': 'вход', 'stepcast.yml': PIPELINE });
    const first = await run(b);

    b.project.write('stepcast.yml', PIPELINE.replace('name: сравнение', 'name: другое-имя'));
    const second = await run(b);

    const comparison = compare(b, first, second);
    assert.ok(comparison.notes.some((note) => note.includes('пайплайны различаются')));
  });
});

describe('run-diff: адресация прогонов', () => {
  it('разрешает короткий идентификатор и указатель на последний', async () => {
    const b = bed({ 'сырьё.txt': 'вход', 'stepcast.yml': PIPELINE });
    const first = await run(b);

    const short = first.journal.paths.runId.slice(first.journal.paths.runId.lastIndexOf('-') + 1);
    assert.equal(resolveRun(b.runsRoot, b.project.root, short).runId, first.journal.paths.runId);
  });
});

describe('run-diff: построчное сравнение', () => {
  it('показывает удалённые и добавленные строки', () => {
    const lines = lineDiff('один\nдва\nтри\n', 'один\nдругая\nтри\n');
    assert.deepEqual(lines, ['  - два', '  + другая']);
  });

  it('на одинаковом тексте различий не даёт', () => {
    assert.deepEqual(lineDiff('одинаково', 'одинаково'), []);
  });
});
