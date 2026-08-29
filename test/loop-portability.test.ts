import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative as relativePath, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';

import { createFakeBackend, initLine, resultLine } from '../src/core/backend/fake.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { readStatus } from '../src/core/journal/reader.js';
import { runPipeline } from '../src/core/run/runner.js';
import { asAgent } from './helpers.js';
import { makeProject, type Project } from './helpers.js';

/**
 * Корень репозитория. Тесты компилируются в `dist/test/**`, а файлы петли —
 * `.stepcast/**` — остаются там же, где лежат в исходном дереве: два уровня
 * вверх от `dist/test/` (тот же приём, что в `schema-generated.test.ts`).
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const JOBS_DIR = join(ROOT, '.stepcast', 'jobs');
const PROMPTS_DIR = join(ROOT, '.stepcast', 'prompts');

/**
 * Файлы с одним из перечисленных расширений во всём поддереве каталога.
 *
 * Обход именно рекурсивный: `.stepcast/jobs/**` — это весь поддиректорий работ,
 * и файл, положенный в подкаталог, обязан попадать в те же проверки, а не
 * выпадать из них молча.
 */
function filesUnder(dir: string, suffixes: readonly string[]): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full, suffixes);
    return suffixes.some((suffix) => entry.name.endsWith(suffix)) ? [full] : [];
  });
}

/** Файлы работ петли. Оба написания расширения YAML — движок принимает и то и другое. */
function jobFiles(): string[] {
  return filesUnder(JOBS_DIR, ['.yml', '.yaml']);
}

/**
 * Задача 4.11 (а): файлы петли (кроме файла правил, объявленного самим
 * названием) не должны нести литералов OpenSpec — иначе смена практики
 * репозитория потребовала бы правки этих файлов, а именно это изменение и
 * снимает.
 */
