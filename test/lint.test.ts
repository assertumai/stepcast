import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { run, type CliIo } from '../src/cli/main.js';
import type { Config } from '../src/core/config/resolve.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import type { BackendConfig } from '../src/core/config/resolve.js';
import { builtinRegistry } from '../src/core/plugins/builtin.js';
import { addPlugin } from '../src/core/plugins/registry.js';
import { hasErrors, lintPipeline, type Diagnostic } from '../src/core/lint.js';
import { ExitCode, StepcastError, type ExitCodeValue } from '../src/core/errors.js';
import { gitCommit, gitInit, makeProject, withHome, type Project } from './helpers.js';

function lint(project: Project, inputs?: Record<string, string>): Diagnostic[] {
  return lintWithConfig(project, project.config, inputs);
}

function lintWithConfig(project: Project, config: Config, inputs?: Record<string, string>): Diagnostic[] {
  const expanded = expandPipeline({
    pipelinePath: project.path('stepcast.yml'),
    config,
    ...(inputs === undefined ? {} : { inputs }),
  });
  return lintPipeline(expanded, { config });
}

/** Тот же проект, но с объявленным составом `project.nested_repos`, будто он объявлен в `.stepcast/config.yml`. */
function withNestedRepos(project: Project, nestedRepos: readonly string[]): Config {
  return { ...project.config, project: { ...project.config.project, nestedRepos } };
}

function errors(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.filter((item) => item.severity === 'error').map((item) => item.message);
}

function warnings(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.filter((item) => item.severity === 'warning').map((item) => item.message);
}

const OK_PIPELINE = `
kind: pipeline
name: ok
budget: { tokens: 100k }
jobs:
  plan:
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
  build:
    needs: [plan]
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
`;

describe('pipeline-definition: статическая проверка', () => {
  it('чистый пайплайн не даёт ни ошибок, ни предупреждений', () => {
    const diagnostics = lint(makeProject({ 'stepcast.yml': OK_PIPELINE }));
    assert.deepEqual(diagnostics, []);
    assert.equal(hasErrors(diagnostics), false);
  });

  it('принимает lane в kebab-case', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  build:
    lane: a
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
`,
      }),
    );
    assert.equal(hasErrors(diagnostics), false);
  });

  it('отклоняет lane, не являющийся слагом, называя работу и значение', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  build:
    lane: "Дорожка A"
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
`,
      }),
    );
    const messages = errors(diagnostics);
    assert.ok(messages.some((message) => message.includes('build') && message.includes('Дорожка A')));
  });

  // Спека pipeline-definition: «Метка all зарезервирована» — совпадает со
  // значением ключа --lanes команды сведения (design.md, решение 3).
  it('отклоняет lane: all, называя работу и причину резервирования', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  build:
    lane: all
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
`,
      }),
    );
    const messages = errors(diagnostics);
    assert.ok(
      messages.some(
        (message) => message.includes('build') && message.includes('all') && message.includes('зарезервировано'),
      ),
    );
  });

  it('слаг all-lanes остаётся допустимой меткой', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  build:
    lane: all-lanes
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
`,
      }),
    );
    assert.equal(hasErrors(diagnostics), false);
  });
});

/**
 * Спека pipeline-definition: «Работа дорожки не адресует чужую дорожку».
 * Метки `lane`, встреченные в пайплайне, образуют замкнутый словарь имён;
 * `slots` без метки — предшественница обеих дорожек и адресует их свободно.
 */
