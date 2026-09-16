import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';

import { ExitCode } from '../src/kernel/errors.js';
import { runPaths } from '../src/parts/pipeline/run/journal/paths.js';
import { listRuns, readStatus } from '../src/parts/pipeline/run/journal/reader.js';
import { writeDecisionRecord } from '../src/parts/pipeline/run/journal/writer.js';
import { expandPipeline } from '../src/parts/pipeline/document/expand.js';
import { builtinRegistry } from '../src/parts/builtin.js';
import { runPipeline } from '../src/parts/pipeline/run/runner.js';
import { continueRestartChain } from '../src/parts/pipeline/commands/resume.js';
import { runRunCommand } from '../src/parts/pipeline/commands/run.js';
import type { ParsedArgs } from '../src/kernel/cli/types.js';
import { makeProject, withHome, type Project } from './helpers.js';
import { tempDir } from './tmp.js';

/**
 * Цепочка перезапуска (design.md изменения `user-decision-steps`, решение 4):
 * прогон с шагом решения получает исход `restart`, и `stepcast run` сам, без
 * участия демона, планирует и исполняет возобновление с названного места, —
 * тест вызывает команду напрямую, без единой строки кода витрины или демона, и
 * это само по себе показывает, что цепочку ведёт команда.
 */

const POLL_MS = 20;

/** Три работы подряд: точка перезапуска выбирается посередине, чтобы было что переиспользовать. */
const PIPELINE = `
version: 1
kind: pipeline
name: цепочка-перезапуска
jobs:
  prep:
    steps:
      - id: build
        run: ["true"]
  mid:
    needs: [prep]
    steps:
      - id: check
        run: ["true"]
  apply:
    needs: [mid]
    steps:
      - id: gate
        decision:
          prompt: продолжить?
          outcomes:
            approve: continue
            redo: { effect: restart }
`;

function args(positional: string[] = [], flags: ParsedArgs['flags'] = {}): ParsedArgs {
  return { command: 'run', positional, flags };
}

function capture(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('условие не выполнилось вовремя');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Слепок каталога прогона: путь → отпечаток содержимого. Снимок движка
 * пропускается — это копия пакета, а не журнал, и читать её целиком незачем.
 */
function snapshot(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const key = relative(dir, path);
    if (key.startsWith('engine')) continue;
    files.set(key, createHash('sha256').update(readFileSync(path)).digest('hex'));
  }
  return files;
}

interface Bed {
  readonly project: Project;
  readonly runsRoot: string;
}

function bed(pipeline: string = PIPELINE): Bed {
  const project = makeProject({ 'stepcast.yml': pipeline });
  const runsRoot = tempDir('runs-');
  return { project, runsRoot };
}

function configOf(b: Bed) {
  return { ...b.project.config, runs: { ...b.project.config.runs, root: b.runsRoot } };
}

/** Первый прогон: исполняется до шага решения и останавливается на нём. */
function startRun(b: Bed, registry = builtinRegistry(), signal?: AbortSignal) {
  return runPipeline({
    expanded: expandPipeline({ pipelinePath: b.project.path('stepcast.yml'), config: b.project.config, registry }),
    config: configOf(b),
    projectRoot: b.project.root,
    cwd: b.project.root,
    registry,
    decisionPollIntervalMs: POLL_MS,
    ...(signal === undefined ? {} : { signal }),
  });
}

