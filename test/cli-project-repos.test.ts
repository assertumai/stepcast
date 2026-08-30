import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { run as runCli, type CliIo } from '../src/cli/main.js';
import { BacklogSlotsResponseSchema } from '../src/core/backlog/schema.js';
import { ExitCode, type ExitCodeValue } from '../src/core/errors.js';
import { gitCommit, gitInit, withHome } from './helpers.js';

/**
 * `stepcast project repos` — как `assert-clean` (`test/cli-assert-clean.test.ts`):
 * настоящее git-дерево, фальшивый `HOME`. В отличие от неё, команда асинхронна
 * и читает стандартный ввод — `CliIo.readStdin` подменяется фиктивным
 * читателем, а не настоящим процессом.
 */

interface Result {
  readonly code: ExitCodeValue;
  readonly stdout: string;
  readonly stderr: string;
}

async function projectRepos(
  cwd: string,
  home: string,
  options: { readonly stdin?: string; readonly argv?: readonly string[] } = {},
): Promise<Result> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    cwd,
    readStdin: async () => options.stdin ?? '',
  };
  const code = await withHome(home, () => runCli(['project', 'repos', ...(options.argv ?? [])], io));
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'stepcast-project-repos-home-'));
  mkdirSync(join(home, '.stepcast'), { recursive: true });
  return home;
}

function makeRepo(configYaml?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'stepcast-project-repos-'));
  gitInit(dir);
  if (configYaml !== undefined) {
    mkdirSync(join(dir, '.stepcast'), { recursive: true });
    writeFileSync(join(dir, '.stepcast', 'config.yml'), configYaml);
  }
  writeFileSync(join(dir, 'seed.txt'), 'затравка\n');
  gitCommit(dir, 'первый');
  return dir;
}

const ROOT_CONFIG =
  'project:\n  check: npm run check\n  spec:\n    dir: openspec/changes\n    rules: openspec/rules.md\n    tool: openspec\n';

const WITH_BACKEND =
  ROOT_CONFIG +
  '  nested_repos:\n    - dir: backend\n      check: "./gradlew check"\n      spec:\n        dir: docs/changes\n        rules: docs/spec-rules.md\n        tool: openspec\n';

interface LaneRecord {
  readonly slug: string;
  readonly title: string;
  readonly why: string;
  readonly done_when: string;
  readonly group: string;
  readonly repos: readonly string[];
}

function record(slug: string, repos: readonly string[] = []): LaneRecord {
  return { slug, title: 'т', why: 'з', done_when: 'к', group: slug, repos };
}

function filledLane(slug: string, repos: readonly string[] = []): unknown {
  return { filled: true, slug, title: 'т', group: slug, item: record(slug, repos) };
}

const EMPTY_LANE = { filled: false, slug: '', title: '', group: '', item: null };

