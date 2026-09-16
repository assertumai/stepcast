import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { resolveConfig } from '../src/parts/pipeline/config/resolve.js';
import { buildPipelines } from '../src/parts/ui/pipelines.js';
import { makeJournalBed, seedRun } from './helpers.js';

/**
 * Что вид пайплайна несёт доске: объявленное имя и перечень объявленных
 * входов. Диалог «Взять в работу» показывает пайплайны по имени и передаёт
 * слаг пункта только тому, кто вход объявил, — оба значения приходят отсюда,
 * из вида, а не из ядра.
 */

function bed() {
  const { runsRoot, projectRoot, home } = makeJournalBed();
  seedRun(runsRoot, projectRoot, { runId: 'a' });
  mkdirSync(join(projectRoot, '.stepcast', 'pipelines'), { recursive: true });
  return { runsRoot, projectRoot, home };
}

function write(projectRoot: string, name: string, body: string): void {
  writeFileSync(join(projectRoot, '.stepcast', 'pipelines', name), body);
}

const JOB = `kind: pipeline
name: %NAME%
%INPUTS%jobs:
  work:
    steps:
      - id: a
        run: [echo, ok]
`;

function document(name: string, inputs?: string): string {
  return JOB.replace('%NAME%', name).replace('%INPUTS%', inputs === undefined ? '' : inputs);
}

describe('ui-pipelines: имя и входы в виде пайплайна', () => {
  it('несёт объявленное имя документа, а не имя файла', async () => {
    const { runsRoot, projectRoot, home } = bed();
    write(projectRoot, 'loop.yml', document('self-improve'));
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });

    const view = (await buildPipelines(runsRoot, config, { home })).pipelines.find((entry) =>
      entry.file.endsWith('loop.yml'),
    );

    assert.equal(view?.name, 'self-improve');
  });

  it('перечисляет объявленные входы: по ним доска решает, кому передавать пункт', async () => {
    const { runsRoot, projectRoot, home } = bed();
    write(projectRoot, 'with-item.yml', document('takes-item', "inputs:\n  item: { type: string, default: '' }\n"));
    write(projectRoot, 'plain.yml', document('no-inputs'));
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });

    const pipelines = (await buildPipelines(runsRoot, config, { home })).pipelines;
    const withItem = pipelines.find((entry) => entry.file.endsWith('with-item.yml'));
    const plain = pipelines.find((entry) => entry.file.endsWith('plain.yml'));

    assert.deepEqual([...(withItem?.inputs ?? [])], ['item']);
    assert.deepEqual([...(plain?.inputs ?? [])], []);
  });

  it('находит все файлы каталога пайплайнов проекта: перечня доска не ведёт', async () => {
    const { runsRoot, projectRoot, home } = bed();
    write(projectRoot, 'one.yml', document('one'));
    write(projectRoot, 'two.yml', document('two'));
    const { config } = resolveConfig({ cwd: home, home, projectPath: null });

    const names = (await buildPipelines(runsRoot, config, { home })).pipelines.map((entry) => entry.name).sort();

    assert.deepEqual(names, ['one', 'two']);
  });
});