describe('pipeline-definition: работа дорожки не адресует чужую дорожку', () => {
  const LANE_PIPELINE = `
kind: pipeline
budget: { tokens: 100k }
jobs:
  slots:
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
  work-a:
    lane: a
    needs: [slots]
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
  work-b:
    lane: b
    needs: [slots]
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
`;

  it('needs на работу соседней дорожки — ошибка, называющая обе работы и обе дорожки', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': LANE_PIPELINE.replace(
          'work-b:\n    lane: b\n    needs: [slots]',
          'work-b:\n    lane: b\n    needs: [slots, work-a]',
        ),
      }),
    );
    const messages = errors(diagnostics);
    assert.ok(
      messages.some(
        (message) =>
          message.includes('work-b') && message.includes('work-a') && message.includes('b') && message.includes('a'),
      ),
    );
  });

  it('context_upstream на работу соседней дорожки — ошибка про дорожку, а не про граф', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': LANE_PIPELINE.replace(
          'work-b:\n    lane: b\n    needs: [slots]',
          'work-b:\n    lane: b\n    needs: [slots, work-a]\n    context_upstream: [work-a]',
        ),
      }),
    );
    const messages = errors(diagnostics);
    const laneMessage = messages.find(
      (message) => message.includes('context_upstream') && message.includes('дорожк'),
    );
    assert.ok(laneMessage !== undefined, 'ошибка называет дорожку');
    // work-a реально выше по графу (needs его называет) — старое правило
    // «работа не выше по графу» здесь молчит, и звучит только новая причина.
    assert.ok(!messages.some((message) => message.includes('выше по графу')));
  });

  it('те же записи в пределах своей дорожки — ошибки нет', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': LANE_PIPELINE.replace(
          'work-a:\n    lane: a\n    needs: [slots]',
          'work-a:\n    lane: a\n    needs: [slots]\n    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]\n  work-a2:\n    lane: a\n    needs: [slots, work-a]\n    context_upstream: [work-a]',
        ),
      }),
    );
    assert.equal(hasErrors(diagnostics), false);
  });

  it('работа без метки lane, называющая работы обеих дорожек, — ошибки нет', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': LANE_PIPELINE.replace(
          'work-b:\n    lane: b\n    needs: [slots]\n    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]',
          'work-b:\n    lane: b\n    needs: [slots]\n    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]\n  merge:\n    needs: [work-a, work-b]\n    context_upstream: [work-a, work-b]\n    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]',
        ),
      }),
    );
    assert.equal(hasErrors(diagnostics), false);
  });

  it('слот чужой дорожки в подстановке — ошибка, называющая обе дорожки', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': LANE_PIPELINE.replace(
          'work-b:\n    lane: b\n    needs: [slots]\n    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]',
          'work-b:\n    lane: b\n    needs: [slots]\n    steps: [{ id: c, run: [echo, "${jobs.slots.output.lanes.a.repo.check}"], expect: [{ exit_code: 0 }] }]',
        ),
      }),
    );
    const messages = errors(diagnostics);
    assert.ok(
      messages.some((message) => message.includes('work-b') && message.includes('«a»')),
      messages.join('\n'),
    );
  });

  it('собственная дорожка в подстановке слота допустима', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': LANE_PIPELINE.replace(
          'work-a:\n    lane: a\n    needs: [slots]\n    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]',
          'work-a:\n    lane: a\n    needs: [slots]\n    steps: [{ id: c, run: [echo, "${jobs.slots.output.lanes.a.repo.check}"], expect: [{ exit_code: 0 }] }]',
        ),
      }),
    );
    assert.equal(hasErrors(diagnostics), false);
  });

  it('выход работы соседней дорожки в подстановке — ошибка, называющая обе дорожки', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': LANE_PIPELINE.replace(
          'work-b:\n    lane: b\n    needs: [slots]\n    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]',
          'work-b:\n    lane: b\n    needs: [slots, work-a]\n    steps: [{ id: c, run: [echo, "${jobs.work-a.output.slug}"], expect: [{ exit_code: 0 }] }]',
        ),
      }),
    );
    const messages = errors(diagnostics);
    assert.ok(messages.some((message) => message.includes('work-b') && message.includes('work-a')));
  });

  it('ссылка из общего файла промпта называет файл и позицию', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  slots:
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
  work-a:
    uses: ./jobs/work.yml
    lane: a
    needs: [slots]
  work-b:
    uses: ./jobs/work.yml
    lane: b
    needs: [slots]
`,
      'jobs/work.yml': `
kind: job
steps:
  - id: думает
    agent: fake
    prompt: "file:../prompts/work.md"
    expect: [{ exit_code: 0 }]
`,
      'prompts/work.md': 'Слот: ${jobs.slots.output.lanes.a.repo.check}\n',
    });
    const diagnostics = lint(project);
    const promptPath = project.path('prompts/work.md');
    const found = diagnostics.find(
      (entry) => entry.severity === 'error' && entry.file === promptPath && entry.message.includes('work-b'),
    );
    assert.ok(found !== undefined, 'ошибка называет путь к файлу промпта');
    assert.match(found?.at ?? '', /^\d+:\d+$/, 'место — позиция строка:столбец в файле');
  });

  // Решено и закреплено тестом: правило не распространяется на ключи
  // display — их раскрывает витрина в момент отрисовки, когда все работы уже
  // завершились, а не движок перед исполнением работы (checkDisplaySubstitutions).
  it('ссылка на данные соседней дорожки в display ошибкой не является', () => {
    // needs остаётся [slots]: display раскрывается витриной после того, как
    // весь граф завершился, и требование «работа выше по графу» для него
    // бессмысленно (checkDisplaySubstitutions) — упоминание work-a в needs
    // здесь не нужно и само стало бы отдельной, не связанной с этим тестом
    // ошибкой чужой дорожки.
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': LANE_PIPELINE.replace(
          'work-b:\n    lane: b\n    needs: [slots]\n    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]',
          'work-b:\n    lane: b\n    needs: [slots]\n    display: { title: "${jobs.work-a.data.title}" }\n    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]',
        ),
      }),
    );
    assert.equal(
      errors(diagnostics).some((message) => message.includes('дорожк')),
      false,
    );
  });

  it('условие if, обращающееся к сегменту чужой дорожки, — ошибка', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': LANE_PIPELINE.replace(
          'work-b:\n    lane: b\n    needs: [slots]',
          'work-b:\n    lane: b\n    needs: [slots]\n    if: "jobs.slots.output.lanes.a.filled == true"',
        ),
      }),
    );
    const messages = errors(diagnostics);
    assert.ok(messages.some((message) => message.includes('work-b') && message.includes('дорожк')));
  });
});

describe('pipeline-definition: статическая проверка', () => {
  // Сценарий: «Цикл в зависимостях»
  it('находит цикл и перечисляет участников', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  a:
    needs: [b]
    steps: [{ id: c, run: [echo, ok] }]
  b:
    needs: [a]
    steps: [{ id: c, run: [echo, ok] }]
`,
      }),
    );

    const cycle = errors(diagnostics).find((message) => message.startsWith('Цикл'));
    assert.ok(cycle !== undefined, 'цикл должен быть найден');
    assert.match(cycle, /a/);
    assert.match(cycle, /b/);
  });

  it('сообщает о недостижимой работе за циклом', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  a:
    needs: [b]
    steps: [{ id: c, run: [echo, ok] }]
  b:
    needs: [a]
    steps: [{ id: c, run: [echo, ok] }]
  ship:
    needs: [a]
    steps: [{ id: c, run: [echo, ok] }]
`,
      }),
    );
    assert.ok(errors(diagnostics).some((message) => /ship недостижима/.test(message)));
  });

  it('находит зависимость от несуществующей работы', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  build:
    needs: [nonexistent]
    steps: [{ id: c, run: [echo, ok] }]
`,
      }),
    );
    assert.ok(errors(diagnostics).some((message) => /nonexistent/.test(message)));
  });

  it('предупреждает о явно перечисленной транзитивной зависимости', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  plan:
    steps: [{ id: c, run: [echo, ok] }]
  build:
    needs: [plan]
    steps: [{ id: c, run: [echo, ok] }]
  ship:
    needs: [build, plan]
    steps: [{ id: c, run: [echo, ok] }]
`,
      }),
    );
    assert.ok(warnings(diagnostics).some((message) => /транзитивные зависимости/.test(message)));
    assert.equal(hasErrors(diagnostics), false, 'предупреждение не влияет на исход');
  });

  it('отклоняет условие с необъявленным входом', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  build:
    if: "not inputs.skip"
    steps: [{ id: c, run: [echo, ok] }]
`,
      }),
    );
    assert.ok(errors(diagnostics).some((message) => /необъявленному входу skip/.test(message)));
  });

  it('отклоняет условие о работе не выше по графу', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  plan:
    steps: [{ id: c, run: [echo, ok] }]
  build:
    if: 'jobs.plan.status == "success"'
    steps: [{ id: c, run: [echo, ok] }]
`,
      }),
    );
    assert.ok(errors(diagnostics).some((message) => /которой нет выше по графу/.test(message)));
  });

  it('разрешает условие о работе выше по графу и при needs: all', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  plan:
    steps: [{ id: c, run: [echo, ok] }]
  build:
    needs: [plan]
    if: 'jobs.plan.status == "success"'
    steps: [{ id: c, run: [echo, ok] }]
  triage:
    needs: all
    on: failure
    if: 'jobs.plan.status == "failed"'
    steps: [{ id: c, run: [echo, ok] }]
`,
      }),
    );
    assert.deepEqual(errors(diagnostics), []);
  });

  // Спека pipeline-definition: «Ссылка на работу вне зависимостей при
  // параллелизме предупреждается» — сценарий «Условие ссылается на соседа»
  it('предупреждает об условии на соседнюю работу при concurrency больше единицы', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
concurrency: 2
jobs:
  review:
    steps: [{ id: c, run: [echo, ok] }]
  docs:
    if: "jobs.review.status == 'success'"
    steps: [{ id: c, run: [echo, ok] }]
`,
      }),
    );
    assert.deepEqual(errors(diagnostics), []);
    assert.ok(
      warnings(diagnostics).some((message) => /docs/.test(message) && /review/.test(message)),
      'предупреждение называет обе работы',
    );
  });

  // Сценарий: «Ссылка на зависимость не предупреждается»
  it('не предупреждает об условии на объявленную зависимость при concurrency больше единицы', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
concurrency: 2
jobs:
  review:
    steps: [{ id: c, run: [echo, ok] }]
  docs:
    needs: [review]
    if: "jobs.review.status == 'success'"
    steps: [{ id: c, run: [echo, ok] }]
`,
      }),
    );
    assert.deepEqual(
      warnings(diagnostics).filter((message) => /обращается|ссылается/.test(message)),
      [],
    );
  });

  // Сценарий: «Последовательное исполнение не предупреждается» — при
  // concurrency: 1 порядок определён объявлением, предупреждать не о чем.
  it('не предупреждает о той же ссылке при concurrency: 1', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  review:
    steps: [{ id: c, run: [echo, ok] }]
  docs:
    if: "jobs.review.status == 'success'"
    steps: [{ id: c, run: [echo, ok] }]
`,
      }),
    );
    assert.deepEqual(warnings(diagnostics), []);
  });

  // Спека pipeline-definition: «Подстановка выхода работы вне
  // предшественников отклоняется» — сценарий «Подстановка выхода соседа»
  function neighborSubstitutionPipeline(concurrency: number): string {
    return `
version: 1
kind: pipeline
name: подстановка
concurrency: ${concurrency}
budget: { tokens: 100k }
jobs:
  propose:
    output:
      from: думает
    steps:
      - id: думает
        agent: fake
        prompt: придумай
        expect: [{ exit_code: 0 }]
  implement:
    steps:
      - id: использует
        run: [sh, -c, 'echo "\${jobs.propose.output.slug}" > slug.txt']
        expect: [{ exit_code: 0 }]
`;
  }

  it('отклоняет ошибкой подстановку выхода соседней работы при concurrency больше единицы', () => {
    const diagnostics = lint(
      makeProject({ 'stepcast.yml': neighborSubstitutionPipeline(2) }),
    );
    assert.ok(
      errors(diagnostics).some(
        (message) =>
          /Работа implement подставляет/.test(message) &&
          /выход работы propose, не входящей/.test(message),
      ),
      'ошибка называет обе работы',
    );
  });

  // Сценарий: «Последовательное исполнение не оправдывает ссылку»
  it('отклоняет ту же подстановку и при concurrency: 1', () => {
    const diagnostics = lint(
      makeProject({ 'stepcast.yml': neighborSubstitutionPipeline(1) }),
    );
    assert.ok(
      errors(diagnostics).some(
        (message) =>
          /Работа implement подставляет/.test(message) &&
          /выход работы propose, не входящей/.test(message),
      ),
    );
  });

  // Сценарий: «Транзитивная предшественница допустима»
  it('не отклоняет подстановку выхода транзитивной предшественницы', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
version: 1
kind: pipeline
name: подстановка
concurrency: 2
budget: { tokens: 100k }
jobs:
  propose:
    output:
      from: думает
    steps:
      - id: думает
        agent: fake
        prompt: придумай
        expect: [{ exit_code: 0 }]
  build:
    needs: [propose]
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
  implement:
    needs: [build]
    steps:
      - id: использует
        run: [sh, -c, 'echo "\${jobs.propose.output.slug}" > slug.txt']
        expect: [{ exit_code: 0 }]
`,
      }),
    );
    assert.deepEqual(
      errors(diagnostics).filter((message) => /подставляет/.test(message)),
      [],
    );
  });

  // Сценарий: «Зависимость от всех допустима»
  it('не отклоняет подстановку выхода любой работы при needs: all', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
version: 1
kind: pipeline
name: подстановка
concurrency: 2
budget: { tokens: 100k }
jobs:
  propose:
    output:
      from: думает
    steps:
      - id: думает
        agent: fake
        prompt: придумай
        expect: [{ exit_code: 0 }]
  implement:
    needs: all
    steps:
      - id: использует
        run: [sh, -c, 'echo "\${jobs.propose.output.slug}" > slug.txt']
        expect: [{ exit_code: 0 }]
`,
      }),
    );
    assert.deepEqual(
      errors(diagnostics).filter((message) => /подставляет/.test(message)),
      [],
    );
  });

  // Сценарий: «Ссылка на зависимость не предупреждается», форма подстановки
  it('не отклоняет подстановку выхода объявленной зависимости', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
version: 1
kind: pipeline
name: подстановка
concurrency: 2
budget: { tokens: 100k }
jobs:
  propose:
    output:
      from: думает
    steps:
      - id: думает
        agent: fake
        prompt: придумай
        expect: [{ exit_code: 0 }]
  implement:
    needs: [propose]
    steps:
      - id: использует
        run: [sh, -c, 'echo "\${jobs.propose.output.slug}" > slug.txt']
        expect: [{ exit_code: 0 }]
`,
      }),
    );
    assert.deepEqual(
      errors(diagnostics).filter((message) => /подставляет/.test(message)),
      [],
    );
  });

  // Спека pipeline-definition: «Ссылка на несуществующую работу отклоняется»
  // — сценарий «Опечатка в имени работы»
  it('отклоняет опечатку в имени работы, подставленной через with', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  propose:
    output:
      from: думает
    steps:
      - id: думает
        agent: fake
        prompt: придумай
        expect: [{ exit_code: 0 }]
  build:
    needs: [propose]
    uses: ./jobs/build.yml
    with: { change: "\${jobs.propse.output.slug}" }
`,
        'jobs/build.yml': `
kind: job
params:
  change: { type: string, required: true }
steps: [{ id: c, run: [echo, ok] }]
`,
      }),
    );
    const messages = errors(diagnostics);
    assert.ok(
      messages.some(
        (message) => /jobs.propse.output.slug/.test(message) && /propse/.test(message),
      ),
    );
  });

  // Спека требует называть место объявления: у поля тела подключённой работы
  // это её файл, а у `with` того же подключения — файл пайплайна.
  it('называет файл объявления подстановки: тело работы и место подключения — разные файлы', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  build:
    uses: ./jobs/build.yml
    with: { change: "\${jobs.wired.output.slug}" }
`,
      'jobs/build.yml': `
kind: job
params:
  change: { type: string, required: true }
steps:
  - id: думает
    agent: fake
    prompt: "Слаг: \${jobs.inner.output.slug}"
`,
    });
    const diagnostics = lint(project);

    const inner = diagnostics.find((entry) => /jobs.inner.output.slug/.test(entry.message));
    assert.ok(inner !== undefined, 'подстановка тела работы должна давать ошибку');
    assert.equal(inner?.file, project.path('jobs/build.yml'));
    assert.equal(inner?.at, 'jobs.build.steps.0.prompt');

    const wired = diagnostics.find((entry) => /jobs.wired.output.slug/.test(entry.message));
    assert.ok(wired !== undefined, 'подстановка в with должна давать ошибку');
    assert.equal(wired?.file, project.path('stepcast.yml'));
    assert.equal(wired?.at, 'jobs.build.with.change');
  });

  // Поле уровня пайплайна не принадлежит ни одной работе, и перебор по работам
  // его не видит — но имя, которого в графе нет, не разрешится и в нём.
  it('отклоняет несуществующее имя в подстановке поля пайплайна', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
context:
  - "changes/\${jobs.nope.output.slug}/proposal.md"
jobs:
  build:
    steps:
      - id: думает
        agent: fake
        prompt: сделай
        expect: [{ exit_code: 0 }]
`,
    });
    const diagnostics = lint(project);
    const found = diagnostics.find((entry) => /jobs.nope.output.slug/.test(entry.message));
    assert.ok(found !== undefined, 'ошибка называет выражение поля пайплайна');
    assert.equal(found?.severity, 'error');
    assert.equal(found?.file, project.path('stepcast.yml'));
    assert.equal(found?.at, 'context.0');
  });

  // Сценарий: «Имя без суффикса дорожки в общем промпте» — воспроизведение
  // прогона e1867e: общий файл промпта дорожек ссылается на работу без
  // суффикса, которого в графе нет ни у одной из них.
  it('отклоняет имя без суффикса дорожки, подставленное в общем файле промпта', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  propose-a:
    lane: a
    steps:
      - id: думает
        agent: fake
        prompt: "file:./prompts/propose.md"
        expect: [{ exit_code: 0 }]
  propose-b:
    lane: b
    steps:
      - id: думает
        agent: fake
        prompt: "file:./prompts/propose.md"
        expect: [{ exit_code: 0 }]
`,
      'prompts/propose.md': 'Слаг: ${jobs.propose.output.slug}\n',
    });
    const diagnostics = lint(project);
    const promptPath = project.path('prompts/propose.md');
    const found = diagnostics.find(
      (entry) => entry.severity === 'error' && entry.file === promptPath,
    );
    assert.ok(found !== undefined, 'ошибка называет путь к файлу промпта');
    assert.match(found?.message ?? '', /propose/);
    assert.match(found?.at ?? '', /^\d+:\d+$/, 'место — позиция строка:столбец в файле');
    assert.match(found?.hint ?? '', /propose-a/);
    assert.match(found?.hint ?? '', /propose-b/);
  });

  // Сценарий: «Несуществующее имя в условии при параллелизме»
  it('отклоняет ошибкой несуществующее имя в if при concurrency больше единицы', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
concurrency: 2
jobs:
  build:
    if: "jobs.propose.status == 'success'"
    steps: [{ id: c, run: [echo, ok] }]
`,
      }),
    );
    assert.ok(
      errors(diagnostics).some(
        (message) => /build/.test(message) && /propose/.test(message) && /несуществующ/.test(message),
      ),
    );
    assert.equal(hasErrors(diagnostics), true);
  });

  // Сценарий: «Экранированное выражение» — из спеки «Ссылка на
  // несуществующую работу отклоняется»
  it('не отклоняет экранированную ссылку на несуществующую работу в промпте', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  ask:
    steps:
      - id: a
        agent: claude
        prompt: "file:./prompt.md"
        expect: [{ exit_code: 0 }]
`,
        'prompt.md': 'Литерал: $${jobs.propose.output.slug}\n',
      }),
    );
    assert.deepEqual(errors(diagnostics), []);
  });

  it('не отклоняет экранированную ссылку на несуществующую работу в поле документа', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  build:
    env: { NOTE: "$\${jobs.propose.output.slug}" }
    steps: [{ id: c, run: [echo, ok] }]
`,
      }),
    );
    assert.deepEqual(errors(diagnostics), []);
  });

  // Перечень context_upstream отбирает выходы из работ выше по графу: имя за
  // их пределами не отбирает ничего и оставляет блок беднее заявленного.
  it('отклоняет context_upstream, называющий работу вне предшественников', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  propose:
    steps: [{ id: c, run: [echo, ok] }]
  implement:
    context_upstream: [propose]
    steps: [{ id: c, run: [echo, ok] }]
`,
      }),
    );
    assert.ok(
      errors(diagnostics).some(
        (message) => /context_upstream работы implement/.test(message) && /propose/.test(message),
      ),
      'ошибка называет обе работы',
    );
  });

  it('не трогает context_upstream, называющий объявленную зависимость', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  propose:
    steps: [{ id: c, run: [echo, ok] }]
  implement:
    needs: [propose]
    context_upstream: [propose]
    steps: [{ id: c, run: [echo, ok] }]
`,
      }),
    );
    assert.deepEqual(
      errors(diagnostics).filter((message) => /context_upstream/.test(message)),
      [],
    );
  });

  // Сценарий: «Подстановка вывода модели в командную строку»
  it('отклоняет вывод работы в строковой форме run и предлагает argv', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  plan:
    steps: [{ id: c, run: [echo, ok] }]
  ship:
    needs: [plan]
    steps: [{ id: c, run: "deploy \${jobs.plan.output.target}" }]
`,
      }),
    );

    const found = diagnostics.find((item) => /строковую форму run/.test(item.message));
    assert.ok(found !== undefined);
    assert.equal(found.severity, 'error');
    assert.match(found.hint ?? '', /списком argv/);
  });

  it('разрешает тот же вывод в форме списком argv', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  plan:
    steps: [{ id: c, run: [echo, ok] }]
  ship:
    needs: [plan]
    steps: [{ id: c, run: [deploy, "\${jobs.plan.output.target}"] }]
`,
      }),
    );
    assert.deepEqual(errors(diagnostics), []);
  });

  it('отклоняет переменную env под действующим запретом', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
env:
  HARMLESS: "1"
jobs:
  build:
    env:
      GITHUB_TOKEN: secret
    steps: [{ id: c, run: [echo, ok] }]
`,
      }),
    );
    const found = errors(diagnostics).find((message) => /GITHUB_TOKEN/.test(message));
    assert.ok(found !== undefined, 'запрет *_TOKEN должен сработать');
    assert.match(found, /\*_TOKEN/);
  });

  it('отклоняет неизвестный бэкенд и перечисляет настроенные', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  ask:
    steps: [{ id: a, agent: gpt, prompt: спроси }]
`,
      }),
    );
    const found = diagnostics.find((item) => /Неизвестный бэкенд gpt/.test(item.message));
    assert.ok(found !== undefined);
    assert.match(found.hint ?? '', /claude/);
  });

  // Сценарий: «Путь с подстановкой»
  it('не проверяет существование схемы, если в пути есть подстановка', () => {
    const withSubstitution = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
inputs:
  kind: { type: string, default: plan }
jobs:
  ask:
    steps: [{ id: a, prompt: спроси, output_schema: "./schemas/\${inputs.kind}.json" }]
`,
      }),
    );
    assert.deepEqual(errors(withSubstitution), [], 'путь с подстановкой не проверяется');

    const withoutSubstitution = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  ask:
    steps: [{ id: a, prompt: спроси, output_schema: ./schemas/plan.json }]
