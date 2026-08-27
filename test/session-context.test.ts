import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createFakeBackend, initLine, resultLine } from '../src/core/backend/fake.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { findStepDir } from '../src/core/journal/reader.js';
import { runPipeline, type RunResult } from '../src/core/run/runner.js';
import type { ContextReport } from '../src/core/journal/schema.js';
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

/** Перечень источников записей состава указанного шага и итерации. */
function originsOf(result: RunResult, job: string, step: string, iteration?: number): string[] {
  const dir = findStepDir(result.journal.paths, job, step, iteration);
  assert.ok(dir !== undefined, `каталог шага ${job}/${step} не найден`);
  const report = JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8')) as ContextReport;
  return report.entries.map((entry) => entry.origin);
}

/** Унаследованные уровни — то, чего у продолжателя сессии в составе быть не должно. */
function inheritedOrigins(origins: readonly string[]): string[] {
  return origins.filter((origin) => origin === 'upstream' || origin === 'pipeline' || origin === 'job');
}

/** Отправленный шагу промпт: первая попытка либо явно указанная. */
function promptOf(result: RunResult, job: string, step: string, attempt?: number): string {
  const dir = findStepDir(result.journal.paths, job, step);
  assert.ok(dir !== undefined, `каталог шага ${job}/${step} не найден`);
  const suffix = attempt === undefined || attempt === 1 ? '' : `.${attempt}`;
  return readFileSync(join(dir, `prompt${suffix}.txt`), 'utf8');
}

const SHARED_ONCE = `
version: 1
kind: pipeline
name: shared-session-once

context:
  - text: "контекст пайплайна"

jobs:
  работа:
    session: shared
    context:
      - text: "контекст работы"
    steps:
      - id: первый
        agent: fake
        prompt: "Первый"
        context:
          - text: "контекст шага первый"
        expect: [{ exit_code: 0 }]
      - id: второй
        agent: fake
        prompt: "Второй"
        context:
          - text: "контекст шага второй"
        expect: [{ exit_code: 0 }]
`;

describe('step-context: однократность унаследованного контекста в общей сессии', () => {
  // Сценарий: «Второй шаг общей сессии»
  it('первый шаг получает пайплайн и работу, второй — только собственную запись', async () => {
    const project = makeProject({ 'stepcast.yml': SHARED_ONCE });
    const result = await run(project);
    assert.equal(result.status, 'success');

    const firstOrigins = originsOf(result, 'работа', 'первый');
    assert.ok(firstOrigins.includes('pipeline'));
    assert.ok(firstOrigins.includes('job'));

    const secondOrigins = originsOf(result, 'работа', 'второй');
    assert.deepEqual(inheritedOrigins(secondOrigins), []);
    // Пустой состав по унаследованным уровням зелёным сделал бы и шаг, вовсе
    // не собравший контекста, — собственная запись обязана быть на месте.
    assert.ok(secondOrigins.includes('step'));
  });

  // Сценарий: «Второй шаг общей сессии», второй пробник — по тексту промпта
  it('промпт второго шага не содержит текст контекста пайплайна', async () => {
    const project = makeProject({ 'stepcast.yml': SHARED_ONCE });
    const result = await run(project);

    assert.match(promptOf(result, 'работа', 'первый'), /контекст пайплайна/);
    assert.doesNotMatch(promptOf(result, 'работа', 'второй'), /контекст пайплайна/);
  });
});

const UPSTREAM_SHARED = `
version: 1
kind: pipeline
name: upstream-shared-session

jobs:
  producer:
    output:
      from: делает
    steps:
      - id: делает
        agent: fake
        prompt: "Собери факт"
        expect: [{ exit_code: 0 }]

  consumer:
    needs: [producer]
    session: shared
    steps:
      - id: первый
        agent: fake
        prompt: "Первый"
        context:
          - text: "контекст шага первый"
        expect: [{ exit_code: 0 }]
      - id: второй
        agent: fake
        prompt: "Второй"
        context:
          - text: "контекст шага второй"
        expect: [{ exit_code: 0 }]
`;

describe('step-context: блок выходов предшественников в общей сессии', () => {
  // Сценарий: продолжение «Второго шага общей сессии» блоком выходов
  it('первый шаг consumer получает блок выходов, второй — нет', async () => {
    const project = makeProject({ 'stepcast.yml': UPSTREAM_SHARED });
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
    // Первый запуск бэкенда — агентский шаг producer, отдающий структурный
    // выход; остальные — шаги consumer, которым структура не нужна.
    const backend = createFakeBackend({
      lines: (index) => [
        initLine(),
        index === 0 ? resultLine({ structured: { факт: 'значение' } }) : resultLine({ text: 'ок' }),
      ],
    });

    const result = await runPipeline({
      expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
      config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
      adapterFor: () => backend.adapter,
    });
    assert.equal(result.status, 'success');

    assert.ok(originsOf(result, 'consumer', 'первый').includes('upstream'));

    const secondOrigins = originsOf(result, 'consumer', 'второй');
    assert.deepEqual(inheritedOrigins(secondOrigins), []);
    // Тот же якорь, что и в проверке общей сессии: пустой перечень
    // унаследованных уровней обязан означать «блок выходов не повторился», а не
    // «состав не собрался вовсе».
    assert.ok(secondOrigins.includes('step'));
  });
});

