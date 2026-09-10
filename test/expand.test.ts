import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';

import { expandPipeline } from '../src/core/pipeline/expand.js';
import { interpolate, interpolateTree, type Scope } from '../src/core/pipeline/interpolate.js';
import { jobLockHash, serializeLock } from '../src/core/pipeline/lock.js';
import { computeStepKey } from '../src/core/run/stepKey.js';
import { StepcastError } from '../src/core/errors.js';
import type { BackendConfig, Config } from '../src/core/config/resolve.js';
import { asAgent, asRun, asScript, makeProject, MINIMAL_PIPELINE, type Project } from './helpers.js';
import { tempDir } from './tmp.js';
import type { ScriptRoots } from '../src/core/pipeline/expand.js';

/** Бэкенд с умолчанием модели — для проверки слоя `backend`. */
const BACKEND_WITH_DEFAULT_MODEL: BackendConfig = {
  command: 'claude',
  enabled: true,
  defaultModel: 'haiku',
  concurrency: 2,
  cacheReadWeight: 0.1,
  sessions: true,
  structuredOutput: true,
  strictPermissions: true,
  mcp: true,
  permissions: undefined,
  env: {},
};

/** Тот же проект, но с указанным `project.check`, будто он объявлен в `.stepcast/config.yml`. */
function withProjectCheck(project: Project, check: string | undefined): Config {
  return { ...project.config, project: { ...project.config.project, check } };
}

/** Тот же проект, но с указанной группой `project.spec`, будто она объявлена в `.stepcast/config.yml`. */
function withProjectSpec(project: Project, spec: Partial<Config['project']['spec']>): Config {
  return {
    ...project.config,
    project: { ...project.config.project, spec: { ...project.config.project.spec, ...spec } },
  };
}

/** Тот же проект, но с указанными `project.tools`, будто они объявлены в `.stepcast/config.yml`. */
function withProjectTools(project: Project, tools: readonly string[] | undefined): Config {
  return { ...project.config, project: { ...project.config.project, tools } };
}

/** Тот же проект, но с указанными `project.edit_paths`, будто они объявлены в `.stepcast/config.yml`. */
function withProjectEditPaths(project: Project, editPaths: readonly string[] | undefined): Config {
  return { ...project.config, project: { ...project.config.project, editPaths } };
}

/** Тот же проект, но с указанной группой `project.knowledge`, будто она объявлена в `.stepcast/config.yml`. */
function withProjectKnowledge(
  project: Project,
  knowledge: Partial<Config['project']['knowledge']>,
): Config {
  return {
    ...project.config,
    project: {
      ...project.config.project,
      knowledge: { ...project.config.project.knowledge, ...knowledge },
    },
  };
}

function expand(project: Project, file = 'stepcast.yml', inputs?: Record<string, string>) {
  return expandPipeline({
    pipelinePath: project.path(file),
    config: project.config,
    ...(inputs === undefined ? {} : { inputs }),
  });
}

function expandWith(project: Project, config: Config, file = 'stepcast.yml') {
  return expandPipeline({ pipelinePath: project.path(file), config });
}

/**
 * Корни трёх слоёв script, изолированные от машины: `home` и `builtin` —
 * пустые временные каталоги, а не настоящие `homedir()` и пакет stepcast.
 * Тест, которому нужен непустой слой, дописывает в него файлом.
 */
function isolatedScriptRoots(project: Project): ScriptRoots {
  return { project: project.root, home: tempDir('script-home-'), builtin: tempDir('script-builtin-') };
}

function expandScript(
  project: Project,
  scriptRoots: ScriptRoots,
  file = 'stepcast.yml',
) {
  return expandPipeline({ pipelinePath: project.path(file), config: project.config, scriptRoots });
}

/** Записать файл вне дерева проекта — домашний и встроенный слои script туда и указывают. */
function writeOutsideProject(dir: string, name: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content);
}

/** Отказ, пойманный ради самого сообщения: `assert.throws` его не возвращает. */
function thrown(fn: () => unknown): StepcastError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof StepcastError);
    return error;
  }
  assert.fail('ожидался отказ разбора');
}

