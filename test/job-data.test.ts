import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { row as dataRow, runDataCommand } from '../src/cli/commands/data.js';
import { parseArgs } from '../src/cli/args.js';
import type { CommandSpec } from '../src/core/plugins/cli-types.js';

/** Описание аргументов команды `data` — из её собственного модуля (`cli-commands-as-rows`), не из общего литерала. */
const DATA_COMMANDS: Record<string, CommandSpec> = { data: dataRow.command.spec };
import { StepcastError } from '../src/core/errors.js';
import { readJobData, writeJobDataUnchecked, jobDataPath } from '../src/core/journal/data.js';
import { readStatus } from '../src/core/journal/reader.js';
import { jobDir as runJobDir, projectKey } from '../src/core/journal/paths.js';
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
import { tempDir } from './tmp.js';

/**
 * Каталог работы на диске: тот же вид, что заводит журнал прогона —
 * `resolved.json` рядом с файлом данных, объявляющий переданные ключи.
 * Пустой список по умолчанию — работа без объявления, запись из неё
 * отказывает, как и без файла вовсе (`jobDirWithoutDeclaration`).
 */
function jobDir(declared: readonly string[] = []): string {
  const dir = join(tempDir('jobdata-'), 'jobs', 'работа');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'resolved.json'), JSON.stringify({ data: declared }));
  return dir;
}

/** Каталог работы без `resolved.json` вовсе — определение работы недоступно. */
function jobDirWithoutDeclaration(): string {
  const dir = join(tempDir('jobdata-'), 'jobs', 'работа');
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
    parseArgs(['data', ...argv], DATA_COMMANDS),
    (line) => lines.push(line),
    dir === undefined ? {} : { STEPCAST_JOB_DIR: dir },
  );
  return { lines };
}