`,
      }),
    );
    assert.ok(errors(withoutSubstitution).some((message) => /Файл схемы не найден/.test(message)));
  });

  it('проверяет превышение потолков конфигурации', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
budget: { tokens: 90M }
concurrency: 20
jobs:
  build:
    steps: [{ id: c, run: [echo, ok] }]
`,
    });
    const messages = errors(lint(project));
    assert.ok(messages.some((message) => /limits\.tokens/.test(message)));
    assert.ok(messages.some((message) => /limits\.concurrency/.test(message)));
  });

  it('предупреждает о пайплайне без бюджета', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps: [{ id: c, run: [echo, ok] }]
`,
      }),
    );
    assert.ok(warnings(diagnostics).some((message) => /нет бюджета/.test(message)));
    assert.equal(hasErrors(diagnostics), false);
  });

  it('предупреждает о cwd при параллелизме', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
concurrency: 3
jobs:
  a:
    steps: [{ id: c, run: [echo, ok] }]
  b:
    steps: [{ id: c, run: [echo, ok] }]
`,
      }),
    );
    assert.ok(warnings(diagnostics).some((message) => /workspace\.mode: cwd/.test(message)));
  });

  it('предупреждает о единственном предикате changed_only', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  build:
    steps:
      - id: a
        prompt: сделай
        expect: [{ changed_only: ["src/**"] }]
`,
      }),
    );
    assert.ok(warnings(diagnostics).some((message) => /changed_only/.test(message)));
  });

  // `on_exceed: wait` без `rate_limit_pct` перестал быть бессмысленным: это
  // ровно то, чем область объявляет режим ожидания для упора в лимит
  // подписки бэкенда (requirement «Упор в лимит подписки — второе основание
  // для ожидания сброса окна» в pipeline-execution/spec.md) — измеренный
  // порог тут вообще ни при чём.
  it('не предупреждает о on_exceed: wait без rate_limit_pct', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k, on_exceed: wait }
jobs:
  build:
    steps:
      - id: a
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
`,
      }),
    );
    assert.equal(warnings(diagnostics).some((message) => /on_exceed: wait/.test(message)), false);
    assert.equal(hasErrors(diagnostics), false);
  });

  it('не предупреждает о wait, объявленном вместе с rate_limit_pct', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  build:
    steps:
      - id: a
        run: [echo, ok]
        budget: { rate_limit_pct: 80, on_exceed: wait }
        expect: [{ exit_code: 0 }]
`,
      }),
    );
    assert.equal(warnings(diagnostics).some((message) => /on_exceed: wait/.test(message)), false);
  });

  it('предупреждает о гейте только из совещательного judge', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  build:
    steps:
      - id: a
        prompt: сделай
        expect: [{ judge: "всё хорошо" }]
`,
      }),
    );
    assert.ok(warnings(diagnostics).some((message) => /структурных предикатов/.test(message)));
  });

  it('не отклоняет judge на бэкенде со структурированным выводом', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  build:
    steps:
      - id: a
        prompt: сделай
        expect: [{ exit_code: 0 }, { judge: "всё хорошо", hard: true }]
`,
      }),
    );
    assert.equal(errors(diagnostics).length, 0);
  });

  it('отклоняет неизвестный бэкенд судьи', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  build:
    steps:
      - id: a
        prompt: сделай
        expect: [{ exit_code: 0 }, { judge: "всё хорошо", agent: nope }]
`,
      }),
    );
    assert.ok(errors(diagnostics).some((message) => /Неизвестный бэкенд судьи nope/.test(message)));
  });

  it('отклоняет бэкенд судьи без структурированного вывода', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  build:
    steps:
      - id: a
        prompt: сделай
        expect: [{ exit_code: 0 }, { judge: "всё хорошо", agent: text_only }]
`,
    });
    const config = {
      ...project.config,
      backends: {
        ...project.config.backends,
        text_only: {
          command: 'text-only',
          enabled: true,
          defaultModel: undefined,
          concurrency: 1,
          cacheReadWeight: 0.1,
          sessions: true,
          structuredOutput: false,
          strictPermissions: false,
          permissions: undefined,
          env: {},
        },
      },
    };
    const diagnostics = lintPipeline(
      expandPipeline({ pipelinePath: project.path('stepcast.yml'), config }),
      { config },
    );
    assert.ok(
      errors(diagnostics).some((message) => /не поддерживает структурированный вывод/.test(message)),
    );
  });

  // plugin-contributions: бэкенд судьи обязан быть не только настроен, но и
  // предоставлен — иначе прогон упрётся в это на первом вызове судьи.
  it('отклоняет бэкенд судьи, для которого нет адаптера', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  build:
    steps:
      - id: a
        prompt: сделай
        expect: [{ exit_code: 0 }, { judge: "всё хорошо", agent: codex }]
`,
    });
    const config = {
      ...project.config,
      backends: {
        ...project.config.backends,
        codex: { ...(project.config.backends.claude as BackendConfig), command: 'codex' },
      },
    };

    const diagnostics = lintPipeline(
      expandPipeline({ pipelinePath: project.path('stepcast.yml'), config }),
      { config },
    );

    const message = errors(diagnostics).find((text) => /Адаптер бэкенда судьи codex/.test(text));
    assert.ok(message !== undefined, errors(diagnostics).join('\n'));
  });

  it('принимает бэкенд судьи, предоставленный плагином', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  build:
    steps:
      - id: a
        prompt: сделай
        expect: [{ exit_code: 0 }, { judge: "всё хорошо", agent: codex }]
`,
    });
    const config = {
      ...project.config,
      backends: {
        ...project.config.backends,
        codex: { ...(project.config.backends.claude as BackendConfig), command: 'codex' },
      },
    };
    const registry = builtinRegistry();
    addPlugin(registry, { name: 'codex-adapter', backends: { codex: { create: () => ({}) as never } } }, '/м.js');

    const diagnostics = lintPipeline(
      expandPipeline({ pipelinePath: project.path('stepcast.yml'), config }),
      { config, registry },
    );

    assert.deepEqual(
      errors(diagnostics).filter((text) => /Адаптер бэкенда судьи/.test(text)),
      [],
    );
  });

  // Сценарий: «Противоречивое сочетание с разрешающим режимом»
  it('отклоняет enforce: strict рядом с разрешающим режимом бэкенда', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  build:
    steps:
      - id: ask
        prompt: сделай
        permissions:
          mode: bypassPermissions
          enforce: strict
`,
    });
    const diagnostics = lint(project);
    const messages = errors(diagnostics);
    assert.ok(
      messages.some(
        (message) => /enforce: strict/.test(message) && /mode: bypassPermissions/.test(message),
      ),
    );
  });

  // Сценарий: «Жёсткий режим на бэкенде без поддержки»
  it('отклоняет enforce: strict на бэкенде без объявленной возможности', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  build:
    steps:
      - id: ask
        agent: no_strict
        prompt: сделай
        permissions:
          enforce: strict
`,
    });
    const config = {
      ...project.config,
      backends: {
        ...project.config.backends,
        no_strict: {
          command: 'no-strict',
          enabled: true,
          defaultModel: undefined,
          concurrency: 1,
          cacheReadWeight: 0.1,
          sessions: true,
          structuredOutput: true,
          strictPermissions: false,
          permissions: undefined,
          env: {},
        },
      },
    };
    const diagnostics = lintPipeline(
      expandPipeline({ pipelinePath: project.path('stepcast.yml'), config }),
      { config },
    );
    const messages = errors(diagnostics);
    assert.ok(
      messages.some(
        (message) => /no_strict/.test(message) && /не объявляет возможность/.test(message),
      ),
    );
  });

  it('enforce: strict на поддерживающем бэкенде с запрещающим режимом проходит молча', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  build:
    steps:
      - id: ask
        prompt: сделай
        permissions:
          mode: manual
          allow: [Read]
          enforce: strict
`,
    });
    const diagnostics = lint(project);
    assert.deepEqual(errors(diagnostics), []);
  });

  it('называет объявление работы, а не скопированное в шаг поле', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  build:
    permissions:
      mode: bypassPermissions
      enforce: strict
    steps:
      - id: ask
        prompt: сделай
`,
    });
    const found = lint(project).filter(
      (item) => item.severity === 'error' && /enforce: strict/.test(item.message),
    );
    assert.equal(found.length, 1);
    assert.equal(found[0]?.at, 'jobs.build.permissions.enforce');
  });

  it('базовый strict бэкенда проверяется и у шага со своим блоком permissions', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  build:
    steps:
      - id: ask
        agent: no_strict
        prompt: сделай
        permissions:
          allow: [Read]
`,
    });
    const config = {
      ...project.config,
      backends: {
        ...project.config.backends,
        no_strict: {
          command: 'no-strict',
          enabled: true,
          defaultModel: undefined,
          concurrency: 1,
          cacheReadWeight: 0.1,
          sessions: true,
          structuredOutput: true,
          strictPermissions: false,
          permissions: { enforce: 'strict' as const },
          env: {},
        },
      },
    };
    const found = lintPipeline(
      expandPipeline({ pipelinePath: project.path('stepcast.yml'), config }),
      { config },
    ).filter((item) => item.severity === 'error');

    assert.ok(found.some((item) => /не объявляет возможность/.test(item.message)));
    assert.equal(found[0]?.at, 'backends.no_strict.permissions.enforce');
  });

  it('предупреждает о контексте у работы без агентских шагов', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  build:
    context: [AGENTS.md]
    steps: [{ id: c, run: [echo, ok] }]
`,
      'AGENTS.md': 'правила\n',
    });
    assert.ok(warnings(lint(project)).some((message) => /нет агентских шагов/.test(message)));
  });

  it('собирает все ошибки сразу, а не по одной', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 90M }
jobs:
  build:
    needs: [nope]
    if: "inputs.absent"
    env: { API_KEY_SECRET: x }
    steps: [{ id: c, run: [echo, ok] }]
`,
      }),
    );
    assert.ok(errors(diagnostics).length >= 4, `собрано ошибок: ${errors(diagnostics).length}`);
  });

  // Спека stepcast-configuration: «budget.cost выше limits.cost»
  it('даёт ошибку при budget.cost выше limits.cost на уровне пайплайна', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
budget: { cost: 999 }
jobs:
  build:
    steps: [{ id: c, run: [echo, ok] }]
`,
    });
    const messages = errors(lint(project));
    assert.ok(messages.some((message) => message.includes('budget.cost') && message.includes('limits.cost')));
  });

  it('даёт ошибку при budget.cost выше limits.cost на уровне шага', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: s
        agent: claude
        prompt: hi
        budget: { cost: 999 }
`,
    });
    const messages = errors(lint(project));
    assert.ok(messages.some((message) => message.includes('budget.cost')));
  });

  it('не даёт ошибку, когда budget.cost не объявлен', () => {
    const diagnostics = lint(makeProject({ 'stepcast.yml': OK_PIPELINE }));
    assert.deepEqual(errors(diagnostics), []);
  });

  it('ошибка раскрытия остаётся фатальной и одиночной', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    uses: ./jobs/missing.yml
`,
    });
    assert.throws(
      () =>
        expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
      StepcastError,
    );
  });
});

describe('pipeline-definition: путь копии при неподходящем режиме', () => {
  it('отклоняет путь размещения рабочей копии при режиме, отличном от copy', () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: путь-не-туда
workspace: { mode: cwd, path: ./куда-то }
jobs:
  build:
    steps:
      - id: a
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
`,
    });

    const diagnostics = lint(project);
    assert.ok(
      errors(diagnostics).some((message) => /допустим только при режиме copy/.test(message)),
    );
  });
});