describe('pipeline-definition: разбор и раскрытие', () => {
  // Сценарий: «Работа описана на месте»
  it('исполняет работу, описанную на месте', () => {
    const project = makeProject({ 'stepcast.yml': MINIMAL_PIPELINE });
    const { pipeline } = expand(project);

    assert.equal(pipeline.jobs.length, 1);
    const job = pipeline.jobs[0]!;
    assert.equal(job.id, 'build');
    assert.equal(job.source, project.path('stepcast.yml'));
    assert.equal(job.steps[0]!.kind, 'run');
  });

  // Сценарий: «Работа подключена файлом»
  it('раскрывает работу, подключённую файлом', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
name: p
jobs:
  build:
    uses: ./jobs/build.yml
`,
      'jobs/build.yml': `
kind: job
name: build
steps:
  - id: compile
    run: [echo, ok]
`,
    });

    const { pipeline } = expand(project);
    assert.equal(pipeline.jobs[0]!.source, project.path('jobs/build.yml'));
    assert.equal(pipeline.jobs[0]!.steps[0]!.id, 'compile');
  });

  it('отклоняет файл, у которого kind не job', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    uses: ./jobs/build.yml
`,
      'jobs/build.yml': 'kind: pipeline\njobs: {}\n',
    });
    assert.throws(() => expand(project), StepcastError);
  });

  // Сценарий: «Обязательный параметр не передан»
  it('требует обязательный параметр работы', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    uses: ./jobs/build.yml
`,
      'jobs/build.yml': `
kind: job
params:
  target: { type: string, required: true }
steps:
  - id: compile
    run: [echo, "\${params.target}"]
`,
    });

    assert.throws(
      () => expand(project),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /target/);
        return true;
      },
    );
  });

  // Сценарий: «Лишний ключ в with»
  it('отклоняет лишний ключ в with', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    uses: ./jobs/build.yml
    with: { nope: 1 }
`,
      'jobs/build.yml': 'kind: job\nsteps:\n  - id: c\n    run: [echo, ok]\n',
    });
    assert.throws(() => expand(project), StepcastError);
  });

  // Сценарий: «Умолчание параметра»
  it('подставляет умолчание параметра', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    uses: ./jobs/build.yml
`,
      'jobs/build.yml': `
kind: job
params:
  target: { type: string, default: desktop }
steps:
  - id: compile
    run: [echo, "\${params.target}"]
`,
    });

    const step = expand(project).pipeline.jobs[0]!.steps[0]!;
    assert.deepEqual(asRun(step).command, ['echo', 'desktop']);
  });

  it('приводит типы параметров', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
inputs:
  count: { type: int }
  flag: { type: bool }
jobs:
  build:
    steps:
      - id: c
        run: [echo, "\${inputs.count}-\${inputs.flag}"]
`,
    });

    const step = expand(project, 'stepcast.yml', { count: '3', flag: 'false' }).pipeline.jobs[0]!
      .steps[0]!;
    assert.deepEqual(asRun(step).command, ['echo', '3-false']);
  });

  // Сценарий: «needs в файле работы»
  it('отклоняет обвязку внутри файла работы', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    uses: ./jobs/build.yml
`,
      'jobs/build.yml': `
kind: job
needs: [other]
steps:
  - id: c
    run: [echo, ok]
`,
    });

    assert.throws(
      () => expand(project),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /needs недопустим внутри файла работы/);
        assert.equal(error.file, project.path('jobs/build.yml'));
        return true;
      },
    );
  });

  // Сценарий: «Подстановка входа пайплайна»
  it('подставляет вход пайплайна', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
inputs:
  change: { type: string, required: true }
jobs:
  build:
    steps:
      - id: c
        run: [echo, "\${inputs.change}"]
`,
    });

    const step = expand(project, 'stepcast.yml', { change: 'foo' }).pipeline.jobs[0]!.steps[0]!;
    assert.deepEqual(asRun(step).command, ['echo', 'foo']);
  });

  // Сценарий: «Неизвестное имя»
  it('отклоняет обращение к необъявленному входу', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: c
        run: [echo, "\${inputs.missing}"]
`,
    });
    assert.throws(() => expand(project), StepcastError);
  });

  it('работе недоступны inputs пайплайна', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
inputs:
  change: { type: string, default: x }
jobs:
  build:
    uses: ./jobs/build.yml
`,
      'jobs/build.yml': `
kind: job
steps:
  - id: c
    run: [echo, "\${inputs.change}"]
`,
    });

    assert.throws(
      () => expand(project),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.hint ?? '', /Работе недоступны inputs/);
        return true;
      },
    );
  });

  it('оставляет подстановки времени прогона нераскрытыми и запоминает их', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  plan:
    steps:
      - id: c
        run: [echo, ok]
  ship:
    needs: [plan]
    steps:
      - id: c
        run: [echo, "\${jobs.plan.output.target}"]
`,
    });

    const { pipeline, substitutions } = expand(project);
    assert.deepEqual(asRun(pipeline.jobs[1]!.steps[0]!).command, [
      'echo',
      '${jobs.plan.output.target}',
    ]);

    const recorded = [...substitutions.values()].flat();
    const deferred = recorded.find((item) => item.namespace === 'jobs');
    assert.ok(deferred !== undefined, 'подстановка времени прогона должна быть записана');
    assert.equal(deferred.deferred, true);
    assert.equal(deferred.expression, 'jobs.plan.output.target');
  });

  // Сценарий: «Экранирование в промпте»
  it('экранирует $${ в промпте', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  ask:
    steps:
      - id: a
        prompt: "file:./prompts/a.md"
`,
      'prompts/a.md': 'Литерал: $${params.x}\n',
    });

    const step = asAgent(expand(project).pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.prompt.trim(), 'Литерал: ${params.x}');
  });

  // Сценарий: «Промпт рядом с файлом работы»
  it('разрешает промпт от файла работы, а не от пайплайна', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  ask:
    uses: ./.stepcast/jobs/ask.yml
`,
      '.stepcast/jobs/ask.yml': `
kind: job
steps:
  - id: a
    prompt: "file:../prompts/ask.md"
`,
      '.stepcast/prompts/ask.md': 'спроси\n',
    });

    const step = asAgent(expand(project).pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.prompt.trim(), 'спроси');
    assert.equal(step.promptSource, project.path('.stepcast/prompts/ask.md'));
  });

  it('шаблонизирует файл промпта параметрами работы', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  ask:
    uses: ./jobs/ask.yml
    with: { topic: сессии }
`,
      'jobs/ask.yml': `
kind: job
params:
  topic: { type: string, required: true }
steps:
  - id: a
    prompt: "file:./ask.md"
`,
      'jobs/ask.md': 'Расскажи про \${params.topic}.\n',
    });

    const step = asAgent(expand(project).pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.prompt.trim(), 'Расскажи про сессии.');
  });

  // Спека pipeline-definition: «Подстановки файлов промптов видны
  // статической проверке» — сценарий «Подстановка внешнего промпта попадает в карту»
  it('подстановка внешнего промпта попадает в карту под путём шага', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
inputs:
  change: { type: string, default: x }
jobs:
  ask:
    steps:
      - id: a
        prompt: "file:./prompts/ask.md"
`,
      'prompts/ask.md': 'x=${inputs.change}\n',
    });

    const { substitutions } = expand(project);
    const list = substitutions.get('jobs.ask.steps.0.prompt') ?? [];
    const found = list.find((item) => item.namespace === 'inputs');
    assert.ok(found !== undefined, 'подстановка из файла промпта должна быть записана');
    assert.equal(found.origin, project.path('prompts/ask.md'));
    assert.equal(found.line, 1);
    assert.equal(found.column, 3);
  });

  // Сценарий: «Внутренний промпт учитывается как прежде»
  it('подстановка внутреннего промпта записана под тем же путём и без origin', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
inputs:
  change: { type: string, default: x }
jobs:
  ask:
    steps:
      - id: a
        prompt: "\${inputs.change}"
`,
    });

    const { substitutions } = expand(project);
    const list = substitutions.get('jobs.ask.steps.0.prompt') ?? [];
    const found = list.find((item) => item.namespace === 'inputs');
    assert.ok(found !== undefined);
    assert.equal(found.origin, undefined);
  });

  it('подстановка в самом пути file: не теряется', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
inputs:
  which: { type: string, default: ask }
jobs:
  ask:
    steps:
      - id: a
        prompt: "file:./prompts/\${inputs.which}.md"
`,
      'prompts/ask.md': 'спроси\n',
    });

    const { pipeline, substitutions } = expand(project);
    assert.equal(asAgent(pipeline.jobs[0]!.steps[0]!).promptSource, project.path('prompts/ask.md'));
    const list = substitutions.get('jobs.ask.steps.0.prompt') ?? [];
    assert.ok(
      list.some((item) => item.expression === 'inputs.which'),
      'подстановка из пути остаётся в карте наравне с подстановками текста',
    );
  });

  // Промпт документа раскрывается один раз, вместе с телом работы: второй
  // проход снял бы экранирование ещё раз и продублировал бы записи в карте.
  it('внутренний промпт не раскрывается дважды', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
inputs:
  change: { type: string, default: x }
jobs:
  ask:
    steps:
      - id: a
        prompt: "литерал $\${inputs.change}, отложенное \${jobs.other.output.slug}"
  other:
    steps: [{ id: c, run: [echo, ok] }]
`,
    });

    const { pipeline, substitutions } = expand(project);
    const text = asAgent(pipeline.jobs[0]!.steps[0]!).prompt;
    assert.match(text, /литерал \$\{inputs\.change\}/, 'экранирование снято ровно один раз');

    const list = substitutions.get('jobs.ask.steps.0.prompt') ?? [];
    assert.deepEqual(
      list.filter((item) => item.namespace === 'jobs').map((item) => item.expression),
      ['jobs.other.output.slug'],
    );
  });

  it('on_fail.prompt из файла тоже попадает в карту', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
inputs:
  change: { type: string, default: x }
jobs:
  build:
    steps:
      - id: c
        run: [echo, ok]
        on_fail:
          analyze: claude
          prompt: "file:./prompts/fail.md"
`,
      'prompts/fail.md': 'x=${inputs.change}\n',
    });

    const { substitutions } = expand(project);
    const list = substitutions.get('jobs.build.steps.0.on_fail.prompt') ?? [];
    const found = list.find((item) => item.namespace === 'inputs');
    assert.ok(found !== undefined);
    assert.equal(found.origin, project.path('prompts/fail.md'));
  });

  it('применяет умолчания конфигурации и пайплайна к шагам', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
defaults:
  model: opus
jobs:
  ask:
    steps:
      - id: a
        prompt: спроси
      - id: b
        prompt: ещё
        model: sonnet
        timeout: 5m
`,
    });

    const steps = expand(project).pipeline.jobs[0]!.steps;
    const first = asAgent(steps[0]!);
    const second = asAgent(steps[1]!);

    assert.equal(first.agent, 'claude');
    assert.equal(first.model, 'opus');
    assert.equal(first.timeoutMs, 30 * 60_000, 'умолчание step_timeout из конфигурации');
    assert.equal(second.model, 'sonnet');
    assert.equal(second.timeoutMs, 5 * 60_000);
  });

  describe('слой модели шага', () => {
    it('слой step: модель объявлена самим шагом', () => {
      const project = makeProject({
        'stepcast.yml': `
kind: pipeline
defaults:
  model: opus
jobs:
  ask:
    steps:
      - id: a
        prompt: спроси
        model: sonnet
`,
      });

      const { pipeline, modelOrigins } = expand(project);
      assert.equal(asAgent(pipeline.jobs[0]!.steps[0]!).model, 'sonnet');
      assert.deepEqual(modelOrigins.get('ask/a'), { layer: 'step' });
    });

    it('слой pipeline: модель пришла из умолчаний документа', () => {
      const project = makeProject({
        'stepcast.yml': `
kind: pipeline
defaults:
  model: opus
jobs:
  ask:
    steps:
      - id: a
        prompt: спроси
`,
      });

      const { pipeline, modelOrigins } = expand(project);
      assert.equal(asAgent(pipeline.jobs[0]!.steps[0]!).model, 'opus');
      assert.deepEqual(modelOrigins.get('ask/a'), { layer: 'pipeline' });
    });

    it('слой config: модель пришла из конфигурации, документ умолчания не объявляет', () => {
      const project = makeProject({
        'stepcast.yml': `
kind: pipeline
jobs:
  ask:
    steps:
      - id: a
        prompt: спроси
`,
      });
      const config: Config = {
        ...project.config,
        defaults: { ...project.config.defaults, model: 'opus' },
      };

      const { pipeline, modelOrigins } = expandWith(project, config);
      assert.equal(asAgent(pipeline.jobs[0]!.steps[0]!).model, 'opus');
      assert.deepEqual(modelOrigins.get('ask/a'), { layer: 'config' });
    });

    it('слой backend: модель — умолчание бэкенда шага', () => {
      const project = makeProject({
        'stepcast.yml': `
kind: pipeline
jobs:
  ask:
    steps:
      - id: a
        prompt: спроси
`,
      });
      const config: Config = {
        ...project.config,
        backends: { ...project.config.backends, claude: BACKEND_WITH_DEFAULT_MODEL },
      };

      const { pipeline, modelOrigins } = expandWith(project, config);
      assert.equal(asAgent(pipeline.jobs[0]!.steps[0]!).model, 'haiku');
      assert.deepEqual(modelOrigins.get('ask/a'), { layer: 'backend', backend: 'claude' });
    });

    it('слой none: модель не задана ни на одном из четырёх звеньев', () => {
      const project = makeProject({
        'stepcast.yml': `
kind: pipeline
jobs:
  ask:
    steps:
      - id: a
        prompt: спроси
`,
      });

      const config: Config = {
        ...project.config,
        backends: { claude: { ...project.config.backends.claude!, defaultModel: undefined } },
      };
      const { pipeline, modelOrigins } = expandWith(project, config);
      assert.equal(asAgent(pipeline.jobs[0]!.steps[0]!).model, undefined);
      assert.deepEqual(modelOrigins.get('ask/a'), { layer: 'none' });
    });

    it('одинаковое значение модели с разных звеньев остаётся различимо', () => {
      const project = makeProject({
        'stepcast.yml': `
kind: pipeline
jobs:
  ask:
    steps:
      - id: declared
        prompt: спроси
        model: opus
      - id: from-config
        prompt: спроси
`,
      });
      const config: Config = {
        ...project.config,
        defaults: { ...project.config.defaults, model: 'opus' },
      };

      const { pipeline, modelOrigins } = expandWith(project, config);
      const steps = pipeline.jobs[0]!.steps;
      assert.equal(asAgent(steps[0]!).model, 'opus');
      assert.equal(asAgent(steps[1]!).model, 'opus');
      assert.deepEqual(modelOrigins.get('ask/declared'), { layer: 'step' });
      assert.deepEqual(modelOrigins.get('ask/from-config'), { layer: 'config' });
    });

    it('ключ шага и pipeline.lock.yml не зависят от слоя, давшего модель', () => {
      // Один и тот же шаг `a`, одно и то же значение модели `opus`, но с
      // разных звеньев: документ объявляет умолчание в одном пайплайне,
      // конфигурация — в другом. Step, который хеширует `computeStepKey`, не
      // видит звена вовсе (design.md, Решение 1) — значит, объекты обязаны
      // выйти побитово равными, а ключ и лок — совпасть.
      const pipelineLayerProject = makeProject({
        'stepcast.yml': `
kind: pipeline
defaults:
  model: opus
jobs:
  ask:
    steps:
      - id: a
        prompt: спроси
`,
      });
      const configLayerProject = makeProject({
        'stepcast.yml': `
kind: pipeline
jobs:
  ask:
    steps:
      - id: a
        prompt: спроси
`,
      });
      const configLayerConfig: Config = {
        ...configLayerProject.config,
        defaults: { ...configLayerProject.config.defaults, model: 'opus' },
      };

      const fromPipelineLayer = expand(pipelineLayerProject);
      const fromConfigLayer = expandWith(configLayerProject, configLayerConfig);

      assert.deepEqual(fromPipelineLayer.modelOrigins.get('ask/a'), { layer: 'pipeline' });
      assert.deepEqual(fromConfigLayer.modelOrigins.get('ask/a'), { layer: 'config' });

      const stepA = fromPipelineLayer.pipeline.jobs[0]!.steps[0]!;
      const stepB = fromConfigLayer.pipeline.jobs[0]!.steps[0]!;
      assert.deepEqual(stepA, stepB, 'Step не несёт слоя — объекты обязаны совпасть');

      const keyFor = (step: typeof stepA): string =>
        computeStepKey({
          lockHash: 'лок',
          jobId: 'ask',
          step,
          inputsFingerprint: undefined,
          backendCommand: undefined,
          upstream: [],
        });
      assert.equal(keyFor(stepA), keyFor(stepB));

      // Ожидание зафиксировано, а не пересчитано этим же движком: сверка двух
      // раскрытий друг с другом ловит только слой, попавший в `Step`, — любое
      // другое новое поле сдвинуло бы обе стороны одинаково, и тест остался бы
      // зелёным при обнулённом переиспользовании шагов. Ключ снят до появления
      // карты слоёв; если он поменялся — первый же `resume` перестанет узнавать
      // шаги прошлых прогонов, и менять его можно только сознательно.
      assert.equal(keyFor(stepA), 'e23b8b5db41c59d4');

      // Лок сериализуется из `Pipeline`, а не из `ExpandedPipeline`: путь к
      // файлу пайплайна в нём неизбежно разный (разные временные проекты), но
      // секция шага внутри — как и его ключ — от слоя не зависит и тоже снята
      // до появления карты.
      const lock = serializeLock(fromPipelineLayer.pipeline);
      const marker = '    steps:\n';
      assert.ok(lock.includes(marker));
      assert.equal(
        lock.slice(lock.indexOf(marker) + marker.length),
        `      - id: a
        index: 1
        timeout: 30m
        attempts:
          max: 1
        agent: claude
        model: opus
        session: default
        prompt: спроси
`,
      );
    });
  });

  it('раздаёт псевдонимы сессий по режиму работы', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  shared_job:
    steps:
      - id: a
        prompt: раз
      - id: b
        prompt: два
  split_job:
    session: per_step
    steps:
      - id: a
        prompt: раз
      - id: b
        prompt: два
        session: named
`,
    });

    const [sharedJob, splitJob] = expand(project).pipeline.jobs;

    assert.deepEqual(
      sharedJob!.steps.map((step) => asAgent(step).session),
      ['default', 'default'],
    );
    assert.deepEqual(
      splitJob!.steps.map((step) => asAgent(step).session),
      ['a', 'named'],
    );
  });

  it('накладывает переопределения с места подключения поверх файла работы', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    uses: ./jobs/build.yml
    env: { NODE_ENV: development }
    budget: { tokens: 100k }
`,
      'jobs/build.yml': `
kind: job
env: { NODE_ENV: test, CI: "1" }
budget: { tokens: 900k }
steps:
  - id: c
    run: [echo, ok]
`,
    });

    const job = expand(project).pipeline.jobs[0]!;
    assert.equal(job.env.NODE_ENV, 'development', 'место подключения побеждает');
    assert.equal(job.env.CI, '1', 'остальное из файла работы сохраняется');
    assert.equal(job.budget?.tokens, 100_000);
  });

  // Спека pipeline-definition: «Денежный потолок на трёх уровнях»
  it('раскрывает budget.cost независимо на трёх уровнях', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
budget: { cost: 20 }
jobs:
  build:
    budget: { cost: "$8" }
    steps:
      - id: s
        agent: claude
        prompt: hi
        budget: { cost: 2.5 }
`,
    });

    const { pipeline } = expand(project);
    assert.equal(pipeline.budget?.costMicroUsd, 20_000_000);
    const job = pipeline.jobs[0]!;
    assert.equal(job.budget?.costMicroUsd, 8_000_000);
    assert.equal(job.steps[0]!.budget?.costMicroUsd, 2_500_000);
  });

  it('cost рядом с tokens не отменяет его', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
budget: { tokens: 500k, cost: 5 }
jobs:
  build:
    steps:
      - id: s
        run: [echo, ok]
`,
    });

    const { pipeline } = expand(project);
    assert.equal(pipeline.budget?.tokens, 500_000);
    assert.equal(pipeline.budget?.costMicroUsd, 5_000_000);
  });

  it('отклоняет отрицательный budget.cost с указанием места', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
budget: { cost: -5 }
jobs:
  build:
    steps:
      - id: s
        run: [echo, ok]
`,
    });

    assert.throws(
      () => expand(project),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.at ?? '', /budget\.cost/);
        return true;
      },
    );
  });

  it('отклоняет валютный суффикс в budget.cost', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
budget: { cost: "12 EUR" }
jobs:
  build:
    steps:
      - id: s
        run: [echo, ok]
`,
    });

    assert.throws(() => expand(project), StepcastError);
  });

  it('отклоняет output без from у работы без агентских шагов', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    output: {}
    steps:
      - id: c
        run: [echo, ok]
`,
    });
    assert.throws(() => expand(project), StepcastError);
  });

  it('отклоняет превышение limits.attempts', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: c
        run: [echo, ok]
        attempts: { max: 9 }
`,
    });
    assert.throws(
      () => expand(project),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /limits\.attempts/);
        return true;
      },
    );
  });

  it('сохраняет порядок объявления работ', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  zebra:
    steps: [{ id: c, run: [echo, ok] }]
  alpha:
    steps: [{ id: c, run: [echo, ok] }]
  middle:
    steps: [{ id: c, run: [echo, ok] }]
`,
    });
    assert.deepEqual(
      expand(project).pipeline.jobs.map((job) => job.id),
      ['zebra', 'alpha', 'middle'],
    );
  });

  // Сценарий: «Дорожка объявлена на месте подключения»
  it('разбирает lane на месте подключения работы', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    lane: a
    steps: [{ id: c, run: [echo, ok] }]
  other:
    steps: [{ id: c, run: [echo, ok] }]
`,
    });
    const { pipeline } = expand(project);
    assert.equal(pipeline.jobs[0]!.lane, 'a');
    assert.equal(pipeline.jobs[1]!.lane, undefined);
  });

  it('отклоняет lane внутри файла работы, как и прочую обвязку', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    uses: ./jobs/build.yml
`,
      'jobs/build.yml': `
kind: job
lane: a
steps:
  - id: compile
    run: [echo, ok]
`,
    });

    assert.throws(() => expand(project), StepcastError);
  });

  // Сценарий: «Освобождение от потолка прогона объявлено на месте подключения»
  it('разбирает budget_exempt на месте подключения работы', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  finalize:
    on: always
    budget_exempt: true
    steps: [{ id: c, run: [echo, ok] }]
  other:
    steps: [{ id: c, run: [echo, ok] }]
`,
    });
    const { pipeline } = expand(project);
    assert.equal(pipeline.jobs[0]!.budgetExempt, true);
    assert.equal(pipeline.jobs[1]!.budgetExempt, undefined);
  });

  it('отклоняет budget_exempt внутри файла работы, как и прочую обвязку', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    uses: ./jobs/build.yml
`,
      'jobs/build.yml': `
kind: job
budget_exempt: true
steps:
  - id: compile
    run: [echo, ok]
`,
    });

    assert.throws(() => expand(project), StepcastError);
  });

  it('не меняет порядок исполнения графа при объявленной lane', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  zebra:
    lane: a
    steps: [{ id: c, run: [echo, ok] }]
  alpha:
    lane: b
    steps: [{ id: c, run: [echo, ok] }]
`,
    });
    assert.deepEqual(
      expand(project).pipeline.jobs.map((job) => job.id),
      ['zebra', 'alpha'],
    );
  });
});

