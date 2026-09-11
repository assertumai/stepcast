import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative as relativePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { isEditableEngine, locateEngine, pinEngine, type EngineLocation } from '../src/core/run/engine.js';
import { StepcastError } from '../src/core/errors.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { runPipeline, type RunResult } from '../src/core/run/runner.js';
import { planResume, readSourceRun } from '../src/core/run/resumePlan.js';
import { readEvents, readManifest } from '../src/core/journal/reader.js';
import type { Event } from '../src/core/journal/schema.js';
import { makeProject, testBaseEnv, type Project } from './helpers.js';
import { tempDir } from './tmp.js';

describe('run-engine-snapshot: locateEngine — расположение исполняющего движка', () => {
  it('возвращает существующий корень пакета и существующую точку входа', () => {
    const location = locateEngine();
    assert.ok(existsSync(join(location.root, 'package.json')), `${location.root}/package.json должен существовать`);
    assert.ok(existsSync(location.entry), `${location.entry} должен существовать`);
  });

  /**
   * Корень и точка входа берутся от расположения модуля движка и от `bin`
   * его пакета, а не от `process.argv[1]`: у движка, поднятого библиотекой,
   * обёрткой — или, как здесь, тестовым бегунком, — `argv[1]` называет файл
   * вызывающего, и снимок сняли бы с чужого пакета.
   */
  it('не выводит движок из process.argv[1]: точка входа — объявленный bin пакета', () => {
    const location = locateEngine();
    const declared = JSON.parse(readFileSync(join(location.root, 'package.json'), 'utf8')) as {
      readonly name?: string;
      readonly bin?: Readonly<Record<string, string>>;
    };
    const bin = declared.bin?.[declared.name ?? ''];

    assert.ok(bin !== undefined, 'пакет движка объявляет bin — иначе проверять нечего');
    assert.equal(location.entry, join(location.root, bin));
    assert.notEqual(
      location.entry,
      process.argv[1],
      'argv[1] тестового процесса — файл теста, и совпадение значило бы, что расположение выведено из него',
    );
    const inside = relativePath(location.root, location.entry);
    assert.equal(inside.startsWith('..'), false, 'точка входа обязана лежать внутри корня пакета');
  });
});

describe('run-engine-snapshot: isEditableEngine — предикат правимости', () => {
  it('корень пакета движка внутри дерева проекта — правим', () => {
    const tree = tempDir('stepcast-tree-');
    const engineRoot = join(tree, 'packages', 'engine');
    mkdirSync(engineRoot, { recursive: true });

    assert.equal(isEditableEngine({ engineRoot, projectRoot: tree }), true);
  });

  it('движок установлен зависимостью проекта (<дерево>/node_modules/<пакет>) — не правим', () => {
    const tree = tempDir('stepcast-tree-');
    const engineRoot = join(tree, 'node_modules', 'stepcast');
    mkdirSync(engineRoot, { recursive: true });

    assert.equal(isEditableEngine({ engineRoot, projectRoot: tree }), false);
  });

  it('корень пакета движка лежит вне дерева проекта — не правим', () => {
    const tree = tempDir('stepcast-tree-');
    const outside = tempDir('stepcast-outside-');

    assert.equal(isEditableEngine({ engineRoot: outside, projectRoot: tree }), false);
  });

  it('цепочка символических ссылок распознаётся правимой, буквальное сравнение — нет', () => {
    const tree = tempDir('stepcast-tree-');
    const engineRoot = join(tree, 'packages', 'engine');
    mkdirSync(engineRoot, { recursive: true });

    // /opt/homebrew/bin/stepcast → .../lib/node_modules/stepcast → рабочее
    // дерево: та же цепочка, что в design.md, решение 2.
    const installDir = tempDir('stepcast-install-');
    const linkedRoot = join(installDir, 'stepcast');
    symlinkSync(engineRoot, linkedRoot, 'dir');

    assert.equal(
      linkedRoot.startsWith(`${tree}/`),
      false,
      'буквальный путь ссылки не должен формально лежать под деревом — иначе разрешение симлинков нечего было бы проверять',
    );
    assert.equal(isEditableEngine({ engineRoot: linkedRoot, projectRoot: tree }), true);
  });
});