describe('pipeline-definition: состав вложенных репозиториев в изолированных режимах', () => {
  const PIPELINE_WORKTREE = `
version: 1
kind: pipeline
name: составной
workspace: { mode: worktree }
jobs:
  build:
    steps:
      - id: a
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
`;

  const PIPELINE_COPY = PIPELINE_WORKTREE.replace('mode: worktree', 'mode: copy');

  // Копия `.git` не содержит — тот же отказ и та же причина, что в
  // `checkWorkspaceAvailability` (run/workspace.ts), только раньше, статически.
  it('отклоняет работу в режиме copy при объявленном составе, называя работу и режим', () => {
    const project = makeProject({ 'stepcast.yml': PIPELINE_COPY });

    const diagnostics = lintWithConfig(project, withNestedRepos(project, ['public-site']));
    const found = diagnostics.find((item) => item.at === 'jobs.build.workspace.mode');
    assert.ok(found !== undefined, 'диагностика по jobs.build.workspace.mode должна найтись');
    assert.equal(found.severity, 'error');
    assert.match(found.message, /build/);
    assert.match(found.message, /copy/);
    assert.equal(found.file, project.path('stepcast.yml'));
  });

  // Задача 3 (nested-repo-isolation): worktree при объявленном составе больше
  // не отклоняется — часть материализуется собственным рабочим деревом.
  it('worktree при объявленном составе не отклоняется по workspace.mode', () => {
    const project = makeProject({ 'stepcast.yml': PIPELINE_WORKTREE });

    const diagnostics = lintWithConfig(project, withNestedRepos(project, ['public-site']));
    assert.equal(
      diagnostics.some((item) => item.at === 'jobs.build.workspace.mode'),
      false,
    );
  });

  it('на пустом составе диагностики нет', () => {
    const project = makeProject({ 'stepcast.yml': PIPELINE_WORKTREE });

    const diagnostics = lint(project);
    assert.equal(
      diagnostics.some((item) => item.at === 'jobs.build.workspace.mode' || item.at === 'project.nested_repos'),
      false,
    );
  });

  it('отклоняет часть без коммита в режиме worktree, даже если корень её игнорирует', () => {
    const project = makeProject({
      'stepcast.yml': PIPELINE_WORKTREE,
      '.gitignore': 'public-site/\n',
      'public-site/index.html': 'сайт\n',
    });
    gitInit(project.root);
    gitCommit(project.root, 'первый');
    gitInit(project.path('public-site'));

    const diagnostics = lintWithConfig(project, withNestedRepos(project, ['public-site']));
    const found = diagnostics.find((item) => item.at === 'project.nested_repos');
    assert.ok(found !== undefined, 'диагностика по project.nested_repos должна найтись');
    assert.equal(found.severity, 'error');
    assert.match(found.message, /public-site/);
    assert.match(found.message, /не имеет ни одного коммита/);
  });

  it('отклоняет часть, чьи файлы отслеживает корень, в режиме worktree', () => {
    const project = makeProject({
      'stepcast.yml': PIPELINE_WORKTREE,
      'public-site/index.html': 'сайт\n',
    });
    gitInit(project.root);
    gitCommit(project.root, 'первый');
    gitInit(project.path('public-site'));
    gitCommit(project.path('public-site'), 'начало части');

    const diagnostics = lintWithConfig(project, withNestedRepos(project, ['public-site']));
    const found = diagnostics.find((item) => item.at === 'project.nested_repos');
    assert.ok(found !== undefined, 'диагностика по project.nested_repos должна найтись');
    assert.equal(found.severity, 'error');
    assert.match(found.message, /public-site/);
    assert.match(found.message, /отслеживает файлы/);
  });

  it('пригодный состав в режиме worktree диагностики не даёт', () => {
    const project = makeProject({
      'stepcast.yml': PIPELINE_WORKTREE,
      'public-site/.gitkeep': '',
    });
    gitInit(project.path('public-site'));
    gitCommit(project.path('public-site'), 'начало части');
    gitInit(project.root);
    gitCommit(project.root, 'первый');

    const diagnostics = lintWithConfig(project, withNestedRepos(project, ['public-site']));
    assert.equal(
      diagnostics.some((item) => item.at === 'jobs.build.workspace.mode' || item.at === 'project.nested_repos'),
      false,
    );
  });
});