/**
 * Спека pipeline-definition: пространство подстановки `job` — единственное
 * имя `lane`, значение ключа обвязки `lane` с места подключения работы.
 * Раскрывается при разборе документа, наравне с `params` и `project`.
 */
describe('pipeline-definition: пространство подстановки ${job.lane}', () => {
  it('раскрывается в поле тела, в аргументе шага и в тексте файла промпта работы, подключённой через uses', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    uses: ./jobs/build.yml
    lane: a
`,
      'jobs/build.yml': `
kind: job
description: "Дорожка \${job.lane}"
context_upstream: ["plan-\${job.lane}"]
steps:
  - id: c
    run: [echo, "\${job.lane}"]
  - id: think
    agent: fake
    prompt: "file:./prompt.md"
    expect: [{ exit_code: 0 }]
`,
      'jobs/prompt.md': 'Дорожка: ${job.lane}\n',
    });

    const job = expand(project).pipeline.jobs.find((item) => item.id === 'build')!;
    assert.equal(job.description, 'Дорожка a');
    assert.deepEqual(job.contextUpstream, ['plan-a']);
    assert.deepEqual(asRun(job.steps[0]!).command, ['echo', 'a']);
    assert.equal(asAgent(job.steps[1]!).prompt, 'Дорожка: a\n');
  });

  it('раскрывается в теле работы, объявленной прямо в пайплайне', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    lane: b
    description: "Дорожка \${job.lane}"
    steps: [{ id: c, run: [echo, "\${job.lane}"] }]
`,
    });

    const job = expand(project).pipeline.jobs[0]!;
    assert.equal(job.description, 'Дорожка b');
    assert.deepEqual(asRun(job.steps[0]!).command, ['echo', 'b']);
  });

  // Решено явно (expand.ts, `overrideScope`): переопределения с места
  // подключения (description, context_upstream и прочие поля вне файла
  // работы) видят ${job.lane} наравне с телом — буква дорожки известна уже
  // здесь, там же, где стоит и сам ключ lane.
  it('доступна в переопределении с места подключения (context_upstream поверх uses)', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    uses: ./jobs/build.yml
    lane: a
    context_upstream: ["plan-\${job.lane}"]
`,
      'jobs/build.yml': `
kind: job
steps: [{ id: c, run: [echo, ok] }]
`,
    });

    const job = expand(project).pipeline.jobs[0]!;
    assert.deepEqual(job.contextUpstream, ['plan-a']);
  });

  it('отказ разбора на ${job.lane} у работы без объявленной метки, называющий работу', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    uses: ./jobs/build.yml
`,
      'jobs/build.yml': `
kind: job
steps: [{ id: c, run: [echo, "\${job.lane}"] }]
`,
    });

    const error = thrown(() => expand(project));
    assert.match(error.message + (error.hint ?? ''), /build/);
    assert.doesNotMatch(error.message + (error.hint ?? ''), /^\s*$/);
  });

  it('отказ разбора на ${job.lane} у работы без метки, объявленной прямо в пайплайне', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    description: "\${job.lane}"
    steps: [{ id: c, run: [echo, ok] }]
`,
    });

    assert.throws(() => expand(project), StepcastError);
  });

  it('lane внутри документа kind: job по-прежнему отклоняется rejectWiringKeys, даже когда работа читает job.lane', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    uses: ./jobs/build.yml
    lane: a
`,
      'jobs/build.yml': `
kind: job
lane: a
steps: [{ id: c, run: [echo, "\${job.lane}"] }]
`,
    });

    assert.throws(() => expand(project), StepcastError);
  });
});

// Спека pipeline-definition: «Режим применения прав принимается и проверяется статически»
describe('pipeline-definition: permissions.enforce', () => {
  // Сценарий: «Значение принято»
  it('принимает enforce: strict на шаге и переносит в раскрытый пайплайн', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: ask
        prompt: сделай
        permissions:
          allow: [Read]
          enforce: strict
`,
    });
    const { pipeline } = expand(project);
    const step = asAgent(pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.permissions?.enforce, 'strict');
  });

  // Сценарий: «Неизвестное значение отклоняется»
  it('отклоняет enforce вне перечня', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: ask
        prompt: сделай
        permissions:
          enforce: yolo
`,
    });
    assert.throws(() => expand(project), StepcastError);
  });

  // Сценарий: «Шаг сужает режим работы»
  it('шаг со strict перекрывает работу с inherit', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    permissions:
      allow: [Read]
      enforce: inherit
    steps:
      - id: ask
        prompt: сделай
        permissions:
          allow: [Read]
          enforce: strict
`,
    });
    const { pipeline } = expand(project);
    const step = asAgent(pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.permissions?.enforce, 'strict');
  });

  // Работа со strict, шаг без своего блока permissions — работа побеждает целиком.
  it('работа со strict применяется к шагу без своего блока permissions', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    permissions:
      allow: [Read]
      enforce: strict
    steps:
      - id: ask
        prompt: сделай
`,
    });
    const { pipeline } = expand(project);
    const step = asAgent(pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.permissions?.enforce, 'strict');
    assert.deepEqual(step.permissions?.allow, ['Read']);
  });

  // Отсутствие обоих объявлений даёт прежнее раскрытие без поля.
  it('без объявлений на работе и шаге раскрытие не несёт permissions', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: ask
        prompt: сделай
`,
    });
    const { pipeline } = expand(project);
    const step = asAgent(pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.permissions, undefined);
  });
});

// Спека pipeline-definition: «Единицы измерения» — подстановка в числовые поля
describe('pipeline-definition: подстановка в числовые поля', () => {
  // Сценарий: «Предел итераций задан параметром»
  it('раскрывает max_iterations из with в число', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    uses: ./jobs/build.yml
    with: { max_iterations: 4 }
`,
      'jobs/build.yml': `
kind: job
params:
  max_iterations: { type: int, required: true }
until:
  max_iterations: "\${params.max_iterations}"
  check: [{ file_exists: done.txt }]
steps:
  - id: c
    run: [echo, ok]
`,
    });

    const job = expand(project).pipeline.jobs[0]!;
    assert.equal(job.until?.maxIterations, 4);
  });

  // Сценарий: «Число попыток задано параметром»
  it('раскрывает attempts.max из подстановки в число', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    uses: ./jobs/build.yml
    with: { retries: 3 }
`,
      'jobs/build.yml': `
kind: job
params:
  retries: { type: int, required: true }
steps:
  - id: c
    run: [echo, ok]
    attempts: { max: "\${params.retries}" }
`,
    });

    const job = expand(project).pipeline.jobs[0]!;
    assert.equal(job.steps[0]!.attempts.max, 3);
  });

  // Сценарий: «Ширина параллелизма задана входом пайплайна»
  it('раскрывает concurrency из входа пайплайна в число', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
inputs:
  workers: { type: int, required: true }
concurrency: "\${inputs.workers}"
jobs:
  build:
    steps: [{ id: c, run: [echo, ok] }]
`,
    });

    const { pipeline } = expand(project, 'stepcast.yml', { workers: '2' });
    assert.equal(pipeline.concurrency, 2);
  });

  // Сценарий: «Числовой литерал разбирается как прежде»
  it('литеральная запись числовых полей разбирается как прежде', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
concurrency: 1
jobs:
  build:
    until:
      max_iterations: 4
      check: [{ file_exists: done.txt }]
    steps: [{ id: c, run: [echo, ok] }]
`,
    });

    const { pipeline } = expand(project);
    assert.equal(pipeline.concurrency, 1);
    assert.equal(pipeline.jobs[0]!.until?.maxIterations, 4);
  });

  // Сценарий: «Нечисловое значение отклонено» и «Ошибка называет источник значения»
  it('отклоняет нечисловое значение с путём поля, значением и источником', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
inputs:
  n: { type: string, required: true }
jobs:
  build:
    until:
      max_iterations: "\${inputs.n}"
      check: [{ file_exists: done.txt }]
    steps: [{ id: c, run: [echo, ok] }]
`,
    });

    assert.throws(
      () => expand(project, 'stepcast.yml', { n: 'много' }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.at ?? '', /until\.max_iterations/);
        assert.match(error.message, /много/);
        assert.match(error.hint ?? '', /\$\{inputs\.n\}/);
        return true;
      },
    );
  });

  // Сценарий: «Отложенная подстановка в числовом поле отклонена»
  it('отклоняет ${jobs.*} в числовом поле объясняющей ошибкой', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  plan:
    steps: [{ id: c, run: [echo, ok] }]
  ship:
    needs: [plan]
    until:
      max_iterations: "\${jobs.plan.output.rounds}"
      check: [{ file_exists: done.txt }]
    steps: [{ id: c, run: [echo, ok] }]
`,
    });

    assert.throws(
      () => expand(project),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /jobs/);
        assert.match(error.hint ?? '', /разбор(е|а) пайплайна/);
        return true;
      },
    );
  });

  it('отклоняет ${run.*} и ${env.*} в числовом поле объясняющей ошибкой', () => {
    const runProject = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps: [{ id: c, run: [echo, ok], attempts: { max: "\${run.id}" } }]
`,
    });
    assert.throws(
      () => expand(runProject),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /run/);
        return true;
      },
    );

    const envProject = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps: [{ id: c, run: [echo, ok], attempts: { max: "\${env.WORKERS}" } }]
`,
    });
    assert.throws(
      () => expand(envProject),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /env/);
        return true;
      },
    );
  });

  // Сценарий: «Отложенная подстановка доезжает до числового поля через параметр»
  it('называет отложенное пространство, когда оно доехало через params', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  plan:
    steps: [{ id: c, run: [echo, ok] }]
  ship:
    needs: [plan]
    uses: ./jobs/ship.yml
    with: { n: "\${jobs.plan.output.rounds}" }
`,
      'jobs/ship.yml': `
kind: job
params:
  n: { type: string, required: true }
until:
  max_iterations: "\${params.n}"
  check: [{ file_exists: done.txt }]
steps:
  - id: c
    run: [echo, ok]
`,
    });

    assert.throws(
      () => expand(project),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /отложенное пространство jobs/);
        assert.match(error.hint ?? '', /\$\{params\.n\}/);
        return true;
      },
    );
  });

  // Экранирование оставляет в тексте литерал `${`, а не подстановку: числовое
  // поле должно жаловаться на неразбираемое число, а не на пространство.
  it('отклоняет экранированный литерал в числовом поле как неразбираемое число', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
concurrency: "$\${params.x}"
jobs:
  build:
    steps: [{ id: c, run: [echo, ok] }]
`,
    });

    assert.throws(
      () => expand(project),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /Не удалось разобрать счётчик/);
        assert.doesNotMatch(error.message, /отложенное пространство/);
        return true;
      },
    );
  });

  // Сценарий: «Ограничение поля проверяется после раскрытия»
  it('attempts.max из подстановки, превышающий limits.attempts, даёт ошибку о потолке', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    uses: ./jobs/build.yml
    with: { retries: 9 }
`,
      'jobs/build.yml': `
kind: job
params:
  retries: { type: int, required: true }
steps:
  - id: c
    run: [echo, ok]
    attempts: { max: "\${params.retries}" }
`,
    });

    assert.throws(
      () => expand(project),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /limits\.attempts/);
        return true;
      },
    );
  });
});

