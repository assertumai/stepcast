import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { resolveConfig } from '../src/core/config/resolve.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { StepcastError } from '../src/core/errors.js';
import { buildPipelines } from '../src/ui/pipelines.js';
import { makeJournalBed, makeProject, seedRun, type Project } from './helpers.js';

/** Ошибка разбора пайплайна проекта — единственное, ради чего заведён проект. */
function refusal(project: Project): StepcastError {
  try {
    expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config });
  } catch (error) {
    assert.ok(error instanceof StepcastError);
    return error;
  }
  throw new Error('пайплайн разобрался, хотя не должен был');
}

describe('schema-diagnostics: отказ схемы называет причину', () => {
  // Сценарий: «Неизвестный ключ работы»
  it('называет неизвестный ключ работы, а не обобщённое Invalid input', () => {
    const error = refusal(
      makeProject({
        'stepcast.yml': `kind: pipeline
name: t
jobs:
  propose:
    bogus_key: build-a
    uses: ./jobs/x.yml
`,
      }),
    );
    assert.match(error.message, /bogus_key/);
    assert.doesNotMatch(error.message, /Invalid input/);
    assert.equal(error.at, 'jobs.propose');
  });

  // Сценарий: «Ошибка внутри варианта объединения»
  it('указывает причину внутри варианта шага, а не отказ объединения целиком', () => {
    const error = refusal(
      makeProject({
        'stepcast.yml': `kind: pipeline
name: t
jobs:
  build:
    steps:
      - id: a
        promt: сделай
`,
      }),
    );
    assert.match(error.message, /promt/);
    assert.equal(error.at, 'jobs.build.steps.0');
  });

  // Причина лежит на два объединения вглубь: работа, затем шаг, затем список
  // попыток. Слепо взятая первая issue остановилась бы на самом верхнем.
  it('спускается до глубоко вложенного лишнего ключа', () => {
    const error = refusal(
      makeProject({
        'stepcast.yml': `kind: pipeline
name: t
jobs:
  build:
    steps:
      - id: a
        prompt: сделай
        attempts:
          max: 2
          escalation:
            - modle: opus
`,
      }),
    );
    assert.match(error.message, /modle/);
    assert.equal(error.at, 'jobs.build.steps.0.attempts.escalation.0');
  });

  // Сообщения, которые и раньше были по существу, остаются прежними: выбор
  // issue меняется только там, где первая ничего не объясняла.
  it('не теряет осмысленное сообщение там, где объединения нет', () => {
    const error = refusal(
      makeProject({
        'stepcast.yml': `kind: pipeline
name: t
jobs:
  build:
    steps: []
`,
      }),
    );
    assert.equal(error.at, 'jobs.build.steps');
    assert.match(error.message, />=1/);
  });

  it('называет неизвестный ключ конфигурации тем же разбором', () => {
    const bed = makeJournalBed();
    mkdirSync(join(bed.projectRoot, '.stepcast'), { recursive: true });
    writeFileSync(join(bed.projectRoot, '.stepcast', 'config.yml'), 'defaults:\n  modle: opus\n');
    assert.throws(
      () =>
        resolveConfig({
          cwd: bed.projectRoot,
          home: bed.home,
          projectPath: join(bed.projectRoot, '.stepcast', 'config.yml'),
        }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /modle/);
        assert.equal(error.at, 'defaults');
        return true;
      },
    );
  });
});

describe('ui-dashboard: карточка нечитаемого пайплайна называет место', () => {
  it('отдаёт экрану место ошибки и подсказку, а не один текст', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(
      join(projectRoot, 'stepcast.yml'),
      `kind: pipeline
name: t
jobs:
  propose:
    bogus_key: build-a
    uses: ./jobs/x.yml
`,
    );
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });

    const view = buildPipelines(runsRoot, config, { home }).pipelines[0];
    assert.ok(view !== undefined);
    assert.match(view.error ?? '', /bogus_key/);
    assert.equal(view.errorAt, 'jobs.propose');
    assert.equal(view.errorFile, 'stepcast.yml');
    assert.match(view.errorHint ?? '', /pipeline-format/);
  });

  it('называет файл работы, если отказала она, а не файл пайплайна', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(
      join(projectRoot, 'stepcast.yml'),
      `kind: pipeline
name: t
jobs:
  propose:
    uses: ./jobs/x.yml
`,
    );
    mkdirSync(join(projectRoot, 'jobs'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'jobs', 'x.yml'),
      `kind: job
steps:
  - id: a
    promt: сделай
`,
    );
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });

    const view = buildPipelines(runsRoot, config, { home }).pipelines[0];
    assert.ok(view !== undefined);
    assert.equal(view.file, 'stepcast.yml');
    assert.equal(view.errorFile, 'jobs/x.yml');
    assert.equal(view.errorAt, 'steps.0');
    assert.match(view.error ?? '', /promt/);
  });
});