describe('pipeline-definition: подстановка в числовые поля', () => {
  it('пайплайн с параметризованными числовыми полями проходит lint', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
inputs:
  workers: { type: int, required: true }
concurrency: "\${inputs.workers}"
jobs:
  build:
    uses: ./jobs/build.yml
    with: { retries: 2 }
`,
      'jobs/build.yml': `
kind: job
params:
  retries: { type: int, required: true }
until:
  max_iterations: "\${params.retries}"
  check: [{ file_exists: done.txt }]
steps:
  - id: c
    run: [echo, ok]
    attempts: { max: "\${params.retries}" }
`,
    });

    const diagnostics = lint(project, { workers: '2' });
    assert.deepEqual(errors(diagnostics), []);
  });

  // Предупреждение о худшем случае цикла until считается по раскрытому пределу
  it('предупреждение о худшем случае цикла until считается по раскрытому max_iterations', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  build:
    uses: ./jobs/build.yml
    with: { rounds: 5 }
`,
      'jobs/build.yml': `
kind: job
params:
  rounds: { type: int, required: true }
until:
  max_iterations: "\${params.rounds}"
  check: [{ file_exists: done.txt }]
steps:
  - id: c
    run: [echo, ok]
`,
    });

    const diagnostics = lint(project);
    assert.ok(
      diagnostics.some(
        (item) => item.severity === 'warning' && /Худший случай: до 5 исполнений/.test(item.hint ?? ''),
      ),
    );
  });
});

