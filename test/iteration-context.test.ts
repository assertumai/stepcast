import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createFakeBackend, initLine, resultLine } from '../src/core/backend/fake.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { findStepDir, readStatus } from '../src/core/journal/reader.js';
import { runPipeline, type RunResult } from '../src/core/run/runner.js';
import { readSourceRun } from '../src/core/run/resumePlan.js';
import { buildPreviousFailure } from '../src/core/run/previousFailure.js';
import { makeProject, type Project } from './helpers.js';

/** Прогон с поддельным бэкендом: важен контекст, а не настоящая модель. */
async function run(project: Project): Promise<RunResult> {
  const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
  const backend = createFakeBackend({ lines: [initLine(), resultLine({ text: 'ок' })] });

  return runPipeline({
    expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
    config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
    projectRoot: project.root,
    cwd: project.root,
    adapterFor: () => backend.adapter,
  });
}

/** Отправленный шагу промпт указанной итерации. */
function promptOf(result: RunResult, job: string, step: string, iteration?: number): string {
  const dir = findStepDir(result.journal.paths, job, step, iteration);
  assert.ok(dir !== undefined, `каталог шага ${job}/${step} не найден`);
  return readFileSync(join(dir, 'prompt.txt'), 'utf8');
}

const LOOPING = `
version: 1
kind: pipeline
name: контекст-итерации
jobs:
  работа:
    session: per_step
    until:
      max_iterations: 3
      check:
        - cmd: "test -f готово.txt"
    steps:
      - id: думает
        agent: fake
        prompt: "Сделай дело"
        expect: [{ exit_code: 0 }]
      - id: отмечает
        run: [sh, -c, 'test -f счётчик.txt && touch готово.txt || touch счётчик.txt']
        expect: [{ exit_code: 0 }]
`;

describe('step-context: результат непрошедшей проверки в следующей итерации', () => {
  // Сценарий: «На первой итерации записи нет»
  it('не подмешивает результат проверки на первой итерации', async () => {
    const project = makeProject({ 'stepcast.yml': LOOPING });
    const result = await run(project);

    assert.equal(result.status, 'success');
    assert.ok(
      !promptOf(result, 'работа', 'думает', 1).includes('Проверка предыдущей итерации'),
      'первой итерации предъявлять нечего',
    );
  });

  // Сценарий: «Вывод проверки подмешан»
  it('подмешивает результат непрошедшей проверки на следующей итерации', async () => {
    const project = makeProject({ 'stepcast.yml': LOOPING });
    const result = await run(project);

    const second = promptOf(result, 'работа', 'думает', 2);
    assert.match(second, /Проверка предыдущей итерации не прошла/);
    assert.match(second, /cmd/);
  });

  // Сценарий: «Берётся только предыдущая итерация»
  it('не накапливает результаты нескольких прошлых итераций', async () => {
    const project = makeProject({ 'stepcast.yml': LOOPING });
    const result = await run(project);

    const second = promptOf(result, 'работа', 'думает', 2);
    const occurrences = second.split('Проверка предыдущей итерации не прошла').length - 1;
    assert.equal(occurrences, 1, 'запись должна быть ровно одна');
  });

  // Сценарий: «Запись учитывается в составе контекста»
  it('включает запись в фиксируемый состав контекста', async () => {
    const project = makeProject({ 'stepcast.yml': LOOPING });
    const result = await run(project);

    const dir = findStepDir(result.journal.paths, 'работа', 'думает', 2);
    assert.ok(dir !== undefined);
    const report = JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8')) as {
      entries: { origin: string; kind: string }[];
      total_tokens: number;
    };

    assert.ok(
      report.entries.some((entry) => entry.origin === 'step' && entry.kind === 'text'),
      'запись должна быть видна в составе контекста',
    );
    assert.ok(report.total_tokens > 0, 'и учитываться в размере контекста');
  });
});

describe('step-context: выдержка о прошлом отказе', () => {
  // Сценарий: «Запись добавлена первому переисполняемому шагу»
  it('попадает в контекст первого переисполняемого шага и только в него', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: возобновление-с-контекстом
jobs:
  работа:
    session: per_step
    steps:
      - id: думает
        agent: fake
        prompt: "Сделай дело"
        expect: [{ exit_code: 0 }]
      - id: тоже-думает
        agent: fake
        prompt: "И ещё одно"
        expect: [{ exit_code: 0 }]
      - id: падает
        run: [sh, -c, 'exit 4']
        expect: [{ exit_code: 0 }]
`,
    });

    const first = await run(project);
    assert.equal(first.status, 'failed');

    const source = readSourceRun(first.journal.paths);
    const note = buildPreviousFailure(source.paths, source.status);
    assert.ok(note !== undefined);

    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
    const backend = createFakeBackend({ lines: [initLine(), resultLine({ text: 'ок' })] });
    const second = await runPipeline({
      expanded: expandPipeline({
        pipelinePath: project.path('stepcast.yml'),
        config: project.config,
      }),
      config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
      adapterFor: () => backend.adapter,
      resume: {
        source,
        plan: {
          sourceRunId: source.manifest.run_id,
          steps: [
            { job: 'работа', step: 'думает', decision: { kind: 'rerun', reason: 'проверка' } },
            { job: 'работа', step: 'тоже-думает', decision: { kind: 'rerun', reason: 'проверка' } },
            { job: 'работа', step: 'падает', decision: { kind: 'rerun', reason: 'проверка' } },
          ],
          outputs: new Map(),
          observedInputs: new Map(),
          fromScratch: true,
        },
      },
    });

    const firstPrompt = promptOf(second, 'работа', 'думает');
    const secondPrompt = promptOf(second, 'работа', 'тоже-думает');

    assert.match(firstPrompt, /Прошлый прогон не дошёл до конца/);
    assert.ok(
      !secondPrompt.includes('Прошлый прогон не дошёл до конца'),
      'второй шаг выдержку не получает',
    );
    assert.equal(readStatus(second.journal.paths).resumed_from, first.journal.paths.runId);
  });
});
