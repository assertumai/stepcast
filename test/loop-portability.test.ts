import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  ];

  function filesIn(dir: string, suffix: string): string[] {
    return readdirSync(dir)
      .filter((name) => name.endsWith(suffix))
      .map((name) => join(dir, name));
  }

  it('файлы работ петли не называют OpenSpec и его документы', () => {
    for (const file of filesIn(JOBS_DIR, '.yml')) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of FORBIDDEN) {
        assert.doesNotMatch(text, pattern, `${file} содержит ${pattern}`);
      }
    }
  });

  it('промпты петли, кроме файла правил, не называют OpenSpec и его документы', () => {
    for (const file of filesIn(PROMPTS_DIR, '.md')) {
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
 * Задача 4.11 (б): настоящие файлы работ петли, раскрытые против чужого
 * объявления `project.spec`, обязаны нести чужие пути и чужое имя
 * инструмента — а не сегодняшние `openspec/changes` и `openspec`, которые
 * дают только потому, что это объявление этого репозитория.
 */
describe('self-improvement-loop: настоящие файлы петли против чужого объявления', () => {
  function foreignPipeline(): string {
    return `
kind: pipeline
name: foreign
project:
  check: "true"
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

  function expandForeign(project: Project) {
    project.write('stepcast.yml', foreignPipeline());
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
});