/** Пакет движка на диске: package.json, dist/bin.js, schema/, node_modules/. */
function makeEnginePackage(options: { readonly files?: readonly string[]; readonly content?: string } = {}): {
  readonly root: string;
  readonly entry: string;
} {
  const root = tempDir('stepcast-engine-');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'fake-engine',
      ...(options.files === undefined ? {} : { files: options.files }),
    }),
  );
  mkdirSync(join(root, 'dist', 'src'), { recursive: true });
  const entry = join(root, 'dist', 'src', 'bin.js');
  writeFileSync(entry, options.content ?? '#!/usr/bin/env node\n');
  chmodSync(entry, 0o755);
  mkdirSync(join(root, 'schema'), { recursive: true });
  writeFileSync(join(root, 'schema', 'foo.schema.json'), '{}');
  mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
  return { root, entry };
}

describe('run-engine-snapshot: pinEngine — снятие снимка', () => {
  it('снимок содержит package.json, объявленные files и ссылку node_modules', () => {
    const engine = makeEnginePackage({ files: ['dist', 'schema'] });
    const snapshotDir = join(tempDir('stepcast-run-'), 'engine');

    const pinnedEntry = pinEngine({ engine, snapshotDir });

    assert.equal(pinnedEntry, join(snapshotDir, 'dist', 'src', 'bin.js'));
    assert.ok(existsSync(join(snapshotDir, 'package.json')));
    assert.ok(existsSync(pinnedEntry));
    assert.ok(existsSync(join(snapshotDir, 'schema', 'foo.schema.json')));
    assert.equal(lstatSync(join(snapshotDir, 'node_modules')).isSymbolicLink(), true);
    assert.equal(
      readFileSync(join(snapshotDir, 'node_modules', 'dep', 'index.js'), 'utf8'),
      'module.exports = 1;\n',
    );
  });

  it('бит исполнения точки входа сохранён', () => {
    const engine = makeEnginePackage({ files: ['dist'] });
    const snapshotDir = join(tempDir('stepcast-run-'), 'engine');

    const pinnedEntry = pinEngine({ engine, snapshotDir });

    assert.equal(statSync(pinnedEntry).mode & 0o777, 0o755);
  });

  it('пакет без объявленного files копируется целиком, минус node_modules и .git', () => {
    const root = tempDir('stepcast-engine-');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fake-engine' }));
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'bin.js'), 'x');
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), '1');

    const snapshotDir = join(tempDir('stepcast-run-'), 'engine');
    pinEngine({ engine: { root, entry: join(root, 'dist', 'bin.js') }, snapshotDir });

    assert.ok(existsSync(join(snapshotDir, 'dist', 'bin.js')));
    assert.equal(existsSync(join(snapshotDir, '.git')), false);
    // Ссылка, а не копия каталога с содержимым.
    assert.equal(lstatSync(join(snapshotDir, 'node_modules')).isSymbolicLink(), true);
  });

  it('отказ снятия снимка называет причину и не проглатывается', () => {
    const root = tempDir('stepcast-engine-'); // package.json отсутствует
    const snapshotDir = join(tempDir('stepcast-run-'), 'engine');

    assert.throws(
      () => pinEngine({ engine: { root, entry: join(root, 'dist', 'bin.js') }, snapshotDir }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /package\.json/);
        return true;
      },
    );
  });

  it('точка входа, не покрытая объявленным files, — отказ, а не снимок с висящим STEPCAST_BIN', () => {
    // npm кладёт файлы из `bin` в пакет независимо от `files`, так что такое
    // объявление законно, а снимок по нему точку входа теряет.
    const root = tempDir('stepcast-engine-');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fake-engine', files: ['lib'] }));
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(join(root, 'lib', 'index.js'), 'x');
    const entry = join(root, 'cli.js');
    writeFileSync(entry, 'x');

    assert.throws(
      () => pinEngine({ engine: { root, entry }, snapshotDir: join(tempDir('stepcast-run-'), 'engine') }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /Точка входа движка не попала в снимок/);
        return true;
      },
    );
  });

  it('точка входа вне корня пакета — отказ до всякого копирования', () => {
    const root = tempDir('stepcast-engine-');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fake-engine' }));
    const snapshotDir = join(tempDir('stepcast-run-'), 'engine');

    assert.throws(
      () => pinEngine({ engine: { root, entry: join(tempDir('stepcast-elsewhere-'), 'bin.js') }, snapshotDir }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /лежит вне его пакета/);
        return true;
      },
    );
    assert.equal(existsSync(snapshotDir), false, 'до отказа каталог снимка не создаётся');
  });

  it('files с шаблоном копирует корень целиком, а не падает на несуществующем пути', () => {
    const root = tempDir('stepcast-engine-');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'fake-engine', files: ['dist/*.js', '!dist/test'] }),
    );
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'bin.js'), 'ORIGINAL');
    writeFileSync(join(root, 'README.md'), 'читать');
    mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), '1');

    const snapshotDir = join(tempDir('stepcast-run-'), 'engine');
    const pinnedEntry = pinEngine({ engine: { root, entry: join(root, 'dist', 'bin.js') }, snapshotDir });

    assert.equal(readFileSync(pinnedEntry, 'utf8'), 'ORIGINAL');
    assert.ok(existsSync(join(snapshotDir, 'README.md')), 'шаблон разбирать нечем — копируется весь корень');
    assert.equal(lstatSync(join(snapshotDir, 'node_modules')).isSymbolicLink(), true);
  });

  it('запись files, которой нет на диске, пропускается — как её пропускает npm', () => {
    const root = tempDir('stepcast-engine-');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fake-engine', files: ['dist', 'schema'] }));
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'bin.js'), 'x');

    const snapshotDir = join(tempDir('stepcast-run-'), 'engine');
    pinEngine({ engine: { root, entry: join(root, 'dist', 'bin.js') }, snapshotDir });

    assert.ok(existsSync(join(snapshotDir, 'dist', 'bin.js')));
    assert.equal(existsSync(join(snapshotDir, 'schema')), false);
  });
});