describe('resume-chain: восстановление по просьбе о перезапуске', () => {
  it('переиспользует шаги выше точки, а журнал исходного прогона не трогает', async () => {
    const b = bed();
    const registry = builtinRegistry();
    const first = await (async () => {
      const promise = startRun(b, registry);
      await waitUntil(() => listRuns(b.runsRoot, b.project.root).length === 1);
      const id = listRuns(b.runsRoot, b.project.root)[0] as string;
      const paths = runPaths(b.runsRoot, projectKeyOf(b), id);
      await waitUntil(() => (readStatus(paths).awaiting?.length ?? 0) > 0);
      const waitId = readStatus(paths).awaiting?.[0]?.wait_id as string;
      writeDecisionRecord(paths, waitId, { outcome: 'redo', restart_from: 'mid' });
      return { result: await promise, paths, id };
    })();

    assert.equal(first.result.status, 'canceled');
    assert.deepEqual(first.result.restart, { from: 'mid' });
    assert.equal(readStatus(first.paths).restart_from, 'mid');

    // Слепок снимается ДО возобновления: сравнение двух чтений одного файла
    // после цепочки не сказало бы о её ходе ничего.
    const before = snapshot(first.paths.dir);

    const { lines, write } = capture();
    const chain = continueRestartChain('mid', first.paths, configOf(b), b.project.root, write, registry);

    await waitUntil(() => listRuns(b.runsRoot, b.project.root).length === 2);
    const secondId = listRuns(b.runsRoot, b.project.root).find((id) => id !== first.id) as string;
    const secondPaths = runPaths(b.runsRoot, projectKeyOf(b), secondId);
    await waitUntil(() => (readStatus(secondPaths).awaiting?.length ?? 0) > 0);
    writeDecisionRecord(secondPaths, readStatus(secondPaths).awaiting?.[0]?.wait_id as string, {
      outcome: 'approve',
    });

    assert.equal(await chain, ExitCode.ok);
    assert.ok(lines.some((line) => /: success$/.test(line)), JSON.stringify(lines));

    const second = readStatus(secondPaths);
    assert.equal(second.status, 'success');
    assert.equal(second.resumed_from, first.id);
    // Шаг выше точки взят из исходного прогона, точка и всё ниже — исполнены
    // заново (дельта `run-resume`, сценарий «Шаги выше точки переиспользованы»).
    assert.ok(second.jobs.find((job) => job.id === 'prep')?.steps[0]?.reused_from !== undefined);
    assert.equal(second.jobs.find((job) => job.id === 'mid')?.steps[0]?.reused_from, undefined);
    assert.equal(second.jobs.find((job) => job.id === 'apply')?.steps[0]?.reused_from, undefined);

    assert.deepEqual(snapshot(first.paths.dir), before, 'файлы исходного прогона изменились');
  });

  it('отмена команды прерывает звено цепочки, стоящее на шаге решения', async () => {
    const b = bed();
    const registry = builtinRegistry();
    const promise = startRun(b, registry);
    await waitUntil(() => listRuns(b.runsRoot, b.project.root).length === 1);
    const firstId = listRuns(b.runsRoot, b.project.root)[0] as string;
    const firstPaths = runPaths(b.runsRoot, projectKeyOf(b), firstId);
    await waitUntil(() => (readStatus(firstPaths).awaiting?.length ?? 0) > 0);
    writeDecisionRecord(firstPaths, readStatus(firstPaths).awaiting?.[0]?.wait_id as string, {
      outcome: 'redo',
      restart_from: 'mid',
    });
    await promise;

    // Звену цепочки передаётся тот же сигнал, что получил первый прогон: без
    // него Ctrl-C на ожидающем звене не отменял бы ничего, и выйти из него
    // штатно было бы нельзя — ожидание решения бессрочно.
    const controller = new AbortController();
    const { write } = capture();
    const chain = continueRestartChain(
      'mid',
      firstPaths,
      configOf(b),
      b.project.root,
      write,
      registry,
      controller.signal,
    );

    await waitUntil(() => listRuns(b.runsRoot, b.project.root).length === 2);
    const secondId = listRuns(b.runsRoot, b.project.root).find((id) => id !== firstId) as string;
    const secondPaths = runPaths(b.runsRoot, projectKeyOf(b), secondId);
    await waitUntil(() => (readStatus(secondPaths).awaiting?.length ?? 0) > 0);

    const started = Date.now();
    controller.abort();
    await chain;
    assert.ok(Date.now() - started < 5000, 'отмена не должна ждать такта опроса');

    const second = readStatus(secondPaths);
    assert.equal(second.status, 'canceled');
    assert.deepEqual(second.awaiting, undefined, 'закончившийся прогон ничего не ждёт');
  });

  it('прогон, запущенный командой, ведёт цепочку сам — без демона', async () => {
    const project = makeProject({ 'stepcast.yml': PIPELINE });
    const runsRoot = tempDir('runs-');
    // `runs.root` допустим только в глобальной конфигурации.
    writeFileSync(join(project.home, '.stepcast', 'config.yml'), `runs:\n  root: ${runsRoot}\n`);
    const { lines, write } = capture();

    const promise = withHome(project.home, () => runRunCommand(args(['stepcast.yml']), write, project.root));

    await waitUntil(() => listRuns(runsRoot, project.root).length === 1);
    const firstRunId = listRuns(runsRoot, project.root)[0] as string;
    const { projectKey } = await import('../src/parts/pipeline/run/journal/paths.js');
    const firstPaths = runPaths(runsRoot, projectKey(project.root), firstRunId);
    await waitUntil(() => (readStatus(firstPaths).awaiting?.length ?? 0) > 0);
    writeDecisionRecord(firstPaths, readStatus(firstPaths).awaiting?.[0]?.wait_id as string, {
      outcome: 'redo',
      restart_from: 'mid',
    });

    await waitUntil(() => listRuns(runsRoot, project.root).length === 2);
    const secondRunId = listRuns(runsRoot, project.root).find((id) => id !== firstRunId) as string;
    const secondPaths = runPaths(runsRoot, projectKey(project.root), secondRunId);
    await waitUntil(() => (readStatus(secondPaths).awaiting?.length ?? 0) > 0);
    writeDecisionRecord(secondPaths, readStatus(secondPaths).awaiting?.[0]?.wait_id as string, { outcome: 'approve' });

    const exitCode = await promise;

    assert.equal(exitCode, ExitCode.ok);
    const summaryLines = lines.filter((line) => /^прогон .+: (canceled|success)$/.test(line));
    assert.equal(summaryLines.length, 2, JSON.stringify(lines));
    assert.match(summaryLines[0] as string, /: canceled$/);
    assert.match(summaryLines[1] as string, /: success$/);
  });
});

/** Ключ проекта в корне прогонов: тест заводит ровно один проект на корень. */
function projectKeyOf(b: Bed): string {
  return readdirSync(b.runsRoot).find((name) => name !== 'projects.json') as string;
}
