import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runDataCommand } from '../src/cli/commands/data.js';
import { parseArgs } from '../src/cli/args.js';
import { COMMANDS } from '../src/cli/main.js';
import { StepcastError } from '../src/core/errors.js';
import { readJobData, writeJobData, jobDataPath } from '../src/core/journal/data.js';
import { readStatus } from '../src/core/journal/reader.js';
import { projectKey } from '../src/core/journal/paths.js';
import { renderDisplay } from '../src/core/pipeline/display.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { lintPipeline } from '../src/core/lint.js';
import { serializeLock } from '../src/core/pipeline/lock.js';
import { resolveLate } from '../src/core/pipeline/late.js';
import {
  buildResumePlan,
  parseFrom,
  readSourceRun,
  type ResumePlan,
} from '../src/core/run/resumePlan.js';
import { runPipeline, type RunResult } from '../src/core/run/runner.js';
import { buildSnapshot } from '../src/ui/snapshot.js';
import { makeJournalBed, makeProject, seedRun, type Project } from './helpers.js';

/** Каталог работы на диске: тот же вид, что заводит журнал прогона. */
function jobDir(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'stepcast-jobdata-')), 'jobs', 'работа');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Позвать команду так же, как её зовёт `stepcast`, но с заданным окружением. */
function data(
  dir: string | undefined,
  argv: readonly string[],
): { readonly lines: string[] } {
  const lines: string[] = [];
  runDataCommand(
    parseArgs(['data', ...argv], COMMANDS),
    (line) => lines.push(line),
    dir === undefined ? {} : { STEPCAST_JOB_DIR: dir },
  );
  return { lines };
}

describe('job-display-data: команда stepcast data', () => {
  // Сценарий: «Работа публикует значение по ключу»
  it('записывает значение с двоеточиями двумя позиционными аргументами', () => {
    const dir = jobDir();
    data(dir, ['set', 'title', 'Витрина: расход деньгами и токенами']);

    assert.deepEqual(readJobData(dir), { title: 'Витрина: расход деньгами и токенами' });
  });

  it('последняя запись по ключу побеждает, соседние ключи сохраняются', () => {
    const dir = jobDir();
    data(dir, ['set', 'title', 'первое']);
    data(dir, ['set', 'slug', 'nested-repo-anchor']);
    data(dir, ['set', 'title', 'второе']);

    assert.deepEqual(readJobData(dir), { title: 'второе', slug: 'nested-repo-anchor' });
  });

  it('merge дописывает объект целиком поверх опубликованного', () => {
    const dir = jobDir();
    data(dir, ['set', 'title', 'было']);
    data(dir, ['merge', '--json', '{"repo":"backend","slug":"nested-repo-anchor"}']);

    assert.deepEqual(readJobData(dir), {
      title: 'было',
      repo: 'backend',
      slug: 'nested-repo-anchor',
    });
  });

  it('get отдаёт одно значение и всю карту', () => {
    const dir = jobDir();
    data(dir, ['set', 'title', 'заголовок']);

    assert.deepEqual(data(dir, ['get', 'title']).lines, ['заголовок']);
    assert.deepEqual(
      JSON.parse(data(dir, ['get']).lines.join('\n')) as unknown,
      { title: 'заголовок' },
    );
  });

  // Сценарий: «Вызов вне шага прогона»
  it('отказывает без STEPCAST_JOB_DIR, называя причину', () => {
    assert.throws(
      () => data(undefined, ['set', 'title', 'что-нибудь']),
      (error: unknown) =>
        error instanceof StepcastError && /только внутри шага прогона/.test(error.message),
    );
  });

  it('не принимает путей вовсе — целевая работа только из окружения', () => {
    assert.throws(() => parseArgs(['data', 'set', 'k', 'v', '--job-dir', '/tmp'], COMMANDS));
  });

  it('отклоняет ключ с точкой: пространство подстановки одноуровневое', () => {
    const dir = jobDir();
    assert.throws(
      () => data(dir, ['set', 'a.b', 'значение']),
      (error: unknown) => error instanceof StepcastError && /Недопустимый ключ/.test(error.message),
    );
    assert.deepEqual(readJobData(dir), {});
  });

  it('отклоняет составное значение в merge', () => {
    const dir = jobDir();
    assert.throws(
      () => data(dir, ['merge', '--json', '{"a":{"b":1}}']),
      (error: unknown) =>
        error instanceof StepcastError && /непредставимо строкой/.test(error.message),
    );
  });

  // Сценарий: «Параллельные писатели не видят половины документа»
  it('пишет атомарно: временный файл, затем переименование', () => {
    const dir = jobDir();
    const seen: string[] = [];
    writeJobData(dir, { title: 'значение' });
    // Читатель, заставший запись в любой момент, видит либо старое состояние,
    // либо новое целиком: файла-обрубка на месте назначения не бывает.
    for (let i = 0; i < 20; i += 1) {
      writeJobData(dir, { title: `значение-${i}` });
      seen.push(readFileSync(jobDataPath(dir), 'utf8'));
    }
    for (const text of seen) assert.doesNotThrow(() => JSON.parse(text));
  });

  it('повреждённый файл читается пустотой, а не отказом', () => {
    const dir = jobDir();
    writeFileSync(jobDataPath(dir), '{ это не json');
    assert.deepEqual(readJobData(dir), {});
  });
});