// Сценарий: «Фиксация перед запуском»
describe('pipeline.lock.yml', () => {
  it('не содержит ссылок uses и нераскрытых подстановок пайплайна', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
inputs:
  change: { type: string, required: true }
jobs:
  build:
    uses: ./jobs/build.yml
    with: { change: "\${inputs.change}" }
`,
      'jobs/build.yml': `
kind: job
params:
  change: { type: string, required: true }
steps:
  - id: c
    run: [echo, "\${params.change}"]
`,
    });

    const lock = serializeLock(expand(project, 'stepcast.yml', { change: 'foo' }).pipeline);
    assert.doesNotMatch(lock, /uses:/);
    assert.doesNotMatch(lock, /\$\{(inputs|params)\./);
    assert.match(lock, /foo/);

    const parsed = parseYaml(lock) as { kind: string; jobs: unknown[] };
    assert.equal(parsed.kind, 'pipeline.lock');
    assert.equal(parsed.jobs.length, 1);
  });

  it('несёт permissions.enforce работы и шага', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    permissions:
      allow: [Read]
      enforce: strict
    steps:
      - id: ask
        prompt: сделай
`,
    });
    const lock = serializeLock(expand(project).pipeline);
    const parsed = parseYaml(lock) as {
      jobs: Array<{ permissions?: { enforce?: string }; steps: Array<{ permissions?: { enforce?: string } }> }>;
    };
    assert.equal(parsed.jobs[0]!.permissions?.enforce, 'strict');
    assert.equal(parsed.jobs[0]!.steps[0]!.permissions?.enforce, 'strict');
  });

  it('сохраняет подстановки времени прогона как есть', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  plan:
    steps: [{ id: c, run: [echo, ok] }]
  ship:
    needs: [plan]
    steps: [{ id: c, run: [echo, "\${jobs.plan.output.x}"] }]
`,
    });
    assert.match(serializeLock(expand(project).pipeline), /\$\{jobs\.plan\.output\.x\}/);
  });

  it('раскрывает умолчания, чтобы лок был самодостаточен', () => {
    const project = makeProject({ 'stepcast.yml': MINIMAL_PIPELINE });
    const parsed = parseYaml(serializeLock(expand(project).pipeline)) as {
      concurrency: number;
      fail_fast: boolean;
      workspace: { mode: string };
      jobs: Array<{ on: string; session: string; steps: Array<{ timeout: string }> }>;
    };

    assert.equal(parsed.concurrency, 1);
    assert.equal(parsed.fail_fast, true);
    assert.equal(parsed.workspace.mode, 'cwd');
    assert.equal(parsed.jobs[0]!.on, 'success');
    assert.equal(parsed.jobs[0]!.session, 'shared');
    assert.equal(parsed.jobs[0]!.steps[0]!.timeout, '30m');
  });

  // Сценарий: «Работа объявляет источник наследования»
  it('раскрывает workspace.inherit и сохраняет его в локе', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
workspace: { mode: worktree }
jobs:
  a:
    steps: [{ id: s, run: [echo, a] }]
  b:
    steps: [{ id: s, run: [echo, b] }]
  c:
    needs: [a, b]
    workspace: { inherit: a }
    steps: [{ id: s, run: [echo, c] }]
`,
    });

    const { pipeline } = expand(project);
    const c = pipeline.jobs.find((job) => job.id === 'c');
    assert.equal(c?.workspace.inherit, 'a');
    // Режим не переобъявлен на работе — унаследован от пайплайна, а не потерян
    // при слиянии с частичным workspace работы.
    assert.equal(c?.workspace.mode, 'worktree');

    assert.match(serializeLock(pipeline), /inherit: a/);
  });

  // Слияние частичного workspace работы с пайплайновым не должно протаскивать
  // в работу пайплайновый путь размещения копий: он принадлежит пайплайновому
  // режиму, а при режиме, отличном от copy, и вовсе запрещён.
  it('не наследует пайплайновый path работе, сменившей режим', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
workspace: { mode: copy, path: ./сборка }
jobs:
  a:
    steps: [{ id: s, run: [echo, a] }]
  b:
    workspace: { mode: worktree }
    steps: [{ id: s, run: [echo, b] }]
`,
    });

    const { pipeline } = expand(project);
    const a = pipeline.jobs.find((job) => job.id === 'a');
    const b = pipeline.jobs.find((job) => job.id === 'b');
    assert.equal(a?.workspace.path, './сборка', 'режим тот же — путь пайплайна в силе');
    assert.equal(b?.workspace.mode, 'worktree');
    assert.equal(b?.workspace.path, undefined);
  });

  it('раскрывает работу без inherit как прежде', () => {
    const project = makeProject({ 'stepcast.yml': MINIMAL_PIPELINE });
    const { pipeline } = expand(project);
    assert.equal(pipeline.jobs[0]!.workspace.inherit, undefined);
    assert.doesNotMatch(serializeLock(pipeline), /inherit/);
  });

  it('сохраняет объявленную lane в pipeline.lock.yml', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    lane: a
    steps: [{ id: c, run: [echo, ok] }]
`,
    });
    const { pipeline } = expand(project);
    const plain = parseYaml(serializeLock(pipeline)) as { jobs: { lane?: string }[] };
    assert.equal(plain.jobs[0]?.lane, 'a');
  });

  // Сценарий: «Пайплайн без триггеров не изменился»
  it('раскрывает пайплайн без triggers ровно как прежде', () => {
    const project = makeProject({ 'stepcast.yml': MINIMAL_PIPELINE });
    const { pipeline } = expand(project);
    assert.equal(pipeline.triggers, undefined);

    const plain = parseYaml(serializeLock(pipeline)) as Record<string, unknown>;
    assert.equal('triggers' in plain, false);
  });

  // Сценарий: «Расписание объявлено одной записью»
  it('видит объявленное расписание в раскрытой модели и в локе', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
name: scheduled
triggers:
  schedule:
    - cron: "0 3 * * *"
      timezone: Asia/Nicosia
jobs:
  build:
    steps: [{ id: c, run: [echo, ok] }]
`,
    });

    const { pipeline } = expand(project);
    assert.deepEqual(pipeline.triggers, {
      schedule: [{ cron: '0 3 * * *', timezone: 'Asia/Nicosia' }],
    });

    const plain = parseYaml(serializeLock(pipeline)) as {
      triggers: { schedule: Array<{ cron: string; timezone?: string }> };
    };
    assert.deepEqual(plain.triggers.schedule, [{ cron: '0 3 * * *', timezone: 'Asia/Nicosia' }]);
  });

  // Сценарий: «Два расписания на один пайплайн»
  it('раскрывает несколько записей расписания', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
triggers:
  schedule:
    - cron: "0 8 * * 1-5"
    - cron: "0 12 * * 6,0"
jobs:
  build:
    steps: [{ id: c, run: [echo, ok] }]
`,
    });

    const { pipeline } = expand(project);
    assert.equal(pipeline.triggers?.schedule.length, 2);
    assert.equal(pipeline.triggers?.schedule[0]?.timezone, undefined);
  });

  // Сценарий: «Триггер в файле работы»
  it('отклоняет triggers внутри файла работы, как и прочую обвязку', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    uses: ./jobs/build.yml
`,
      'jobs/build.yml': `
kind: job
triggers:
  schedule: [{ cron: "0 3 * * *" }]
steps:
  - id: compile
    run: [echo, ok]
`,
    });

    assert.throws(() => expand(project), StepcastError);
  });

  // Сценарий: «Незнакомый вид триггера»
  it('отклоняет незнакомый вид триггера, называя его ключ', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
triggers:
  github: {}
jobs:
  build:
    steps: [{ id: c, run: [echo, ok] }]
`,
    });

    assert.throws(() => expand(project), (error: unknown) => {
      assert.ok(error instanceof StepcastError);
      assert.match(error.message, /github/);
      return true;
    });
  });
});

describe('pipeline-definition: объявление MCP-серверов', () => {
  // Сценарий: «Объявление на шаге»
  it('шаг с объявленным сервером-процессом несёт его в раскрытой модели', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: ask
        prompt: сделай
        mcp:
          assertum:
            command: [node, ./mcp/assertum-server.js]
            env: { ASSERTUM_PROJECT: demo }
`,
    });
    const { pipeline } = expand(project);
    const step = asAgent(pipeline.jobs[0]!.steps[0]!);
    assert.deepEqual(step.mcp, {
      assertum: { command: ['node', './mcp/assertum-server.js'], env: { ASSERTUM_PROJECT: 'demo' } },
    });
  });

  it('сервер конечной точкой несёт url и headers', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: ask
        prompt: сделай
        mcp:
          docs:
            url: https://mcp.example.com/mcp
            headers: { X-Client: stepcast }
`,
    });
    const { pipeline } = expand(project);
    const step = asAgent(pipeline.jobs[0]!.steps[0]!);
    assert.deepEqual(step.mcp, {
      docs: { url: 'https://mcp.example.com/mcp', headers: { 'X-Client': 'stepcast' } },
    });
  });

  // Сценарий: «Наследование от работы и от пайплайна»
  it('сервер, объявленный пайплайном, доходит до шага без своего объявления', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
mcp:
  a: { command: [node, a.js] }
jobs:
  build:
    steps:
      - id: ask
        prompt: сделай
`,
    });
    const { pipeline } = expand(project);
    const step = asAgent(pipeline.jobs[0]!.steps[0]!);
    assert.deepEqual(step.mcp, { a: { command: ['node', 'a.js'] } });
  });

  it('объявление работы перекрывает объявление пайплайна целиком', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
mcp:
  a: { command: [node, a.js] }
jobs:
  build:
    mcp:
      b: { command: [node, b.js] }
    steps:
      - id: ask
        prompt: сделай
`,
    });
    const { pipeline } = expand(project);
    const step = asAgent(pipeline.jobs[0]!.steps[0]!);
    assert.deepEqual(step.mcp, { b: { command: ['node', 'b.js'] } });
  });

  // Сценарий: «Ближайшее объявление побеждает целиком»
  it('объявление шага перекрывает и пайплайн, и работу', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
mcp:
  a: { command: [node, a.js] }
jobs:
  build:
    mcp:
      b: { command: [node, b.js] }
    steps:
      - id: ask
        prompt: сделай
        mcp:
          c: { command: [node, c.js] }
`,
    });
    const { pipeline } = expand(project);
    const step = asAgent(pipeline.jobs[0]!.steps[0]!);
    assert.deepEqual(step.mcp, { c: { command: ['node', 'c.js'] } });
  });

  // Сценарий: «Снятие унаследованных серверов»
  it('mcp: {} на шаге снимает унаследованное от работы', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    mcp:
      b: { command: [node, b.js] }
    steps:
      - id: ask
        prompt: сделай
        mcp: {}
`,
    });
    const { pipeline } = expand(project);
    const step = asAgent(pipeline.jobs[0]!.steps[0]!);
    assert.deepEqual(step.mcp, {});
  });

  // Сценарий: «Шаг без объявления»
  it('ни один уровень не объявляет — раскрытие не несёт mcp', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: ask
        prompt: сделай
`,
    });
    const { pipeline } = expand(project);
    const step = asAgent(pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.mcp, undefined);
  });

  // Сценарий: «Сервер без транспорта»
  it('отказывает на сервере без command и без url, называя место объявления', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: ask
        prompt: сделай
        mcp:
          empty: {}
`,
    });
    const error = thrown(() => expand(project));
    assert.match(error.at ?? '', /mcp\.empty/);
  });

  // Сценарий: «Сервер с двумя транспортами»
  it('отказывает на сервере с command и url разом, называя место объявления', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: ask
        prompt: сделай
        mcp:
          both:
            command: [node, x.js]
            url: https://example.com
`,
    });
    const error = thrown(() => expand(project));
    assert.match(error.at ?? '', /mcp\.both/);
  });

  // Сценарий: «Недопустимое имя сервера»
  it('отказывает на имени сервера с пробелом', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: ask
        prompt: сделай
        mcp:
          "bad name": { command: [node, x.js] }
`,
    });
    const error = thrown(() => expand(project));
    assert.match(error.at ?? '', /mcp/);
  });

  it('отказывает на имени сервера с точкой', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: ask
        prompt: сделай
        mcp:
          "bad.name": { command: [node, x.js] }
`,
    });
    const error = thrown(() => expand(project));
    assert.match(error.at ?? '', /mcp/);
  });

  // Сценарий: «Команда строкой»
  it('отказывает, когда command объявлена строкой, а не списком argv', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: ask
        prompt: сделай
        mcp:
          a:
            command: "node x.js"
`,
    });
    const error = thrown(() => expand(project));
    assert.match(error.at ?? '', /mcp\.a\.command/);
  });
});

describe('pipeline.lock.yml: объявление MCP-серверов', () => {
  it('записи шага и работы несут своё объявление', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    mcp:
      b: { command: [node, b.js] }
    steps:
      - id: ask
        prompt: сделай
        mcp:
          c: { command: [node, c.js] }
`,
    });
    const lock = serializeLock(expand(project).pipeline);
    const parsed = parseYaml(lock) as {
      jobs: Array<{ mcp?: Record<string, unknown>; steps: Array<{ mcp?: Record<string, unknown> }> }>;
    };
    assert.deepEqual(Object.keys(parsed.jobs[0]!.mcp ?? {}), ['b']);
    assert.deepEqual(Object.keys(parsed.jobs[0]!.steps[0]!.mcp ?? {}), ['c']);
  });

  it('шаг без объявления не несёт ключа mcp в записи', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: ask
        prompt: сделай
`,
    });
    const lock = serializeLock(expand(project).pipeline);
    const parsed = parseYaml(lock) as { jobs: Array<{ steps: Array<{ mcp?: unknown }> }> };
    assert.equal('mcp' in parsed.jobs[0]!.steps[0]!, false);
  });

  const PIPELINE_WITHOUT_MCP = `
kind: pipeline
jobs:
  build:
    steps:
      - id: ask
        prompt: сделай
`;

  const PIPELINE_WITH_MCP = `
kind: pipeline
mcp:
  a: { command: [node, a.js] }
jobs:
  build:
    steps:
      - id: ask
        prompt: сделай
`;

  /** Состав замка для `PIPELINE_WITHOUT_MCP` — тот же, что до этого изменения. */
  const EXPECTED_LOCK_WITHOUT_MCP = `version: 1
kind: pipeline.lock
name: pipeline
file: <root>/stepcast.yml
inputs: {}
workspace: &a1
  mode: cwd
env_deny:
  - "*_TOKEN"
  - "*_SECRET"
  - "*_PASSWORD"
  - "*_KEY"
  - "*_CREDENTIALS"
  - AWS_*
  - KUBECONFIG
context_upstream: all
concurrency: 1
fail_fast: true
jobs:
  - id: build
    source: <root>/stepcast.yml
    needs: []
    on: success
    session: shared
    workspace: *a1
    context_upstream: all
    steps:
      - id: ask
        index: 1
        timeout: 30m
        attempts:
          max: 1
        agent: claude
        model: sonnet
        session: default
        prompt: сделай
`;

  function keyOf(project: Project): { readonly lockHash: string; readonly stepKey: string } {
    const { pipeline } = expand(project);
    const job = pipeline.jobs[0]!;
    const lockHash = jobLockHash(pipeline, job);
    const stepKey = computeStepKey({
      lockHash,
      jobId: job.id,
      step: job.steps[0]!,
      inputsFingerprint: undefined,
      backendCommand: undefined,
      upstream: [],
    });
    return { lockHash, stepKey };
  }

  it('объявление серверов меняет jobLockHash и ключ шага', () => {
    const without = keyOf(makeProject({ 'stepcast.yml': PIPELINE_WITHOUT_MCP }));
    const withMcp = keyOf(makeProject({ 'stepcast.yml': PIPELINE_WITH_MCP }));
    assert.notEqual(without.lockHash, withMcp.lockHash);
    assert.notEqual(without.stepKey, withMcp.stepKey);
  });

  // Сценарий: «Пайплайн без объявлений не задет». Эталон — состав замка, а не
  // его хеш: в замок входят абсолютные пути (`file`, `source`), и литеральный
  // хеш был бы привязан к временному каталогу машины. Состав же определяет
  // хеш целиком, и запись вида `mcp: null` у шага или работы — единственный
  // способ развести ключи документа без объявлений — здесь видна глазом.
  it('замок пайплайна без объявлений сохраняет прежний состав, без единого ключа mcp', () => {
    const project = makeProject({ 'stepcast.yml': PIPELINE_WITHOUT_MCP });
    const { pipeline } = expand(project);
    const lock = serializeLock(pipeline)
      .replaceAll(project.root, '<root>')
      .replaceAll(project.home, '<home>');

    assert.equal(lock, EXPECTED_LOCK_WITHOUT_MCP);
  });

  it('пайплайн без объявлений даёт устойчивый результат при повторном раскрытии', () => {
    // Тот же путь документа при обоих раскрытиях: иначе `pipeline.file`,
    // входящий в замок, сам по себе развёл бы хеши — это проверка
    // устойчивости к mcp, а не к расположению временного проекта.
    const project = makeProject({ 'stepcast.yml': PIPELINE_WITHOUT_MCP });
    const first = keyOf(project);
    const second = keyOf(project);
    assert.equal(first.lockHash, second.lockHash);
    assert.equal(first.stepKey, second.stepKey);
  });
});