describe('schedule-trigger: статическая проверка расписания', () => {
  // Сценарий: «Триггер расписания признаётся»
  it('принимает объявленное расписание', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
triggers:
  schedule:
    - cron: "0 3 * * *"
jobs:
  build:
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
`,
      }),
    );
    assert.deepEqual(errors(diagnostics), []);
  });

  // Сценарий: «Поле cron отсутствует»
  it('называет отсутствие обязательного cron', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
triggers:
  schedule:
    - timezone: UTC
jobs:
  build:
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
`,
      }),
    );
    const found = diagnostics.find(
      (item) => item.severity === 'error' && item.at === 'triggers.schedule.0.cron',
    );
    assert.ok(found !== undefined, 'ошибка должна называть поле cron записи 0');
    assert.match(found.message, /cron/);
  });

  it('называет пустой cron тем же способом, что и отсутствующий', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
triggers:
  schedule:
    - cron: ""
      timezone: UTC
jobs:
  build:
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
`,
      }),
    );
    const found = errors(diagnostics).find((message) => /cron/.test(message));
    assert.ok(found !== undefined);
  });

  // Сценарий: «Неразбираемое выражение»
  it('называет номер записи и причину отказа разбора', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
triggers:
  schedule:
    - cron: "не выражение"
jobs:
  build:
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
`,
      }),
    );
    const found = diagnostics.find(
      (item) => item.severity === 'error' && item.at === 'triggers.schedule.0.cron',
    );
    assert.ok(found !== undefined, 'ошибка должна называть запись 0');
  });

  // Сценарий: «Неизвестный часовой пояс»
  it('называет неизвестный часовой пояс', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
triggers:
  schedule:
    - cron: "0 3 * * *"
      timezone: Mars/Olympus
jobs:
  build:
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
`,
      }),
    );
    const found = errors(diagnostics).find((message) => /Mars\/Olympus/.test(message));
    assert.ok(found !== undefined);
  });

  // Сценарий: «Расписание без срабатываний»
  it('называет невыполнимое расписание', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
triggers:
  schedule:
    - cron: "0 0 30 2 *"
jobs:
  build:
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
`,
      }),
    );
    const found = diagnostics.find(
      (item) => item.severity === 'error' && item.at === 'triggers.schedule.0',
    );
    assert.ok(found !== undefined);
  });

  it('принимает 29 февраля: вердикт не зависит от дня запуска линта', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
triggers:
  schedule:
    - cron: "0 0 29 2 *"
jobs:
  build:
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
`,
      }),
    );
    assert.deepEqual(errors(diagnostics), []);
  });

  // Сценарий: «Расписание проверено целиком» — ошибочна вторая запись
  it('называет именно вторую запись из двух, когда ошибочна она', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
triggers:
  schedule:
    - cron: "0 3 * * *"
    - cron: "0 0 30 2 *"
jobs:
  build:
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
`,
      }),
    );
    const scheduleErrors = errors(diagnostics).filter((message) => /расписан/i.test(message));
    assert.equal(scheduleErrors.length, 1);
    const found = diagnostics.find(
      (item) => item.severity === 'error' && item.at === 'triggers.schedule.1',
    );
    assert.ok(found !== undefined, 'ошибка должна называть именно вторую запись (индекс 1)');
  });
});