const PIPELINE_WITH_DISPLAY = `
version: 1
kind: pipeline
name: подпись
jobs:
  slots:
    display:
      title: \${jobs.slots.data.title}
    steps:
      - id: publish
        run: [sh, -c, 'printf %s "{\\"title\\": \\"Выбрано: Расход деньгами и токенами\\"}" > "$STEPCAST_JOB_DIR/data.json"']
        expect: [{ exit_code: 0 }]
      - id: after
        run: [echo, дальше]
        expect: [{ exit_code: 0 }]
`;

async function runProject(project: Project): Promise<RunResult> {
  const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
  return runPipeline({
    expanded: expandPipeline({
      pipelinePath: project.path('stepcast.yml'),
      config: project.config,
    }),
    config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
    projectRoot: project.root,
    cwd: project.root,
  });
}

describe('job-display-data: движок складывает данные в состояние', () => {
  // Сценарий: «Данные видны в состоянии до конца работы»
  it('кладёт данные в запись работы после шага, который их записал', async () => {
    const project = makeProject({ 'stepcast.yml': PIPELINE_WITH_DISPLAY });
    const result = await runProject(project);

    const slots = readStatus(result.journal.paths).jobs.find((job) => job.id === 'slots');
    assert.deepEqual(slots?.data, { title: 'Выбрано: Расход деньгами и токенами' });
  });

  it('доносит данные до подстановки в работе ниже по графу', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: потребитель
jobs:
  первая:
    steps:
      - id: publish
        run: [sh, -c, 'printf %s "{\\"slug\\": \\"nested-repo-anchor\\"}" > "$STEPCAST_JOB_DIR/data.json"']
        expect: [{ exit_code: 0 }]
  вторая:
    needs: [первая]
    steps:
      - id: read
        run: [sh, -c, 'echo \${jobs.первая.data.slug} > итог.txt']
        expect: [{ exit_code: 0 }]
`,
    });
    const result = await runProject(project);

    assert.equal(result.status, 'success');
    assert.equal(readFileSync(project.path('итог.txt'), 'utf8').trim(), 'nested-repo-anchor');
  });

  it('отсутствующий ключ чужой работы — отказ с объяснением, а не пустая строка', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: строгий-потребитель
jobs:
  первая:
    steps:
      - id: publish
        run: [sh, -c, 'printf %s "{\\"slug\\": \\"есть\\"}" > "$STEPCAST_JOB_DIR/data.json"']
        expect: [{ exit_code: 0 }]
  вторая:
    needs: [первая]
    steps:
      - id: read
        run: [sh, -c, 'echo \${jobs.первая.data.нет}']
        expect: [{ exit_code: 0 }]
`,
    });
    const result = await runProject(project);

    const вторая = readStatus(result.journal.paths).jobs.find((job) => job.id === 'вторая');
    assert.equal(вторая?.status, 'failed');
    assert.match(вторая?.reason ?? '', /jobs\.первая\.data\.нет не определена/);
  });

  it('объясняет отказ составом опубликованных данных', () => {
    const project = makeProject({ 'stepcast.yml': PIPELINE_WITH_DISPLAY });
    const job = expandPipeline({
      pipelinePath: project.path('stepcast.yml'),
      config: project.config,
    }).pipeline.jobs[0];
    assert.ok(job !== undefined);

    assert.throws(
      () =>
        resolveLate(
          { ...job, env: { взгляд: '${jobs.другая.data.нет}' } },
          {
            jobs: { другая: { status: 'success', data: { slug: 'есть' } } },
            run: { id: 'r', dir: '/d', workspace: '/w', scratch: '/s' },
            env: {},
          },
        ),
      (error: unknown) =>
        error instanceof StepcastError && /опубликовала данные slug/.test(error.hint ?? ''),
    );
  });
});