describe('pipeline-definition: секция project документа', () => {
  it('разбирает верхний ключ project', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
project:
  check: make check
jobs:
  build:
    steps: [{ id: c, run: "\${project.check}" }]
`,
    });
    const step = asRun(expand(project).pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.command, 'make check');
  });

  it('отклоняет пустую project.check в пайплайне, называя ключ', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
project:
  check: ""
jobs:
  build:
    steps: [{ id: c, run: [echo, ok] }]
`,
    });
    assert.throws(
      () => expand(project),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.at ?? error.message, /project\.check/);
        return true;
      },
    );
  });

  it('отклоняет неизвестное поле внутри секции project', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
project:
  name: x
jobs:
  build:
    steps: [{ id: c, run: [echo, ok] }]
`,
    });
    assert.throws(() => expand(project), StepcastError);
  });
});

describe('pipeline-definition: группа project.spec документа', () => {
  it('разбирает группу spec внутри верхнего ключа project', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
project:
  spec:
    dir: openspec/changes
    rules: .stepcast/prompts/spec-rules.md
    tool: openspec
    check: openspec validate "$SPEC_CHANGE" --strict
jobs:
  build:
    steps:
      - id: dir
        run: "\${project.spec.dir}"
      - id: rules
        run: "\${project.spec.rules}"
      - id: tool
        run: "\${project.spec.tool}"
      - id: check
        run: "\${project.spec.check}"
`,
    });
    const steps = expand(project).pipeline.jobs[0]!.steps;
    assert.equal(asRun(steps[0]!).command, 'openspec/changes');
    assert.equal(asRun(steps[1]!).command, '.stepcast/prompts/spec-rules.md');
    assert.equal(asRun(steps[2]!).command, 'openspec');
    assert.equal(asRun(steps[3]!).command, 'openspec validate "$SPEC_CHANGE" --strict');
  });

  it('отклоняет пустой dir внутри группы spec', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
project:
  spec:
    dir: "   "
jobs:
  build:
    steps: [{ id: c, run: [echo, ok] }]
`,
    });
    assert.throws(() => expand(project), StepcastError);
  });

  it('отклоняет абсолютный путь внутри группы spec', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
project:
  spec:
    dir: /tmp/changes
jobs:
  build:
    steps: [{ id: c, run: [echo, ok] }]
`,
    });
    assert.throws(() => expand(project), StepcastError);
  });

  it('отклоняет неизвестный ключ внутри группы spec', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
project:
  spec:
    folder: openspec/changes
jobs:
  build:
    steps: [{ id: c, run: [echo, ok] }]
`,
    });
    assert.throws(() => expand(project), StepcastError);
  });
});

describe('pipeline-definition: действующее значение project.spec.*', () => {
  const PIPELINE_WITH_SPEC_DIR = `
kind: pipeline
project:
  spec:
    dir: docs/changes
jobs:
  build:
    steps: [{ id: c, run: "\${project.spec.dir}" }]
`;

  it('пайплайн перекрывает конфигурацию по ключу', () => {
    const project = makeProject({ 'stepcast.yml': PIPELINE_WITH_SPEC_DIR });
    const config = withProjectSpec(project, { dir: 'openspec/changes' });
    const step = asRun(expandWith(project, config).pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.command, 'docs/changes');
  });

  it('объявление только в пайплайне раскрывается им', () => {
    const project = makeProject({ 'stepcast.yml': PIPELINE_WITH_SPEC_DIR });
    const config = withProjectSpec(project, {});
    const step = asRun(expandWith(project, config).pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.command, 'docs/changes');
  });

  it('объявление только в конфигурации раскрывается им, когда пайплайн ключ не называет', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps: [{ id: c, run: "\${project.spec.dir}" }]
`,
    });
    const config = withProjectSpec(project, { dir: 'openspec/changes' });
    const step = asRun(expandWith(project, config).pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.command, 'openspec/changes');
  });

  it('частичное объявление в обоих слоях сливается по ключу, а не по группе целиком', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
project:
  spec:
    dir: docs/changes
jobs:
  build:
    steps:
      - id: dir
        run: "\${project.spec.dir}"
      - id: tool
        run: "\${project.spec.tool}"
`,
    });
    const config = withProjectSpec(project, { tool: 'make' });
    const steps = expandWith(project, config).pipeline.jobs[0]!.steps;
    assert.equal(asRun(steps[0]!).command, 'docs/changes');
    assert.equal(asRun(steps[1]!).command, 'make');
  });

  // Задача 3.3 / Сценарий: «Ключ practice.spec.check раскрывается из конфигурации»
  it('project.spec.check раскрывается из конфигурации, когда пайплайн ключ не называет', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps: [{ id: c, run: "\${project.spec.check}" }]
`,
    });
    const config = withProjectSpec(project, { check: 'openspec validate "$SPEC_CHANGE" --strict' });
    const step = asRun(expandWith(project, config).pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.command, 'openspec validate "$SPEC_CHANGE" --strict');
  });

  // Задача 3.3 / Сценарий: «Пайплайн перекрывает конфигурацию по project.spec.check»
  it('пайплайн перекрывает конфигурацию по project.spec.check', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
project:
  spec:
    check: make spec-check
jobs:
  build:
    steps: [{ id: c, run: "\${project.spec.check}" }]
`,
    });
    const config = withProjectSpec(project, { check: 'openspec validate "$SPEC_CHANGE" --strict' });
    const step = asRun(expandWith(project, config).pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.command, 'make spec-check');
  });

  // Задача 1.7 / Сценарий: «Соседний ключ группы не затирается». Тест выше
  // («частичное объявление в обоих слоях…») сливает группу по двум ключам и
  // до появления `check` доказывал полистовое слияние целиком; теперь ключей
  // четыре, и слияние проверяется на полном составе: три из конфигурации,
  // четвёртый из документа пайплайна. Слияние по группе целиком (а не по
  // листьям) обнулило бы здесь три значения из четырёх.
  it('project.spec.check из пайплайна не затирает dir, rules и tool из конфигурации', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
project:
  spec:
    check: make spec-check
jobs:
  build:
    steps:
      - id: dir
        run: "\${project.spec.dir}"
      - id: rules
        run: "\${project.spec.rules}"
      - id: tool
        run: "\${project.spec.tool}"
      - id: check
        run: "\${project.spec.check}"
`,
    });
    const config = withProjectSpec(project, {
      dir: 'openspec/changes',
      rules: '.stepcast/prompts/spec-rules.md',
      tool: 'openspec',
    });

    const steps = expandWith(project, config).pipeline.jobs[0]!.steps;
    assert.equal(asRun(steps[0]!).command, 'openspec/changes');
    assert.equal(asRun(steps[1]!).command, '.stepcast/prompts/spec-rules.md');
    assert.equal(asRun(steps[2]!).command, 'openspec');
    assert.equal(asRun(steps[3]!).command, 'make spec-check');
  });

  // Задача 3.4: значение известно до прогона — снимок несёт объявленную
  // команду строкой, а не подстановку, дожившую до исполнения.
  it('project.spec.check попадает в снимок пайплайна строкой, а не подстановкой', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
project:
  spec:
    check: openspec validate "$SPEC_CHANGE" --strict
jobs:
  build:
    steps: [{ id: c, run: "\${project.spec.check}" }]
`,
    });

    const lock = serializeLock(expand(project).pipeline);
    assert.doesNotMatch(lock, /\$\{project\.spec\.check\}/);
    assert.match(lock, /openspec validate "\$SPEC_CHANGE" --strict/);
  });
});

describe('pipeline-definition: состав пространства project.spec.*', () => {
  it('ссылка на необъявленный project.spec.dir — отказ, называющий ключ и оба места', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps: [{ id: c, run: "\${project.spec.dir}" }]
`,
    });

    assert.throws(
      () => expand(project),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.hint ?? '', /project\.spec\.dir/);
        assert.match(error.hint ?? '', new RegExp(project.path('stepcast.yml').replace(/[/\\]/g, '\\$&')));
        assert.match(error.hint ?? '', /\.stepcast\/config\.yml/);
        return true;
      },
    );
  });

  it('обращение к имени вне состава пространства называет доступные имена, включая составные', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps: [{ id: c, run: "\${project.spec.folder}" }]
`,
    });

    assert.throws(
      () => expand(project),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.hint ?? '', /spec\.dir/);
        assert.match(error.hint ?? '', /spec\.rules/);
        assert.match(error.hint ?? '', /spec\.tool/);
        assert.match(error.hint ?? '', /spec\.check/);
        return true;
      },
    );
  });

  // Задача 3.3 / Сценарий: «${project.spec.validate} — не имя, а грамматика подкоманды»
  it('ссылка на ${project.spec.validate} отклоняется, называя спискок имён, среди которых spec.check', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps: [{ id: c, run: "\${project.spec.validate}" }]
`,
    });

    assert.throws(
      () => expand(project),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.hint ?? '', /содержит только/);
        assert.match(error.hint ?? '', /spec\.check/);
        return true;
      },
    );
  });

  // Задача 3.3 / Сценарий: «Ссылка на необъявленный project.spec.check — оба места»
  it('ссылка на необъявленный project.spec.check — отказ, называющий ключ и оба места', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps: [{ id: c, run: "\${project.spec.check}" }]
`,
    });

    assert.throws(
      () => expand(project),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.hint ?? '', /project\.spec\.check/);
        assert.match(error.hint ?? '', new RegExp(project.path('stepcast.yml').replace(/[/\\]/g, '\\$&')));
        assert.match(error.hint ?? '', /\.stepcast\/config\.yml/);
        return true;
      },
    );
  });

  it('необъявленный составной ключ и имя вне состава — разные сообщения', () => {
    const undeclared = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps: [{ id: c, run: "\${project.spec.dir}" }]
`,
    });
    const outside = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps: [{ id: c, run: "\${project.spec.folder}" }]
`,
    });

    const first = thrown(() => expand(undeclared));
    const second = thrown(() => expand(outside));

    assert.notEqual(first.hint, second.hint);
    assert.match(first.hint ?? '', /Объявите project\.spec\.dir/);
    assert.doesNotMatch(first.hint ?? '', /содержит только/);
    assert.match(second.hint ?? '', /содержит только/);
    assert.doesNotMatch(second.hint ?? '', /Объявите/);
  });

  // Обращение к группе, а не к её листу: `spec` — не имя пространства, и
  // отказ обязан перечислить состав так же, как на `spec.folder`, а не
  // отделаться сообщением о непредставимом строкой значении.
  it('обращение к группе без листа называет доступные имена', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
project:
  spec:
    dir: openspec/changes
jobs:
  build:
    steps: [{ id: c, run: "\${project.spec}" }]
`,
    });

    const error = thrown(() => expand(project));
    assert.match(error.hint ?? '', /содержит только/);
    assert.match(error.hint ?? '', /spec\.dir/);
    assert.doesNotMatch(error.hint ?? '', /допустимы строки/);
  });
});