describe('self-improvement-loop: переносимость файлов петли', () => {
  const FORBIDDEN: readonly RegExp[] = [
    /openspec/i,
    /proposal\.md/,
    /design\.md/,
    /tasks\.md/,
    /specs\/\*\*/,
    // Документ каталога изменения и команда его пересборки — такая же часть
    // практики репозитория, как имена остальных документов: чужой репозиторий,
    // скопировавший промпты, получил бы указание завести status.md и позвать
    // скрипт, которого у него нет.
    /status\.md/,
    /status:build/,
    // job-tools-declaration: инструментарий этого репозитория называется
    // объявлением project.tools, а не правом файла работы напрямую. Образец —
    // само право (`Bash(npm`), а не всякое вхождение слова: комментарий,
    // поясняющий пример подстановкой, литералом права не является.
    /Bash\(npm\b/,
    /Bash\(npx\b/,
    /Bash\(node\b/,
    // changed-only-boundaries-declaration: раскладка этого репозитория
    // называется объявлением project.edit_paths, а не шаблонами changed_only
    // в файле работы напрямую. Шаблон с `**` — это как раз запись границы
    // (`docs/config.md` в обычном тексте комментария границей не является).
    /src\/\*\*/,
    /test\/\*\*/,
    /docs\/\*\*/,
    /schema\/\*\*/,
    /scripts\/\*\*/,
    /ui\/\*\*/,
    /package\.json/,
    /package-lock\.json/,
    /vite\.config/,
    /eslint\.config/,
    /README\.md/,
    /\.gitattributes/,
    // Та же раскладка, пересказанная промптом словами, а не шаблоном
    // changed_only: каталог, названный в обратных кавычках со слешем, — это
    // объявление границы промптом, а не случайное упоминание пути в тексте.
    /`src\//,
    /`test\//,
    /`docs\//,
  ];

  it('файлы работ петли не называют OpenSpec и его документы', () => {
    for (const file of jobFiles()) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of FORBIDDEN) {
        assert.doesNotMatch(text, pattern, `${file} содержит ${pattern}`);
      }
    }
  });

  it('промпты петли, кроме файла правил, не называют OpenSpec и его документы', () => {
    for (const file of filesUnder(PROMPTS_DIR, ['.md'])) {
      if (file.endsWith('spec-rules.md')) continue;
      const text = readFileSync(file, 'utf8');
      for (const pattern of FORBIDDEN) {
        assert.doesNotMatch(text, pattern, `${file} содержит ${pattern}`);
      }
    }
  });

  it('файл правил остаётся местом, где OpenSpec назван', () => {
    const text = readFileSync(join(PROMPTS_DIR, 'spec-rules.md'), 'utf8');
    assert.match(text, /openspec/i);
  });

  /**
   * Файл, названный объявлением, обязан существовать. Линт этого не увидит:
   * `${project.spec.rules}` в `implement.yml` и `propose.yml` — путь с
   * подстановкой, но раскрывается он при разборе, и проверка существования
   * его теперь ловит (`checkDeclaredPath`). Здесь — та же проверка на самом
   * объявлении, чтобы промах был виден и без прогона линта на петле.
   */
  it('файл, названный project.spec.rules, лежит на диске', () => {
    const document = parseYaml(
      readFileSync(join(ROOT, '.stepcast', 'pipelines', 'self-improve.yml'), 'utf8'),
    ) as { project?: { spec?: { rules?: string } } };
    const rules = document.project?.spec?.rules;

    assert.equal(typeof rules, 'string');
    assert.ok(existsSync(join(ROOT, rules as string)), `файла ${rules} нет в дереве`);
  });
});

/**
 * job-tools-declaration: настоящий пайплайн петли, раскрытый целиком, обязан
 * давать `implement` и `fix-review` тот же набор прав, что они несли
 * литералами до изменения, — в том же порядке и с теми же соседями.
 *
 * Проверка идёт по настоящему `.stepcast/pipelines/self-improve.yml`, а не по
 * его копии: перенос объявления `tools` в `.stepcast/config.yml` или правка
 * прав в файле работы обязаны быть видны здесь, а копия пайплайна отставала бы
 * от оригинала молча. Ожидаемый список выписан целиком, а не проверен на
 * вхождение: смысл требования — тождество прежнему набору, и лишнее право в
 * нём такой же промах, как недостающее.
 */
describe('self-improvement-loop: настоящий пайплайн петли даёт прежний набор прав', () => {
  const EXPECTED_ALLOW = [
    'Read',
    'Grep',
    'Glob',
    'Edit',
    'Write',
    'Bash(npm *)',
    'Bash(npx *)',
    'Bash(node *)',
    'Bash(git status*)',
    'Bash(git diff*)',
    'Bash(git log*)',
  ];

  /**
   * changed-only-boundaries-declaration: тот же набор шаблонов, что нёс
   * предикат до переноса раскладки в `project.edit_paths`, — сравнивается как
   * множество, а не по порядку: `edit_paths` идёт в предикате одной записью
   * подстановки, и порядок соседей (`${project.spec.dir}/**`, записи
   * `.stepcast/**`) внутри списка сегодня другой, но сам набор границ обязан
   * остаться тождественным.
   */
  const EXPECTED_CHANGED_ONLY = new Set([
    'src/**',
    'test/**',
    'docs/**',
    'openspec/changes/**',
    'schema/**',
    'scripts/**',
    'package.json',
    'package-lock.json',
    '.gitattributes',
    '.stepcast/config.yml',
    '.stepcast/prompts/**',
    '.stepcast/prompts/spec-rules.md',
    '.stepcast/jobs/**',
    '.stepcast/pipelines/**',
    '.stepcast/schemas/**',
    'ui/**',
    'vite.config.ts',
    'README.md',
    'eslint.config.js',
  ]);

  /**
   * merged-sessions: правящие шаги переехали внутрь слитых работ, и адрес
   * теперь пара «работа, идентификатор шага», а не работа целиком. Шаг ищется
   * по имени, а не по индексу: индекс сместится при первой же вставке
   * соседнего шага, и тест начнёт проверять не то, о чём написан.
   */
  const EDITING_STEPS = [
    ['build-a', 'write-code'],
    ['build-b', 'write-code'],
    ['review-fix-a', 'apply-fixes'],
    ['review-fix-b', 'apply-fixes'],
  ] as const;

  const editingStep = (pipelineJobs: ReturnType<typeof expandPipeline>['pipeline']['jobs'], jobId: string, stepId: string) => {
    const job = pipelineJobs.find((item) => item.id === jobId);
    assert.ok(job !== undefined, `работы ${jobId} нет в пайплайне петли`);
    const step = job.steps.find((item) => item.id === stepId);
    assert.ok(step !== undefined, `${jobId}: нет шага ${stepId}`);
    return step;
  };

  it('правящие шаги обеих дорожек несут прежние права в прежнем порядке', () => {
    const project = makeProject();
    const { pipeline } = expandPipeline({
      pipelinePath: join(ROOT, '.stepcast', 'pipelines', 'self-improve.yml'),
      config: project.config,
    });

    for (const [jobId, stepId] of EDITING_STEPS) {
      const step = editingStep(pipeline.jobs, jobId, stepId);
      assert.deepEqual(asAgent(step).permissions?.allow, EXPECTED_ALLOW, `${jobId}/${stepId}`);
    }
  });

  it('правящие шаги обеих дорожек несут прежний набор границ changed_only', () => {
    const project = makeProject();
    const { pipeline } = expandPipeline({
      pipelinePath: join(ROOT, '.stepcast', 'pipelines', 'self-improve.yml'),
      config: project.config,
    });

    for (const [jobId, stepId] of EDITING_STEPS) {
      const step = editingStep(pipeline.jobs, jobId, stepId);
      const predicate = step.expect.find((item) => item.kind === 'changed_only') as
        | { readonly globs: readonly string[] }
        | undefined;
      assert.ok(predicate !== undefined, `${jobId}/${stepId}: нет предиката changed_only`);
      assert.deepEqual(new Set(predicate.globs), EXPECTED_CHANGED_ONLY, `${jobId}/${stepId}`);
    }
  });
});

/**
 * Задача 4.11 (б): настоящие файлы работ петли, раскрытые против чужого
 * объявления `project.spec`, обязаны нести чужие пути и чужое имя
 * инструмента — а не сегодняшние `openspec/changes` и `openspec`, которые
 * дают только потому, что это объявление этого репозитория.
 */
describe('self-improvement-loop: настоящие файлы петли против чужого объявления', () => {
  function foreignPipeline(
    tools: readonly string[] = ['make'],
    editPaths: readonly string[] = ['cmd/**', 'internal/**', 'go.mod'],
  ): string {
    return `
kind: pipeline
name: foreign
project:
  check: "true"
  tools: [${tools.join(', ')}]
  spec:
    dir: docs/changes
    rules: docs/spec-rules.md
    tool: make
  edit_paths: [${editPaths.join(', ')}]
jobs:
  build-a:
    uses: ${JOBS_DIR}/build.yml
    with: { lane: a, change: demo-change }
  review-fix-a:
    uses: ${JOBS_DIR}/review-fix.yml
    with: { change: demo-change }
    needs: [build-a]
`;
  }

  function expandForeign(project: Project, tools?: readonly string[]) {
    project.write('stepcast.yml', foreignPipeline(tools));
    return expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }).pipeline;
  }

  type Pipeline = ReturnType<typeof expandForeign>;

  /**
   * merged-sessions: адрес правящего места — пара «работа, шаг», а не работа
   * целиком. Шаг ищется по идентификатору, а не по индексу: индекс сместится
   * при первой же вставке соседа, и проверка начнёт утверждать не то, о чём
   * написана.
   */
  function jobOf(pipeline: Pipeline, jobId: string) {
    const job = pipeline.jobs.find((item) => item.id === jobId);
    assert.ok(job !== undefined, `работы ${jobId} нет в пайплайне`);
    return job;
  }

  function step(pipeline: Pipeline, jobId: string, stepId: string) {
    const found = jobOf(pipeline, jobId).steps.find((item) => item.id === stepId);
    assert.ok(found !== undefined, `${jobId}: нет шага ${stepId}`);
    return found;
  }

  function changedOnlyGlobs(pipeline: Pipeline, jobId: string, stepId: string): readonly string[] {
    const predicate = step(pipeline, jobId, stepId).expect.find((item) => item.kind === 'changed_only') as
      | { readonly globs: readonly string[] }
      | undefined;
    assert.ok(predicate !== undefined, `${jobId}/${stepId}: нет предиката changed_only`);
    return predicate.globs;
  }

  /** Правящие места петли: где объявлены права инструментов и границы правок. */
  const EDITING = [
    ['build-a', 'write-code'],
    ['review-fix-a', 'apply-fixes'],
  ] as const;

  it('шаг заведения изменения: границы и право на инструмент называют чужие значения', () => {
    const pipeline = expandForeign(makeProject());
    const created = step(pipeline, 'build-a', 'create-change');

    assert.deepEqual(created.expect.find((item) => item.kind === 'changed_only'), {
      kind: 'changed_only',
      globs: ['docs/changes/**'],
    });
    assert.ok(asAgent(created).permissions?.allow?.includes('Bash(make *)'));
    // Файл правил переехал в контекст работы: общая сессия отправляет его один
    // раз на все три шага, а не по вставке в каждый.
    assert.deepEqual(jobOf(pipeline, 'build-a').context, [
      { kind: 'path', path: 'docs/spec-rules.md', mode: 'inline' },
    ]);
  });

  it('шаг планирования: путь контекста ведёт в чужой каталог документов', () => {
    const pipeline = expandForeign(makeProject());

    assert.deepEqual(step(pipeline, 'build-a', 'read-change').context, [
      { kind: 'path', path: 'docs/changes/demo-change/**/*.md', mode: 'auto', required: true },
    ]);
  });

  it('шаг реализации: контекст, границы и правила ведут в чужой каталог', () => {
    const pipeline = expandForeign(makeProject());

    assert.deepEqual(step(pipeline, 'build-a', 'write-code').context, [
      {
        kind: 'path',
        path: 'docs/changes/demo-change/**/*.md',
        mode: 'reference',
        required: true,
      },
    ]);
    const globs = changedOnlyGlobs(pipeline, 'build-a', 'write-code');
    assert.ok(globs.includes('docs/changes/**'));
    assert.ok(globs.includes('docs/spec-rules.md'));
  });

  it('работа ревью и правки: контекст ведёт в чужой каталог документов и к чужим правилам', () => {
    const pipeline = expandForeign(makeProject());

    assert.deepEqual(jobOf(pipeline, 'review-fix-a').context, [
      { kind: 'path', path: 'docs/changes/demo-change/**/*.md', mode: 'auto', required: true },
      { kind: 'path', path: 'docs/spec-rules.md', mode: 'inline' },
    ]);
  });

  it('шаг устранения находок: границы включают чужой каталог и чужие правила', () => {
    const pipeline = expandForeign(makeProject());
    const globs = changedOnlyGlobs(pipeline, 'review-fix-a', 'apply-fixes');

    assert.ok(globs.includes('docs/changes/**'));
    assert.ok(globs.includes('docs/spec-rules.md'));
  });

  // job-tools-declaration: правящие шаги читают инструменты чужим объявлением
  // (project.tools: [make]), а не тремя литералами этого репозитория — право
  // называет чужой инструмент, и ни одного из старых трёх среди прав нет.
  it('правящие шаги несут право Bash(make *) и ни одного из npm/npx/node', () => {
    const pipeline = expandForeign(makeProject());
    for (const [jobId, stepId] of EDITING) {
      const allow = asAgent(step(pipeline, jobId, stepId)).permissions?.allow ?? [];
      const where = `${jobId}/${stepId}`;
      assert.ok(allow.includes('Bash(make *)'), `${where}: нет Bash(make *)`);
      assert.ok(!allow.includes('Bash(npm *)'), `${where}: остался Bash(npm *)`);
      assert.ok(!allow.includes('Bash(npx *)'), `${where}: остался Bash(npx *)`);
      assert.ok(!allow.includes('Bash(node *)'), `${where}: остался Bash(node *)`);
    }
  });

  it('объявление нескольких инструментов даёт записи в объявленном порядке', () => {
    const pipeline = expandForeign(makeProject(), ['./gradlew', 'java']);
    for (const [jobId, stepId] of EDITING) {
      const allow = asAgent(step(pipeline, jobId, stepId)).permissions?.allow ?? [];
      const where = `${jobId}/${stepId}`;
      const gradlewIndex = allow.indexOf('Bash(./gradlew *)');
      const javaIndex = allow.indexOf('Bash(java *)');
      assert.ok(gradlewIndex !== -1 && javaIndex !== -1, `${where}: не нашлись оба права`);
      assert.ok(gradlewIndex < javaIndex, `${where}: порядок не совпадает с объявленным`);
    }
  });

  // changed-only-boundaries-declaration: implement и fix-review читают
  // раскладку чужим объявлением (project.edit_paths: [cmd/**, internal/**,
  // go.mod]), а не двенадцатью литералами этого репозитория — границы называют
  // чужой стек, ни одного из старых npm-шаблонов среди них нет, а каталог
  // документов изменения и файл правил остаются, потому что их объявляет
  // отдельный ключ (project.spec), не задетый этим объявлением.
  it('правящие шаги несут границы cmd/**, internal/**, go.mod и ни одной раскладки этого репозитория', () => {
    const REPO_LAYOUT = [
      'src/**',
      'test/**',
      'docs/**',
      'schema/**',
      'scripts/**',
      'ui/**',
      'package.json',
      'package-lock.json',
      'vite.config.ts',
      'eslint.config.js',
      'README.md',
      '.gitattributes',
    ];

    const pipeline = expandForeign(makeProject());
    for (const [jobId, stepId] of EDITING) {
      const globs = changedOnlyGlobs(pipeline, jobId, stepId);
      const where = `${jobId}/${stepId}`;
      assert.ok(globs.includes('cmd/**'), `${where}: нет cmd/**`);
      assert.ok(globs.includes('internal/**'), `${where}: нет internal/**`);
      assert.ok(globs.includes('go.mod'), `${where}: нет go.mod`);
      for (const pattern of REPO_LAYOUT) {
        assert.ok(!globs.includes(pattern), `${where}: остался шаблон этого репозитория ${pattern}`);
      }
      assert.ok(globs.includes('docs/changes/**'), `${where}: пропал каталог документов изменения`);
      assert.ok(globs.includes('docs/spec-rules.md'), `${where}: пропал файл правил`);
    }
  });

  // Устройство петли задаёт движок, а не репозиторий, поэтому записи
  // `.stepcast/**` остались в файлах работ литералами и в `project.edit_paths`
  // не переносятся: чужое объявление границ их не заменяет и не отменяет.
  // Косвенно это же сторожит сравнение с прежним набором на настоящем
  // пайплайне, но там свойство видно только через отсутствие записей в
  // `edit_paths` — здесь оно утверждается прямо.
  it('записи .stepcast/** остаются в границах и против чужого объявления', () => {
    const ENGINE_FILES = [
      '.stepcast/config.yml',
      '.stepcast/jobs/**',
      '.stepcast/pipelines/**',
      '.stepcast/prompts/**',
      '.stepcast/schemas/**',
    ];

    const pipeline = expandForeign(makeProject());
    for (const [jobId, stepId] of EDITING) {
      const globs = changedOnlyGlobs(pipeline, jobId, stepId);
      for (const pattern of ENGINE_FILES) {
        assert.ok(globs.includes(pattern), `${jobId}/${stepId}: пропала запись ${pattern}`);
      }
    }
  });
});

/**
 * Задача 4.11 (в): сквозной прогон петли на поддельном бэкенде в дереве без
 * каталога `openspec/` доходит до последней работы.
 *
 * Цепочка — обе агентские работы петли целиком (`build → review-fix`); из
 * обвязки выброшены `slots`, `merge` и `finalize`, занятые выбором пункта
 * очереди и сведением дорожек, устройством, не связанным с этим изменением.
 * Файл выбранного пункта (`${run.dir}/item-<дорожка>.json`, который в
 * настоящей петле пишет `slots`) подкладывает командный шаг `seed`: после
 * слияния работ заведение изменения — первый шаг `build`, и обойти его,
 * начав цепочку с планирования, больше нельзя.
 *
 * Пяти агентских шагов достаточно, чтобы доказать: чужое объявление
 * `project.spec` доезжает подстановкой через контекст, предикаты `cmd`
 * (командой `${project.check}` и командой инструмента практики), границы
 * `changed_only` и права — до самого конца, ни разу не споткнувшись о литерал
 * OpenSpec.
 *
 * `spec.tool: "true"` здесь, а не `make`: инструмент практики попал в
 * предикат шага и теперь исполняется, а не только раскрывается, — а `make` в
 * дереве проверок звать нечем. Статические проверки выше по-прежнему берут
 * `make` и стерегут именно раскрытие.
 */
describe('self-improvement-loop: сквозной прогон против чужого объявления', () => {
  const RUN_PIPELINE = `
kind: pipeline
name: foreign-run
project:
  check: "true"
  tools: [make]
  spec:
    dir: docs/changes
    rules: docs/spec-rules.md
    tool: "true"
  edit_paths: [cmd/**, internal/**, go.mod]
jobs:
  seed:
    steps:
      - id: write-item
        run: [sh, -c, 'echo demo-change > "$STEPCAST_RUN_DIR/item-a.json"']
  build-a:
    uses: ${JOBS_DIR}/build.yml
    with: { lane: a, change: demo-change }
    needs: [seed]
  review-fix-a:
    uses: ${JOBS_DIR}/review-fix.yml
    with: { change: demo-change }
    needs: [build-a]
`;

  /**
   * Чужое дерево: свой файл правил и каталог изменения из одного документа —
   * состав нарочно неполный, потому что практика допускает не заводить часть
   * документов, и работы петли обязаны это пережить.
   */
  function foreignTree(): Project {
    const project = makeProject({
      'stepcast.yml': RUN_PIPELINE,
      'docs/spec-rules.md': 'Документы изменения пишутся руками, проверяются `make spec`.\n',
      'docs/changes/demo-change/README.md': '# demo-change\n\nОписание изменения.\n',
    });
    return project;
  }

  it('доходит до последней работы в дереве без каталога openspec/', async () => {
    const project = foreignTree();

    const structuredByInvocation = [
      {
        slug: 'demo-change',
        change_dir: 'docs/changes/demo-change',
        artifacts: ['README.md'],
        summary: 'демонстрационное изменение',
      },
      { tasks: [{ id: 't1', title: 'demo', files: ['src/x.ts'], done_when: 'tests pass' }] },
      { changed_files: [], completed: ['t1'], remaining: [] },
      { findings: [] },
      { changed_files: [], completed: [], remaining: [] },
    ];
    const backend = createFakeBackend({
      lines: (index) => [initLine(), resultLine({ text: 'ок', structured: structuredByInvocation[index] })],
    });

    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
    const result = await runPipeline({
      expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
      config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
      adapterFor: () => backend.adapter,
    });

    assert.equal(result.status, 'success');
    const status = readStatus(result.journal.paths);
    assert.equal(status.jobs.find((job) => job.id === 'review-fix-a')?.status, 'success');
    assert.equal(backend.invocations.length, 5);

    // Документы изменения дошли до агента: глоб раскрылся в чужом каталоге, а
    // не остался пустым, — иначе успех цепочки ничего бы не доказывал. Второй
    // вызов, а не первый: первый — заведение изменения, и каталог документов
    // ему приходит не глобом, а файлом выбранного пункта.
    assert.match(backend.invocations[1]?.prompt ?? '', /docs\/changes\/demo-change\/README\.md/);
  });

  /**
   * Обратная сторона того же: пустой каталог изменения — это не «часть
   * документов не заведена», а несобранный контекст, и работа обязана
   * отказать, а не планировать по пустому месту. До `required: true` цепочка
   * из четырёх работ проходила в дереве, где каталога `docs/changes/` нет
   * вовсе.
   */
  it('пустой каталог изменения роняет шаг планирования, а не проходит молча', async () => {
    const project = makeProject({
      'stepcast.yml': RUN_PIPELINE,
      'docs/spec-rules.md': 'правила\n',
    });

    // Заведение изменения проходит: отказать обязан следующий шаг — тот, чей
    // контекст глобом ведёт в каталог, которого нет.
    const backend = createFakeBackend({
      lines: () => [
        initLine(),
        resultLine({
          text: 'ок',
          structured: {
            slug: 'demo-change',
            change_dir: 'docs/changes/demo-change',
            artifacts: ['README.md'],
            summary: 'демонстрационное изменение',
          },
        }),
      ],
    });

    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
    const result = await runPipeline({
      expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
      config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
      adapterFor: () => backend.adapter,
    });

    assert.notEqual(result.status, 'success');
    const status = readStatus(result.journal.paths);
    const build = status.jobs.find((job) => job.id === 'build-a');
    assert.equal(build?.status, 'failed');
    // Отказ именно на записи контекста, а не на чём-то попутном.
    assert.match(build?.reason ?? '', /docs\/changes\/demo-change/);
    // Ровно один агентский вызов — заведение изменения; планирование до
    // бэкенда не дошло.
    assert.equal(backend.invocations.length, 1);
  });

  // job-tools-declaration: implement и fix-review ссылаются на ${project.tools}
  // — объявление обязательно там, где на него ссылаются, и его отсутствие
  // роняет разбор раньше первого исполнения, а не проезжает мимо молча.
  it('пайплайн без объявления project.tools роняет разбор', () => {
    const project = makeProject({
      'stepcast.yml': RUN_PIPELINE.replace('  tools: [make]\n', ''),
      'docs/spec-rules.md': 'правила\n',
      'docs/changes/demo-change/README.md': '# demo-change\n',
    });

    assert.throws(
      () => expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
      (error: unknown) => {
        assert.match((error as Error).message ?? '', /project\.tools/);
        return true;
      },
    );
  });

  // changed-only-boundaries-declaration: implement и fix-review ссылаются на
  // ${project.edit_paths} — то же правило, что у project.tools: отсутствие
  // объявления роняет разбор до первого агентского вызова, а не запускает
  // петлю с границами наугад.
  it('пайплайн без объявления project.edit_paths роняет разбор до первого агентского вызова', () => {
    const project = makeProject({
      'stepcast.yml': RUN_PIPELINE.replace('  edit_paths: [cmd/**, internal/**, go.mod]\n', ''),
      'docs/spec-rules.md': 'правила\n',
      'docs/changes/demo-change/README.md': '# demo-change\n',
    });

    assert.throws(
      () => expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
      (error: unknown) => {
        assert.match((error as Error).message ?? '', /project\.edit_paths/);
        return true;
      },
    );
  });
});

/**
 * job-schema-path-portable: ни одна ссылка файла работы петли, разрешаемая от
 * файла объявления, не должна вести за пределы `.stepcast/` — иначе перенос
 * `.stepcast/jobs/` в чужой репозиторий требует правки внутри скопированных
 * файлов. `slots.yml` был последней ссылкой наружу (`../../schema/...`);
 * форма `stepcast:<имя>` резолвится от расположения движка, а не от файла
 * объявления, и на границу репозитория не выходит.
 *
 * `changed_only` и `context` в обход не входят: это не ссылки на файл рядом с
 * документом работы, а описание дерева репозитория, который петля правит
 * (границы правок и контекст, разрешаемый от корня рабочей директории) —
 * включение их запретило бы петле знать что-либо о правимом репозитории, а
 * не сузило бы проверку до настоящих ссылок.
 */
describe('self-improvement-loop: ссылки файлов работ петли не покидают .stepcast/', () => {
  const STEPCAST_DIR = join(ROOT, '.stepcast');

  interface DeclaredRef {
    readonly key: string;
    readonly value: string;
  }

  /** Записи предиката (`expect` либо `until.check`), несущие `schema`. */
  function collectPredicateSchemas(predicates: unknown, prefix: string, refs: DeclaredRef[]): void {
    for (const [index, predicate] of ((predicates as readonly { schema?: string }[]) ?? []).entries()) {
      if (typeof predicate?.schema === 'string') {
        refs.push({ key: `${prefix}.${index}.schema`, value: predicate.schema });
      }
    }
  }

  /** Значение промпта, если это ссылка на файл (`prompt: ok` — текст, а не путь). */
  function promptRef(prompt: unknown, key: string, refs: DeclaredRef[]): void {
    if (typeof prompt === 'string' && prompt.startsWith('file:')) {
      refs.push({ key, value: prompt.slice('file:'.length) });
    }
  }

  /** Все ссылки файла работы, разрешаемые от него самого: uses, оба prompt: file: и все три места схемы. */
  function collectRefs(document: unknown): DeclaredRef[] {
    const doc = document as {
      uses?: string;
      output?: { schema?: string };
      until?: { check?: unknown };
      steps?: readonly {
        output_schema?: string;
        prompt?: string;
        expect?: unknown;
        on_fail?: { prompt?: string };
      }[];
    };
    const refs: DeclaredRef[] = [];

    if (typeof doc.uses === 'string') refs.push({ key: 'uses', value: doc.uses });
    if (typeof doc.output?.schema === 'string') {
      refs.push({ key: 'output.schema', value: doc.output.schema });
    }
    if (doc.until?.check !== undefined) collectPredicateSchemas(doc.until.check, 'until.check', refs);

    for (const [index, step] of (doc.steps ?? []).entries()) {
      if (typeof step.output_schema === 'string') {
        refs.push({ key: `steps.${index}.output_schema`, value: step.output_schema });
      }
      promptRef(step.prompt, `steps.${index}.prompt`, refs);
      // Промпт разбора неудачи — такая же ссылка `file:`, разрешаемая от файла
      // объявления (`readPrompt` в expand.ts), что и промпт самого шага: работ
      // с `on_fail` в петле пока нет, но появившаяся ссылка наружу обязана
      // ронять проверку, а не проезжать мимо сторожа.
      promptRef(step.on_fail?.prompt, `steps.${index}.on_fail.prompt`, refs);
      if (step.expect !== undefined) collectPredicateSchemas(step.expect, `steps.${index}.expect`, refs);
    }

    return refs;
  }

  /** Ссылки документа работы, ведущие за пределы `.stepcast/`, — с местом объявления. */
  function outsideRefs(document: unknown, file: string): string[] {
    return collectRefs(document)
      .filter((ref) => {
        // Ссылка на схему пакета не выходит за пределы .stepcast/ по построению:
        // движок разрешает её от собственного расположения, а не от файла
        // работы, и файловую систему работы вовсе не затрагивает.
        if (ref.value.startsWith('stepcast:')) return false;

        const resolved = isAbsolute(ref.value) ? ref.value : resolvePath(dirname(file), ref.value);
        const rel = relativePath(STEPCAST_DIR, resolved);
        return rel === '' || rel.startsWith('..') || isAbsolute(rel);
      })
      .map((ref) => `${file}: ${ref.key} = ${ref.value}`);
  }

  it('каждая ссылка uses, prompt: file: и объявленная схема разрешается внутрь .stepcast/', () => {
    const files = jobFiles();
    assert.ok(files.length > 0, `в ${JOBS_DIR} не найдено ни одного файла работы`);

    for (const file of files) {
      assert.deepEqual(outsideRefs(parseYaml(readFileSync(file, 'utf8')), file), []);
    }
  });

  /**
   * Сам сторож: работ с `on_fail` в петле сегодня нет, и обход настоящих файлов
   * о его ссылке ничего не сказал бы — ни когда она внутри, ни когда наружу.
   * Здесь проверяется, что ссылка каждого из четырёх видов, выведенная наружу,
   * обходом ловится и называется ключом объявления.
   */
  it('ссылку наружу ловит и называет — в uses, в обоих prompt: file: и в схеме', () => {
    const file = join(JOBS_DIR, 'probe.yml');
    const document = parseYaml(`
kind: job
name: probe
uses: ../../other/base.yml
output:
  schema: ../../schema/backlog-slots.schema.json
steps:
  - id: think
    agent: claude
    prompt: file:../../prompts/think.md
    on_fail:
      analyze: почему
      prompt: file:../../prompts/analyze.md
    expect:
      - schema: ../../schema/backlog-slots.schema.json
`);

    assert.deepEqual(outsideRefs(document, file), [
      `${file}: uses = ../../other/base.yml`,
      `${file}: output.schema = ../../schema/backlog-slots.schema.json`,
      `${file}: steps.0.prompt = ../../prompts/think.md`,
      `${file}: steps.0.on_fail.prompt = ../../prompts/analyze.md`,
      `${file}: steps.0.expect.0.schema = ../../schema/backlog-slots.schema.json`,
    ]);
  });

  it('те же ссылки внутри .stepcast/ и форма stepcast: наружу не считаются', () => {
    const file = join(JOBS_DIR, 'probe.yml');
    const document = parseYaml(`
kind: job
name: probe
output:
  schema: stepcast:backlog-slots
steps:
  - id: think
    agent: claude
    prompt: file:../prompts/think.md
    on_fail:
      analyze: почему
      prompt: file:../prompts/analyze.md
    expect:
      - schema: stepcast:backlog-slots
`);

    assert.deepEqual(outsideRefs(document, file), []);
  });
});

/**
 * job-schema-path-portable: обход выше доказывает, что ссылка не выходит за
 * `.stepcast/`; он не доказывает, что `stepcast:backlog-slots` в чужом дереве
 * во что-то разрешается. Здесь — настоящий `slots.yml`, скопированный (не
 * подключённый по абсолютному пути — тот всегда лежит рядом с настоящим
 * `schema/` этого репозитория и ничего бы не доказал) в проект, где каталога
 * `schema/` нет вовсе, и подключённый оттуда пайплайном.
 */
describe('self-improvement-loop: работа slots раскрывается в дереве без schema/', () => {
  it('output.schema ведёт в схему пакета, существующую и читаемую как JSON', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
name: probe
jobs:
  slots:
    uses: ./.stepcast/jobs/slots.yml
`,
      '.stepcast/jobs/slots.yml': readFileSync(join(JOBS_DIR, 'slots.yml'), 'utf8'),
    });

    const { pipeline } = expandPipeline({
      pipelinePath: project.path('stepcast.yml'),
      config: project.config,
    });

    const schemaPath = pipeline.jobs.find((job) => job.id === 'slots')?.output?.schemaPath;
    assert.ok(schemaPath !== undefined, 'output.schema не разрешился');
    assert.ok(existsSync(schemaPath), `схема не найдена: ${schemaPath}`);
    assert.doesNotThrow(() => JSON.parse(readFileSync(schemaPath, 'utf8')));
  });
});
