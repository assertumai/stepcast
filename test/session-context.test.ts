import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createFakeBackend, initLine, resultLine } from '../src/core/backend/fake.js';
import type { BackendConfig } from '../src/core/config/resolve.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { findStepDir, readEvents, resolveRun } from '../src/core/journal/reader.js';
import { planResume, readSourceRun } from '../src/core/run/resumePlan.js';
import { runPipeline, type RunResult } from '../src/core/run/runner.js';
import type { ContextReport } from '../src/core/journal/schema.js';
import { gitInit, makeProject, type Project } from './helpers.js';

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStepStarted(
  runsRoot: string,
  projectRoot: string,
  job: string,
  step: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const started = readEvents(resolveRun(runsRoot, projectRoot)).some(
        (event) => event.kind === 'step.started' && event.job === job && event.step === step,
      );
      if (started) return;
    } catch {
      // Журнал прогона ещё не создан — рано, пробуем снова.
    }
    if (Date.now() > deadline) throw new Error(`шаг ${job}/${step} не начался за ${timeoutMs}мс`);
    await sleep(10);
  }
}

const FAKE_BACKEND_CONFIG: BackendConfig = {
  command: 'fake',
  enabled: true,
  defaultModel: undefined,
  concurrency: 1,
  cacheReadWeight: 0.1,
  sessions: true,
  structuredOutput: true,
  strictPermissions: true,
  permissions: undefined,
  env: {},
};

describe('step-context: продолженная сессия не пересылает унаследованный контекст', () => {
  const CONTINUATION_PIPELINE = `
version: 1
kind: pipeline
name: продолжение-без-повтора-контекста

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
        expect: [{ exit_code: 0 }]
      - id: второй
        agent: fake
        prompt: "Второй"
        expect: [{ exit_code: 0 }]
      - id: третий
        agent: fake
        prompt: "Третий"
        expect: [{ exit_code: 0 }]
`;

  // Сценарий: «Продолженная сессия контекста не повторяет»
  it('промпт продолженной попытки содержит промпт шага и запись о прерывании, но не контекст пайплайна и не выходы предшественников', async () => {
    const project = makeProject({ 'stepcast.yml': CONTINUATION_PIPELINE });
    gitInit(project.root);
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
    const config: Project['config'] = {
      ...project.config,
      runs: { ...project.config.runs, root: runsRoot },
      backends: { ...project.config.backends, fake: FAKE_BACKEND_CONFIG },
    };

    const backend = createFakeBackend({
      lines: (index) => (index === 0 ? [initLine(), resultLine({ text: 'ок' })] : [initLine()]),
      hangMs: (index) => (index === 0 ? 0 : 60_000),
    });

    const controller = new AbortController();
    const firstPromise = runPipeline({
      expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config }),
      config,
      projectRoot: project.root,
      cwd: project.root,
      signal: controller.signal,
      adapterFor: () => backend.adapter,
    });

    await waitForStepStarted(runsRoot, project.root, 'работа', 'второй');
    controller.abort();
    const first = await firstPromise;
    assert.equal(first.status, 'canceled');

    const { plan } = planResume({ cwd: project.root, config, source: readSourceRun(first.journal.paths) });
    assert.equal(plan.steps.find((item) => item.step === 'второй')?.decision.kind, 'continue');

    const secondBackend = createFakeBackend({
      lines: [initLine(), resultLine({ text: 'готово' }), initLine(), resultLine({ text: 'дальше' })],
    });
    const second = await runPipeline({
      expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config }),
      config,
      projectRoot: project.root,
      cwd: project.root,
      resume: { plan, source: readSourceRun(first.journal.paths) },
      adapterFor: () => secondBackend.adapter,
    });
    assert.equal(second.status, 'success');

    const prompt = promptOf(second, 'работа', 'второй');
    assert.match(prompt, /Второй/, 'собственный промпт шага обязан дойти');
    assert.match(prompt, /прерван/, 'запись о прерывании обязана быть в составе');
    assert.doesNotMatch(prompt, /контекст пайплайна/);
    assert.doesNotMatch(prompt, /контекст работы/);

    assert.deepEqual(inheritedOrigins(originsOf(second, 'работа', 'второй')), []);

    // Сценарий: «Запись не достаётся другим шагам»
    assert.doesNotMatch(
      promptOf(second, 'работа', 'третий'),
      /прерван/,
      'запись о прерывании — только продолжаемому шагу',
    );
  });

  const CONTINUATION_RETRY_PIPELINE = CONTINUATION_PIPELINE.replace(
    `        prompt: "Второй"
        expect: [{ exit_code: 0 }]`,
    `        prompt: "Второй"
        attempts: { max: 2 }
        expect: [{ exit_code: 0 }]`,
  );

  // Попытка после неудавшегося продолжения начинает разговор с чистого листа:
  // сессия не открылась, засев снят, контекст пересылается целиком — и запись
  // о прерывании ей уже неправда, диалога, который «продолжается», нет.
  it('попытка после неудавшегося продолжения получает полный контекст и записи о прерывании не получает', async () => {
    const project = makeProject({ 'stepcast.yml': CONTINUATION_RETRY_PIPELINE });
    gitInit(project.root);
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
    const config: Project['config'] = {
      ...project.config,
      runs: { ...project.config.runs, root: runsRoot },
      backends: { ...project.config.backends, fake: FAKE_BACKEND_CONFIG },
    };

    const backend = createFakeBackend({
      lines: (index) => (index === 0 ? [initLine(), resultLine({ text: 'ок' })] : [initLine()]),
      hangMs: (index) => (index === 0 ? 0 : 60_000),
    });

    const controller = new AbortController();
    const firstPromise = runPipeline({
      expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config }),
      config,
      projectRoot: project.root,
      cwd: project.root,
      signal: controller.signal,
      adapterFor: () => backend.adapter,
    });

    await waitForStepStarted(runsRoot, project.root, 'работа', 'второй');
    controller.abort();
    const first = await firstPromise;
    assert.equal(first.status, 'canceled');

    const { plan } = planResume({ cwd: project.root, config, source: readSourceRun(first.journal.paths) });
    assert.equal(plan.steps.find((item) => item.step === 'второй')?.decision.kind, 'continue');

    // Первый запуск нового прогона — отказ продолжения: ненулевой код и ни
    // одной записи `init`.
    const secondBackend = createFakeBackend({
      lines: (index) => (index === 0 ? [] : [initLine(), resultLine({ text: 'готово' })]),
      exitCode: (index) => (index === 0 ? 1 : 0),
    });
    const second = await runPipeline({
      expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config }),
      config,
      projectRoot: project.root,
      cwd: project.root,
      resume: { plan, source: readSourceRun(first.journal.paths) },
      adapterFor: () => secondBackend.adapter,
    });
    assert.equal(second.status, 'success');
    assert.equal(secondBackend.invocations[0]?.resumeSession, true);
    assert.equal(secondBackend.invocations[1]?.resumeSession, false, 'засев снят отказом продолжения');

    assert.match(promptOf(second, 'работа', 'второй'), /прерван/, 'продолженная попытка — та самая');

    const retry = promptOf(second, 'работа', 'второй', 2);
    assert.doesNotMatch(retry, /прерван/, 'диалога, который продолжается, у этой попытки нет');
    assert.match(retry, /контекст пайплайна/, 'разговор начинается заново — с полным контекстом');
    assert.match(retry, /контекст работы/);
  });
});