describe('dependent-job-workspace: источник наследования рабочего дерева', () => {
  // Сценарий: «Неизвестная работа в источнике»
  it('отклоняет inherit, называющий несуществующую работу', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
workspace: { mode: worktree }
budget: { tokens: 100k }
jobs:
  a:
    steps: [{ id: c, run: [echo, a] }]
  b:
    needs: [a]
    workspace: { inherit: ghost }
    steps: [{ id: c, run: [echo, b] }]
`,
      }),
    );
    const message = errors(diagnostics).find((item) => /ghost/.test(item));
    assert.ok(message !== undefined, 'ошибка должна называть несуществующую работу ghost');
  });

  // Сценарий: «Источник вне зависимостей»
  it('отклоняет inherit, называющий работу вне зависимостей', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
workspace: { mode: worktree }
budget: { tokens: 100k }
jobs:
  a:
    steps: [{ id: c, run: [echo, a] }]
  b:
    steps: [{ id: c, run: [echo, b] }]
  c:
    needs: [b]
    workspace: { inherit: a }
    steps: [{ id: c, run: [echo, c] }]
`,
      }),
    );
    const message = errors(diagnostics).find((item) => /не входящей в её зависимости/.test(item));
    assert.ok(message !== undefined);
  });

  // Сценарий: «Источник при режиме cwd»
  it('отклоняет inherit при режиме cwd', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
workspace: { mode: cwd }
budget: { tokens: 100k }
jobs:
  a:
    steps: [{ id: c, run: [echo, a] }]
  b:
    needs: [a]
    workspace: { inherit: a }
    steps: [{ id: c, run: [echo, b] }]
`,
      }),
    );
    const message = errors(diagnostics).find((item) => /режиме cwd/.test(item));
    assert.ok(message !== undefined);
  });

  // Сценарий: «Несколько зависимостей без объявленного источника»
  it('отклоняет несколько зависимостей в изолирующем режиме без inherit', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
workspace: { mode: worktree }
budget: { tokens: 100k }
jobs:
  a:
    steps: [{ id: c, run: [echo, a] }]
  b:
    steps: [{ id: c, run: [echo, b] }]
  c:
    needs: [a, b]
    steps: [{ id: c, run: [echo, c] }]
`,
      }),
    );
    const message = errors(diagnostics).find((item) => /не объявляет workspace\.inherit/.test(item));
    assert.ok(message !== undefined);
  });

  // Сценарий: «Источник объявлен пайплайном» — `inherit` осмыслен только на
  // работе: источник выбирается для конкретной зависимой работы, а не для
  // пайплайна целиком. Отказ приходит из схемы, до линта, и называет ключ.
  it('отклоняет workspace.inherit на уровне пайплайна, называя ключ', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
workspace: { mode: worktree, inherit: a }
budget: { tokens: 100k }
jobs:
  a:
    steps: [{ id: c, run: [echo, a] }]
`,
    });

    assert.throws(
      () => lint(project),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /inherit/);
        assert.equal(error.at, 'workspace');
        return true;
      },
    );
  });

  it('отклоняет workspace.inherit в defaults.workspace, называя ключ', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
defaults: { workspace: { mode: worktree, inherit: a } }
jobs:
  a:
    steps: [{ id: c, run: [echo, a] }]
`,
    });

    assert.throws(
      () => lint(project),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /inherit/);
        return true;
      },
    );
  });

  // Сценарий: «Единственная зависимость объявления не требует»
  it('принимает единственную зависимость без inherit', () => {
    const diagnostics = lint(
      makeProject({
        'stepcast.yml': `
kind: pipeline
workspace: { mode: worktree }
budget: { tokens: 100k }
jobs:
  a:
    steps: [{ id: c, run: [echo, a] }]
  b:
    needs: [a]
    steps: [{ id: c, run: [echo, b] }]
`,
      }),
    );
    assert.deepEqual(errors(diagnostics), []);
  });
});

/**
 * Проверки идут настоящими командами `stepcast lint` и `stepcast run`, а не
 * прямым вызовом `expandPipeline`: сценарии спеки говорят именно о них, и
 * важно не только то, что раскрытие отказывает, но и то, что отказ случается
 * до заведения каталога прогона.
 */
