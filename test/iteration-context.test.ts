import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createFakeBackend, initLine, resultLine } from '../src/core/backend/fake.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { findStepDir, readStatus, readEvents } from '../src/core/journal/reader.js';
import { runPipeline, type RunResult } from '../src/core/run/runner.js';
import { readSourceRun } from '../src/core/run/resumePlan.js';
import { buildPreviousFailure } from '../src/core/run/previousFailure.js';
import { buildIterationNote } from '../src/core/run/iterationNote.js';
import type { PredicateResult } from '../src/core/journal/schema.js';
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

const VERBOSE_CHECK_LOOPING = `
version: 1
kind: pipeline
name: многословная-проверка
jobs:
  работа:
    session: per_step
    until:
      max_iterations: 3
      check:
        - cmd: "for i in $(seq 1 3000); do echo \\"строка $i с довольно длинным заполнителем\\"; done; exit 1"
    steps:
      - id: думает
        agent: fake
        prompt: "Сделай дело"
        context_max_tokens: 8k
        expect: [{ exit_code: 0 }]
      - id: отмечает
        run: [sh, -c, 'exit 0']
        expect: [{ exit_code: 0 }]
`;

describe('step-context: многословная проверка не срывает следующую итерацию', () => {
  // Сценарий: «Многословная проверка не срывает следующую итерацию»
  it('усекает выдержку и проходит вторую итерацию вместо отказа по пределу', async () => {
    const project = makeProject({ 'stepcast.yml': VERBOSE_CHECK_LOOPING });
    const result = await run(project);

    const second = promptOf(result, 'работа', 'думает', 2);
    assert.match(second, /Проверка предыдущей итерации не прошла/);
    assert.match(second, /отброшено строк/);

    const events = readEvents(result.journal.paths);
    const truncated = events.find((event) => event.kind === 'context.note_truncated');
    assert.ok(truncated !== undefined, 'должно быть записано событие об усечении');
    if (truncated?.kind === 'context.note_truncated') {
      assert.equal(truncated.job, 'работа');
      assert.equal(truncated.step, 'думает');
      assert.ok(truncated.original_tokens > truncated.final_tokens);
    }
  });
});

const RETRYING_VERBOSE = `
version: 1
kind: pipeline
name: повторная-попытка
jobs:
  работа:
    session: per_step
    until:
      max_iterations: 2
      check:
        - cmd: "for i in $(seq 1 3000); do echo \\"строка $i с довольно длинным заполнителем\\"; done; exit 1"
    steps:
      - id: думает
        agent: fake
        prompt: "Сделай дело"
        context_max_tokens: 8k
        attempts: { max: 2 }
        expect: [{ matches: "готово" }]
`;

describe('step-context: событие об усечении не двоится по попыткам', () => {
  it('пишет одно событие на шаг, сколько бы попыток он ни сделал', async () => {
    const project = makeProject({ 'stepcast.yml': RETRYING_VERBOSE });
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
    // Вторая итерация с первой попытки не проходит предикат: промпт с
    // выдержкой собирается дважды, а усечение у него одно.
    const backend = createFakeBackend({
      lines: (index) => [initLine(), resultLine({ text: index === 1 ? 'мимо' : 'готово' })],
    });

    const result = await runPipeline({
      expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
      config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
      adapterFor: () => backend.adapter,
    });

    const truncations = readEvents(result.journal.paths).filter(
      (event) => event.kind === 'context.note_truncated',
    );
    assert.equal(backend.invocations.length, 3, 'вторая итерация должна повторить попытку');
    assert.equal(truncations.length, 1, 'событие об усечении должно быть одно');
  });
});

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

function predicateResult(predicate: string, detail: string): PredicateResult {
  return { predicate, passed: false, hard: true, detail };
}

/** Закрывающая фраза выдержки — каркас, который усечение обязано сохранить. */
const CLOSING = 'Это та же работа, следующий заход. Почини причину.';