// Задача 1.9: пределы практики памяти (`index_max_tokens`,
// `spec_index_max_tokens`, `unit_max_tokens`) не публикуются подстановкой
// (см. `PROJECT_NAMES` в expand.ts), но раскрываются на слитом значении
// `Pipeline.knowledge` тем же порядком, каким слиты `project.spec.*`.
describe('pipeline-definition: действующее значение project.knowledge.* (пределы памяти)', () => {
  const PIPELINE_WITH_SPEC_LIMIT = `
kind: pipeline
project:
  knowledge:
    spec_index_max_tokens: 6k
jobs:
  build:
    steps: [{ id: c, run: echo ok }]
`;

  it('пайплайн перекрывает конфигурацию по project.knowledge.spec_index_max_tokens', () => {
    const project = makeProject({ 'stepcast.yml': PIPELINE_WITH_SPEC_LIMIT });
    const config = withProjectKnowledge(project, { specIndexMaxTokens: 2000 });
    const pipeline = expandWith(project, config).pipeline;
    assert.equal(pipeline.knowledge.specIndexMaxTokens, 6000);
  });

  it('объявление одного ключа в пайплайне не задевает два других предела из конфигурации', () => {
    const project = makeProject({ 'stepcast.yml': PIPELINE_WITH_SPEC_LIMIT });
    const config = withProjectKnowledge(project, {
      indexMaxTokens: 4000,
      specIndexMaxTokens: 2000,
      unitMaxTokens: 1500,
    });
    const pipeline = expandWith(project, config).pipeline;
    assert.equal(pipeline.knowledge.specIndexMaxTokens, 6000, 'ключ пайплайна побеждает');
    assert.equal(pipeline.knowledge.indexMaxTokens, 4000, 'не объявленный пайплайном ключ берётся из конфигурации');
    assert.equal(pipeline.knowledge.unitMaxTokens, 1500, 'не объявленный пайплайном ключ берётся из конфигурации');
  });

  it('объявление только в конфигурации раскрывается им, когда пайплайн ключ не называет', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps: [{ id: c, run: echo ok }]
`,
    });
    const config = withProjectKnowledge(project, { unitMaxTokens: 1500 });
    const pipeline = expandWith(project, config).pipeline;
    assert.equal(pipeline.knowledge.unitMaxTokens, 1500);
  });
});

// Задача 2.4: nested_repos не заводит пайплайновый слой и не публикуется
// подстановкой — оба факта закреплены отказом, а не молчаливым поведением.
describe('pipeline-definition: project.nested_repos не имеет пайплайнового слоя', () => {
  it('документ пайплайна с project.nested_repos отклоняется, называя ключ', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
project:
  nested_repos: [public-site]
jobs:
  build:
    steps: [{ id: c, run: echo ok }]
`,
    });

    assert.throws(
      () => expand(project),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /nested_repos/);
        assert.equal(error.file, project.path('stepcast.yml'));
        return true;
      },
    );
  });

  it('обращение к ${project.nested_repos} отказывает действующим составом пространства', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps: [{ id: c, run: "\${project.nested_repos}" }]
`,
    });

    const error = thrown(() => expand(project));
    assert.match(error.hint ?? '', /содержит только/);
    assert.doesNotMatch(error.hint ?? '', /nested_repos/);
  });
});

/**
 * `${project.spec.*}` — это то, чем петля пользуется в файлах работ,
 * подключённых через `uses`: путь контекста, `changed_only`,
 * `permissions.allow` и текст промпта. Все четыре проверяются в одной работе,
 * подключённой файлом, чтобы доказать раскрытие именно в `bodyScope`, а не
 * только в области пайплайна (её и так покрывают тесты выше).
 */
describe('pipeline-definition: ${project.spec.*} в подключённой работе', () => {
  function usesProject(): Project {
    return makeProject({
      'stepcast.yml': `
kind: pipeline
name: p
project:
  spec:
    dir: openspec/changes
    rules: .stepcast/prompts/spec-rules.md
    tool: openspec
jobs:
  work:
    uses: ./.stepcast/jobs/work.yml
`,
      '.stepcast/jobs/work.yml': `
kind: job
context:
  - path: "\${project.spec.dir}/**/*.md"
steps:
  - id: agent
    prompt: "file:../prompts/agent.md"
    permissions:
      allow: ["Bash(\${project.spec.tool} *)"]
    expect:
      - changed_only: ["\${project.spec.dir}/**"]
`,
      '.stepcast/prompts/agent.md': 'Правила: ${project.spec.rules}\n',
    });
  }

  it('раскрывает путь контекста, changed_only, permissions.allow и текст промпта', () => {
    const project = usesProject();
    const { pipeline } = expandWith(
      project,
      withProjectSpec(project, {}),
      'stepcast.yml',
    );
    const job = pipeline.jobs[0]!;

    assert.deepEqual(job.context[0], {
      kind: 'path',
      path: 'openspec/changes/**/*.md',
      mode: 'auto',
    });

    const step = asAgent(job.steps[0]!);
    assert.equal(step.prompt.trim(), 'Правила: .stepcast/prompts/spec-rules.md');
    assert.deepEqual(step.permissions?.allow, ['Bash(openspec *)']);
    assert.deepEqual(step.expect[0], { kind: 'changed_only', globs: ['openspec/changes/**'] });
  });

  it('раскрытый пайплайн несёт значения, а не подстановки', () => {
    const project = usesProject();
    const { pipeline } = expandWith(project, withProjectSpec(project, {}), 'stepcast.yml');

    const lock = serializeLock(pipeline);
    assert.doesNotMatch(lock, /\$\{project\.spec\.\w+\}/);
    assert.match(lock, /openspec\/changes/);
    assert.match(lock, /Bash\(openspec \*\)/);
  });
});

describe('pipeline-definition: действующее значение project.check', () => {
  it('пайплайн перекрывает конфигурацию', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
project:
  check: make check
jobs:
  build:
    steps: [{ id: c, run: "\${project.check}" }]
`,
    });
    const config = withProjectCheck(project, 'npm run check');
    const step = asRun(expandWith(project, config).pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.command, 'make check');
  });

  it('раскрывается значением из пайплайна, когда конфигурация секции не содержит', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
project:
  check: make check
jobs:
  build:
    steps: [{ id: c, run: "\${project.check}" }]
`,
    });
    const config = withProjectCheck(project, undefined);
    const step = asRun(expandWith(project, config).pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.command, 'make check');
  });

  it('раскрывается значением из конфигурации, когда пайплайн секцию не объявляет', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps: [{ id: c, run: "\${project.check}" }]
`,
    });
    const config = withProjectCheck(project, 'npm run check');
    const step = asRun(expandWith(project, config).pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.command, 'npm run check');
  });

  it('документ без ссылки на подстановку разбирается без ошибки, даже если ключ не объявлен ни там ни там', () => {
    const project = makeProject({ 'stepcast.yml': MINIMAL_PIPELINE });
    const config = withProjectCheck(project, undefined);
    assert.doesNotThrow(() => expandWith(project, config));
  });
});

describe('pipeline-definition: подстановка ${project.check}', () => {
  function projectPipeline(): Project {
    return makeProject({
      'stepcast.yml': `
kind: pipeline
name: p
context: [{ text: "проверяется \${project.check}" }]
jobs:
  loop:
    until:
      max_iterations: 3
      check: [{ cmd: "\${project.check}" }]
    steps:
      - id: run-str
        run: "\${project.check}"
      - id: run-arr
        run: ["\${project.check}"]
      - id: ask
        prompt: "file:./prompts/ask.md"
`,
      'prompts/ask.md': 'Проверка: ${project.check}\n',
    });
  }

  it('раскрывается в until.check[].cmd, в run строкой и массивом, в тексте промпта и в context', () => {
    const project = projectPipeline();
    const config = withProjectCheck(project, 'npm run check');
    const { pipeline } = expandWith(project, config);
    const job = pipeline.jobs[0]!;

    assert.equal(job.until?.check[0]?.kind, 'cmd');
    assert.equal((job.until?.check[0] as { command: string }).command, 'npm run check');

    assert.equal(asRun(job.steps[0]!).command, 'npm run check');
    assert.deepEqual(asRun(job.steps[1]!).command, ['npm run check']);
    assert.equal(asAgent(job.steps[2]!).prompt.trim(), 'Проверка: npm run check');

    assert.deepEqual(pipeline.context[0], { kind: 'text', text: 'проверяется npm run check' });
  });

  it('раскрытый пайплайн несёт команду, а не подстановку', () => {
    const project = projectPipeline();
    const config = withProjectCheck(project, 'npm run check');
    const { pipeline } = expandWith(project, config);

    const lock = serializeLock(pipeline);
    assert.doesNotMatch(lock, /\$\{project\.check\}/);
    assert.match(lock, /npm run check/);
  });

  it('ссылка на необъявленный project.check — отказ разбора, называющий оба места объявления', () => {
    const project = projectPipeline();
    const config = withProjectCheck(project, undefined);

    assert.throws(
      () => expandWith(project, config),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.hint ?? '', /project\.check/);
        assert.match(error.hint ?? '', new RegExp(project.path('stepcast.yml').replace(/[/\\]/g, '\\$&')));
        assert.match(error.hint ?? '', /\.stepcast\/config\.yml/);
        return true;
      },
    );
  });

  it('обращение к имени вне состава пространства называет доступные имена', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps: [{ id: c, run: "\${project.name}" }]
`,
    });
    const config = withProjectCheck(project, 'npm run check');

    assert.throws(
      () => expandWith(project, config),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        // Сообщение о составе, а не о том, где объявить: имя `name`
        // пространству не принадлежит вовсе, и объявлять его негде. Обе ветки
        // содержат слово «check», поэтому различает их не оно.
        assert.match(error.hint ?? '', /содержит только check/);
        assert.doesNotMatch(error.hint ?? '', /Объявите/);
        return true;
      },
    );
  });

  it('необъявленный ключ и имя вне состава — разные сообщения', () => {
    const undeclared = projectPipeline();
    const outside = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps: [{ id: c, run: "\${project.name}" }]
`,
    });

    const first = thrown(() => expandWith(undeclared, withProjectCheck(undeclared, undefined)));
    const second = thrown(() => expandWith(outside, withProjectCheck(outside, 'npm run check')));

    assert.notEqual(first.hint, second.hint);
    assert.match(first.hint ?? '', /Объявите/);
    assert.doesNotMatch(first.hint ?? '', /содержит только/);
  });
});

/**
 * Работа, подключённая через `uses:`, раскрывается в собственной области
 * видимости (`bodyScope`) — не в области пайплайна. Именно этим путём петля и
 * пользуется: `verify`, `implement`, `fix-review` и `merge` подключены файлами,
 * поэтому подстановка в описанной на месте работе ничего о них не доказывает.
 */