describe('CLI: stepcast project repos', () => {
  it('дорожка с вложенным репозиторием получает его объявления', async () => {
    const dir = makeRepo(WITH_BACKEND);
    const document = { lanes: { a: filledLane('an-item', ['backend']) } };
    const out = await projectRepos(dir, makeHome(), { stdin: JSON.stringify(document) });

    assert.equal(out.code, ExitCode.ok, out.stderr);
    const parsed = JSON.parse(out.stdout) as { lanes: Record<string, { repo?: unknown }> };
    assert.deepEqual(parsed.lanes.a?.repo, {
      dir: 'backend',
      check: './gradlew check',
      spec: { dir: 'backend/docs/changes', rules: 'backend/docs/spec-rules.md', tool: 'openspec' },
    });
  });

  it('дорожка без поля repos получает объявления корня, dir "."', async () => {
    const dir = makeRepo(ROOT_CONFIG);
    const document = { lanes: { a: filledLane('an-item') } };
    const out = await projectRepos(dir, makeHome(), { stdin: JSON.stringify(document) });

    assert.equal(out.code, ExitCode.ok, out.stderr);
    const parsed = JSON.parse(out.stdout) as { lanes: Record<string, { repo?: { dir: string; spec: { dir: string } } }> };
    assert.equal(parsed.lanes.a?.repo?.dir, '.');
    assert.equal(parsed.lanes.a?.repo?.spec.dir, 'openspec/changes');
  });

  it('явный "." даёт тот же блок repo, что и отсутствие поля', async () => {
    const dir = makeRepo(ROOT_CONFIG);
    const withoutField = await projectRepos(dir, makeHome(), {
      stdin: JSON.stringify({ lanes: { a: filledLane('an-item') } }),
    });
    const withDot = await projectRepos(dir, makeHome(), {
      stdin: JSON.stringify({ lanes: { a: filledLane('an-item', ['.']) } }),
    });
    const repoOf = (out: Result): unknown => (JSON.parse(out.stdout) as { lanes: { a: { repo: unknown } } }).lanes.a.repo;
    assert.deepEqual(repoOf(withDot), repoOf(withoutField));
  });

  it('незаполненная дорожка остаётся без блока repo и не считается отказом', async () => {
    const dir = makeRepo(ROOT_CONFIG);
    const document = { lanes: { a: filledLane('an-item'), b: EMPTY_LANE } };
    const out = await projectRepos(dir, makeHome(), { stdin: JSON.stringify(document) });

    assert.equal(out.code, ExitCode.ok, out.stderr);
    const parsed = JSON.parse(out.stdout) as { lanes: Record<string, { repo?: unknown }> };
    assert.equal(parsed.lanes.b?.repo, undefined);
  });

  it('--file читает файл, а не стандартный ввод', async () => {
    const dir = makeRepo(ROOT_CONFIG);
    const file = join(dir, 'lanes.json');
    writeFileSync(file, JSON.stringify({ lanes: { a: filledLane('an-item') } }));

    const out = await projectRepos(dir, makeHome(), { argv: ['--file', file], stdin: 'полная чушь, не json' });
    assert.equal(out.code, ExitCode.ok, out.stderr);
    const parsed = JSON.parse(out.stdout) as { lanes: Record<string, { repo?: { dir: string } }> };
    assert.equal(parsed.lanes.a?.repo?.dir, '.');
  });

  it('необъявленное имя отказывает кодом 2, называя пункт и имя', async () => {
    const dir = makeRepo(ROOT_CONFIG);
    const document = { lanes: { a: filledLane('an-item', ['no-such']) } };
    const out = await projectRepos(dir, makeHome(), { stdin: JSON.stringify(document) });

    assert.equal(out.code, ExitCode.configError);
    assert.match(out.stderr, /an-item/);
    assert.match(out.stderr, /no-such/);
  });

  it('два имени у пункта отказывают, называя дорожку с одним репозиторием', async () => {
    const dir = makeRepo(WITH_BACKEND);
    const document = { lanes: { a: filledLane('an-item', ['.', 'backend']) } };
    const out = await projectRepos(dir, makeHome(), { stdin: JSON.stringify(document) });

    assert.equal(out.code, ExitCode.configError);
    assert.match(out.stderr, /один репозиторий/);
  });

  it('недостающий ключ объявления отказывает, называя пункт и .stepcast/config.yml', async () => {
    const incomplete = ROOT_CONFIG + '  nested_repos: [backend]\n';
    const dir = makeRepo(incomplete);
    const document = { lanes: { a: filledLane('an-item', ['backend']) } };
    const out = await projectRepos(dir, makeHome(), { stdin: JSON.stringify(document) });

    assert.equal(out.code, ExitCode.configError);
    assert.match(out.stderr, /an-item/);
    assert.match(out.stderr, /backend/);
    assert.match(out.stderr, /\.stepcast\/config\.yml/);
  });

  /**
   * Обе дорожки заполнены и ведут разные репозитории: отказ обязан называть
   * пункт именно той дорожки, чей репозиторий недообъявлен, — по одному лишь
   * имени репозитория человек не знает, какую из двух дорожек разбирать.
   */
  it('при двух заполненных дорожках отказ называет пункт той, чей репозиторий недообъявлен', async () => {
    const dir = makeRepo(WITH_BACKEND + '    - dir: mobile\n');
    const document = {
      lanes: { a: filledLane('lane-a-item', ['backend']), b: filledLane('lane-b-item', ['mobile']) },
    };
    const out = await projectRepos(dir, makeHome(), { stdin: JSON.stringify(document) });

    assert.equal(out.code, ExitCode.configError);
    assert.match(out.stderr, /lane-b-item/);
    assert.doesNotMatch(out.stderr, /lane-a-item/);
    assert.equal(out.stdout, '');
  });

  it('объявление только в документе пайплайна не подменяет отсутствие в конфигурации', async () => {
    const dir = makeRepo();
    mkdirSync(join(dir, '.stepcast', 'pipelines'), { recursive: true });
    writeFileSync(
      join(dir, '.stepcast', 'pipelines', 'self-improve.yml'),
      'kind: pipeline\nproject:\n  check: npm run check\njobs:\n  build:\n    steps: [{ id: c, run: echo ok }]\n',
    );
    const document = { lanes: { a: filledLane('an-item') } };
    const out = await projectRepos(dir, makeHome(), { stdin: JSON.stringify(document) });

    assert.equal(out.code, ExitCode.configError);
    assert.match(out.stderr, /\.stepcast\/config\.yml/);
  });

  it('пустой стандартный ввод отказывает кодом 2 и не печатает в stdout', async () => {
    const dir = makeRepo(ROOT_CONFIG);
    const out = await projectRepos(dir, makeHome(), { stdin: '' });
    assert.equal(out.code, ExitCode.configError);
    assert.equal(out.stdout, '');
  });

  it('неразбираемый ввод отказывает кодом 2 и не печатает в stdout', async () => {
    const dir = makeRepo(ROOT_CONFIG);
    const out = await projectRepos(dir, makeHome(), { stdin: '{ не json' });
    assert.equal(out.code, ExitCode.configError);
    assert.equal(out.stdout, '');
  });

  it('файл очереди и конфигурация остаются неизменными после вызова', async () => {
    const dir = makeRepo(WITH_BACKEND);
    writeFileSync(join(dir, 'backlog.md'), '# Очередь\n');
    const configPath = join(dir, '.stepcast', 'config.yml');
    const configBefore = readFileSync(configPath, 'utf8');
    const backlogBefore = readFileSync(join(dir, 'backlog.md'), 'utf8');

    const document = { lanes: { a: filledLane('an-item', ['backend']) } };
    await projectRepos(dir, makeHome(), { stdin: JSON.stringify(document) });

    assert.equal(readFileSync(configPath, 'utf8'), configBefore);
    assert.equal(readFileSync(join(dir, 'backlog.md'), 'utf8'), backlogBefore);
  });
});

