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