describe('job-display-data: раскрытие подписи', () => {
  it('resolveLate не трогает display: его раскрывает витрина', () => {
    const project = makeProject({ 'stepcast.yml': PIPELINE_WITH_DISPLAY });
    const { pipeline } = expandPipeline({
      pipelinePath: project.path('stepcast.yml'),
      config: project.config,
    });
    const job = pipeline.jobs[0];
    assert.ok(job !== undefined);

    const resolved = resolveLate(job, {
      jobs: {},
      run: { id: 'r', dir: '/d', workspace: '/w', scratch: '/s' },
      env: {},
    });

    assert.equal(resolved.display?.title, '${jobs.slots.data.title}');
  });

  it('лок хранит подпись нераскрытой', () => {
    const project = makeProject({ 'stepcast.yml': PIPELINE_WITH_DISPLAY });
    const text = serializeLock(
      expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config })
        .pipeline,
    );
    assert.match(text, /display:/);
    assert.match(text, /\$\{jobs\.slots\.data\.title\}/);
  });

  it('раскрывает подпись против данных работы', () => {
    assert.deepEqual(
      renderDisplay(
        { title: 'Выбрано: ${jobs.slots.data.title}' },
        { slots: { data: { title: 'расход' } } },
      ),
      { title: 'Выбрано: расход' },
    );
  });

  // Сценарий: «Ключа нет — поля нет»
  it('опускает поле с неразрешённым ключом и сохраняет соседнее', () => {
    assert.deepEqual(
      renderDisplay(
        { title: '${jobs.slots.data.нет}', repo: '${jobs.slots.data.repo}' },
        { slots: { data: { repo: 'backend' } } },
      ),
      { repo: 'backend' },
    );
  });

  it('подпись без единого раскрытого поля отсутствует целиком', () => {
    assert.equal(renderDisplay({ title: '${jobs.slots.data.нет}' }, {}), undefined);
  });
});

describe('job-display-data: подпись в снимке витрины', () => {
  function seeded(runId: string) {
    const project = makeProject({ 'stepcast.yml': PIPELINE_WITH_DISPLAY });
    const lock = serializeLock(
      expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config })
        .pipeline,
    );
    const bed = makeJournalBed();
    const journal = seedRun(bed.runsRoot, bed.projectRoot, {
      runId,
      lock,
      jobs: [
        {
          id: 'slots',
          status: 'running',
          data: { title: 'Выбрано: Расход деньгами и токенами' },
          steps: [],
        },
      ],
    });
    return { journal, key: projectKey(bed.projectRoot) };
  }

  // Сценарий: «Подпись собирается при отрисовке, а не при раскрытии работы»
  it('раскрывает самоссылку работы против её собственных данных', () => {
    const { journal, key } = seeded('run-display');
    const snapshot = buildSnapshot(journal.paths, key);
    const slots = snapshot.jobs.find((job) => job.id === 'slots');

    assert.deepEqual(slots?.display, { title: 'Выбрано: Расход деньгами и токенами' });
    assert.equal(
      snapshot.graph.nodes.find((node) => node.id === 'slots')?.display?.title,
      'Выбрано: Расход деньгами и токенами',
    );
  });

  it('снимок работы без данных подписи не несёт', () => {
    const project = makeProject({ 'stepcast.yml': PIPELINE_WITH_DISPLAY });
    const lock = serializeLock(
      expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config })
        .pipeline,
    );
    const bed = makeJournalBed();
    const journal = seedRun(bed.runsRoot, bed.projectRoot, {
      runId: 'run-empty',
      lock,
      jobs: [{ id: 'slots', status: 'running', steps: [] }],
    });

    const slots = buildSnapshot(journal.paths, projectKey(bed.projectRoot)).jobs.find(
      (job) => job.id === 'slots',
    );
    assert.equal(slots?.display, undefined);
  });
});

