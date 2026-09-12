import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ExitCode } from '../src/core/errors.js';
import { projectKey, runPaths, type RunPaths } from '../src/core/journal/paths.js';
import { readManifest, readStatus } from '../src/core/journal/reader.js';
import { atomicWrite } from '../src/core/journal/writer.js';
import { runDecideCommand } from '../src/cli/commands/decide.js';
import { runStatusCommand } from '../src/cli/commands/status.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { runPipeline, type RunResult } from '../src/core/run/runner.js';
import { makeProject, withHome, type Project } from './helpers.js';
import { tempDir } from './tmp.js';

const PIPELINE = `
version: 1
kind: pipeline
name: decide-команда
jobs:
  prep:
    steps:
      - id: build
        run: ["true"]
  apply:
    needs: [prep]
    steps:
      - id: gate
        decision:
          prompt: продолжить?
          outcomes:
            approve: continue
            deny: { effect: reject }
            redo: { effect: restart }
`;

const TWO_GATES = `
version: 1
kind: pipeline
name: decide-два-ожидания
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
`;

function capture(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('условие не выполнилось вовремя');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Проект с `runs.root`, направленным во временный каталог, читаемым обычным
 * `resolveConfig({ cwd })`, — decide и status разрешают конфигурацию сами, а
 * не принимают её параметром (кроме decide, которому тест передаёт её явно
 * там, где это короче).
 */
function projectWithRuns(): { readonly project: Project; readonly runsRoot: string } {
  const project = makeProject({});
  const runsRoot = tempDir('runs-');
  writeFileSync(join(project.home, '.stepcast', 'config.yml'), `runs:\n  root: ${runsRoot}\n`);
  return { project, runsRoot };
}

/** Запустить пайплайн и дождаться первого ожидания решения. */
async function startAwaiting(
  project: Project,
  runsRoot: string,
  pipeline = PIPELINE,
): Promise<{ readonly promise: Promise<RunResult>; readonly paths: RunPaths }> {
  project.write('stepcast.yml', pipeline);
  const expanded = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config });
  const promise = runPipeline({
    expanded,
    config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
    projectRoot: project.root,
    cwd: project.root,
    decisionPollIntervalMs: 20,
  });

  const key = projectKey(project.root);
  await waitUntil(() => {
    try {
      return readdirSync(join(runsRoot, key)).some((name) => name !== 'latest');
    } catch {
      return false;
    }
  });
  const runId = readdirSync(join(runsRoot, key)).find((name) => name !== 'latest') as string;
  const paths = runPaths(runsRoot, key, runId);
  await waitUntil(() => (readStatus(paths).awaiting?.length ?? 0) > 0);
  return { promise, paths };
}

