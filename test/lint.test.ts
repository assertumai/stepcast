import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { expandPipeline } from '../src/core/pipeline/expand.js';
import { hasErrors, lintPipeline, type Diagnostic } from '../src/core/lint.js';
import { StepcastError } from '../src/core/errors.js';
import { makeProject, type Project } from './helpers.js';

function lint(project: Project, inputs?: Record<string, string>): Diagnostic[] {
  const expanded = expandPipeline({
    pipelinePath: project.path('stepcast.yml'),
    config: project.config,
    ...(inputs === undefined ? {} : { inputs }),
  });
  return lintPipeline(expanded, { config: project.config });
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

  // Сценарий, тот же перечень, для подстановки ${jobs.<id>.*} вне `if`
  it('предупреждает о подстановке выхода соседней работы при concurrency больше единицы', () => {
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
    steps:
      - id: использует
        run: [sh, -c, 'echo "\${jobs.propose.output.slug}" > slug.txt']
        expect: [{ exit_code: 0 }]
`,
      }),
    );
    assert.ok(
      warnings(diagnostics).some(
        (message) =>
          /Работа implement подставляет/.test(message) &&
          /выход работы propose, не входящей/.test(message),
      ),
      'предупреждение называет обе работы',
    );
  });

  // Сценарий: «Ссылка на зависимость не предупреждается», форма подстановки
  it('не предупреждает о подстановке выхода объявленной зависимости', () => {
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
      warnings(diagnostics).filter((message) => /подставляет/.test(message)),
      [],
    );
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