describe('pipeline-definition: ${project.check} в подключённой работе', () => {
  function usesProject(): Project {
    return makeProject({
      'stepcast.yml': `
kind: pipeline
name: p
jobs:
  loop:
    uses: ./.stepcast/jobs/loop.yml
`,
      '.stepcast/jobs/loop.yml': `
kind: job
until:
  max_iterations: 3
  check: [{ cmd: "\${project.check}" }]
steps:
  - id: run-str
    run: "\${project.check}"
  - id: run-arr
    run: ["\${project.check}"]
  - id: ask
    prompt: "file:../prompts/ask.md"
`,
      '.stepcast/prompts/ask.md': 'Проверка: ${project.check}\n',
    });
  }

  it('раскрывается в until, в шагах и в промпте файла работы', () => {
    const project = usesProject();
    const { pipeline } = expandWith(project, withProjectCheck(project, 'npm run check'));
    const job = pipeline.jobs[0]!;

    assert.equal(job.source, project.path('.stepcast/jobs/loop.yml'));
    assert.equal((job.until?.check[0] as { command: string }).command, 'npm run check');
    assert.equal(asRun(job.steps[0]!).command, 'npm run check');
    assert.deepEqual(asRun(job.steps[1]!).command, ['npm run check']);
    assert.equal(asAgent(job.steps[2]!).prompt.trim(), 'Проверка: npm run check');
  });

  it('ссылка из файла работы на необъявленный ключ — отказ с тем же объяснением', () => {
    const project = usesProject();

    assert.throws(
      () => expandWith(project, withProjectCheck(project, undefined)),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        // Диагностика называет файл работы — там объявлено поле, — а подсказка
        // оба места, где команду можно объявить.
        assert.equal(error.file, project.path('.stepcast/jobs/loop.yml'));
        assert.match(error.hint ?? '', /Объявите project\.check/);
        assert.match(error.hint ?? '', /\.stepcast\/config\.yml/);
        return true;
      },
    );
  });

  it('файл работы адресует project даже без параметров: подсказка про inputs его не касается', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    uses: ./jobs/build.yml
`,
      'jobs/build.yml': `
kind: job
steps: [{ id: c, run: "\${project.name}" }]
`,
    });

    assert.throws(
      () => expandWith(project, withProjectCheck(project, 'npm run check')),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.hint ?? '', /содержит только check/);
        return true;
      },
    );
  });
});

describe('pipeline-definition: действующее значение project.tools', () => {
  it('пайплайн перекрывает конфигурацию целиком', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
project:
  tools: [make]
jobs:
  build:
    steps: [{ id: c, run: ["\${project.tools}"] }]
`,
    });
    const config = withProjectTools(project, ['npm', 'npx']);
    const step = asRun(expandWith(project, config).pipeline.jobs[0]!.steps[0]!);
    assert.deepEqual(step.command, ['make']);
  });

  it('раскрывается значением из конфигурации, когда пайплайн секцию не объявляет', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps: [{ id: c, run: ["\${project.tools}"] }]
`,
    });
    const config = withProjectTools(project, ['npm', 'npx', 'node']);
    const step = asRun(expandWith(project, config).pipeline.jobs[0]!.steps[0]!);
    assert.deepEqual(step.command, ['npm', 'npx', 'node']);
  });

  it('документ без ссылки на подстановку разбирается без ошибки, даже если ключ не объявлен ни там ни там', () => {
    const project = makeProject({ 'stepcast.yml': MINIMAL_PIPELINE });
    const config = withProjectTools(project, undefined);
    assert.doesNotThrow(() => expandWith(project, config));
  });
});

describe('pipeline-definition: подстановка ${project.tools}', () => {
  it('ссылка на необъявленный project.tools — отказ разбора, называющий оба места объявления', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps: [{ id: c, run: ["\${project.tools}"] }]
`,
    });
    const config = withProjectTools(project, undefined);

    assert.throws(
      () => expandWith(project, config),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.hint ?? '', /project\.tools/);
        assert.match(error.hint ?? '', new RegExp(project.path('stepcast.yml').replace(/[/\\]/g, '\\$&')));
        assert.match(error.hint ?? '', /\.stepcast\/config\.yml/);
        return true;
      },
    );
  });

  it('обращение к имени вне состава пространства называет доступные имена, включая tools', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps: [{ id: c, run: "\${project.toolchain}" }]
`,
    });
    const config = withProjectTools(project, ['npm']);

    assert.throws(
      () => expandWith(project, config),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.hint ?? '', /содержит только/);
        assert.match(error.hint ?? '', /\btools\b/);
        return true;
      },
    );
  });

  it('шаг с правом Bash(${project.tools} *) уходит в permissions.allow тремя записями в объявленном порядке', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
project:
  tools: [npm, npx, node]
jobs:
  build:
    steps:
      - id: ask
        prompt: сделай
        permissions:
          allow: [Read, "Bash(\${project.tools} *)", "Bash(git log*)"]
`,
    });
    const { pipeline } = expand(project);
    const step = asAgent(pipeline.jobs[0]!.steps[0]!);
    assert.deepEqual(step.permissions?.allow, [
      'Read',
      'Bash(npm *)',
      'Bash(npx *)',
      'Bash(node *)',
      'Bash(git log*)',
    ]);
  });

  // Значение известно до прогона, поэтому в снимке на его месте обязаны стоять
  // объявленные строки: подстановка, дожившая до pipeline.lock.yml, означала бы,
  // что раскрытие отложилось до исполнения и снимок описывает не то, что пойдёт
  // в бэкенд.
  it('раскрытое значение попадает в снимок пайплайна строками, а не подстановкой', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
project:
  tools: [npm, npx, node]
jobs:
  build:
    steps:
      - id: ask
        prompt: сделай
        permissions:
          allow: [Read, "Bash(\${project.tools} *)", "Bash(git log*)"]
`,
    });

    const lock = serializeLock(expand(project).pipeline);
    assert.doesNotMatch(lock, /\$\{project\.tools\}/);

    const parsed = parseYaml(lock) as {
      jobs: Array<{ steps: Array<{ permissions?: { allow?: readonly string[] } }> }>;
    };
    assert.deepEqual(parsed.jobs[0]!.steps[0]!.permissions?.allow, [
      'Read',
      'Bash(npm *)',
      'Bash(npx *)',
      'Bash(node *)',
      'Bash(git log*)',
    ]);
  });
});

describe('pipeline-definition: действующее значение project.edit_paths', () => {
  it('пайплайн перекрывает конфигурацию целиком', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
project:
  edit_paths: [cmd/**]
jobs:
  build:
    steps: [{ id: c, run: ["\${project.edit_paths}"] }]
`,
    });
    const config = withProjectEditPaths(project, ['src/**', 'test/**']);
    const step = asRun(expandWith(project, config).pipeline.jobs[0]!.steps[0]!);
    assert.deepEqual(step.command, ['cmd/**']);
  });

  it('раскрывается значением из конфигурации, когда пайплайн секцию не объявляет', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps: [{ id: c, run: ["\${project.edit_paths}"] }]
`,
    });
    const config = withProjectEditPaths(project, ['src/**', 'test/**', 'package.json']);
    const step = asRun(expandWith(project, config).pipeline.jobs[0]!.steps[0]!);
    assert.deepEqual(step.command, ['src/**', 'test/**', 'package.json']);
  });

  it('документ без ссылки на подстановку разбирается без ошибки, даже если ключ не объявлен ни там ни там', () => {
    const project = makeProject({ 'stepcast.yml': MINIMAL_PIPELINE });
    const config = withProjectEditPaths(project, undefined);
    assert.doesNotThrow(() => expandWith(project, config));
  });
});

describe('pipeline-definition: подстановка ${project.edit_paths}', () => {
  it('ссылка на необъявленный project.edit_paths — отказ разбора, называющий оба места объявления', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps: [{ id: c, run: ["\${project.edit_paths}"] }]
`,
    });
    const config = withProjectEditPaths(project, undefined);

    assert.throws(
      () => expandWith(project, config),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.hint ?? '', /project\.edit_paths/);
        assert.match(error.hint ?? '', new RegExp(project.path('stepcast.yml').replace(/[/\\]/g, '\\$&')));
        assert.match(error.hint ?? '', /\.stepcast\/config\.yml/);
        return true;
      },
    );
  });

  it('обращение к имени вне состава пространства называет доступные имена, включая edit_paths', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps: [{ id: c, run: "\${project.edit_path}" }]
`,
    });
    const config = withProjectEditPaths(project, ['src/**']);

    assert.throws(
      () => expandWith(project, config),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.hint ?? '', /содержит только/);
        assert.match(error.hint ?? '', /\bedit_paths\b/);
        return true;
      },
    );
  });

  it('элемент changed_only со ссылкой даёт по шаблону на объявленный путь, в объявленном порядке, соседи на местах', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
project:
  edit_paths: [src/**, test/**, package.json]
jobs:
  build:
    steps:
      - id: ask
        prompt: сделай
        expect:
          - changed_only: ["\${project.spec.dir}/**", "\${project.edit_paths}", ".stepcast/**"]
`,
    });
    const { pipeline } = expandWith(project, withProjectSpec(project, { dir: 'openspec/changes' }));
    const step = asAgent(pipeline.jobs[0]!.steps[0]!);
    assert.deepEqual(step.expect[0], {
      kind: 'changed_only',
      globs: ['openspec/changes/**', 'src/**', 'test/**', 'package.json', '.stepcast/**'],
    });
  });

  it('check: ${project.edit_paths} — отказ о значении, непредставимом строкой, с подсказкой про элемент списка', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
project:
  edit_paths: [src/**, test/**]
jobs:
  build:
    steps: [{ id: c, run: "\${project.edit_paths}" }]
`,
    });

    assert.throws(
      () => expand(project),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /непредставимо/);
        assert.match(error.hint ?? '', /раскрывается только в элементе списка/);
        return true;
      },
    );
  });

  it('раскрытое значение попадает в снимок пайплайна путями, а не подстановкой', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
project:
  edit_paths: [src/**, test/**, package.json]
jobs:
  build:
    steps:
      - id: ask
        prompt: сделай
        expect:
          - changed_only: ["\${project.edit_paths}"]
`,
    });

    const lock = serializeLock(expand(project).pipeline);
    assert.doesNotMatch(lock, /\$\{project\.edit_paths\}/);

    const parsed = parseYaml(lock) as {
      jobs: Array<{ steps: Array<{ expect?: Array<{ globs?: readonly string[] }> }> }>;
    };
    assert.deepEqual(parsed.jobs[0]!.steps[0]!.expect?.[0]?.globs, ['src/**', 'test/**', 'package.json']);
  });
});

describe('pipeline-definition: позиция подстановки', () => {
  const scope: Scope = { values: { params: { x: 'ok' } }, deferred: new Set() };

  it('строка и столбец первой и последующих подстановок в многострочном тексте', () => {
    const template = 'a: ${params.x}\nb: ${params.x} и ${params.x}\n';
    const { substitutions } = interpolate(template, scope);

    assert.equal(substitutions.length, 3);
    assert.deepEqual(
      substitutions.map((item) => [item.line, item.column]),
      [
        [1, 4],
        [2, 4],
        [2, 18],
      ],
    );
  });

  it('позиция считается по исходному шаблону, а не по результату', () => {
    // Подставленное значение короче выражения — не он должен влиять на
    // позицию второй подстановки в той же строке.
    const template = '${params.x} затем ${params.x}';
    const { substitutions } = interpolate(template, scope);

    assert.equal(substitutions[1]?.column, 19);
  });

  it('экранированное $${...} позиции не порождает', () => {
    const template = 'литерал $${params.x} и настоящая ${params.x}';
    const { substitutions } = interpolate(template, scope);

    assert.equal(substitutions.length, 1);
    assert.equal(substitutions[0]?.expression, 'params.x');
  });

  it('origin у полей документа отсутствует, а при объявлении в scope — записывается', () => {
    const withoutOrigin = interpolate('${params.x}', scope);
    assert.equal(withoutOrigin.substitutions[0]?.origin, undefined);

    const withOrigin = interpolate('${params.x}', { ...scope, origin: '/tmp/prompt.md' });
    assert.equal(withOrigin.substitutions[0]?.origin, '/tmp/prompt.md');
  });
});

describe('pipeline-definition: раскрытие списочного значения в элемент списка', () => {
  const scope: Scope = {
    values: { project: { tools: ['npm', 'npx', 'node'] } },
    deferred: new Set(['jobs']),
  };

  it('элемент со списочной подстановкой размножается по числу значений', () => {
    const { value } = interpolateTree({ allow: ['Bash(${project.tools} *)'] }, scope, '');
    assert.deepEqual(value.allow, ['Bash(npm *)', 'Bash(npx *)', 'Bash(node *)']);
  });

  it('список из одного значения даёт один элемент', () => {
    const single: Scope = { values: { project: { tools: ['make'] } }, deferred: new Set() };
    const { value } = interpolateTree({ allow: ['Bash(${project.tools} *)'] }, single, '');
    assert.deepEqual(value.allow, ['Bash(make *)']);
  });

  it('окружающий текст применяется к каждому значению, порядок соседей сохранён', () => {
    const { value } = interpolateTree(
      { allow: ['Read', 'Bash(${project.tools} *)', 'Bash(git log*)'] },
      scope,
      '',
    );
    assert.deepEqual(value.allow, ['Read', 'Bash(npm *)', 'Bash(npx *)', 'Bash(node *)', 'Bash(git log*)']);
  });

  it('отложенная подстановка того же элемента выживает в каждой копии', () => {
    const { value, substitutions } = interpolateTree(
      { allow: ['Bash(${project.tools} ${jobs.build.output.x})'] },
      scope,
      '',
    );
    assert.deepEqual(value.allow, [
      'Bash(npm ${jobs.build.output.x})',
      'Bash(npx ${jobs.build.output.x})',
      'Bash(node ${jobs.build.output.x})',
    ]);
    assert.equal(substitutions.get('allow.0')?.some((item) => item.deferred), true);
    assert.equal(substitutions.get('allow.1')?.some((item) => item.deferred), true);
    assert.equal(substitutions.get('allow.2')?.some((item) => item.deferred), true);
  });

  it('карта подстановок пишется по путям произведённых элементов, не исходного индекса', () => {
    const { substitutions } = interpolateTree(
      { allow: ['Read', 'Bash(${project.tools} *)', 'Bash(git log*)'] },
      scope,
      '',
    );
    assert.ok(substitutions.has('allow.1'));
    assert.ok(substitutions.has('allow.2'));
    assert.ok(substitutions.has('allow.3'));
    // Путь allow.1 в исходном дереве указывал на "Bash(${project.tools} *)" —
    // после размножения по этому пути стоит "Bash(git log*)", у которой своих
    // подстановок нет, поэтому единственная запись под allow.1 должна быть той,
    // что относится к произведённому npm-элементу, а не к прежнему индексу.
    assert.equal(substitutions.get('allow.1')?.[0]?.expression, 'project.tools');
  });

  it('две списочные подстановки в одном элементе — отказ, называющий поле и оба выражения', () => {
    assert.throws(
      () => interpolateTree({ allow: ['${project.tools}-${project.tools}'] }, scope, ''),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.at, 'allow.0');
        assert.match(error.message, /project\.tools/);
        return true;
      },
    );
  });

  it('списочное значение в скалярном поле — отказ с подсказкой о раскрытии в элементе списка', () => {
    assert.throws(
      () => interpolateTree({ check: '${project.tools}' }, scope, ''),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.at, 'check');
        assert.match(error.hint ?? '', /раскрывается только в элементе списка/);
        return true;
      },
    );
  });

  /**
   * Ноль значений дал бы ноль элементов: в `permissions.allow` — исчезнувшее
   * право, в `changed_only` — исчезнувшую границу правок. Обе схемы пустой
   * список отклоняют, но значение доезжает сюда и мимо них (слоем флагов), и
   * тихо удалять элемент нельзя.
   */
  it('пустой список — отказ, а не исчезнувший элемент', () => {
    const empty: Scope = { values: { project: { tools: [] } }, deferred: new Set() };
    assert.throws(
      () => interpolateTree({ allow: ['Read', 'Bash(${project.tools} *)'] }, empty, ''),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.at, 'allow.1');
        assert.match(error.message, /пустой список/);
        return true;
      },
    );
  });

  /**
   * Размножается только список строк. Разнородный массив до размножения не
   * доходит и падает в `renderValue` — там, где автор уже стоит в элементе
   * списка, подсказка «раскрывается только в элементе списка» была бы тупиком,
   * поэтому выдаётся перечень допустимых значений.
   */
  it('массив не из строк в элементе списка отказывает перечнем допустимых значений', () => {
    const mixed: Scope = { values: { project: { tools: ['npm', 2] } }, deferred: new Set() };
    assert.throws(
      () => interpolateTree({ allow: ['Bash(${project.tools} *)'] }, mixed, ''),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.at, 'allow.0');
        assert.match(error.hint ?? '', /допустимы строки, числа и логические значения/);
        return true;
      },
    );
  });
});

describe('pipeline-definition: required у записи контекста', () => {
  it('доезжает до раскрытой записи, а необъявленное требование её не меняет', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    context:
      - path: "changes/**/*.md"
        required: true
      - path: AGENTS.md
    steps:
      - id: agent
        agent: claude
        prompt: ok
`,
    });

    const { pipeline } = expand(project);

    assert.deepEqual(pipeline.jobs[0]!.context, [
      { kind: 'path', path: 'changes/**/*.md', mode: 'auto', required: true },
      { kind: 'path', path: 'AGENTS.md', mode: 'auto' },
    ]);
  });

  it('опечатка в имени ключа записи отклоняется разбором', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    context:
      - path: AGENTS.md
        require: true
    steps: [{ id: c, run: "true" }]
`,
    });

    assert.throws(() => expand(project), StepcastError);
  });
});