describe('job-display-data: линт подписи', () => {
  function diagnose(pipeline: string): readonly string[] {
    const project = makeProject({ 'stepcast.yml': pipeline });
    const expanded = expandPipeline({
      pipelinePath: project.path('stepcast.yml'),
      config: project.config,
    });
    return lintPipeline(expanded, { config: project.config, cwd: project.root })
      .filter((item) => item.severity === 'error')
      .map((item) => item.message);
  }

  // Сценарий: «Самоссылка вне подписи отклоняется»
  it('отклоняет ${jobs.<сам>.data.*} в поле, потребляемом шагом', () => {
    const errors = diagnose(`
version: 1
kind: pipeline
name: самоссылка
jobs:
  slots:
    steps:
      - id: use
        run: [sh, -c, 'echo \${jobs.slots.data.title}']
        expect: [{ exit_code: 0 }]
`);
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? '', /собственные данные вне display/);
  });

  it('разрешает ту же самоссылку внутри display', () => {
    assert.deepEqual(diagnose(PIPELINE_WITH_DISPLAY), []);
  });

  it('отклоняет в display работу, которой нет в пайплайне', () => {
    const errors = diagnose(`
version: 1
kind: pipeline
name: чужая-работа
jobs:
  slots:
    display:
      title: \${jobs.нету.data.title}
    steps:
      - id: one
        run: [echo, ок]
        expect: [{ exit_code: 0 }]
`);
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? '', /работы нету нет в пайплайне/);
  });

  it('отклоняет в display пространство, кроме data', () => {
    const errors = diagnose(`
version: 1
kind: pipeline
name: не-данные
jobs:
  slots:
    display:
      title: \${jobs.slots.output.slug}
    steps:
      - id: one
        run: [echo, ок]
        expect: [{ exit_code: 0 }]
`);
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? '', /только данные работы/);
  });

  it('display внутри файла работы отклоняется как остальная обвязка', () => {
    const project = makeProject({
      'job.yml': `
version: 1
kind: job
name: работа
display:
  title: подпись
steps:
  - id: one
    run: [echo, ок]
    expect: [{ exit_code: 0 }]
`,
      'stepcast.yml': `
version: 1
kind: pipeline
name: обвязка-в-работе
jobs:
  slots:
    uses: ./job.yml
`,
    });

    assert.throws(
      () => expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
      (error: unknown) => error instanceof StepcastError && /display/.test(error.message),
    );
  });
});

describe('job-display-data: возобновление переносит данные', () => {
  // Сценарий: «Переиспользованный шаг ничего не пишет, а данные остаются»
  it('переносит data.json переиспользованной работы в новый прогон', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: перенос
jobs:
  первая:
    inputs: []
    steps:
      - id: publish
        run: [sh, -c, 'printf %s "{\\"slug\\": \\"nested-repo-anchor\\"}" > "$STEPCAST_JOB_DIR/data.json"']
        expect: [{ exit_code: 0 }]
  вторая:
    needs: [первая]
    steps:
      - id: read
        run: [sh, -c, 'echo \${jobs.первая.data.slug} > итог.txt']
        expect: [{ exit_code: 0 }]
`,
    });
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
    execFileSync('git', ['-C', project.root, 'init', '--quiet', '--initial-branch=main']);
    execFileSync('git', ['-C', project.root, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', project.root, 'config', 'user.name', 'Тест']);
    execFileSync('git', ['-C', project.root, 'add', '-A']);
    execFileSync('git', ['-C', project.root, 'commit', '--quiet', '-m', 'первый']);

    const config = { ...project.config, runs: { ...project.config.runs, root: runsRoot } };
    const expandedOf = () =>
      expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config });

    const first = await runPipeline({
      expanded: expandedOf(),
      config,
      projectRoot: project.root,
      cwd: project.root,
    });
    assert.equal(first.status, 'success');

    const source = readSourceRun(first.journal.paths);
    const plan: ResumePlan = buildResumePlan({
      expanded: expandedOf(),
      config: project.config,
      source,
      changed: [],
      cwd: project.root,
      producedPaths: () => undefined,
      from: parseFrom('вторая'),
    });

    const second = await runPipeline({
      expanded: expandedOf(),
      config,
      projectRoot: project.root,
      cwd: project.root,
      resume: { plan, source },
    });

    assert.equal(second.status, 'success');
    const первая = readStatus(second.journal.paths).jobs.find((job) => job.id === 'первая');
    assert.deepEqual(первая?.data, { slug: 'nested-repo-anchor' });
  });
});