/**
 * Зависимости снимка: ссылка на `node_modules` исходного пакета отдаёт снимку
 * его зависимости, но только те, что лежат в самом пакете. Движок в
 * монорепозитории с поднятыми в корень зависимостями — конфигурация, названная
 * целевой, — из снимка их не разрешит, и это обязан быть внятный отказ на
 * старте, а не ERR_MODULE_NOT_FOUND посреди прогона.
 */
describe('run-engine-snapshot: pinEngine — разрешимость зависимостей из снимка', () => {
  function engineWith(options: {
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly installed?: readonly string[];
  }): EngineLocation {
    const root = tempDir('stepcast-engine-');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'fake-engine',
        files: ['dist'],
        ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
      }),
    );
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'bin.js'), 'x');
    for (const name of options.installed ?? []) {
      mkdirSync(join(root, 'node_modules', ...name.split('/')), { recursive: true });
    }
    return { root, entry: join(root, 'dist', 'bin.js') };
  }

  it('зависимости подняты выше корня пакета: отказ называет их и каталог', () => {
    const engine = engineWith({ dependencies: { zod: '^4', execa: '^9' } });

    assert.throws(
      () => pinEngine({ engine, snapshotDir: join(tempDir('stepcast-run-'), 'engine') }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /Зависимости движка не разрешаются из снимка/);
        assert.match(error.message, /zod/);
        return true;
      },
    );
  });

  it('часть зависимостей в node_modules пакета отсутствует: отказ называет недостающие', () => {
    const engine = engineWith({ dependencies: { zod: '^4', execa: '^9' }, installed: ['zod'] });

    assert.throws(
      () => pinEngine({ engine, snapshotDir: join(tempDir('stepcast-run-'), 'engine') }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /execa/);
        assert.doesNotMatch(error.message, /zod/);
        return true;
      },
    );
  });

  it('пакет без зависимостей и без node_modules снимается без ссылки и без отказа', () => {
    const engine = engineWith({});
    const snapshotDir = join(tempDir('stepcast-run-'), 'engine');

    const pinnedEntry = pinEngine({ engine, snapshotDir });

    assert.ok(existsSync(pinnedEntry));
    assert.equal(existsSync(join(snapshotDir, 'node_modules')), false, 'висячей ссылки быть не должно');
  });
});

/** Прогон минимального пайплайна с подставленным расположением движка. */
async function run(
  project: Project,
  engineLocator: () => EngineLocation,
  onEvent?: (event: Event) => void,
): Promise<RunResult> {
  const runsRoot = tempDir('runs-');
  return runPipeline({
    expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
    config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
    projectRoot: project.root,
    cwd: project.root,
    baseEnv: testBaseEnv(),
    engineLocator,
    ...(onEvent === undefined ? {} : { onEvent: (event: Event) => onEvent(event) }),
  });
}