const PER_STEP = `
version: 1
kind: pipeline
name: per-step-session

context:
  - text: "контекст пайплайна"

jobs:
  работа:
    session: per_step
    context:
      - text: "контекст работы"
    steps:
      - id: первый
        agent: fake
        prompt: "Первый"
        expect: [{ exit_code: 0 }]
      - id: второй
        agent: fake
        prompt: "Второй"
        expect: [{ exit_code: 0 }]
`;

describe('step-context: границы отметки об отправленном контексте', () => {
  // Сценарий: «Работа с session: per_step»
  it('session: per_step — каждый шаг получает унаследованный контекст сам', async () => {
    const project = makeProject({ 'stepcast.yml': PER_STEP });
    const result = await run(project);
    assert.equal(result.status, 'success');

    for (const step of ['первый', 'второй']) {
      const origins = originsOf(result, 'работа', step);
      assert.ok(origins.includes('pipeline'), `${step}: ожидался origin pipeline`);
      assert.ok(origins.includes('job'), `${step}: ожидался origin job`);
    }
  });

  const SAME_SESSION_NAME = `
version: 1
kind: pipeline
name: same-session-name

context:
  - text: "контекст пайплайна"

jobs:
  первая:
    session: shared
    context:
      - text: "контекст работы первая"
    steps:
      - id: шаг
        agent: fake
        prompt: "Первая работа"
        expect: [{ exit_code: 0 }]

  вторая:
    session: shared
    context:
      - text: "контекст работы вторая"
    steps:
      - id: шаг
        agent: fake
        prompt: "Вторая работа"
        expect: [{ exit_code: 0 }]
`;

  // Сценарий: «Одноимённая сессия соседней работы»
  it('одноимённая сессия соседней работы получает унаследованный контекст самостоятельно', async () => {
    const project = makeProject({ 'stepcast.yml': SAME_SESSION_NAME });
    const result = await run(project);
    assert.equal(result.status, 'success');

    assert.ok(originsOf(result, 'первая', 'шаг').includes('pipeline'));
    assert.ok(originsOf(result, 'вторая', 'шаг').includes('pipeline'));
  });

  const UNTIL_BOUNDARY = `
version: 1
kind: pipeline
name: until-context-boundary

context:
  - text: "контекст пайплайна"

jobs:
  работа:
    session: shared
    context:
      - text: "контекст работы"
    until:
      max_iterations: 2
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

  // Сценарий: «Новая итерация цикла»
  it('новая итерация until начинает сессию заново и получает контекст снова', async () => {
    const project = makeProject({ 'stepcast.yml': UNTIL_BOUNDARY });
    const result = await run(project);
    assert.equal(result.status, 'success');

    for (const iteration of [1, 2]) {
      const origins = originsOf(result, 'работа', 'думает', iteration);
      assert.ok(origins.includes('pipeline'), `итерация ${iteration}: ожидался origin pipeline`);
      assert.ok(origins.includes('job'), `итерация ${iteration}: ожидался origin job`);
    }
  });

  const RETRY_BOUNDARY = `
version: 1
kind: pipeline
name: retry-context-boundary

context:
  - text: "контекст пайплайна"

jobs:
  работа:
    session: per_step
    steps:
      - id: думает
        agent: fake
        prompt: "Сделай дело"
        attempts: { max: 2 }
        expect: [{ matches: "готово" }]
`;

  // Сценарий: «Повторная попытка шага»
  it('повторная попытка внутри шага унаследованный контекст заново не получает', async () => {
    const project = makeProject({ 'stepcast.yml': RETRY_BOUNDARY });
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
    const backend = createFakeBackend({
      lines: (index) => [initLine(), resultLine({ text: index === 0 ? 'мимо' : 'готово' })],
    });

    const result = await runPipeline({
      expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
      config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
      adapterFor: () => backend.adapter,
    });
    assert.equal(result.status, 'success');
    assert.equal(backend.invocations.length, 2, 'вторая попытка обязана состояться');

    assert.match(promptOf(result, 'работа', 'думает', 1), /контекст пайплайна/);
    assert.doesNotMatch(promptOf(result, 'работа', 'думает', 2), /контекст пайплайна/);

    // `context.json` у шага один и перезаписывается каждой попыткой — к
    // моменту финального успеха он отражает сборку второй попытки, где
    // унаследованного контекста уже нет. Сравнивать составы обеих попыток
    // поэтому нельзя, только промпты — они сохраняются в отдельные файлы.
    assert.deepEqual(inheritedOrigins(originsOf(result, 'работа', 'думает')), []);
  });
});
