import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { expandPipeline } from '../src/parts/pipeline/document/expand.js';
import { resolveLate, type LateScope } from '../src/parts/pipeline/document/late.js';
import { runPipeline, type RunResult } from '../src/parts/pipeline/run/runner.js';
import { jobScratchDir } from '../src/parts/pipeline/run/journal/paths.js';
import { readStatus } from '../src/parts/pipeline/run/journal/reader.js';
import { asAgent, asRun, asScript, makeProject, type Project } from './helpers.js';
import type { Job } from '../src/parts/pipeline/document/model.js';
import { tempDir } from './tmp.js';

const SCOPE: LateScope = {
  jobs: {
    // `files` и `nothing` — списки строк: выход работы это произвольный JSON,
    // и строковый массив в нём обычен (собственный `implement` этой петли
    // отдаёт `changed_files`). Правило размножения элемента списка на них
    // распространяться не должно — см. тесты ниже.
    plan: {
      status: 'success',
      output: { slug: 'add-oauth', count: 3, files: ['src/a.ts', 'src/b.ts'], nothing: [] },
    },
    empty: { status: 'success' },
    broken: { status: 'failed' },
  },
  run: { id: 'run-1', dir: '/runs/run-1', workspace: '/work', scratch: '/runs/run-1/jobs/probe/scratch' },
  env: { NODE_ENV: 'test' },
};

/** Раскрыть первую работу пайплайна, собранного из переданного текста. */
function expandJob(document: string): Job {
  const project = makeProject({ 'stepcast.yml': document });
  const { pipeline } = expandPipeline({
    pipelinePath: project.path('stepcast.yml'),
    config: project.config,
  });
  return pipeline.jobs[0] as Job;
}

function pipelineWith(body: string): string {
  return `
version: 1
kind: pipeline
name: probe
jobs:
  probe:
${body}
`;
}