describe('decide: приём решения командой', () => {
  it('неизвестный прогон — отказ', async () => {
    const { project } = projectWithRuns();
    const { lines, write } = capture();
    const code = await withHome(project.home, () =>
      runDecideCommand({ command: 'decide', positional: ['нет-такого', 'approve'], flags: {} }, write, project.root),
    );
    assert.notEqual(code, ExitCode.ok);
    assert.ok(lines.length > 0);
  });

  it('прогон без ожиданий — отказ', async () => {
    const { project, runsRoot } = projectWithRuns();
    project.write('stepcast.yml', 'version: 1\nkind: pipeline\nname: без-ожиданий\njobs:\n  build:\n    steps:\n      - id: s\n        run: ["true"]\n');
    const expanded = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config });
    const result = await runPipeline({
      expanded,
      config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
    });
    assert.equal(result.status, 'success');

    const { lines, write } = capture();
    const code = await withHome(project.home, () =>
      runDecideCommand({ command: 'decide', positional: [result.journal.paths.runId, 'approve'], flags: {} }, write, project.root),
    );
    assert.notEqual(code, ExitCode.ok);
    assert.ok(lines.some((line) => /не ждёт решения/.test(line)), JSON.stringify(lines));
  });

  it('несколько ожиданий без --step — отказ с перечнем', async () => {
    const { project, runsRoot } = projectWithRuns();
    const { promise, paths } = await startAwaiting(project, runsRoot, TWO_GATES);

    const { lines, write } = capture();
    const code = await withHome(project.home, () =>
      runDecideCommand({ command: 'decide', positional: [paths.runId, 'approve'], flags: {} }, write, project.root),
    );
    assert.notEqual(code, ExitCode.ok);
    assert.ok(lines.some((line) => /нескольких шагах/.test(line)), JSON.stringify(lines));

    // Разрешить дело до конца — иначе прогон повиснет опросом навсегда.
    await withHome(project.home, () =>
      runDecideCommand({ command: 'decide', positional: [paths.runId, 'approve'], flags: { step: 'a/gate' } }, () => {}, project.root),
    );
    await withHome(project.home, () =>
      runDecideCommand({ command: 'decide', positional: [paths.runId, 'approve'], flags: { step: 'b/gate' } }, () => {}, project.root),
    );
    await promise;
  });

  it('исход вне перечня — отказ', async () => {
    const { project, runsRoot } = projectWithRuns();
    const { promise, paths } = await startAwaiting(project, runsRoot);

    const { lines, write } = capture();
    const code = await withHome(project.home, () =>
      runDecideCommand({ command: 'decide', positional: [paths.runId, 'nonsense'], flags: {} }, write, project.root),
    );
    assert.notEqual(code, ExitCode.ok);
    assert.ok(lines.some((line) => /nonsense/.test(line)), JSON.stringify(lines));

    await withHome(project.home, () =>
      runDecideCommand({ command: 'decide', positional: [paths.runId, 'approve'], flags: {} }, () => {}, project.root),
    );
    await promise;
  });

  it('reject без причины — отказ; с причиной останавливает прогон отменой', async () => {
    const { project, runsRoot } = projectWithRuns();
    const { promise, paths } = await startAwaiting(project, runsRoot);

    const bad = capture();
    const badCode = await withHome(project.home, () =>
      runDecideCommand({ command: 'decide', positional: [paths.runId, 'deny'], flags: {} }, bad.write, project.root),
    );
    assert.notEqual(badCode, ExitCode.ok);
    assert.ok(bad.lines.some((line) => /причин/.test(line)), JSON.stringify(bad.lines));

    const good = capture();
    const goodCode = await withHome(project.home, () =>
      runDecideCommand(
        { command: 'decide', positional: [paths.runId, 'deny'], flags: { reason: 'не готово' } },
        good.write,
        project.root,
      ),
    );
    assert.equal(goodCode, ExitCode.ok);
    assert.ok(good.lines.some((line) => /deny/.test(line) && /reject/.test(line)), JSON.stringify(good.lines));

    const result = await promise;
    assert.equal(result.status, 'canceled');
  });

  it('restart без --from — отказ; с несуществующим шагом — отказ, называющий доступные', async () => {
    const { project, runsRoot } = projectWithRuns();
    const { promise, paths } = await startAwaiting(project, runsRoot);

    const noFrom = capture();
    const noFromCode = await withHome(project.home, () =>
      runDecideCommand({ command: 'decide', positional: [paths.runId, 'redo'], flags: {} }, noFrom.write, project.root),
    );
    assert.notEqual(noFromCode, ExitCode.ok);
    assert.ok(noFrom.lines.some((line) => /шага, с которого/.test(line)), JSON.stringify(noFrom.lines));

    const badFrom = capture();
    const badFromCode = await withHome(project.home, () =>
      runDecideCommand(
        { command: 'decide', positional: [paths.runId, 'redo'], flags: { from: 'нет-такой-работы' } },
        badFrom.write,
        project.root,
      ),
    );
    assert.notEqual(badFromCode, ExitCode.ok);
    assert.ok(badFrom.lines.some((line) => /нет-такой-работы/.test(line)), JSON.stringify(badFrom.lines));

    const good = capture();
    const goodCode = await withHome(project.home, () =>
      runDecideCommand(
        { command: 'decide', positional: [paths.runId, 'redo'], flags: { from: 'prep' } },
        good.write,
        project.root,
      ),
    );
    assert.equal(goodCode, ExitCode.ok);

    const result = await promise;
    assert.deepEqual(result.restart, { from: 'prep' });
  });

  it('успешная запись называет исход и шаг', async () => {
    const { project, runsRoot } = projectWithRuns();
    const { promise, paths } = await startAwaiting(project, runsRoot);

    const { lines, write } = capture();
    const code = await withHome(project.home, () =>
      runDecideCommand({ command: 'decide', positional: [paths.runId, 'approve'], flags: {} }, write, project.root),
    );
    assert.equal(code, ExitCode.ok);
    assert.ok(lines.some((line) => /apply\/gate/.test(line) && /approve/.test(line)), JSON.stringify(lines));

    const result = await promise;
    assert.equal(result.status, 'success');
  });

  it('прогон с мёртвым процессом: решение записывается, вывод называет команду возобновления', async () => {
    const { project, runsRoot } = projectWithRuns();
    const { promise, paths } = await startAwaiting(project, runsRoot);

    // Подделываем мёртвый pid прямо в манифесте — тот же приём, что и у прочих
    // тестов «мёртвого прогона» (isRunAlive проверяет существование процесса).
    const manifest = readManifest(paths);
    atomicWrite(paths.manifest, `${JSON.stringify({ ...manifest, pid: 999_999_999 }, null, 2)}\n`);

    const { lines, write } = capture();
    const code = await withHome(project.home, () =>
      runDecideCommand({ command: 'decide', positional: [paths.runId, 'approve'], flags: {} }, write, project.root),
    );
    assert.equal(code, ExitCode.ok);
    assert.ok(lines.some((line) => /не идёт/.test(line) && /stepcast resume/.test(line)), JSON.stringify(lines));

    // Решение легло на диск; настоящий процесс (этот тест) всё ещё опрашивает
    // каталог и подхватит его, несмотря на подделанный pid манифеста.
    await promise;
  });
});

describe('decide: строка ожидания в stepcast status', () => {
  it('прогон с непустым awaiting печатается строкой ожидания рядом с местом печати пробуждения', async () => {
    const { project, runsRoot } = projectWithRuns();
    const { promise, paths } = await startAwaiting(project, runsRoot);

    const { lines, write } = capture();
    withHome(project.home, () =>
      runStatusCommand({ command: 'status', positional: [], flags: { run: paths.runId } }, write, project.root),
    );
    assert.ok(lines.some((line) => /ждёт решения/.test(line) && /apply\/gate/.test(line)), JSON.stringify(lines));

    await withHome(project.home, () =>
      runDecideCommand({ command: 'decide', positional: [paths.runId, 'approve'], flags: {} }, () => {}, project.root),
    );
    await promise;
  });

  it('прогон без ожиданий печатается как прежде, без строки ожидания', async () => {
    const { project, runsRoot } = projectWithRuns();
    project.write('stepcast.yml', 'version: 1\nkind: pipeline\nname: без-ожиданий\njobs:\n  build:\n    steps:\n      - id: s\n        run: ["true"]\n');
    const expanded = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config });
    const result = await runPipeline({
      expanded,
      config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
    });

    const { lines, write } = capture();
    withHome(project.home, () =>
      runStatusCommand(
        { command: 'status', positional: [], flags: { run: result.journal.paths.runId } },
        write,
        project.root,
      ),
    );
    assert.ok(!lines.some((line) => /ждёт решения/.test(line)), JSON.stringify(lines));
  });
});
