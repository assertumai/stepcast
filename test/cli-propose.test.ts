import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ExitCode } from '../src/core/errors.js';
import { runProposeCommand } from '../src/cli/commands/propose.js';
import { proposalsDirPath, readProposalsDir } from '../src/core/proposals/store.js';
import { makeJournalBed, seedRun, withHome } from './helpers.js';
import { tempDir } from './tmp.js';

function capture(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

/** Переменные STEPCAST_* окружения шага — устанавливаются на время вызова и снимаются после. */
function withStepEnv<T>(vars: Readonly<Record<string, string | undefined>>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(vars)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  const restore = (): void => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  try {
    const result = fn();
    if (result instanceof Promise) return result.finally(restore) as T;
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

/** Фальшивый HOME на время вызова — иначе `resolveConfig` внутри команды подхватила бы настоящий `~/.stepcast/config.yml`. */
function withFakeHome<T>(fn: () => T): T {
  const home = tempDir('propose-home-');
  mkdirSync(join(home, '.stepcast'), { recursive: true });
  return withHome(home, fn);
}

/**
 * Снять окружение прогона на время вызова: сама эта проверка почти наверняка
 * гоняется самим stepcast (петля саморазвития) и наследует `STEPCAST_RUN_DIR`
 * и соседей от внешнего прогона (`test/helpers.ts`, `testBaseEnv`) — без
 * снятия команда сочла бы себя вызванной изнутри чужого, настоящего прогона.
 */
function withoutRunEnv<T>(fn: () => T): T {
  return withStepEnv(
    { STEPCAST_RUN_DIR: undefined, STEPCAST_RUN_ID: undefined, STEPCAST_JOB: undefined, STEPCAST_STEP: undefined },
    fn,
  );
}

describe('cli propose: постановка из шага прогона', () => {
  it('workspace: worktree — запись встаёт в проект, а не во временное дерево', async () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot);

    // Временное дерево работы (`workspace: worktree`) — рабочая директория
    // команды, но не проект: очередь обязана лечь в `projectRoot`, а не сюда.
    const worktree = tempDir('worktree-');
    mkdirSync(join(worktree, '.stepcast'), { recursive: true });

    const contentFile = join(worktree, 'clock.tsx');
    writeFileSync(contentFile, 'export default 1;\n');

    const { lines, write } = capture();
    const code = await withFakeHome(() =>
      withStepEnv(
        {
          STEPCAST_RUN_DIR: journal.paths.dir,
          STEPCAST_RUN_ID: journal.paths.runId,
          STEPCAST_JOB: 'migrate',
          STEPCAST_STEP: 'agent',
        },
        () =>
          runProposeCommand(
            { command: 'propose', positional: ['.stepcast/widgets/clock.tsx'], flags: { from: contentFile } },
            write,
            worktree,
          ),
      ),
    );

    assert.equal(code, ExitCode.ok, lines.join('\n'));
    const inProject = readProposalsDir(projectRoot);
    assert.equal(inProject.records.length, 1);
    assert.equal(inProject.records[0]?.origin.run, journal.paths.runId);
    assert.equal(inProject.records[0]?.origin.job, 'migrate');
    assert.equal(inProject.records[0]?.origin.step, 'agent');
    assert.equal(existsSync(proposalsDirPath(worktree)), false);
  });
});

describe('cli propose: вызов вне прогона', () => {
  function project(): string {
    const dir = tempDir('propose-cli-');
    mkdirSync(join(dir, '.git'), { recursive: true });
    mkdirSync(join(dir, '.stepcast'), { recursive: true });
    return dir;
  }

  it('вызов руками — запись встаёт в очередь этого проекта, происхождение пусто', async () => {
    const dir = project();
    const contentFile = join(dir, 'clock.tsx');
    writeFileSync(contentFile, 'export default 1;\n');

    const { lines, write } = capture();
    const code = await withFakeHome(() =>
      withoutRunEnv(() =>
        runProposeCommand(
          { command: 'propose', positional: ['.stepcast/widgets/clock.tsx'], flags: { from: contentFile } },
          write,
          dir,
        ),
      ),
    );

    assert.equal(code, ExitCode.ok, lines.join('\n'));
    const result = readProposalsDir(dir);
    assert.equal(result.records.length, 1);
    assert.deepEqual(result.records[0]?.origin, {});
  });

  it('содержимое стандартным вводом', async () => {
    const dir = project();
    const { write } = capture();
    const code = await withFakeHome(() =>
      withoutRunEnv(() =>
        runProposeCommand(
          { command: 'propose', positional: ['.stepcast/widgets/clock.tsx'], flags: {} },
          write,
          dir,
          async () => 'export default 2;\n',
        ),
      ),
    );
    assert.equal(code, ExitCode.ok);
    const result = readProposalsDir(dir);
    assert.equal(result.records[0]?.content, 'export default 2;\n');
  });

  it('содержимого нет вовсе — отказ, очередь не меняется', async () => {
    const dir = project();
    const { write } = capture();
    const code = await withFakeHome(() =>
      withoutRunEnv(() =>
        runProposeCommand(
          { command: 'propose', positional: ['.stepcast/widgets/clock.tsx'], flags: {} },
          write,
          dir,
          async () => '',
        ),
      ),
    );
    assert.equal(code, ExitCode.configError);
    assert.equal(existsSync(proposalsDirPath(dir)), false);
  });

  it('нечитаемый --from — отказ', async () => {
    const dir = project();
    const { write } = capture();
    const code = await withFakeHome(() =>
      withoutRunEnv(() =>
        runProposeCommand(
          {
            command: 'propose',
            positional: ['.stepcast/widgets/clock.tsx'],
            flags: { from: join(dir, 'нет-такого-файла.tsx') },
          },
          write,
          dir,
        ),
      ),
    );
    assert.equal(code, ExitCode.configError);
  });

  it('чужая цель — отказ, очередь не меняется', async () => {
    const dir = project();
    const { write } = capture();
    const code = await withFakeHome(() =>
      withoutRunEnv(() =>
        runProposeCommand(
          { command: 'propose', positional: ['.stepcast/config.yml'], flags: {} },
          write,
          dir,
          async () => 'version: 1\n',
        ),
      ),
    );
    assert.equal(code, ExitCode.configError);
    assert.equal(existsSync(proposalsDirPath(dir)), false);
  });

  it('режим queue по умолчанию — цель не меняется, запись открыта', async () => {
    const dir = project();
    const { write } = capture();
    const code = await withFakeHome(() =>
      withoutRunEnv(() =>
        runProposeCommand(
          { command: 'propose', positional: ['.stepcast/dashboards/release.yml'], flags: {} },
          write,
          dir,
          async () => 'title: r\n',
        ),
      ),
    );
    assert.equal(code, ExitCode.ok);
    assert.equal(existsSync(join(dir, '.stepcast', 'dashboards', 'release.yml')), false);
    assert.equal(readProposalsDir(dir).records[0]?.state, 'pending');
  });

  it('режим direct — цель записана немедленно, очередь остаётся пустой', async () => {
    const dir = project();
    writeFileSync(join(dir, '.stepcast', 'config.yml'), 'project:\n  proposals: direct\n');
    const { lines, write } = capture();
    const code = await withFakeHome(() =>
      withoutRunEnv(() =>
        runProposeCommand(
          { command: 'propose', positional: ['.stepcast/dashboards/release.yml'], flags: {} },
          write,
          dir,
          async () => 'title: r\n',
        ),
      ),
    );
    assert.equal(code, ExitCode.ok);
    assert.equal(readFileSync(join(dir, '.stepcast', 'dashboards', 'release.yml'), 'utf8'), 'title: r\n');
    assert.equal(existsSync(proposalsDirPath(dir)), false);
    assert.match(lines.join('\n'), /release\.yml/);
  });
});
