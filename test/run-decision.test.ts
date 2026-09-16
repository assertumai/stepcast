import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { builtinRegistry } from '../src/parts/builtin.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { readStatus } from '../src/core/journal/reader.js';
import type { RunPaths } from '../src/core/journal/paths.js';
import { writeDecisionRecord } from '../src/core/journal/writer.js';
import { runPipeline } from '../src/core/run/runner.js';
import { makeProject } from './helpers.js';
import { tempDir } from './tmp.js';

const POLL_MS = 20;

function decide(paths: RunPaths, waitId: string, body: { outcome: string; reason?: string; restart_from?: string }): void {
  writeDecisionRecord(paths, waitId, body);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('условие не выполнилось вовремя');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function singleGate(extra = ''): string {
  return `
version: 1
kind: pipeline
name: решение-прогон
jobs:
  build:
    steps:
      - id: gate
        decision:
          prompt: продолжить?
          outcomes:
            approve: continue
            deny: { effect: reject }
            redo: { effect: restart }
${extra}
`;
}

/** Найти каталог единственного прогона в корне: тест создаёт ровно один прогон на runsRoot. */
async function findRunPaths(runsRoot: string): Promise<RunPaths> {
  const { readdirSync } = await import('node:fs');
  await waitUntil(() => readdirSync(runsRoot).length > 0);
  const projectKey = readdirSync(runsRoot).find((name) => name !== 'projects.json');
  if (projectKey === undefined) throw new Error('каталог проекта не появился');
  const { join } = await import('node:path');
  const projectDir = join(runsRoot, projectKey);
  await waitUntil(() => readdirSync(projectDir).some((name) => name !== 'latest'));
  const runId = readdirSync(projectDir).find((name) => name !== 'latest') as string;
  const { runPaths } = await import('../src/core/journal/paths.js');
  return runPaths(runsRoot, projectKey, runId);
}

describe('run-decision: остановка прогона на решении человека', () => {
  it('continue продолжает прогон успехом, ожидание не тратит бюджет', async () => {
    const runsRoot = tempDir('runs-');
    const project = makeProject({ 'stepcast.yml': singleGate() });
    const registry = builtinRegistry();
    const promise = runPipeline({
      expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config, registry }),
      config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
      registry,
      decisionPollIntervalMs: POLL_MS,
    });

    const paths = await findRunPaths(runsRoot);
    await waitUntil(() => (readStatus(paths).awaiting?.length ?? 0) > 0);
    const status = readStatus(paths);
    const entry = status.awaiting?.[0];
    assert.ok(entry !== undefined);
    assert.equal(entry.job, 'build');
    assert.equal(entry.step, 'gate');
    assert.deepEqual(Object.keys(entry.outcomes).sort(), ['approve', 'deny', 'redo']);

    await new Promise((resolve) => setTimeout(resolve, 120));
    decide(paths, entry.wait_id, { outcome: 'approve' });

    const result = await promise;
    assert.equal(result.status, 'success');
    assert.equal(result.restart, undefined);

    const finalStatus = readStatus(paths);
    assert.equal(finalStatus.awaiting, undefined);
    const step = finalStatus.jobs[0]?.steps[0];
    assert.deepEqual(step?.decision, { outcome: 'approve', effect: 'continue', by: 'user' });
    // Сторожевой тест (pipeline-owns-services, задача 1.3): `decision` —
    // вид плагинного контракта (`kind: plugin` в журнале), и его владелец
    // обязан остаться «встроенный» и после переезда служебных сервисов в
    // строку `pipeline` — переезд не вправе сменить подпись записи журнала.
    assert.deepEqual(step?.plugin_step, { name: 'decision', plugin: 'встроенный' });

    // Ожидание не тратит бюджет: proспанные ~120мс не должны отразиться в
    // wallclock тем же порядком величины.
    assert.ok(finalStatus.budget.wallclock_ms < 100, `wallclock_ms=${finalStatus.budget.wallclock_ms}`);
  });

  it('reject останавливает прогон отменой с названной причиной', async () => {
    const runsRoot = tempDir('runs-');
    const project = makeProject({ 'stepcast.yml': singleGate() });
    const registry = builtinRegistry();
    const promise = runPipeline({
      expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config, registry }),
      config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
      registry,
      decisionPollIntervalMs: POLL_MS,
    });

    const paths = await findRunPaths(runsRoot);
    await waitUntil(() => (readStatus(paths).awaiting?.length ?? 0) > 0);
    const waitId = readStatus(paths).awaiting?.[0]?.wait_id as string;
    decide(paths, waitId, { outcome: 'deny', reason: 'не готово' });

    const result = await promise;
    assert.equal(result.status, 'canceled');

    const finalStatus = readStatus(paths);
    const step = finalStatus.jobs[0]?.steps[0];
    assert.equal(step?.status, 'canceled');
    assert.equal(step?.cause, 'canceled');
    assert.match(step?.reason ?? '', /решение пользователя: отклонено — не готово/);
    assert.deepEqual(step?.decision, { outcome: 'deny', effect: 'reject', by: 'user', reason: 'не готово' });
  });

  it('restart просит продолжить с выбранного шага и записывает restart_from', async () => {
    const runsRoot = tempDir('runs-');
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: решение-перезапуск
jobs:
  prep:
    steps:
      - id: build
        run: ["true"]
  build:
    needs: [prep]
    steps:
      - id: gate
        decision:
          prompt: продолжить?
          outcomes:
            approve: continue
            redo: { effect: restart }
`,
    });
    const registry = builtinRegistry();
    const promise = runPipeline({
      expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config, registry }),
      config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
      registry,
      decisionPollIntervalMs: POLL_MS,
    });

    const paths = await findRunPaths(runsRoot);
    await waitUntil(() => (readStatus(paths).awaiting?.length ?? 0) > 0);
    const waitId = readStatus(paths).awaiting?.[0]?.wait_id as string;
    decide(paths, waitId, { outcome: 'redo', restart_from: 'prep' });

    const result = await promise;
    assert.equal(result.status, 'canceled');
    assert.deepEqual(result.restart, { from: 'prep' });

    const finalStatus = readStatus(paths);
    assert.equal(finalStatus.restart_from, 'prep');
    assert.match(finalStatus.resume?.command ?? '', /--from prep/);
  });

  it('отмена прогона прерывает ожидание сигналом, без записи решения', async () => {
    const runsRoot = tempDir('runs-');
    const project = makeProject({ 'stepcast.yml': singleGate() });
    const registry = builtinRegistry();
    const controller = new AbortController();
    const promise = runPipeline({
      expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config, registry }),
      config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
      registry,
      signal: controller.signal,
      decisionPollIntervalMs: POLL_MS,
    });

    const paths = await findRunPaths(runsRoot);
    await waitUntil(() => (readStatus(paths).awaiting?.length ?? 0) > 0);
    const started = Date.now();
    controller.abort();

    const result = await promise;
    assert.ok(Date.now() - started < 2000, 'отмена не должна ждать такт опроса');
    assert.equal(result.status, 'canceled');
    const step = readStatus(paths).jobs[0]?.steps[0];
    assert.equal(step?.decision, undefined);
  });

  // Дельта `run-resume`: «Решение, записанное мёртвому прогону, применяется
  // при возобновлении». `stepcast decide` пишет решение в каталог исходного
  // прогона и адресует его ожиданию этого прогона; без переноса возобновление
  // спросило бы человека второй раз — притом что команда прямо сказала ему,
  // что решение не потеряно.
  it('решение, записанное прогону с мёртвым процессом, применяется возобновлением', async () => {
    const runsRoot = tempDir('runs-');
    const project = makeProject({ 'stepcast.yml': singleGate() });
    const registry = builtinRegistry();
    const config = { ...project.config, runs: { ...project.config.runs, root: runsRoot } };
    const controller = new AbortController();

    const promise = runPipeline({
      expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config, registry }),
      config,
      projectRoot: project.root,
      cwd: project.root,
      registry,
      signal: controller.signal,
      decisionPollIntervalMs: POLL_MS,
    });

    const paths = await findRunPaths(runsRoot);
    await waitUntil(() => (readStatus(paths).awaiting?.length ?? 0) > 0);
    const waitId = readStatus(paths).awaiting?.[0]?.wait_id as string;

    // Процесс прогона умирает, не применив решения: отмена — то же, что его
    // смерть, с точки зрения человека, отвечающего следом.
    controller.abort();
    await promise;

    // Человек отвечает уже мёртвому прогону — ровно то, что делает
    // `stepcast decide`, увидев, что прогон не идёт.
    decide(paths, waitId, { outcome: 'approve' });

    const { planResume, readSourceRun } = await import('../src/core/run/resumePlan.js');
    const source = readSourceRun(paths);
    const { expanded, plan } = planResume({ cwd: project.root, config, source, registry });
    const resumed = await runPipeline({
      expanded,
      config,
      projectRoot: project.root,
      cwd: project.root,
      registry,
      resume: { plan, source },
      decisionPollIntervalMs: POLL_MS,
    });

    assert.equal(resumed.status, 'success', 'возобновление применило лежащее решение, а не спросило заново');

    const resumedStatus = readStatus(resumed.journal.paths);
    const step = resumedStatus.jobs[0]?.steps[0];
    assert.equal(step?.status, 'success');
    assert.deepEqual(step?.decision, { outcome: 'approve', effect: 'continue', by: 'user' });

    const { readEvents } = await import('../src/core/journal/reader.js');
    const carried = readEvents(resumed.journal.paths).filter((event) => event.kind === 'decision.carried');
    assert.equal(carried.length, 1, 'перенос решения записан событием');

    // Запись решения остаётся в каталоге исходного прогона следом: прочтение
    // её не удаляет.
    const { existsSync } = await import('node:fs');
    const { decisionRecordPath } = await import('../src/core/journal/paths.js');
    assert.ok(existsSync(decisionRecordPath(paths, waitId)));
  });

  // Дельта `run-resume`: «Возобновление не переспрашивает решение успешного
  // шага» — шаг решения переиспользуется общим правилом совпавшего ключа.
  it('успешное решение переиспользуется возобновлением, и человека не спрашивают заново', async () => {
    const runsRoot = tempDir('runs-');
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: решение-переиспользование
jobs:
  build:
    steps:
      - id: gate
        decision:
          prompt: продолжить?
          outcomes:
            approve: continue
  after:
    needs: [build]
    steps:
      - id: boom
        run: ["false"]
`,
    });
    const registry = builtinRegistry();
    const config = { ...project.config, runs: { ...project.config.runs, root: runsRoot } };

    const promise = runPipeline({
      expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config, registry }),
      config,
      projectRoot: project.root,
      cwd: project.root,
      registry,
      decisionPollIntervalMs: POLL_MS,
    });

    const paths = await findRunPaths(runsRoot);
    await waitUntil(() => (readStatus(paths).awaiting?.length ?? 0) > 0);
    decide(paths, readStatus(paths).awaiting?.[0]?.wait_id as string, { outcome: 'approve' });
    const first = await promise;
    assert.equal(first.status, 'failed', 'падает нижележащая работа, а не шаг решения');

    const { planResume, readSourceRun } = await import('../src/core/run/resumePlan.js');
    const source = readSourceRun(paths);
    const { expanded, plan } = planResume({ cwd: project.root, config, source, registry });
    const resumed = await runPipeline({
      expanded,
      config,
      projectRoot: project.root,
      cwd: project.root,
      registry,
      resume: { plan, source },
      decisionPollIntervalMs: POLL_MS,
    });

    const resumedStatus = readStatus(resumed.journal.paths);
    const gate = resumedStatus.jobs.find((job) => job.id === 'build')?.steps[0];
    assert.ok(gate?.reused_from !== undefined, 'шаг решения переиспользован по совпавшему ключу');

    const { readEvents } = await import('../src/core/journal/reader.js');
    const asked = readEvents(resumed.journal.paths).filter((event) => event.kind === 'decision.awaiting');
    assert.deepEqual(asked, [], 'нового ожидания не заводилось');
  });

  it('два ожидания одновременно и снятие одного не трогает другое', async () => {
    const runsRoot = tempDir('runs-');
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: решение-параллель
concurrency: 2
jobs:
  a:
    steps:
      - id: gate
        decision: { prompt: "a?", outcomes: { approve: continue } }
  b:
    steps:
      - id: gate
        decision: { prompt: "b?", outcomes: { approve: continue } }
`,
    });
    const registry = builtinRegistry();
    const promise = runPipeline({
      expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config, registry }),
      config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
      registry,
      decisionPollIntervalMs: POLL_MS,
    });

    const paths = await findRunPaths(runsRoot);
    await waitUntil(() => (readStatus(paths).awaiting?.length ?? 0) === 2);

    const [first, second] = readStatus(paths).awaiting as NonNullable<ReturnType<typeof readStatus>['awaiting']>;
    decide(paths, first!.wait_id, { outcome: 'approve' });
    await waitUntil(() => (readStatus(paths).awaiting?.length ?? 0) === 1);
    assert.equal(readStatus(paths).awaiting?.[0]?.wait_id, second!.wait_id);
    decide(paths, second!.wait_id, { outcome: 'approve' });

    const result = await promise;
    assert.equal(result.status, 'success');
  });
});