const CHECK_BIN_PIPELINE = `
version: 1
kind: pipeline
name: checked
workspace: { mode: cwd }
jobs:
  build:
    steps:
      - id: check
        run: [sh, -c, 'test "$STEPCAST_BIN" = "$STEPCAST_RUN_DIR/engine/dist/src/bin.js"']
        expect: [{ exit_code: 0 }]
`;

describe('run-engine-snapshot: фиксация движка при прогоне', () => {
  it('движок внутри дерева проекта: снимок снят, манифест называет его', async () => {
    const project = makeProject({ 'stepcast.yml': CHECK_BIN_PIPELINE });
    const engineRoot = project.path('vendor/engine');
    mkdirSync(join(engineRoot, 'dist', 'src'), { recursive: true });
    writeFileSync(join(engineRoot, 'package.json'), JSON.stringify({ name: 'fake-engine', files: ['dist'] }));
    const entry = join(engineRoot, 'dist', 'src', 'bin.js');
    writeFileSync(entry, 'ORIGINAL');
    chmodSync(entry, 0o755);

    const result = await run(project, () => ({ root: engineRoot, entry }));

    assert.equal(result.status, 'success');
    assert.ok(existsSync(result.journal.paths.engine));
    assert.ok(existsSync(join(result.journal.paths.engine, 'dist', 'src', 'bin.js')));
    const manifest = readManifest(result.journal.paths);
    assert.equal(manifest.engine?.pinned, true);
    assert.equal(manifest.engine?.root, engineRoot);
    assert.equal(manifest.engine?.entry, join(result.journal.paths.engine, 'dist', 'src', 'bin.js'));
  });

  it('движок вне дерева проекта: каталог engine/ не создаётся, манифест называет установку', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: checked
workspace: { mode: cwd }
jobs:
  build:
    steps:
      - id: check
        run: [sh, -c, 'test -n "$STEPCAST_BIN"']
        expect: [{ exit_code: 0 }]
`,
    });
    const engine = makeEnginePackage({ files: ['dist'] });

    const result = await run(project, () => engine);

    assert.equal(result.status, 'success');
    assert.equal(existsSync(result.journal.paths.engine), false);
    const manifest = readManifest(result.journal.paths);
    assert.equal(manifest.engine?.pinned, false);
    assert.equal(manifest.engine?.root, engine.root);
    assert.equal(manifest.engine?.entry, engine.entry);
  });

  it('отказ снятия снимка останавливает прогон до первого события работы', async () => {
    const project = makeProject({ 'stepcast.yml': CHECK_BIN_PIPELINE });
    const engineRoot = project.path('vendor/broken-engine'); // без package.json
    mkdirSync(engineRoot, { recursive: true });

    const events: Event['kind'][] = [];
    await assert.rejects(
      run(project, () => ({ root: engineRoot, entry: join(engineRoot, 'dist', 'src', 'bin.js') }), (event) =>
        events.push(event.kind),
      ),
      StepcastError,
    );

    assert.ok(events.includes('run.started'), 'run.started обязано быть записано до отказа снимка');
    assert.equal(events.includes('job.started'), false, 'до первой работы прогон не дошёл');
  });
});

describe('step-execution: STEPCAST_BIN — точка входа движка этого прогона', () => {
  it('шаг видит STEPCAST_BIN, ведущий в каталог прогона', async () => {
    const project = makeProject({ 'stepcast.yml': CHECK_BIN_PIPELINE });
    const engineRoot = project.path('vendor/engine');
    mkdirSync(join(engineRoot, 'dist', 'src'), { recursive: true });
    writeFileSync(join(engineRoot, 'package.json'), JSON.stringify({ name: 'fake-engine', files: ['dist'] }));
    const entry = join(engineRoot, 'dist', 'src', 'bin.js');
    writeFileSync(entry, 'x');
    chmodSync(entry, 0o755);

    const result = await run(project, () => ({ root: engineRoot, entry }));

    assert.equal(result.status, 'success');
  });

  it('движок вне правимого дерева: переменная несёт прежнее значение', async () => {
    const engine = makeEnginePackage({ files: ['dist'] });
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: checked
workspace: { mode: cwd }
jobs:
  build:
    steps:
      - id: check
        run: [sh, -c, 'test "$STEPCAST_BIN" = "${engine.entry}"']
        expect: [{ exit_code: 0 }]
`,
    });

    const result = await run(project, () => engine);

    assert.equal(result.status, 'success');
  });
});