describe('pipeline-definition: команды о необъявленном project.check', () => {
  async function cli(
    project: Project,
    argv: readonly string[],
  ): Promise<{ code: ExitCodeValue; out: string }> {
    const lines: string[] = [];
    const io: CliIo = {
      out: (line) => lines.push(line),
      err: (line) => lines.push(line),
      cwd: project.root,
    };
    const code = await withHome(project.home, () => run(argv, io));
    return { code, out: lines.join('\n') };
  }

  const REFERRING = `
kind: pipeline
name: ссылается
budget: { tokens: 100k }
jobs:
  build:
    steps: [{ id: c, run: "\${project.check}", expect: [{ exit_code: 0 }] }]
`;

  it('lint отказывает на ссылке без объявления, называя оба места объявления', async () => {
    const project = makeProject({ 'stepcast.yml': REFERRING });

    const result = await cli(project, ['lint', 'stepcast.yml']);

    assert.equal(result.code, ExitCode.configError);
    assert.match(result.out, /project\.check/);
    assert.match(result.out, /\.stepcast\/config\.yml/);
  });

  it('lint отказывает на имени вне состава пространства — другим сообщением', async () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  build:
    steps: [{ id: c, run: "\${project.name}", expect: [{ exit_code: 0 }] }]
`,
    });

    const result = await cli(project, ['lint', 'stepcast.yml']);

    assert.equal(result.code, ExitCode.configError);
    assert.match(result.out, /содержит только check/);
    assert.doesNotMatch(result.out, /Объявите/);
  });

  it('lint принимает пайплайн, когда команду объявляет .stepcast/config.yml проекта', async () => {
    const project = makeProject({
      'stepcast.yml': REFERRING,
      '.stepcast/config.yml': 'project:\n  check: npm run check\n',
    });

    const result = await cli(project, ['lint', 'stepcast.yml']);

    assert.equal(result.code, ExitCode.ok);
    assert.match(result.out, /^ok: stepcast\.yml/m);
  });

  it('run не начинает прогон: каталога журнала не появляется', async () => {
    const project = makeProject({ 'stepcast.yml': REFERRING });

    const result = await cli(project, ['run', 'stepcast.yml']);

    assert.equal(result.code, ExitCode.configError);
    assert.match(result.out, /project\.check/);
    // `runs.root` умолчанием — `~/.stepcast/runs`, а HOME на время вызова
    // подменён каталогом проекта: отсутствие каталога и значит, что прогон не
    // начинался.
    assert.equal(existsSync(join(project.home, '.stepcast', 'runs')), false);
  });
});

/**
 * Тот же контракт, что у `project.check` выше, но для составного имени
 * пространства `project.spec.*` (задача 3.5): настоящие команды, не прямой
 * вызов `expandPipeline`, — сценарий спеки говорит именно про `stepcast lint`
 * и `stepcast run`.
 */
describe('pipeline-definition: команды о необъявленном project.spec.dir', () => {
  async function cli(
    project: Project,
    argv: readonly string[],
  ): Promise<{ code: ExitCodeValue; out: string }> {
    const lines: string[] = [];
    const io: CliIo = {
      out: (line) => lines.push(line),
      err: (line) => lines.push(line),
      cwd: project.root,
    };
    const code = await withHome(project.home, () => run(argv, io));
    return { code, out: lines.join('\n') };
  }

  const REFERRING = `
kind: pipeline
name: ссылается
budget: { tokens: 100k }
jobs:
  build:
    steps: [{ id: c, run: "\${project.spec.dir}", expect: [{ exit_code: 0 }] }]
`;

  it('lint отказывает на ссылке без объявления, называя ключ и оба места объявления', async () => {
    const project = makeProject({ 'stepcast.yml': REFERRING });

    const result = await cli(project, ['lint', 'stepcast.yml']);

    assert.equal(result.code, ExitCode.configError);
    assert.match(result.out, /project\.spec\.dir/);
    assert.match(result.out, /\.stepcast\/config\.yml/);
  });

  it('lint принимает пайплайн, когда группу объявляет .stepcast/config.yml проекта', async () => {
    const project = makeProject({
      'stepcast.yml': REFERRING,
      '.stepcast/config.yml': 'project:\n  spec:\n    dir: openspec/changes\n',
    });

    const result = await cli(project, ['lint', 'stepcast.yml']);

    assert.equal(result.code, ExitCode.ok);
    assert.match(result.out, /^ok: stepcast\.yml/m);
  });

  it('run не начинает прогон: каталога журнала не появляется', async () => {
    const project = makeProject({ 'stepcast.yml': REFERRING });

    const result = await cli(project, ['run', 'stepcast.yml']);

    assert.equal(result.code, ExitCode.configError);
    assert.match(result.out, /project\.spec\.dir/);
    assert.equal(existsSync(join(project.home, '.stepcast', 'runs')), false);
  });
});

describe('lint: практика памяти', () => {
  const WITH_KNOWLEDGE = `
kind: pipeline
name: knowledge
budget: { tokens: 100k }
context:
  - knowledge: index
jobs:
  work:
    steps:
      - id: write
        agent: claude
        prompt: пиши
        expect: [{ knowledge_valid: true }]
`;

  /** Практика памяти, объявленная так, будто она в `.stepcast/config.yml`. */
  function withKnowledge(project: Project): Config {
    return {
      ...project.config,
      project: {
        ...project.config.project,
        knowledge: { ...project.config.project.knowledge, provider: 'fs', dir: 'knowledge' },
      },
    };
  }

  // Задача 3.7 / Сценарий: «Запись знания без источника»
  it('отклоняет запись knowledge, когда практика памяти не объявлена', () => {
    const project = makeProject({ 'stepcast.yml': WITH_KNOWLEDGE });
    const messages = errors(lint(project));

    assert.ok(messages.some((message) => /Запись контекста knowledge/.test(message)));
  });

  // Задача 6.2 / Сценарий: «Предикат без источника»
  it('отклоняет предикат knowledge_valid, когда практика памяти не объявлена', () => {
    const project = makeProject({ 'stepcast.yml': WITH_KNOWLEDGE });
    const messages = errors(lint(project));

    assert.ok(messages.some((message) => /Предикат knowledge_valid/.test(message)));
  });

  it('принимает и запись, и предикат, когда практика объявлена', () => {
    const project = makeProject({ 'stepcast.yml': WITH_KNOWLEDGE });
    const messages = errors(lintWithConfig(project, withKnowledge(project)));

    assert.deepEqual(
      messages.filter((message) => /knowledge/i.test(message)),
      [],
    );
  });

  // Задача 3.6 / Сценарий: «Неизвестная форма отклоняется»
  it('раскрытие отклоняет неизвестную форму селектора', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
name: bad
context:
  - knowledge: { query: "судья" }
jobs:
  work:
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
`,
    });

    assert.throws(() => lint(project), StepcastError);
  });

  // Задача 3.6: ни одной формы селектора — та же природа промаха.
  it('раскрытие отклоняет запись knowledge без scope и без id', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
name: bad
context:
  - knowledge: {}
jobs:
  work:
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
`,
    });

    assert.throws(
      () => lint(project),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /ни scope, ни id/);
        return true;
      },
    );
  });

  it('раскрытие отклоняет запись knowledge и со scope, и с id', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
name: bad
context:
  - knowledge: { scope: "src/**", id: "a" }
jobs:
  work:
    steps: [{ id: c, run: [echo, ok], expect: [{ exit_code: 0 }] }]
`,
    });

    assert.throws(
      () => lint(project),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /и scope, и id/);
        return true;
      },
    );
  });

  // Задача 6.1: отрицания у предиката нет, и молчаливое чтение false как
  // «не проверять» отличало бы выключенную проверку от отсутствующей ничем.
  it('раскрытие отклоняет knowledge_valid: false', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
name: bad
jobs:
  work:
    steps:
      - id: c
        run: [echo, ok]
        expect: [{ knowledge_valid: false }]
`,
    });

    assert.throws(
      () => lint(project),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /только true/);
        return true;
      },
    );
  });

  // Задача 3.1 / Сценарий: «Область списком раскрывает подстановку границ»
  it('область списком раскрывает ${project.edit_paths} по элементу на путь', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
name: scoped
budget: { tokens: 100k }
jobs:
  work:
    context:
      - knowledge:
          scope:
            - \${project.edit_paths}
    steps:
      - id: write
        agent: claude
        prompt: пиши
        expect: [{ exit_code: 0 }]
`,
    });

    const config: Config = {
      ...withKnowledge(project),
      project: {
        ...withKnowledge(project).project,
        editPaths: ['src/**', 'test/**'],
      },
    };

    const expanded = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config });
    const entry = expanded.pipeline.jobs[0]?.context[0];
    assert.equal(entry?.kind, 'knowledge');
    assert.deepEqual(entry.selector, { kind: 'scope', scope: ['src/**', 'test/**'] });
  });
});