describe('раскрытие отложенных подстановок', () => {
  it('раскрывает путь контекста', () => {
    const job = expandJob(
      pipelineWith(`    context:
      - changes/\${jobs.plan.output.slug}/proposal.md
    steps:
      - id: think
        agent: claude
        prompt: ok`),
    );

    const entry = resolveLate(job, SCOPE).context[0];
    assert.equal(entry?.kind === 'path' ? entry.path : undefined, 'changes/add-oauth/proposal.md');
  });

  it('раскрывает текст промпта', () => {
    const job = expandJob(
      pipelineWith(`    steps:
      - id: think
        agent: claude
        prompt: "изменение \${jobs.plan.output.slug} в прогоне \${run.id}"`),
    );

    assert.equal(
      asAgent(resolveLate(job, SCOPE).steps[0] as never).prompt,
      'изменение add-oauth в прогоне run-1',
    );
  });

  // Задача 3.2: черновики агента должны идти в каталог, объявленный движком,
  // а не в системный временный (заход 616c1b), и промпт — тот текст, из
  // которого агент узнаёт этот путь.
  it('раскрывает ${run.scratch} в тексте промпта', () => {
    const job = expandJob(
      pipelineWith(`    steps:
      - id: think
        agent: claude
        prompt: "черновики клади в \${run.scratch}"`),
    );

    assert.equal(
      asAgent(resolveLate(job, SCOPE).steps[0] as never).prompt,
      'черновики клади в /runs/run-1/jobs/probe/scratch',
    );
  });

  it('раскрывает ${run.scratch} в пути контекста', () => {
    const job = expandJob(
      pipelineWith(`    context:
      - \${run.scratch}/заметка.md
    steps:
      - id: think
        agent: claude
        prompt: ok`),
    );

    const entry = resolveLate(job, SCOPE).context[0];
    assert.equal(
      entry?.kind === 'path' ? entry.path : undefined,
      '/runs/run-1/jobs/probe/scratch/заметка.md',
    );
  });

  it('раскрывает аргументы командного шага', () => {
    const job = expandJob(
      pipelineWith(`    steps:
      - id: show
        run: [echo, "\${run.dir}/item.json"]`),
    );

    assert.deepEqual(asRun(resolveLate(job, SCOPE).steps[0] as never).command, [
      'echo',
      '/runs/run-1/item.json',
    ]);
  });

  it('раскрывает ${run.scratch} в аргументе командного шага', () => {
    const job = expandJob(
      pipelineWith(`    steps:
      - id: show
        run: [echo, "\${run.scratch}/черновик.txt"]`),
    );

    assert.deepEqual(asRun(resolveLate(job, SCOPE).steps[0] as never).command, [
      'echo',
      '/runs/run-1/jobs/probe/scratch/черновик.txt',
    ]);
  });

  it('раскрывает значение env и рабочую директорию', () => {
    const job = expandJob(
      pipelineWith(`    env:
      SLUG: \${jobs.plan.output.slug}
      WORK: \${run.workspace}
    steps:
      - id: show
        run: [echo, ok]`),
    );

    const resolved = resolveLate(job, SCOPE);
    assert.equal(resolved.env.SLUG, 'add-oauth');
    assert.equal(resolved.env.WORK, '/work');
  });

  it('раскрывает числовое поле выхода как строку', () => {
    const job = expandJob(
      pipelineWith(`    steps:
      - id: show
        run: [echo, "\${jobs.plan.output.count}"]`),
    );

    assert.deepEqual(asRun(resolveLate(job, SCOPE).steps[0] as never).command, ['echo', '3']);
  });

  it('оставляет экранированное как литерал', () => {
    const job = expandJob(
      pipelineWith(`    steps:
      - id: show
        run: [echo, "$\${jobs.plan.output.slug}"]`),
    );

    // Экранирование снимается разбором документа; поздний проход обязан
    // оставить полученный литерал в покое, иначе он истолкует его подстановкой.
    assert.deepEqual(asRun(resolveLate(job, SCOPE).steps[0] as never).command, [
      'echo',
      '${jobs.plan.output.slug}',
    ]);
  });

  // Спека pipeline-definition: «Ссылка на несуществующую работу отклоняется»,
  // сценарий «Экранированное выражение» — вторая половина: линт молчит, а в
  // отправленном тексте остаётся литерал, а не значение.
  it('оставляет экранированное в файле промпта литералом в отправленном тексте', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  probe:
    steps:
      - id: think
        agent: claude
        prompt: "file:./prompt.md"
`,
      'prompt.md': 'Литерал: $${jobs.plan.output.slug}\n',
    });
    const { pipeline } = expandPipeline({
      pipelinePath: project.path('stepcast.yml'),
      config: project.config,
    });

    const text = asAgent(resolveLate(pipeline.jobs[0] as Job, SCOPE).steps[0] as never).prompt;
    assert.match(text, /Литерал: \$\{jobs\.plan\.output\.slug\}/);
    assert.doesNotMatch(text, /add-oauth/);
  });

  it('отказывает при обращении к незавершённой работе', () => {
    const job = expandJob(
      pipelineWith(`    steps:
      - id: show
        run: [echo, "\${jobs.later.output.slug}"]`),
    );

    assert.throws(
      () => resolveLate(job, SCOPE),
      (error: Error & { hint?: string }) =>
        /jobs\.later\.output\.slug/.test(error.message) && /не завершилась/.test(error.hint ?? ''),
    );
  });

  it('отказывает при обращении к выходу упавшей работы', () => {
    const job = expandJob(
      pipelineWith(`    steps:
      - id: show
        run: [echo, "\${jobs.broken.output.slug}"]`),
    );

    assert.throws(
      () => resolveLate(job, SCOPE),
      (error: Error & { hint?: string }) => /упавшей работы не публикуется/.test(error.hint ?? ''),
    );
  });

  it('отказывает, когда работа выхода не публикует', () => {
    const job = expandJob(
      pipelineWith(`    steps:
      - id: show
        run: [echo, "\${jobs.empty.output.slug}"]`),
    );

    assert.throws(
      () => resolveLate(job, SCOPE),
      (error: Error & { hint?: string }) => /выхода не публикует/.test(error.hint ?? ''),
    );
  });

  /**
   * nested-repo-tools: размножение элемента списка действует и на позднем
   * раскрытии — иначе перечень, посчитанный работой (инструменты репозитория,
   * который выбрал пункт очереди), в элемент `allow` не попадает ничем.
   */
  it('строковый массив из выхода работы размножает элемент списка', () => {
    const job = expandJob(
      pipelineWith(`    steps:
      - id: show
        run: [echo, "\${jobs.plan.output.files}"]`),
    );

    const resolved = resolveLate(job, SCOPE);
    const step = resolved.steps[0] as { readonly command: readonly string[] };
    assert.deepEqual(step.command, ['echo', 'src/a.ts', 'src/b.ts']);
  });

  it('строковый массив из выхода работы вне списка остаётся непредставимым строкой', () => {
    const job = expandJob(
      pipelineWith(`    steps:
      - id: show
        run: echo "\${jobs.plan.output.files}"`),
    );

    assert.throws(
      () => resolveLate(job, SCOPE),
      (error: Error & { hint?: string }) => {
        assert.match(error.message, /непредставимое строкой/);
        assert.match(error.hint ?? '', /элементе списка/);
        return true;
      },
    );
  });

  it('пустой массив из выхода работы элемент списка не удаляет, а роняет раскрытие', () => {
    const job = expandJob(
      pipelineWith(`    steps:
      - id: show
        run: [echo, "\${jobs.plan.output.nothing}"]`),
    );

    assert.throws(
      () => resolveLate(job, SCOPE),
      (error: Error & { hint?: string }) => /даёт пустой список/.test(error.message),
    );
  });

  /**
   * `input` шага `script` раскрывается отдельным типизированным проходом
   * (`late.ts`, `omitInput`): общий обход отдал бы объект строкой. Проход
   * возвращает значения по индексу шага — потому среди тестов есть работа с
   * несколькими шагами, где перепутанный индекс виден.
   */
  it('объект из выхода работы уезжает в input объектом', () => {
    const scope: LateScope = {
      ...SCOPE,
      jobs: {
        ...SCOPE.jobs,
        plan: { status: 'success', output: { item: { slug: 'add-oauth', repos: ['ui'] } } },
      },
    };
    const job = expandJob(
      pipelineWith(`    steps:
      - id: work
        script: work.mjs
        input:
          item: \${jobs.plan.output.item}`),
    );

    assert.deepEqual(asScript(resolveLate(job, scope).steps[0] as never).input, {
      item: { slug: 'add-oauth', repos: ['ui'] },
    });
  });

  it('число из выхода работы уезжает в input числом, а смешанная строка — строкой', () => {
    const job = expandJob(
      pipelineWith(`    steps:
      - id: work
        script: work.mjs
        input:
          count: \${jobs.plan.output.count}
          title: "чинить \${jobs.plan.output.slug}"
          list: ["\${jobs.plan.output.files}"]`),
    );

    assert.deepEqual(asScript(resolveLate(job, SCOPE).steps[0] as never).input, {
      count: 3,
      title: 'чинить add-oauth',
      list: [['src/a.ts', 'src/b.ts']],
    });
  });

  it('каждый шаг script получает свой input, а прочие шаги раскрываются как прежде', () => {
    const job = expandJob(
      pipelineWith(`    steps:
      - id: first
        script: first.mjs
        input:
          slug: \${jobs.plan.output.slug}
      - id: middle
        run: [echo, "\${jobs.plan.output.count}"]
      - id: last
        script: last.mjs
        input:
          count: \${jobs.plan.output.count}`),
    );

    const resolved = resolveLate(job, SCOPE);
    assert.deepEqual(asScript(resolved.steps[0] as never).input, { slug: 'add-oauth' });
    assert.deepEqual(asRun(resolved.steps[1] as never).command, ['echo', '3']);
    assert.deepEqual(asScript(resolved.steps[2] as never).input, { count: 3 });
  });

  it('отказывает на имени вне состава run', () => {
    const job = expandJob(
      pipelineWith(`    steps:
      - id: show
        run: [echo, "\${run.step_dir}"]`),
    );

    assert.throws(
      () => resolveLate(job, SCOPE),
      (error: Error & { hint?: string }) =>
        /STEPCAST_STEP_DIR/.test(error.hint ?? '') && /id, dir, workspace, scratch/.test(error.hint ?? ''),
    );
  });
});

async function run(project: Project): Promise<RunResult> {
  const runsRoot = tempDir('runs-');
  return runPipeline({
    expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
    config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
    projectRoot: project.root,
    cwd: project.root,
  });
}

describe('раскрытие отложенных подстановок в прогоне', () => {
  it('вторая работа получает исход первой', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: cross
workspace: { mode: cwd }
jobs:
  first:
    steps:
      - id: noop
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
  second:
    needs: [first]
    steps:
      - id: show
        run: [sh, -c, 'echo "\${jobs.first.status}" > seen.txt']
        expect: [{ exit_code: 0 }]
`,
    });

    const result = await run(project);

    assert.equal(result.status, 'success');
    assert.equal(readFileSync(project.path('seen.txt'), 'utf8').trim(), 'success');
  });

  // Подстановка в `id` шага схемой не запрещена, и такой пайплайн исполнялся
  // всегда. Ключ шага считается от нераскрытого определения, и соответствие
  // раскрытого шага нераскрытому здесь единственно возможное — позиционное:
  // по идентификатору эти два шага не совпадают между собой.
  it('исполняет шаг, идентификатор которого сам содержит подстановку', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: id-substitution
workspace: { mode: cwd }
jobs:
  only:
    env:
      ИМЯ: печать
    steps:
      - id: "шаг-\${env.ИМЯ}"
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
`,
    });

    const result = await run(project);

    assert.equal(result.status, 'success');
    const record = readStatus(result.journal.paths).jobs[0]?.steps[0];
    assert.equal(record?.id, 'шаг-печать');
    assert.equal(typeof record?.key, 'string');
  });

  it('раскрытое определение работы попадает в журнал', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: journalled
workspace: { mode: cwd }
jobs:
  only:
    steps:
      - id: show
        run: [echo, "\${run.id}"]
        expect: [{ exit_code: 0 }]
`,
    });

    const result = await run(project);
    const resolved = JSON.parse(
      readFileSync(join(result.journal.paths.dir, 'jobs', 'only', 'resolved.json'), 'utf8'),
    ) as Job;

    assert.deepEqual(asRun(resolved.steps[0] as never).command, [
      'echo',
      result.journal.paths.runId,
    ]);
  });

  it('${run.scratch} в прогоне раскрывается в каталог черновиков работы', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: scratch-late
workspace: { mode: cwd }
jobs:
  only:
    steps:
      - id: show
        run: [echo, "\${run.scratch}"]
        expect: [{ exit_code: 0 }]
`,
    });

    const result = await run(project);
    const resolved = JSON.parse(
      readFileSync(join(result.journal.paths.dir, 'jobs', 'only', 'resolved.json'), 'utf8'),
    ) as Job;

    assert.deepEqual(asRun(resolved.steps[0] as never).command, [
      'echo',
      jobScratchDir(result.journal.paths, 'only'),
    ]);
  });

  it('работа с until раскрывается один раз и одинаково на всех итерациях', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: looped
workspace: { mode: cwd }
jobs:
  looped:
    until:
      max_iterations: 2
      check:
        - cmd: 'false'
    steps:
      - id: append
        run: [sh, -c, 'echo "\${run.id}" >> seen.txt']
        expect: [{ exit_code: 0 }]
`,
    });

    const result = await run(project);
    const lines = readFileSync(project.path('seen.txt'), 'utf8').trim().split('\n');

    // Обе итерации видят одно значение: работы-предшественники завершились до
    // начала этой, каталог прогона постоянен, и раскрывать заново нечего.
    assert.equal(lines.length, 2);
    assert.deepEqual(lines, [result.journal.paths.runId, result.journal.paths.runId]);
  });

  it('обращение к невыполнявшейся работе роняет работу, а не прогон', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: missing
workspace: { mode: cwd }
fail_fast: false
jobs:
  broken:
    steps:
      - id: show
        run: [echo, "\${jobs.nowhere.output.slug}"]
        expect: [{ exit_code: 0 }]
  after:
    needs: all
    on: always
    steps:
      - id: mark
        run: [sh, -c, 'echo done > after.txt']
        expect: [{ exit_code: 0 }]
`,
    });

    const result = await run(project);
    const status = readStatus(result.journal.paths);

    assert.equal(result.status, 'failed');
    assert.equal(status?.jobs.find((job) => job.id === 'broken')?.status, 'failed');
    // Работа-разбор обязана отработать: отказ подстановки — обычный отказ
    // работы, а не крушение прогона.
    assert.equal(readFileSync(project.path('after.txt'), 'utf8').trim(), 'done');
  });
});

/**
 * `with` шага `uses` — та же `ScriptStep.input`, что и у шага `script`
 * (design.md изменения reusable-steps, решение 1): собран вручную, минуя
 * файловую систему и `expandPipeline`, чтобы проверить ровно то, что
 * `resolveLate` не отличает происхождение шага — общий проход
 * `omitLateSkipped` уже обслуживает оба случая одним кодом.
 *
 * Шаг собран так, как его собирает раскрытие: `uses.params` — **та же**
 * величина, что и `input` (`expand.ts` кладёт в `input` сведённый `with`), и
 * рядом лежит схема параметров манифеста. Обе они обязаны пережить общий
 * обход: вторая копия нераскрытых значений упала бы на объекте, а схема — на
 * литеральном `${` в описании параметра.
 */
describe('раскрытие отложенных подстановок в with шага uses', () => {
  function usesJob(input: Record<string, unknown>, paramsSchema?: Record<string, unknown>): Job {
    return {
      id: 'build',
      source: '/fake/stepcast.yml',
      needs: [],
      on: 'success',
      session: 'per_step',
      workspace: { mode: 'cwd' },
      env: {},
      context: [],
      contextUpstream: 'all',
      inputs: [],
      data: [],
      steps: [
        {
          kind: 'script',
          id: 'c',
          index: 1,
          env: {},
          context: [],
          contextInherit: true,
          contextExclude: [],
          timeoutMs: 60_000,
          expect: [],
          attempts: { max: 1, escalation: [] },
          path: '/abs/main.mjs',
          args: [],
          input,
          uses: {
            name: 'echo-input',
            layer: 'project',
            manifestPath: '/abs/.stepcast/steps/echo-input/step.yml',
            manifestFingerprint: 'a1b2c3d4',
            // Та же величина, что и `input`, — ровно как её кладёт раскрытие.
            params: input,
            ...(paramsSchema === undefined ? {} : { paramsSchema }),
          },
        },
      ],
    };
  }

  /** Раскрытые `input` шага и `params` его блока `uses` — одно и то же. */
  function resolvedWith(job: Job): unknown {
    const step = resolveLate(job, SCOPE).steps[0] as {
      readonly input: unknown;
      readonly uses: { readonly params: unknown };
    };
    assert.deepEqual(step.uses.params, step.input, 'params блока uses разошлись с input шага');
    return step.input;
  }

  it('${jobs.plan.output} даёт объект целиком', () => {
    assert.deepEqual(resolvedWith(usesJob({ item: '${jobs.plan.output}' })), {
      item: SCOPE.jobs.plan!.output as unknown,
    });
  });

  it('${jobs.*} списком строк тоже доезжает списком, а не строкой', () => {
    assert.deepEqual(resolvedWith(usesJob({ files: '${jobs.plan.output.files}' })), {
      files: (SCOPE.jobs.plan!.output as Record<string, unknown>).files as unknown,
    });
  });

  it('${run.*} и ${env.*} раскрываются', () => {
    assert.deepEqual(resolvedWith(usesJob({ dir: '${run.dir}', env: '${env.NODE_ENV}' })), {
      dir: SCOPE.run.dir,
      env: SCOPE.env.NODE_ENV,
    });
  });

  it('строка с подстановкой внутри текста даёт строку', () => {
    assert.deepEqual(resolvedWith(usesJob({ title: 'план: ${jobs.plan.output.slug}' })), {
      title: `план: ${(SCOPE.jobs.plan!.output as Record<string, unknown>).slug as string}`,
    });
  });

  it('схема параметров манифеста проходит раскрытие нетронутой', () => {
    // `${` в описании и в шаблоне параметра — литерал автора манифеста, а не
    // подстановка: раскрытие о нём ничего не знает и знать не должно.
    const paramsSchema = {
      type: 'object',
      properties: {
        item: { type: 'object', description: 'объект, например ${jobs.plan.output}' },
      },
    };
    const step = resolveLate(usesJob({ item: '${jobs.plan.output}' }, paramsSchema), SCOPE)
      .steps[0] as { readonly uses: { readonly paramsSchema: unknown } };
    assert.deepEqual(step.uses.paramsSchema, paramsSchema);
  });
});