describe('run-engine-snapshot: пересборка дерева не меняет код, которым идут следующие шаги', () => {
  it('второй шаг исполняет снимок, а не переписанный файл дерева', async () => {
    const project = makeProject({});
    const engineRoot = project.path('vendor/engine');
    mkdirSync(join(engineRoot, 'dist', 'src'), { recursive: true });
    writeFileSync(join(engineRoot, 'package.json'), JSON.stringify({ name: 'fake-engine', files: ['dist'] }));
    const entry = join(engineRoot, 'dist', 'src', 'bin.js');
    writeFileSync(entry, 'ORIGINAL');
    chmodSync(entry, 0o755);

    project.write(
      'stepcast.yml',
      `
version: 1
kind: pipeline
name: checked
workspace: { mode: cwd }
jobs:
  build:
    steps:
      - id: rewrite
        run: [sh, -c, 'printf %s "$STEPCAST_BIN" > "$STEPCAST_ARTIFACTS/bin1.txt"; printf %s REWRITTEN > "${entry}"']
        expect: [{ exit_code: 0 }]
      - id: read
        run: [sh, -c, 'printf %s "$STEPCAST_BIN" > "$STEPCAST_ARTIFACTS/bin2.txt"; cat "$STEPCAST_BIN" > "$STEPCAST_ARTIFACTS/content.txt"']
        expect: [{ exit_code: 0 }]
`,
    );

    const result = await run(project, () => ({ root: engineRoot, entry }));

    assert.equal(result.status, 'success');
    const bin1 = readFileSync(join(result.journal.paths.artifacts, 'bin1.txt'), 'utf8');
    const bin2 = readFileSync(join(result.journal.paths.artifacts, 'bin2.txt'), 'utf8');
    assert.equal(bin1, bin2, 'STEPCAST_BIN обязан быть одинаковым у обоих шагов');
    assert.equal(
      readFileSync(join(result.journal.paths.artifacts, 'content.txt'), 'utf8'),
      'ORIGINAL',
      'второй шаг обязан исполнять снимок, а не переписанный файл дерева',
    );
    assert.equal(readFileSync(entry, 'utf8'), 'REWRITTEN', 'файл дерева действительно переписан первым шагом');
  });
});

describe('run-engine-snapshot: снимок принадлежит одному прогону', () => {
  it('возобновление снимает собственный снимок, а не тащит чужой из прогона-источника', async () => {
    const project = makeProject({
      'сырьё.txt': 'вход',
      'stepcast.yml': `
version: 1
kind: pipeline
name: возобновление
jobs:
  первая:
    session: per_step
    inputs: [сырьё.txt]
    steps:
      - id: a
        run: [sh, -c, 'echo a']
        expect: [{ exit_code: 0 }]
  вторая:
    needs: [первая]
    session: per_step
    steps:
      - id: c
        run: [sh, -c, 'test -f маркер.txt']
        expect: [{ exit_code: 0 }]
`,
    });
    const engineRoot = project.path('vendor/engine');
    mkdirSync(join(engineRoot, 'dist', 'src'), { recursive: true });
    writeFileSync(join(engineRoot, 'package.json'), JSON.stringify({ name: 'fake-engine', files: ['dist'] }));
    const entry = join(engineRoot, 'dist', 'src', 'bin.js');
    writeFileSync(entry, 'ORIGINAL');
    chmodSync(entry, 0o755);

    const runsRoot = tempDir('runs-');
    const config = { ...project.config, runs: { ...project.config.runs, root: runsRoot } };
    const engineLocator = (): EngineLocation => ({ root: engineRoot, entry });
    const start = (extra: Partial<Parameters<typeof runPipeline>[0]> = {}): Promise<RunResult> =>
      runPipeline({
        expanded: expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config }),
        config,
        projectRoot: project.root,
        cwd: project.root,
        baseEnv: testBaseEnv(),
        engineLocator,
        ...extra,
      });

    const first = await start();
    assert.equal(first.status, 'failed', 'вторая работа падает: маркера нет');
    assert.equal(readFileSync(join(first.journal.paths.engine, 'dist', 'src', 'bin.js'), 'utf8'), 'ORIGINAL');

    // Между прогонами дерево пересобрано, как это делает объявленная проверка
    // репозитория, и упавшая работа починена.
    writeFileSync(entry, 'REBUILT');
    project.write('маркер.txt', 'есть');

    const source = readSourceRun(first.journal.paths);
    const { plan } = planResume({ cwd: project.root, config: project.config, source });
    assert.ok(
      plan.steps.some((step) => step.decision.kind === 'reuse'),
      'сценарий имеет смысл только с переиспользованным шагом — иначе перенос каталога прогона не запускается',
    );

    const second = await start({ resume: { plan, source } });

    assert.equal(second.status, 'success');
    assert.equal(
      readFileSync(join(second.journal.paths.engine, 'dist', 'src', 'bin.js'), 'utf8'),
      'REBUILT',
      'возобновление обязано исполняться собственным снимком, а не снимком прогона-источника',
    );
    const carried = readEvents(second.journal.paths).filter((event) => event.kind === 'run_dir.carried');
    assert.equal(
      carried.some((event) => event.path === 'engine'),
      false,
      'каталог снимка — часть раскладки прогона, а не состояние, переносимое из источника',
    );
    assert.equal(
      readManifest(second.journal.paths).engine?.entry,
      join(second.journal.paths.engine, 'dist', 'src', 'bin.js'),
    );
  });
});