describe('pipeline-definition: отказ раскрытия на ссылке stepcast:<имя>', () => {
  it('неизвестное имя схемы роняет раскрытие, называя ссылку, место объявления и перечень имён', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: think
        agent: claude
        prompt: ok
        output_schema: stepcast:no-such
`,
    });

    const error = thrown(() => expand(project));
    assert.match(error.message, /no-such/);
    assert.match(error.at ?? '', /jobs\.build\.steps\.0\.output_schema/);
    assert.match(error.hint ?? '', /backlog-slots/);
  });

  it('имя с .. роняет раскрытие, не заходя в файловую систему', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: think
        agent: claude
        prompt: ok
        expect:
          - schema: "stepcast:../../etc/passwd"
`,
    });

    const error = thrown(() => expand(project));
    assert.match(error.message, /kebab-case/);
    assert.match(error.at ?? '', /jobs\.build\.steps\.0\.expect\.0\.schema/);
  });

  it('обычный путь схемы разрешается как прежде, а не как ссылка на пакет', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: think
        agent: claude
        prompt: ok
        output_schema: schemas/probe.json
`,
      'schemas/probe.json': JSON.stringify({ type: 'object' }),
    });

    const { pipeline } = expand(project);
    const step = pipeline.jobs[0]!.steps[0] as { outputSchemaPath?: string };
    assert.equal(step.outputSchemaPath, project.path('schemas/probe.json'));
  });
});

describe('pipeline-definition: шаг script', () => {
  // Сценарий: «Шаг объявлен файлом»
  it('разбирается в шаг вида script с путём, args и разрешением', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: cleanup
        script: cleanup.py
        args: ['--dry-run']
        expect: [{ exit_code: 0 }]
`,
    });
    project.write('.stepcast/scripts/cleanup.py', '#!/usr/bin/env python3\nprint("hi")\n');

    const { pipeline } = expandScript(project, isolatedScriptRoots(project));
    const step = asScript(pipeline.jobs[0]!.steps[0]!);

    assert.equal(step.kind, 'script');
    assert.equal(step.path, 'cleanup.py');
    assert.deepEqual(step.args, ['--dry-run']);
    assert.equal(step.unresolved, undefined);
    assert.equal(step.resolved?.layer, 'project');
    assert.equal(step.resolved?.absolutePath, project.path('.stepcast/scripts/cleanup.py'));
    assert.equal(step.resolved?.runner, 'python3');
    assert.deepEqual(step.resolved?.argv, ['python3', project.path('.stepcast/scripts/cleanup.py'), '--dry-run']);
    assert.match(step.resolved?.fingerprint ?? '', /^[0-9a-f]{16}$/);
  });

  // Сценарий: «Два вида шага сразу»
  it('отклоняет шаг, объявивший script вместе с run', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: c
        script: cleanup.py
        run: [echo, hi]
`,
    });
    assert.throws(() => expandScript(project, isolatedScriptRoots(project)), StepcastError);
  });

  it('отклоняет шаг, объявивший script вместе с prompt', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: c
        script: cleanup.py
        prompt: привет
`,
    });
    assert.throws(() => expandScript(project, isolatedScriptRoots(project)), StepcastError);
  });

  // Сценарий: «Аргументы только списком»
  it('отклоняет args строкой', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: c
        script: cleanup.py
        args: "--dry-run --verbose"
`,
    });
    assert.throws(() => expandScript(project, isolatedScriptRoots(project)), StepcastError);
  });

  // Сценарий: «Структурированный выход не объявляется»
  it('отклоняет output_schema у шага script', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: c
        script: cleanup.py
        output_schema: schema.json
`,
      'schema.json': JSON.stringify({ type: 'object' }),
    });
    assert.throws(() => expandScript(project, isolatedScriptRoots(project)), StepcastError);
  });

  it('отклоняет отложенную подстановку в значении script', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: a
        run: [echo, ok]
      - id: c
        script: "\${jobs.a.output.path}"
`,
    });
    const error = thrown(() => expandScript(project, isolatedScriptRoots(project)));
    assert.match(error.message, /jobs/);
  });

  describe('слои пути', () => {
    // Сценарий: «Проектный слой»
    it('находит файл в проектном слое', () => {
      const project = makeProject({
        'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: c
        script: cleanup.py
`,
      });
      project.write('.stepcast/scripts/cleanup.py', 'print(1)\n');
      const roots = isolatedScriptRoots(project);

      const step = asScript(expandScript(project, roots).pipeline.jobs[0]!.steps[0]!);
      assert.equal(step.resolved?.layer, 'project');
      assert.equal(step.resolved?.absolutePath, project.path('.stepcast/scripts/cleanup.py'));
    });

    // Сценарий: «Домашний слой»
    it('падает на домашний слой, когда в проекте файла нет', () => {
      const project = makeProject({
        'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: c
        script: cleanup.py
`,
      });
      const roots = isolatedScriptRoots(project);
      const homeScript = join(roots.home, '.stepcast', 'scripts');
      writeOutsideProject(homeScript, 'cleanup.py', 'print(1)\n');

      const step = asScript(expandScript(project, roots).pipeline.jobs[0]!.steps[0]!);
      assert.equal(step.resolved?.layer, 'home');
      assert.equal(step.resolved?.absolutePath, join(homeScript, 'cleanup.py'));
    });

    // Сценарий: «Встроенный слой»
    it('падает на встроенный слой, когда файла нет ни в проекте, ни дома', () => {
      const project = makeProject({
        'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: c
        script: cleanup.py
`,
      });
      const roots = isolatedScriptRoots(project);
      writeOutsideProject(roots.builtin, 'cleanup.py', 'print(1)\n');

      const step = asScript(expandScript(project, roots).pipeline.jobs[0]!.steps[0]!);
      assert.equal(step.resolved?.layer, 'builtin');
      assert.equal(step.resolved?.absolutePath, join(roots.builtin, 'cleanup.py'));
    });

    // Сценарий: «Явный путь слоёв не касается»
    it('явный путь ./ разрешается от файла объявления и слоёв не касается', () => {
      const project = makeProject({
        'stepcast.yml': `
kind: pipeline
jobs:
  nightly:
    uses: ./jobs/nightly.yml
`,
        'jobs/nightly.yml': `
kind: job
steps:
  - id: cleanup
    script: ../scripts/cleanup.py
`,
      });
      // Файл лежит вне слоя .stepcast/scripts/ — если бы разрешение искало
      // слоями, оно бы этот файл не нашло вовсе.
      project.write('scripts/cleanup.py', 'print(1)\n');
      const roots = isolatedScriptRoots(project);

      const step = asScript(expandScript(project, roots).pipeline.jobs[0]!.steps[0]!);
      assert.equal(step.resolved?.layer, 'explicit');
      assert.equal(step.resolved?.absolutePath, project.path('scripts/cleanup.py'));
    });

    it('ненайденный файл оставляет шаг неразрешённым, называя просмотренные каталоги', () => {
      const project = makeProject({
        'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: c
        script: cleanup.py
`,
      });
      const roots = isolatedScriptRoots(project);

      const step = asScript(expandScript(project, roots).pipeline.jobs[0]!.steps[0]!);
      assert.equal(step.resolved, undefined);
      assert.equal(step.unresolved?.reason, 'file_not_found');
      if (step.unresolved?.reason === 'file_not_found') {
        assert.equal(step.unresolved.searched.length, 3);
        assert.ok(step.unresolved.searched.includes(join(roots.project, '.stepcast', 'scripts')));
        assert.ok(step.unresolved.searched.includes(join(roots.home, '.stepcast', 'scripts')));
        assert.ok(step.unresolved.searched.includes(roots.builtin));
      }
    });

    // Каталог находкой не считается: иначе чтение содержимого упало бы
    // системной ошибкой вместо названного отказа.
    it('каталог на месте скрипта — тот же неразрешённый шаг, а не падение', () => {
      const project = makeProject({
        'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: c
        script: tools
`,
      });
      project.write('.stepcast/scripts/tools/cleanup.py', 'print(1)\n');
      const roots = isolatedScriptRoots(project);

      const step = asScript(expandScript(project, roots).pipeline.jobs[0]!.steps[0]!);
      assert.equal(step.resolved, undefined);
      assert.equal(step.unresolved?.reason, 'file_not_found');
    });

    it('каталог, названный явным путём, тоже не находка', () => {
      const project = makeProject({
        'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: c
        script: ./tools
`,
      });
      project.write('tools/cleanup.py', 'print(1)\n');

      const step = asScript(
        expandScript(project, isolatedScriptRoots(project)).pipeline.jobs[0]!.steps[0]!,
      );
      assert.equal(step.resolved, undefined);
      assert.equal(step.unresolved?.reason, 'file_not_found');
    });

    // Пустое значение отклоняется разбором: внутри слоя оно дало бы сам
    // каталог слоя, то есть находку на пустом месте.
    it('отклоняет пустое значение script', () => {
      for (const value of ['""', '"   "']) {
        const project = makeProject({
          'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: c
        script: ${value}
`,
        });
        assert.throws(() => expandScript(project, isolatedScriptRoots(project)), StepcastError, value);
      }
    });
  });

  describe('выбор раннера', () => {
    // Сценарий: «Явное имя раннера побеждает»
    it('явный runner побеждает расширение', () => {
      const project = makeProject({
        'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: c
        script: build.py
        runner: sh
`,
      });
      project.write('.stepcast/scripts/build.py', 'print(1)\n');
      const step = asScript(expandScript(project, isolatedScriptRoots(project)).pipeline.jobs[0]!.steps[0]!);
      assert.equal(step.resolved?.runner, 'sh');
      assert.equal(step.resolved?.argv[0], 'sh');
    });

    // Сценарий: «Выбор по расширению»
    it('расширение побеждает shebang', () => {
      const project = makeProject({
        'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: c
        script: report.ts
`,
      });
      project.write('.stepcast/scripts/report.ts', '#!/usr/bin/env python3\nconsole.log(1)\n');
      const step = asScript(expandScript(project, isolatedScriptRoots(project)).pipeline.jobs[0]!.steps[0]!);
      assert.equal(step.resolved?.runner, 'node-ts');
      assert.deepEqual(step.resolved?.argv.slice(0, 2), ['node', '--experimental-strip-types']);
    });

    // Сценарий: «Выбор по shebang»
    it('файл без расширения выбирается по shebang', () => {
      const project = makeProject({
        'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: c
        script: tool
`,
      });
      project.write('.stepcast/scripts/tool', '#!/usr/bin/env python3\nprint(1)\n');
      const step = asScript(expandScript(project, isolatedScriptRoots(project)).pipeline.jobs[0]!.steps[0]!);
      assert.equal(step.resolved?.runner, 'python3');
    });

    // Сценарий: «Shebang не исполняется»
    it('форма env -S даёт имя python3, а флаги в argv не попадают', () => {
      const project = makeProject({
        'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: c
        script: tool
`,
      });
      project.write('.stepcast/scripts/tool', '#!/usr/bin/env -S python3 -X utf8\nprint(1)\n');
      const step = asScript(expandScript(project, isolatedScriptRoots(project)).pipeline.jobs[0]!.steps[0]!);
      assert.equal(step.resolved?.runner, 'python3');
      assert.deepEqual(step.resolved?.argv, ['python3', project.path('.stepcast/scripts/tool')]);
    });

    it('неразрешимый выбор оставляет шаг неразрешённым с перечнем известных расширений', () => {
      const project = makeProject({
        'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: c
        script: mystery.rb
`,
      });
      project.write('.stepcast/scripts/mystery.rb', 'puts 1\n');
      const step = asScript(expandScript(project, isolatedScriptRoots(project)).pipeline.jobs[0]!.steps[0]!);
      assert.equal(step.resolved, undefined);
      assert.equal(step.unresolved?.reason, 'runner_undetermined');
      if (step.unresolved?.reason === 'runner_undetermined') {
        assert.deepEqual(step.unresolved.extensions, ['.js', '.mjs', '.mts', '.py', '.sh', '.ts', '.cjs'].sort());
      }
    });

    it('неизвестное имя раннера оставляет шаг неразрешённым с перечнем известных', () => {
      const project = makeProject({
        'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: c
        script: build.py
        runner: bun
`,
      });
      project.write('.stepcast/scripts/build.py', 'print(1)\n');
      const step = asScript(expandScript(project, isolatedScriptRoots(project)).pipeline.jobs[0]!.steps[0]!);
      assert.equal(step.resolved, undefined);
      assert.equal(step.unresolved?.reason, 'unknown_runner');
      if (step.unresolved?.reason === 'unknown_runner') {
        assert.equal(step.unresolved.runner, 'bun');
        assert.deepEqual(step.unresolved.known, ['node', 'node-ts', 'python3', 'sh'].sort());
      }
    });
  });
});

describe('pipeline.lock.yml: шаг script', () => {
  it('несёт путь, слой, абсолютный путь, раннер, argv и отпечаток, но не содержимое', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: cleanup
        script: cleanup.py
        args: ['--dry-run']
`,
    });
    project.write('.stepcast/scripts/cleanup.py', 'секретное содержимое, которого не должно быть в локе\n');

    const { pipeline } = expandScript(project, isolatedScriptRoots(project));
    const lock = serializeLock(pipeline);

    assert.match(lock, /script: cleanup\.py/);
    assert.match(lock, /layer: project/);
    assert.match(lock, /runner: python3/);
    assert.doesNotMatch(lock, /секретное содержимое/);
  });

  // Отпечаток и argv отдельного места в ключе не занимают — они уже часть
  // `step.resolved`, а `computeStepKey` хеширует `step` целиком (stepKey.ts).
  it('правка содержимого файла меняет ключ шага через хеширование step целиком', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: cleanup
        script: cleanup.py
`,
    });
    const roots = isolatedScriptRoots(project);
    project.write('.stepcast/scripts/cleanup.py', 'print(1)\n');
    const before = expandScript(project, roots);
    const beforeStep = asScript(before.pipeline.jobs[0]!.steps[0]!);

    project.write('.stepcast/scripts/cleanup.py', 'print(2)\n');
    const after = expandScript(project, roots);
    const afterStep = asScript(after.pipeline.jobs[0]!.steps[0]!);

    assert.notEqual(beforeStep.resolved?.fingerprint, afterStep.resolved?.fingerprint);

    const keyOf = (pipeline: typeof before.pipeline, step: typeof beforeStep) =>
      computeStepKey({
        lockHash: jobLockHash(pipeline, pipeline.jobs[0]!),
        jobId: 'build',
        step,
        inputsFingerprint: undefined,
        backendCommand: undefined,
        upstream: [],
      });

    assert.notEqual(keyOf(before.pipeline, beforeStep), keyOf(after.pipeline, afterStep));
  });
});