describe('step-context: усечение выдержки о прошлой итерации', () => {
  // Сценарий: «Короткая выдержка не трогается»
  it('не меняет выдержку, укладывающуюся в предел', () => {
    const failed = [predicateResult('cmd', 'коротко')];
    const result = buildIterationNote(failed, 4000);

    assert.equal(result.truncation, undefined);
    assert.match(result.text, /коротко/);
  });

  // Сценарий: «Сохраняется конец вывода» и «Усечение помечено»
  it('усекает многословный вывод, сохраняя его конец и помечая усечение', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `строка вывода номер ${i}`);
    const failed = [predicateResult('cmd', lines.join('\n'))];
    const result = buildIterationNote(failed, 200);

    assert.ok(result.truncation !== undefined);
    assert.ok(result.truncation.originalTokens > result.truncation.finalTokens);
    assert.match(result.text, /отброшено строк/);
    assert.match(result.text, /строка вывода номер 199/, 'должен остаться конец вывода');
    assert.ok(!result.text.includes('строка вывода номер 0\n'), 'начало вывода отброшено');
  });

  // Сценарий: «Целые строки»
  it('не оставляет частичных строк в усечённой выдержке', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `вывод ${i} с довольно длинным заполнителем`);
    const failed = [predicateResult('cmd', lines.join('\n'))];
    const result = buildIterationNote(failed, 150);

    assert.ok(result.truncation !== undefined);
    // Всё, что не каркас записи и не пометка, обязано совпадать с исходной
    // строкой целиком: обрывок исходной строкой не является и тест валит.
    const kept = result.text
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('- `') && !line.startsWith('[…'));
    assert.ok(kept.length > 1, 'в выдержке должны остаться строки вывода');
    for (const line of kept.slice(0, -1)) {
      assert.ok(lines.includes(line), `строка должна быть целой: ${line}`);
    }
    assert.equal(kept.at(-1), CLOSING);
  });

  // Ветка «строка длиннее всей доли»: единственная строка вывода не влезает
  // даже целиком отведённой ей долей.
  it('обрезает единственную длинную строку по хвосту и помечает обрезку', () => {
    const line = `${'начало вывода, '.repeat(200)}существенный хвост`;
    const failed = [predicateResult('cmd', line)];
    const result = buildIterationNote(failed, 90);

    assert.ok(result.truncation !== undefined);
    assert.ok(result.truncation.finalTokens <= 90, 'выдержка обязана уложиться в предел');
    assert.match(result.text, /начало строки обрезано/);
    assert.match(result.text, /существенный хвост/);
    assert.equal(result.text.split('\n').filter((item) => item.includes('начало вывода')).length, 1);
  });

  // Предел, в который не влезают даже имена всех непрошедших предикатов:
  // выдержка обязана уложиться в него всё равно — иначе она сорвёт сборку
  // контекста тем самым отказом, который усечение и предотвращает.
  it('укладывается в предел, когда предикатов больше, чем помещается', () => {
    const failed = Array.from({ length: 8 }, (_, i) =>
      predicateResult(`предикат-${i}`, Array.from({ length: 20 }, (_, j) => `строка ${j}`).join('\n')),
    );
    const result = buildIterationNote(failed, 60);

    assert.ok(result.truncation !== undefined);
    assert.ok(
      result.truncation.finalTokens <= 60,
      `выдержка в ${result.truncation.finalTokens} ток. превысила предел 60`,
    );
    assert.ok(result.truncation.droppedLines > 0, 'отчёт должен называть число отброшенных строк');
  });

  // Сценарий: «Несколько непрошедших предикатов делят предел»
  it('сохраняет вывод всех непрошедших предикатов, даже если один многословен', () => {
    const verbose = Array.from({ length: 200 }, (_, i) => `многословная строка ${i}`).join('\n');
    const failed = [predicateResult('болтливый', verbose), predicateResult('короткий', 'проблема тут')];
    const result = buildIterationNote(failed, 300);

    assert.ok(result.truncation !== undefined);
    assert.match(result.text, /болтливый/);
    assert.match(result.text, /короткий/);
    assert.match(result.text, /проблема тут/);
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
          ignoredEdits: [],
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