/**
 * Сторож: собранный код движка не несёт отложенных импортов, кроме загрузчика
 * плагинов (run-engine-snapshot, «Граф модулей движка загружен до первой
 * работы») и обёртки раннера `stepcast:step`. Проверяет как настоящий
 * `dist/src/**`, так и синтетическое дерево с подложенным нарушением — иначе
 * зелёный результат ничего не значил бы: он мог быть зелёным и потому, что
 * проверка ничего не находит никогда.
 *
 * Обёртка не часть графа движка: она исполняется отдельным процессом
 * `node <обёртка> <скрипт>` и импортирует чужой файл по пути, узнанному из
 * argv, а не из графа модулей движка, — тот же довод, что и у загрузчика
 * плагинов (design.md изменения `script-step-contract`, решение 8).
 */
const ALLOWED_DYNAMIC_IMPORTS = new Set([
  join('src', 'core', 'plugins', 'load.js'),
  join('src', 'step', 'wrapper.js'),
]);

function jsFilesUnder(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return jsFilesUnder(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

function findDisallowedDynamicImports(distRoot: string): string[] {
  const violations: string[] = [];
  for (const file of jsFilesUnder(join(distRoot, 'src'))) {
    if (ALLOWED_DYNAMIC_IMPORTS.has(relativePath(distRoot, file))) continue;
    const text = readFileSync(file, 'utf8');
    const index = text.indexOf('import(');
    if (index === -1) continue;
    const line = text.slice(0, index).split('\n').length;
    violations.push(`${file}:${line}`);
  }
  return violations;
}

describe('run-engine-snapshot: граф модулей движка загружен целиком', () => {
  const ROOT = fileURLToPath(new URL('../../', import.meta.url));

  it('собранный dist/src/** не несёт отложенных импортов вне загрузчика плагинов', () => {
    assert.deepEqual(findDisallowedDynamicImports(join(ROOT, 'dist')), []);
  });

  it('отказывает на подложенном динамическом импорте вне исключения', () => {
    const distRoot = tempDir('stepcast-dynimport-');
    mkdirSync(join(distRoot, 'src', 'core', 'plugins'), { recursive: true });
    mkdirSync(join(distRoot, 'src', 'core', 'run'), { recursive: true });
    writeFileSync(join(distRoot, 'src', 'core', 'plugins', 'load.js'), 'export const load = (u) => import(u);\n');
    writeFileSync(join(distRoot, 'src', 'core', 'run', 'engine.js'), 'export const bad = (u) => import(u);\n');

    const violations = findDisallowedDynamicImports(distRoot);

    assert.equal(violations.length, 1);
    assert.match(violations[0] as string, /run[/\\]engine\.js:1$/);
  });
});