describe('job-data-write-scope: объявление data в определении работы', () => {
  const PIPELINE_WITH_DATA_DECL = `
version: 1
kind: pipeline
name: объявление
jobs:
  slots:
    data: [title, title-a, slug-a]
    steps:
      - id: publish
        run: [echo, ок]
        expect: [{ exit_code: 0 }]
`;

  // Сценарий: «Работа объявляет ключи»
  it('объявление доезжает до раскрытой модели, лока и resolved.json', async () => {
    const project = makeProject({ 'stepcast.yml': PIPELINE_WITH_DATA_DECL });
    const { pipeline } = expandPipeline({
      pipelinePath: project.path('stepcast.yml'),
      config: project.config,
    });
    const job = pipeline.jobs.find((item) => item.id === 'slots');
    assert.deepEqual(job?.data, ['title', 'title-a', 'slug-a']);

    const lockText = serializeLock(pipeline);
    assert.match(lockText, /data:/);
    assert.match(lockText, /title-a/);
    assert.match(lockText, /slug-a/);

    const result = await runProject(project);
    const resolved = JSON.parse(
      readFileSync(join(result.journal.paths.dir, 'jobs', 'slots', 'resolved.json'), 'utf8'),
    ) as { data: readonly string[] };
    assert.deepEqual(resolved.data, ['title', 'title-a', 'slug-a']);
  });

  // Сценарий: «Недопустимое имя в объявлении»
  it('имя с точкой отклоняется разбором, называя работу', () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: недопустимое-имя
jobs:
  slots:
    data: [a.b]
    steps:
      - id: one
        run: [echo, ок]
        expect: [{ exit_code: 0 }]
`,
    });

    assert.throws(
      () => expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
      (error: unknown) =>
        error instanceof StepcastError &&
        /недопустимым именем/.test(error.message) &&
        error.at === 'jobs.slots.data',
    );
  });

  // Сценарий: «Объявления нет»
  it('работа без объявления имеет пустой состав', () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: без-объявления
jobs:
  slots:
    steps:
      - id: one
        run: [echo, ок]
        expect: [{ exit_code: 0 }]
`,
    });
    const { pipeline } = expandPipeline({
      pipelinePath: project.path('stepcast.yml'),
      config: project.config,
    });
    assert.deepEqual(pipeline.jobs[0]?.data, []);
  });

  // Сценарий: «Объявленный ключ не опубликован»
  it('объявленный, но не опубликованный ключ ошибкой не считается', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: не-опубликован
jobs:
  slots:
    data: [slug]
    steps:
      - id: one
        run: [echo, ок]
        expect: [{ exit_code: 0 }]
`,
    });
    const result = await runProject(project);
    assert.equal(result.status, 'success');
  });
});

describe('job-display-data: команда stepcast data', () => {
  // Сценарий: «Работа публикует значение по ключу»
  it('записывает значение с двоеточиями двумя позиционными аргументами', () => {
    const dir = jobDir(['title']);
    data(dir, ['set', 'title', 'Витрина: расход деньгами и токенами']);

    assert.deepEqual(readJobData(dir), { title: 'Витрина: расход деньгами и токенами' });
  });

  it('последняя запись по ключу побеждает, соседние ключи сохраняются', () => {
    const dir = jobDir(['title', 'slug']);
    data(dir, ['set', 'title', 'первое']);
    data(dir, ['set', 'slug', 'nested-repo-anchor']);
    data(dir, ['set', 'title', 'второе']);

    assert.deepEqual(readJobData(dir), { title: 'второе', slug: 'nested-repo-anchor' });
  });

  it('merge дописывает объект целиком поверх опубликованного', () => {
    const dir = jobDir(['title', 'repo', 'slug']);
    data(dir, ['set', 'title', 'было']);
    data(dir, ['merge', '--json', '{"repo":"backend","slug":"nested-repo-anchor"}']);

    assert.deepEqual(readJobData(dir), {
      title: 'было',
      repo: 'backend',
      slug: 'nested-repo-anchor',
    });
  });

  it('get отдаёт одно значение и всю карту', () => {
    const dir = jobDir(['title']);
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
    assert.throws(() => parseArgs(['data', 'set', 'k', 'v', '--job-dir', '/tmp'], DATA_COMMANDS));
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

  // Сценарий: «Необъявленный ключ»
  it('отклоняет необъявленный ключ до касания файла, называя работу и объявленный состав', () => {
    const dir = jobDir(['title']);
    assert.throws(
      () => data(dir, ['set', 'slug', 'значение']),
      (error: unknown) =>
        error instanceof StepcastError &&
        /не объявляла ключ данных «slug»/.test(error.message) &&
        /title/.test(error.hint ?? ''),
    );
    assert.deepEqual(readJobData(dir), {});
  });

  it('merge отклоняет объект целиком, если хотя бы один ключ не объявлен', () => {
    const dir = jobDir(['title']);
    assert.throws(
      () => data(dir, ['merge', '--json', '{"title":"ок","slug":"нет"}']),
      (error: unknown) => error instanceof StepcastError && /«slug»/.test(error.message),
    );
    assert.deepEqual(readJobData(dir), {});
  });

  // Сценарий: «Работа без объявления»
  it('работа без единого объявленного ключа не публикует ничего', () => {
    const dir = jobDir([]);
    assert.throws(
      () => data(dir, ['set', 'title', 'значение']),
      (error: unknown) =>
        error instanceof StepcastError &&
        /Работа не объявляет ни одного ключа данных/.test(error.hint ?? ''),
    );
    assert.deepEqual(readJobData(dir), {});
  });

  // Сценарий: «Определение работы недоступно»
  it('отсутствующий resolved.json — отказ, а не разрешение', () => {
    const dir = jobDirWithoutDeclaration();
    assert.throws(
      () => data(dir, ['set', 'title', 'значение']),
      (error: unknown) =>
        error instanceof StepcastError && /Раскрытого определения работы нет/.test(error.message),
    );
    assert.deepEqual(readJobData(dir), {});
  });

  // Отказ по ненайденному определению отличается от отказа по пустому
  // объявлению: вторая беда — определение работы, первая — дефект каталога
  // прогона, и советовать по ней правку пайплайна не за что.
  it('отсутствующее определение и пустое объявление объясняются по-разному', () => {
    const missing = jobDirWithoutDeclaration();
    const empty = jobDir([]);

    assert.throws(
      () => data(missing, ['set', 'title', 'значение']),
      (error: unknown) =>
        error instanceof StepcastError &&
        error.hint !== undefined &&
        error.hint.includes(join(missing, 'resolved.json')) &&
        !/добавьте data/.test(error.hint),
    );
    assert.throws(
      () => data(empty, ['set', 'title', 'значение']),
      (error: unknown) =>
        error instanceof StepcastError && /добавьте data/.test(error.hint ?? ''),
    );
  });

  it('get не ограничен объявлением', () => {
    const dir = jobDirWithoutDeclaration();
    writeJobDataUnchecked(dir, { title: 'опубликовано в обход объявления' });
    assert.deepEqual(data(dir, ['get', 'title']).lines, ['опубликовано в обход объявления']);
  });

  // Сценарий: «Параллельные писатели не видят половины документа»
  it('пишет атомарно: временный файл, затем переименование', () => {
    const dir = jobDir();
    const seen: string[] = [];
    writeJobDataUnchecked(dir, { title: 'значение' });
    // Читатель, заставший запись в любой момент, видит либо старое состояние,
    // либо новое целиком: файла-обрубка на месте назначения не бывает.
    for (let i = 0; i < 20; i += 1) {
      writeJobDataUnchecked(dir, { title: `значение-${i}` });
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
    data: [title]
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
  const runsRoot = tempDir('runs-');
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
    data: [slug]
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
    data: [slug]
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

  // Сценарий: «Запись в файл в обход команды»
  it('необъявленный ключ в data.json, записанный шагом в обход команды, роняет работу без повторных попыток', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: обход-команды
jobs:
  slots:
    steps:
      - id: publish
        run: [sh, -c, 'printf %s "{\\"title\\": \\"мимо объявления\\"}" > "$STEPCAST_JOB_DIR/data.json"']
        expect: [{ exit_code: 0 }]
`,
    });
    const result = await runProject(project);

    const slots = readStatus(result.journal.paths).jobs.find((job) => job.id === 'slots');
    assert.equal(slots?.status, 'failed');
    assert.match(slots?.reason ?? '', /slots не объявляла ключ данных «title»/);
    assert.equal(slots?.steps[0]?.attempts.length, 1);
  });

  // Исход шага решает первым: сверка данных не вправе подменить собой
  // настоящую причину отказа — иначе статус разошёлся бы с фактом ровно так,
  // как это закрывал budget-stop-status-lies.
  it('упавший шаг сохраняет свою причину и cause, а нарушение объявления дописывается к ней', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: упавший-шаг-с-данными
jobs:
  slots:
    steps:
      - id: publish
        run: [sh, -c, 'printf %s "{\\"slug\\": \\"мимо объявления\\"}" > "$STEPCAST_JOB_DIR/data.json"; exit 3']
        expect: [{ exit_code: 0 }]
`,
    });
    const result = await runProject(project);

    const slots = readStatus(result.journal.paths).jobs.find((job) => job.id === 'slots');
    assert.equal(slots?.status, 'failed');
    assert.equal(slots?.cause, 'expect_failed');
    assert.match(slots?.reason ?? '', /шаг publish/);
    assert.match(slots?.reason ?? '', /не объявляла ключ данных «slug»/);
  });

  // Сценарий: «Объявленное соседство сохраняется»
  it('объявленный сосед необъявленного ключа сохраняется в записи работы', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: соседство
jobs:
  slots:
    data: [title]
    steps:
      - id: publish
        run: [sh, -c, 'printf %s "{\\"title\\": \\"объявлен\\", \\"slug\\": \\"не объявлен\\"}" > "$STEPCAST_JOB_DIR/data.json"']
        expect: [{ exit_code: 0 }]
`,
    });
    const result = await runProject(project);

    const slots = readStatus(result.journal.paths).jobs.find((job) => job.id === 'slots');
    assert.equal(slots?.status, 'failed');
    assert.deepEqual(slots?.data, { title: 'объявлен' });
  });

  // Сценарий: «Подстановка не получает необъявленного значения»
  it('необъявленное значение не доезжает до подстановки в работе ниже по графу', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: не-доезжает
jobs:
  первая:
    steps:
      - id: publish
        run: [sh, -c, 'printf %s "{\\"slug\\": \\"мимо объявления\\"}" > "$STEPCAST_JOB_DIR/data.json"']
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

    const jobs = readStatus(result.journal.paths).jobs;
    assert.equal(jobs.find((job) => job.id === 'первая')?.status, 'failed');
    assert.equal(jobs.find((job) => job.id === 'вторая')?.status, 'skipped');
    assert.ok(!existsSync(project.path('итог.txt')));
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

  // Сценарий: «Читатель называет необъявленный ключ»
  it('отклоняет ${jobs.<работа>.data.<ключ>} в поле, потребляемом шагом, когда работа его не объявляет', () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: необъявленный-читатель
jobs:
  slots:
    data: [title]
    steps:
      - id: publish
        run: [echo, ок]
        expect: [{ exit_code: 0 }]
  потребитель:
    needs: [slots]
    steps:
      - id: use
        run: [sh, -c, 'echo \${jobs.slots.data.repo}']
        expect: [{ exit_code: 0 }]
`,
    });
    const diagnostics = lintPipeline(
      expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
      { config: project.config, cwd: project.root },
    ).filter((item) => item.severity === 'error');

    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0]?.message ?? '', /работа slots не объявляет ключ данных «repo»/);
    assert.match(diagnostics[0]?.hint ?? '', /title/);
  });

  // Сценарий: «Подпись называет необъявленный ключ»
  it('отклоняет тот же необъявленный ключ внутри display', () => {
    const errors = diagnose(`
version: 1
kind: pipeline
name: необъявленная-подпись
jobs:
  slots:
    data: [title]
    display:
      title: \${jobs.slots.data.repo}
    steps:
      - id: publish
        run: [echo, ок]
        expect: [{ exit_code: 0 }]
`);
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? '', /работа slots не объявляет ключ данных «repo»/);
  });

  // Сценарий: «Условие называет необъявленный ключ»
  it('отклоняет тот же необъявленный ключ в условии if', () => {
    const errors = diagnose(`
version: 1
kind: pipeline
name: необъявленное-условие
jobs:
  slots:
    data: [title]
    steps:
      - id: publish
        run: [echo, ок]
        expect: [{ exit_code: 0 }]
  потребитель:
    needs: [slots]
    if: "jobs.slots.data.repo == 'backend'"
    steps:
      - id: use
        run: [echo, ок]
        expect: [{ exit_code: 0 }]
`);
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? '', /работа slots не объявляет ключ данных «repo»/);
  });

  it('пропускает условие if, читающее объявленный ключ', () => {
    const errors = diagnose(`
version: 1
kind: pipeline
name: объявленное-условие
jobs:
  slots:
    data: [repo]
    steps:
      - id: publish
        run: [echo, ок]
        expect: [{ exit_code: 0 }]
  потребитель:
    needs: [slots]
    if: "jobs.slots.data.repo == 'backend'"
    steps:
      - id: use
        run: [echo, ок]
        expect: [{ exit_code: 0 }]
`);
    assert.deepEqual(errors, []);
  });

  // Сценарий: «Читатель называет объявленный ключ»
  it('пропускает объявленный, но ещё не опубликованный ключ', () => {
    const errors = diagnose(`
version: 1
kind: pipeline
name: объявлен-не-опубликован
jobs:
  slots:
    data: [repo]
    steps:
      - id: publish
        run: [echo, ок]
        expect: [{ exit_code: 0 }]
  потребитель:
    needs: [slots]
    steps:
      - id: use
        run: [sh, -c, 'echo \${jobs.slots.data.repo}']
        expect: [{ exit_code: 0 }]
`);
    assert.deepEqual(errors, []);
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
    data: [slug]
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
    const runsRoot = tempDir('runs-');
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

  // Перенос подчиняется объявлению нового определения, а не старого: между
  // прогонами определение могло поменяться, и объявление нового прогона —
  // единственное, которым он сам исполняется. План возобновления строится по
  // исходному определению (иначе шаг не переиспользовался бы вовсе — состав
  // data входит в ключ шага), а исполняется новое: ровно тот случай, ради
  // которого фильтр и заведён.
  it('не переносит ключ, которого новое определение работы больше не объявляет', async () => {
    const ЗАГОЛОВОК = `
version: 1
kind: pipeline
name: перенос-без-объявления
jobs:
  первая:
    inputs: []`;
    const ХВОСТ = `
    steps:
      - id: publish
        run: [sh, -c, 'printf %s "{\\"slug\\": \\"nested-repo-anchor\\"}" > "$STEPCAST_JOB_DIR/data.json"']
        expect: [{ exit_code: 0 }]
  вторая:
    needs: [первая]
    steps:
      - id: read
        run: [echo, дальше]
        expect: [{ exit_code: 0 }]
`;
    const project = makeProject({ 'stepcast.yml': `${ЗАГОЛОВОК}\n    data: [slug]${ХВОСТ}` });
    const runsRoot = tempDir('runs-');
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
    assert.deepEqual(
      readStatus(first.journal.paths).jobs.find((job) => job.id === 'первая')?.data,
      { slug: 'nested-repo-anchor' },
    );

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

    // Объявление снято: работа больше не вправе публиковать `slug`.
    writeFileSync(project.path('stepcast.yml'), `${ЗАГОЛОВОК}${ХВОСТ}`);

    const second = await runPipeline({
      expanded: expandedOf(),
      config,
      projectRoot: project.root,
      cwd: project.root,
      resume: { plan, source },
    });

    const первая = readStatus(second.journal.paths).jobs.find((job) => job.id === 'первая');
    assert.equal(первая?.status, 'success');
    assert.equal(первая?.data, undefined);
    assert.ok(!existsSync(jobDataPath(runJobDir(second.journal.paths, 'первая'))));
  });
});
