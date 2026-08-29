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

  it('implement и fix-review обеих дорожек несут прежние права в прежнем порядке', () => {
    const project = makeProject();
    const { pipeline } = expandPipeline({
      pipelinePath: join(ROOT, '.stepcast', 'pipelines', 'self-improve.yml'),
      config: project.config,
    });

    for (const id of ['implement-a', 'implement-b', 'fix-review-a', 'fix-review-b']) {
      const job = pipeline.jobs.find((item) => item.id === id);
      assert.ok(job !== undefined, `работы ${id} нет в пайплайне петли`);
      assert.deepEqual(asAgent(job.steps[0]!).permissions?.allow, EXPECTED_ALLOW, id);
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
  function foreignPipeline(tools: readonly string[] = ['make']): string {
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
jobs:
  propose-a:
    uses: ${JOBS_DIR}/propose.yml
    with: { lane: a }
  plan-a:
    uses: ${JOBS_DIR}/plan.yml
    with: { change: demo-change }
    needs: [propose-a]
  implement-a:
    uses: ${JOBS_DIR}/implement.yml
    with: { change: demo-change, lane: a }
    needs: [plan-a]
  review-a:
    uses: ${JOBS_DIR}/review.yml
    with: { change: demo-change }
    needs: [implement-a]
  fix-review-a:
    uses: ${JOBS_DIR}/fix-review.yml
    with: { change: demo-change }
    needs: [review-a]
`;
  }

  function expandForeign(project: Project, tools?: readonly string[]) {
    project.write('stepcast.yml', foreignPipeline(tools));
    return expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }).pipeline;
  }

  it('propose-a: границы и право на инструмент называют чужие значения', () => {
    const pipeline = expandForeign(makeProject());
    const job = pipeline.jobs.find((item) => item.id === 'propose-a')!;
    const step = asAgent(job.steps[0]!);

    assert.deepEqual(
      job.steps[0]!.expect.find((item) => item.kind === 'changed_only'),
      { kind: 'changed_only', globs: ['docs/changes/**'] },
    );
    assert.ok(step.permissions?.allow?.includes('Bash(make *)'));
    assert.deepEqual(
      step.context.find((entry) => entry.kind === 'path' && entry.path === 'docs/spec-rules.md'),
      { kind: 'path', path: 'docs/spec-rules.md', mode: 'inline' },
    );
  });

  it('plan-a: путь контекста ведёт в чужой каталог документов', () => {
    const pipeline = expandForeign(makeProject());
    const job = pipeline.jobs.find((item) => item.id === 'plan-a')!;

    assert.deepEqual(job.context, [
      { kind: 'path', path: 'docs/changes/demo-change/**/*.md', mode: 'auto', required: true },
    ]);
  });

  it('implement-a: контекст, границы и правила ведут в чужой каталог', () => {
    const pipeline = expandForeign(makeProject());
    const job = pipeline.jobs.find((item) => item.id === 'implement-a')!;

    assert.deepEqual(job.context, [
      {
        kind: 'path',
        path: 'docs/changes/demo-change/**/*.md',
        mode: 'reference',
        required: true,
      },
      { kind: 'path', path: 'docs/spec-rules.md', mode: 'inline' },
    ]);
    const globs = (
      job.steps[0]!.expect.find((item) => item.kind === 'changed_only') as { globs: readonly string[] }
    ).globs;
    assert.ok(globs.includes('docs/changes/**'));
    assert.ok(globs.includes('docs/spec-rules.md'));
  });

  it('review-a: путь контекста ведёт в чужой каталог документов', () => {
    const pipeline = expandForeign(makeProject());
    const job = pipeline.jobs.find((item) => item.id === 'review-a')!;

    assert.deepEqual(job.context, [
      { kind: 'path', path: 'docs/changes/demo-change/**/*.md', mode: 'auto', required: true },
    ]);
  });

  it('fix-review-a: границы включают чужой каталог и чужие правила', () => {
    const pipeline = expandForeign(makeProject());
    const job = pipeline.jobs.find((item) => item.id === 'fix-review-a')!;

    assert.deepEqual(job.context, [
      { kind: 'path', path: 'docs/spec-rules.md', mode: 'inline' },
    ]);
    const globs = (
      job.steps[0]!.expect.find((item) => item.kind === 'changed_only') as { globs: readonly string[] }
    ).globs;
    assert.ok(globs.includes('docs/changes/**'));
    assert.ok(globs.includes('docs/spec-rules.md'));
  });

  // job-tools-declaration: implement и fix-review читают инструменты чужим
  // объявлением (project.tools: [make]), а не тремя литералами этого
  // репозитория — право называет чужой инструмент, и ни одного из старых
  // трёх среди прав нет.
  it('implement-a и fix-review-a несут право Bash(make *) и ни одного из npm/npx/node', () => {
    const pipeline = expandForeign(makeProject());
    for (const id of ['implement-a', 'fix-review-a']) {
      const job = pipeline.jobs.find((item) => item.id === id)!;
      const allow = asAgent(job.steps[0]!).permissions?.allow ?? [];
      assert.ok(allow.includes('Bash(make *)'), `${id}: нет Bash(make *)`);
      assert.ok(!allow.includes('Bash(npm *)'), `${id}: остался Bash(npm *)`);
      assert.ok(!allow.includes('Bash(npx *)'), `${id}: остался Bash(npx *)`);
      assert.ok(!allow.includes('Bash(node *)'), `${id}: остался Bash(node *)`);
    }
  });

  it('объявление нескольких инструментов даёт записи в объявленном порядке', () => {
    const pipeline = expandForeign(makeProject(), ['./gradlew', 'java']);
    for (const id of ['implement-a', 'fix-review-a']) {
      const job = pipeline.jobs.find((item) => item.id === id)!;
      const allow = asAgent(job.steps[0]!).permissions?.allow ?? [];
      const gradlewIndex = allow.indexOf('Bash(./gradlew *)');
      const javaIndex = allow.indexOf('Bash(java *)');
      assert.ok(gradlewIndex !== -1 && javaIndex !== -1, `${id}: не нашлись оба права`);
      assert.ok(gradlewIndex < javaIndex, `${id}: порядок не совпадает с объявленным`);
    }
  });
});

/**
 * Задача 4.11 (в): сквозной прогон петли на поддельном бэкенде в дереве без
 * каталога `openspec/` доходит до последней работы.
 *
 * Цепочка сокращена до `plan → implement → review → fix-review` — работы
 * `propose`, `slots`, `merge` и `finalize` заняты выбором пункта очереди и
 * сведением дорожек, устройством, не связанным с этим изменением (у `propose`
 * есть свой файл `${run.dir}/item-<дорожка>.json`, который в настоящей петле
 * пишет `slots`). Четырёх оставшихся работ достаточно, чтобы доказать: чужое
 * объявление `project.spec` доезжает подстановкой через контекст, цикл
 * `until` (командой `${project.check}`), границы `changed_only` и права —
 * до самого конца, ни разу не споткнувшись о литерал OpenSpec.
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
    tool: make
jobs:
  plan-a:
    uses: ${JOBS_DIR}/plan.yml
    with: { change: demo-change }
  implement-a:
    uses: ${JOBS_DIR}/implement.yml
    with: { change: demo-change, lane: a }
    needs: [plan-a]
  review-a:
    uses: ${JOBS_DIR}/review.yml
    with: { change: demo-change }
    needs: [implement-a]
  fix-review-a:
    uses: ${JOBS_DIR}/fix-review.yml
    with: { change: demo-change }
    needs: [review-a]
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
    assert.equal(status.jobs.find((job) => job.id === 'fix-review-a')?.status, 'success');
    assert.equal(backend.invocations.length, 4);

    // Документы изменения дошли до агента: глоб раскрылся в чужом каталоге, а
    // не остался пустым, — иначе успех цепочки ничего бы не доказывал.
    assert.match(backend.invocations[0]?.prompt ?? '', /docs\/changes\/demo-change\/README\.md/);
  });

  /**
   * Обратная сторона того же: пустой каталог изменения — это не «часть
   * документов не заведена», а несобранный контекст, и работа обязана
   * отказать, а не планировать по пустому месту. До `required: true` цепочка
   * из четырёх работ проходила в дереве, где каталога `docs/changes/` нет
   * вовсе.
   */
  it('пустой каталог изменения роняет первую же работу, а не проходит молча', async () => {
    const project = makeProject({
      'stepcast.yml': RUN_PIPELINE,
      'docs/spec-rules.md': 'правила\n',
    });

    const backend = createFakeBackend({
      lines: () => [initLine(), resultLine({ text: 'ок', structured: { tasks: [] } })],
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
    const plan = status.jobs.find((job) => job.id === 'plan-a');
    assert.equal(plan?.status, 'failed');
    // Отказ именно на записи контекста, а не на чём-то попутном.
    assert.match(plan?.reason ?? '', /docs\/changes\/demo-change/);
    assert.equal(backend.invocations.length, 0);
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