describe('CLI: конвейер backlog pick --lanes | project repos', () => {
  function laneItem(slug: string, extra = ''): string {
    return `## ${slug}\n\nstatus: pending\ntitle: т\nwhy: з\ndone_when: к\n${extra}`;
  }

  it('выход pick, поданный на вход project repos, даёт документ, проходящий поставляемую схему', async () => {
    const dir = makeRepo(WITH_BACKEND);
    writeFileSync(join(dir, 'backlog.md'), `# Очередь\n\n${laneItem('an-item', 'repos: backend\n')}`);

    const pickStdout: string[] = [];
    const pickCode = await withHome(makeHome(), () =>
      runCli(['backlog', 'pick', '--lanes', 'a'], {
        out: (line) => pickStdout.push(line),
        err: () => {},
        cwd: dir,
      }),
    );
    assert.equal(pickCode, ExitCode.ok);

    const out = await projectRepos(dir, makeHome(), { stdin: pickStdout.join('\n') });
    assert.equal(out.code, ExitCode.ok, out.stderr);

    const document = JSON.parse(out.stdout) as unknown;
    assert.doesNotThrow(() => BacklogSlotsResponseSchema.parse(document));
  });

  it('отказ pick (пустая очередь) не порождает документ, который "чинит" второе звено', async () => {
    const dir = makeRepo(ROOT_CONFIG);
    writeFileSync(join(dir, 'backlog.md'), '# Очередь\n');

    const home = makeHome();
    const pickStdout: string[] = [];
    const pickCode = await withHome(home, () =>
      runCli(['backlog', 'pick', '--lanes', 'a'], {
        out: (line) => pickStdout.push(line),
        err: () => {},
        cwd: dir,
      }),
    );
    assert.equal(pickCode, ExitCode.ok, 'пустая очередь для pick не отказ — раздача просто пуста');

    // Раздача пуста (незаполненная дорожка), второе звено проходит успешно —
    // отказ конвейера проверяется отдельно: пустой/неразбираемый вход второго
    // звена (см. тесты выше) обязан дать код 2, чем бы он ни был порождён.
    const out = await projectRepos(dir, home, { stdin: pickStdout.join('\n') });
    assert.equal(out.code, ExitCode.ok, out.stderr);
  });
});
