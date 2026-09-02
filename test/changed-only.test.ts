import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { Config } from '../src/core/config/resolve.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { findStepDir, readStatus } from '../src/core/journal/reader.js';
import { evaluatePredicates } from '../src/core/expect/evaluate.js';
import { runPipeline, type RunResult } from '../src/core/run/runner.js';
import { gitCommit, gitInit, makeProject, type Project } from './helpers.js';

async function run(project: Project): Promise<RunResult> {
  return runWithConfig(project, project.config);
}

/** То же, что `run`, но с конфигурацией, объявляющей состав вложенных репозиториев. */
async function runWithConfig(project: Project, config: Config): Promise<RunResult> {
  const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
  return runPipeline({
    expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config }),
    config: { ...config, runs: { ...config.runs, root: runsRoot } },
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

  // Заход 616c1b: агент клал черновики живой проверки в системный временный
  // каталог, но описывал их относительным путём — они ложились внутрь
  // рабочего дерева и заваливали границу правок. Теперь для черновиков есть
  // объявленный каталог вне дерева (`$STEPCAST_JOB_DIR/scratch`); шаг,
  // писавший только туда, обязан пройти `changed_only`, а перечисленных путей
  // в отказе быть не должно — черновики в якорь не входят.
  it('черновики в $STEPCAST_JOB_DIR/scratch не идут против changed_only', async () => {
    const project = makeProject({
      'stepcast.yml': bounded(
        'mkdir -p src && echo код > src/a.ts && echo черновик > "$STEPCAST_JOB_DIR/scratch/verify.log"',
        '["src/**"]',
      ),
    });
    const result = await run(project);

    assert.equal(result.status, 'success');
    const step = readStatus(result.journal.paths).jobs[0]?.steps[0];
    assert.equal(step?.reason, undefined);
  });

  // Тот же черновик, но положенный внутрь рабочего дерева, — сегодняшнее
  // поведение до заведения каталога черновиков, и оно обязано остаться
  // отказом: только вынос черновика за дерево чинит границу, а не ослабление
  // предиката списком исключений.
  it('тот же черновик внутри рабочего дерева по-прежнему проваливает предикат', async () => {
    const project = makeProject({
      'stepcast.yml': bounded(
        'mkdir -p src .verify-scratch && echo код > src/a.ts && echo черновик > .verify-scratch/verify.log',
        '["src/**"]',
      ),
    });
    const result = await run(project);

    assert.equal(result.status, 'failed');
    const step = readStatus(result.journal.paths).jobs[0]?.steps[0];
    assert.match(step?.reason ?? '', /verify-scratch/);
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
  it('помечается невычисленным, а не непройденным, когда состояние недоступно', async () => {
    const results = await evaluatePredicates(
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
  const check = async (globs: string[], paths: string[]) =>
    (
      await evaluatePredicates([{ kind: 'changed_only', globs }], {
        exitCode: 0,
        text: '',
        structured: undefined,
        cwd: process.cwd(),
        env: {},
        changedPaths: paths,
      })
    )[0];

  it('`**` пересекает разделители, `*` — нет', async () => {
    assert.equal((await check(['src/**'], ['src/deep/nested/a.ts']))?.passed, true);
    assert.equal((await check(['src/*'], ['src/deep/nested/a.ts']))?.passed, false);
    assert.equal((await check(['src/*.ts'], ['src/a.ts']))?.passed, true);
  });

  it('перечисляет только вышедшие за границу пути', async () => {
    const result = await check(['src/**'], ['src/a.ts', 'docs/b.md', 'package.json']);
    assert.deepEqual(result?.actual, ['docs/b.md', 'package.json']);
  });
});

// Задача 12 (nested-repo-anchor): сквозной сценарий вложенной правки. Стенд —
// корневой репозиторий с вложенным `public-site`, который сам игнорируется
// корнем (`.gitignore`), и работа в режиме каталога запуска со сжатым
// предикатом `changed_only: ["src/**"]`, задевающая только `src/**` корня.
// Правка ложится внутрь `public-site/src/api.ts` — то есть вне объявленной
// границы, если вложенный репозиторий вообще виден якорю.
describe('result-contract: границы правок вложенного репозитория', () => {
  const nestedBounded = (globs: string): string => `
version: 1
kind: pipeline
name: границы-вложенного
workspace: { mode: cwd }
jobs:
  работа:
    steps:
      - id: пишет
        run: [sh, -c, 'echo правка >> public-site/src/api.ts']
        expect:
          - exit_code: 0
          - changed_only: ${globs}
`;

  function nestedProject(globs = '["src/**"]'): Project {
    const project = makeProject({
      '.gitignore': 'public-site/\n',
      'public-site/src/api.ts': 'исходное\n',
      'stepcast.yml': nestedBounded(globs),
    });
    // Часть коммитится раньше корня — иначе `add -A` корня откажет на
    // вложенном репозитории без единого коммита.
    gitInit(project.path('public-site'));
    gitCommit(project.path('public-site'), 'начало части');
    gitInit(project.root);
    gitCommit(project.root, 'первый');
    return project;
  }

  // Сегодняшнее поведение (не объявлено — предикат зелен): `git add -A`
  // корня не заглядывает во вложенный репозиторий, игнорируемый
  // `.gitignore`, — правка внутри него не попадает ни в якорь, ни в
  // сравнение путей, и жёсткий предикат остаётся зелёным, хотя правка вышла
  // за пределы src/**. Этот тест обязан оставаться зелёным и после правки
  // движка: без объявленного состава ничего не меняется.
  it('без объявленного состава жёсткий предикат зелен, хотя правка вышла за пределы src/**', async () => {
    const project = nestedProject();
    const result = await run(project);

    assert.equal(result.status, 'success');
    const step = readStatus(result.journal.paths).jobs[0]?.steps[0];
    assert.equal(step?.reason, undefined);
  });

  // С объявленным составом та же правка видна: жёсткий предикат не проходит,
  // а в объяснении назван путь с префиксом каталога части.
  it('с объявленным составом жёсткий предикат не проходит, называя public-site/src/api.ts', async () => {
    const project = nestedProject();
    const config: Config = {
      ...project.config,
      project: { ...project.config.project, nestedRepos: ['public-site'] },
    };

    const result = await runWithConfig(project, config);

    assert.equal(result.status, 'failed');
    const step = readStatus(result.journal.paths).jobs[0]?.steps[0];
    assert.match(step?.reason ?? '', /public-site\/src\/api\.ts/);
    assert.equal(step?.anchor_kind, 'composite');

    // diff.patch содержит изменение по пути с префиксом, а tree_id на начало
    // и конец шага различаются — правка внутри части видна и в патче, и в якоре.
    const dir = findStepDir(result.journal.paths, 'работа', 'пишет');
    assert.ok(dir !== undefined);
    const patch = readFileSync(join(dir, 'diff.patch'), 'utf8');
    assert.match(patch, /public-site\/src\/api\.ts/);
    assert.notEqual(step?.tree_id, step?.tree_before);
  });

  // Сценарий «Существующий шаблон совпадает с путём части»: отдельного
  // синтаксиса для путей вложенного репозитория не заводится — тот же шаблон,
  // сопоставленный тем же предикатом, ловит путь с префиксом каталога части.
  it('обычный шаблон public-site/** совпадает с путём части, и предикат проходит', async () => {
    const project = nestedProject('["public-site/**"]');
    const config: Config = {
      ...project.config,
      project: { ...project.config.project, nestedRepos: ['public-site'] },
    };

    const result = await runWithConfig(project, config);

    assert.equal(result.status, 'success');
    const step = readStatus(result.journal.paths).jobs[0]?.steps[0];
    assert.equal(step?.reason, undefined);
    assert.equal(step?.anchor_kind, 'composite');
    // Путь всё-таки изменился — предикат прошёл по совпадению, а не потому,
    // что правка снова оказалась невидимой.
    assert.notEqual(step?.tree_id, step?.tree_before);
  });
});
