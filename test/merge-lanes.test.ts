import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { run as runCli, type CliIo } from '../src/cli/main.js';
import { ExitCode, StepcastError, type ExitCodeValue } from '../src/core/errors.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { runPaths } from '../src/core/journal/paths.js';
import { mergeLanes } from '../src/core/lanes/merge.js';
import { runPipeline, type RunResult } from '../src/core/run/runner.js';
import { gitCommit, gitInit as gitInitDir, makeProject, withHome, type Project } from './helpers.js';

/**
 * Сведение дорожек на настоящих прогонах: временный репозиторий, пайплайн с
 * двумя дорожками в режиме `worktree`, настоящий прогон, настоящий
 * `applyRun`, настоящий файл очереди. Фальшивого `stepcast` здесь нет —
 * `merge.ts` зовётся внутрипроцессно, как и в жизни.
 *
 * Работы дорожек названы `work-<дорожка>` / `confirm-<дорожка>` — ни одна не
 * называется `verify` и не несёт суффикса, склеенного из имени дорожки:
 * решение о годности проверяется на именах, которых склейка `verify-${lane}`
 * не найдёт (см. `src/core/lanes/lanes.ts`).
 */

// Переходники к общим помощникам (`test/helpers.ts`): здесь репозиторий
// всегда корень проекта, и звать их проектом короче, чем путём.
function gitInit(project: Project): void {
  gitInitDir(project.root);
}

function commit(project: Project, message: string): void {
  gitCommit(project.root, message);
}

function commitCount(project: Project): number {
  return Number(
    execFileSync('git', ['-C', project.root, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim(),
  );
}

function commitMessages(project: Project, count: number): string[] {
  return execFileSync('git', ['-C', project.root, 'log', `-${count}`, '--format=%s'], { encoding: 'utf8' })
    .trim()
    .split('\n');
}

async function runLanes(project: Project, runsRoot: string): Promise<RunResult> {
  const expanded = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config });
  return runPipeline({
    expanded,
    config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
    projectRoot: project.root,
    cwd: project.root,
  });
}

function writeItem(runDir: string, lane: string, slug: string, title: string): void {
  writeFileSync(join(runDir, `item-${lane}.json`), JSON.stringify({ slug, title }));
}

function backlogItem(slug: string, status = 'in_progress'): string {
  return `## ${slug}\n\nstatus: ${status}\ntitle: Улучшение ${slug}\nwhy: з\ndone_when: к\n`;
}

function statusOf(text: string, slug: string): string | undefined {
  const section = text.split(`## ${slug}\n`)[1]?.split('\n## ')[0] ?? '';
  return /^status:\s*(.*)$/m.exec(section)?.[1];
}

function fieldOf(text: string, slug: string, name: string): string | undefined {
  const section = text.split(`## ${slug}\n`)[1]?.split('\n## ')[0] ?? '';
  return new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(section)?.[1];
}

/** Пайплайн с двумя однорабочими дорожками — по умолчанию обе завершаются успешно. */
function twoLanePipeline(aCommand: string, bCommand: string): string {
  return `
version: 1
kind: pipeline
name: две-дорожки
workspace: { mode: worktree }
concurrency: 2
fail_fast: false
jobs:
  work-a:
    lane: a
    steps: [{ id: шаг, run: [sh, -c, '${aCommand}'], expect: [{ exit_code: 0 }] }]
  work-b:
    lane: b
    steps: [{ id: шаг, run: [sh, -c, '${bCommand}'], expect: [{ exit_code: 0 }] }]
`;
}

const SUCCESS_A = 'printf "от a\\n" > a.txt';
const SUCCESS_B = 'printf "от b\\n" > b.txt';

describe('core: mergeLanes — наложение и порядок', () => {
  it('обе годные дорожки сводятся в порядке перечня, каждая своим коммитом', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-lanes-runs-'));
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, `${backlogItem('a-item')}\n${backlogItem('b-item')}`);
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'Заголовок A');
    writeItem(result.journal.paths.dir, 'b', 'b-item', 'Заголовок B');

    const before = commitCount(project);
    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a', 'b'],
      check: 'exit 0',
      file: backlogFile,
    });

    assert.deepEqual(
      outcomes.map((o) => o.kind),
      ['merged', 'merged'],
    );
    assert.equal(commitCount(project), before + 2);
    assert.deepEqual(commitMessages(project, 2).reverse(), [
      'a-item: Заголовок A',
      'b-item: Заголовок B',
    ]);
    assert.equal(readFileSync(project.path('a.txt'), 'utf8'), 'от a\n');
    assert.equal(readFileSync(project.path('b.txt'), 'utf8'), 'от b\n');

    const text = readFileSync(backlogFile, 'utf8');
    assert.equal(statusOf(text, 'a-item'), 'done');
    assert.equal(statusOf(text, 'b-item'), 'done');
  });

  it('вторая дорожка ложится на дерево, уже несущее первую', async () => {
    const project = makeProject({
      'stepcast.yml': twoLanePipeline(
        'printf "общий файл, правка a\\n" > общий.txt',
        'printf "от b\\n" > b.txt',
      ),
    });
    gitInit(project);
    writeFileSync(project.path('общий.txt'), 'исходное\n');
    commit(project, 'начальный');
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-lanes-runs-'));
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, `${backlogItem('a-item')}\n${backlogItem('b-item')}`);
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    writeItem(result.journal.paths.dir, 'b', 'b-item', 'B');

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a', 'b'],
      check: 'exit 0',
      file: backlogFile,
    });

    assert.deepEqual(outcomes.map((o) => o.kind), ['merged', 'merged']);
    assert.equal(readFileSync(project.path('общий.txt'), 'utf8'), 'общий файл, правка a\n');
    assert.equal(readFileSync(project.path('b.txt'), 'utf8'), 'от b\n');
  });
});

describe('core: mergeLanes — отбор годности', () => {
  it('дорожка с провалившейся работой пропускается, не мешая следующей', async () => {
    const project = makeProject({
      'stepcast.yml': twoLanePipeline('exit 1', SUCCESS_B),
    });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-lanes-runs-'));
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, `${backlogItem('a-item')}\n${backlogItem('b-item')}`);
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    writeItem(result.journal.paths.dir, 'b', 'b-item', 'B');

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a', 'b'],
      check: 'exit 0',
      file: backlogFile,
    });

    assert.equal(outcomes[0]?.kind, 'unfit');
    assert.equal(outcomes[1]?.kind, 'merged');
    assert.equal(existsSync(project.path('a.txt')), false);
    assert.equal(existsSync(project.path('b.txt')), true);

    const text = readFileSync(backlogFile, 'utf8');
    assert.equal(statusOf(text, 'a-item'), 'failed');
    assert.match(fieldOf(text, 'a-item', 'reason') ?? '', /work-a=failed/);
    assert.equal(statusOf(text, 'b-item'), 'done');
  });

  it('смешанные success и skipped не сводятся', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: смешанная-дорожка
workspace: { mode: worktree }
jobs:
  work-a:
    lane: a
    steps: [{ id: шаг, run: [sh, -c, '${SUCCESS_A}'], expect: [{ exit_code: 0 }] }]
  confirm-a:
    lane: a
    needs: [work-a]
    if: "false"
    steps: [{ id: шаг, run: [sh, -c, 'printf "confirm\\n" > confirm-a.txt'], expect: [{ exit_code: 0 }] }]
`,
    });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-lanes-runs-'));
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, backlogItem('a-item'));
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a'],
      check: 'exit 0',
      file: backlogFile,
    });

    assert.equal(outcomes[0]?.kind, 'unfit');
    assert.equal(existsSync(project.path('a.txt')), false);
    assert.equal(statusOf(readFileSync(backlogFile, 'utf8'), 'a-item'), 'failed');
  });

  it('дорожка, все работы которой skipped, пропускается без отказа и без правки очереди', async () => {
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: пустой-слот
workspace: { mode: worktree }
jobs:
  work-a:
    lane: a
    if: "false"
    steps: [{ id: шаг, run: [sh, -c, '${SUCCESS_A}'], expect: [{ exit_code: 0 }] }]
`,
    });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-lanes-runs-'));
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, '# Очередь\n');
    commit(project, 'добавлена очередь');
    const before = commitCount(project);

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a'],
      check: 'exit 0',
      file: backlogFile,
    });

    assert.deepEqual(outcomes, [{ lane: 'a', kind: 'empty' }]);
    assert.equal(commitCount(project), before);
    assert.equal(readFileSync(backlogFile, 'utf8'), '# Очередь\n');
  });

  it('неизвестная дорожка отказывает кодом 2 (StepcastError), перечисляя известные, ничего не накладывая', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-lanes-runs-'));
    const result = await runLanes(project, runsRoot);
    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, '# Очередь\n');
    commit(project, 'добавлена очередь');
    const before = commitCount(project);

    await assert.rejects(
      () =>
        mergeLanes({
          paths: result.journal.paths,
          cwd: project.root,
          lanes: ['нет-такой'],
          check: 'exit 0',
          file: backlogFile,
        }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.exitCode, ExitCode.configError);
        assert.match(error.message, /нет-такой/);
        assert.match(error.hint ?? '', /a/);
        assert.match(error.hint ?? '', /b/);
        return true;
      },
    );
    assert.equal(commitCount(project), before);
    assert.equal(existsSync(project.path('a.txt')), false);
  });

  it('решение о годности не сравнивает имя работы со строкой verify', async () => {
    // Работы дорожки называются нарочно иначе, чем «verify»/«verify-a»: тест
    // падает, если evaluateLane вернётся к склейке имени со строкой.
    const project = makeProject({
      'stepcast.yml': `
version: 1
kind: pipeline
name: имена-не-по-шаблону
workspace: { mode: worktree }
jobs:
  придумай-название:
    lane: a
    steps: [{ id: шаг, run: [sh, -c, '${SUCCESS_A}'], expect: [{ exit_code: 0 }] }]
`,
    });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-lanes-runs-'));
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, backlogItem('a-item'));
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a'],
      check: 'exit 0',
      file: backlogFile,
    });

    assert.equal(outcomes[0]?.kind, 'merged');
    assert.equal(readFileSync(project.path('a.txt'), 'utf8'), 'от a\n');
  });
});

describe('core: mergeLanes — красная проверка', () => {
  it('откатывает дерево к коммиту до наложения, останавливает обход, код 1 на уровне CLI', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-lanes-runs-'));
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, `${backlogItem('a-item')}\n${backlogItem('b-item')}`);
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    writeItem(result.journal.paths.dir, 'b', 'b-item', 'B');

    const beforeCount = commitCount(project);
    // Проверка красная ровно тогда, когда в дереве уже лежит b.txt — то есть
    // после наложения второй дорожки: первая сходит зелёной и коммитится.
    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a', 'b'],
      check: 'test ! -f b.txt',
      file: backlogFile,
    });

    assert.equal(outcomes[0]?.kind, 'merged');
    assert.equal(outcomes[1]?.kind, 'check_failed');
    assert.equal(existsSync(project.path('a.txt')), true, 'дорожка a уже сведена и остаётся на месте');
    assert.equal(existsSync(project.path('b.txt')), false, 'откат снял файлы дорожки b');
    assert.equal(commitCount(project), beforeCount + 1, 'коммит получила только дорожка a');

    const text = readFileSync(backlogFile, 'utf8');
    assert.equal(statusOf(text, 'a-item'), 'done');
    assert.equal(statusOf(text, 'b-item'), 'failed');
    assert.match(fieldOf(text, 'b-item', 'reason') ?? '', /красная/);
  });

  it('игнорируемый путь переживает откат красной проверки', async () => {
    const project = makeProject({
      'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B),
      '.gitignore': 'сборка/\n',
    });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-lanes-runs-'));
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, backlogItem('a-item'));
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');

    // Побочный файл красной проверки — в игнорируемом каталоге, как кеш сборки.
    const check =
      'mkdir -p сборка && printf "кеш\\n" > сборка/кеш.txt && exit 1';

    await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a'],
      check,
      file: backlogFile,
    });

    assert.ok(existsSync(project.path('сборка/кеш.txt')), 'игнорируемый путь обязан пережить откат');
  });

  it('откат не стирает исходы, проставленные более ранним дорожкам того же обхода', async () => {
    // Дорожка a негодна (её работа провалилась), поэтому её `failed` пишется
    // в очередь, но никаким коммитом не закрепляется. Дальше красная проверка
    // дорожки b откатывает дерево — вместе с отслеживаемым `backlog.md`.
    // Отметка дорожки a обязана уцелеть: иначе её пункт остался бы
    // `in_progress` с потерянной различимой причиной.
    const project = makeProject({ 'stepcast.yml': twoLanePipeline('exit 1', SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-lanes-runs-'));
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, `${backlogItem('a-item')}\n${backlogItem('b-item')}`);
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    writeItem(result.journal.paths.dir, 'b', 'b-item', 'B');
    const beforeCount = commitCount(project);

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a', 'b'],
      check: 'test ! -f b.txt',
      file: backlogFile,
    });

    assert.equal(outcomes[0]?.kind, 'unfit');
    assert.equal(outcomes[1]?.kind, 'check_failed');
    assert.equal(commitCount(project), beforeCount, 'ни одна дорожка не сведена');
    assert.equal(existsSync(project.path('b.txt')), false, 'откат снял файлы дорожки b');

    const text = readFileSync(backlogFile, 'utf8');
    assert.equal(statusOf(text, 'a-item'), 'failed', 'отметка дорожки a пережила откат');
    assert.match(fieldOf(text, 'a-item', 'reason') ?? '', /work-a=failed/);
    assert.equal(statusOf(text, 'b-item'), 'failed');
    assert.match(fieldOf(text, 'b-item', 'reason') ?? '', /красная/);
  });
});

describe('core: mergeLanes — дорожка без взятого пункта', () => {
  it('годная дорожка без item-файла пропускается до наложения, не мешая следующей', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-lanes-runs-'));
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, backlogItem('b-item'));
    commit(project, 'добавлена очередь');
    // Пункт достался только дорожке b: у a файла пункта нет вовсе.
    writeItem(result.journal.paths.dir, 'b', 'b-item', 'B');
    const before = commitCount(project);

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a', 'b'],
      check: 'exit 0',
      file: backlogFile,
    });

    assert.deepEqual(outcomes[0], { lane: 'a', kind: 'no_item' });
    assert.equal(outcomes[1]?.kind, 'merged');
    assert.equal(existsSync(project.path('a.txt')), false, 'дорожка без пункта не накладывается вовсе');
    assert.equal(commitCount(project), before + 1, 'коммит только у дорожки b');
    assert.equal(statusOf(readFileSync(backlogFile, 'utf8'), 'b-item'), 'done');
  });

  it('файл пункта без слага отказывает до наложения, не оставляя дифф в дереве', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-lanes-runs-'));
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, backlogItem('a-item'));
    commit(project, 'добавлена очередь');
    writeFileSync(join(result.journal.paths.dir, 'item-a.json'), JSON.stringify({ title: 'без слага' }));
    const before = commitCount(project);

    await assert.rejects(
      () =>
        mergeLanes({
          paths: result.journal.paths,
          cwd: project.root,
          lanes: ['a'],
          check: 'exit 0',
          file: backlogFile,
        }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.exitCode, ExitCode.configError);
        assert.match(error.file ?? '', /item-a\.json$/);
        return true;
      },
    );

    assert.equal(existsSync(project.path('a.txt')), false, 'дерево не тронуто отказом');
    assert.equal(commitCount(project), before);
  });
});

describe('core: mergeLanes — режим файла очереди', () => {
  it('сведение не сужает права backlog.md', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-lanes-runs-'));
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, backlogItem('a-item'));
    commit(project, 'добавлена очередь');
    chmodSync(backlogFile, 0o664);
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');

    await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a'],
      check: 'exit 0',
      file: backlogFile,
    });

    assert.equal(statSync(backlogFile).mode & 0o777, 0o664);
  });
});

describe('core: mergeLanes — конфликт наложения', () => {
  it('дерево не тронуто, обход прекращён, причина называет дорожку и её рабочее дерево', async () => {
    const project = makeProject({
      'спорный.txt': 'строка один\nстрока два\nстрока три\n',
      'stepcast.yml': `
version: 1
kind: pipeline
name: конфликт-дорожки
workspace: { mode: worktree }
concurrency: 2
fail_fast: false
jobs:
  work-a:
    lane: a
    steps:
      - id: шаг
        run: [sh, -c, 'printf "строка один\\nправка прогона\\nстрока три\\n" > спорный.txt']
        expect: [{ exit_code: 0 }]
  work-b:
    lane: b
    steps: [{ id: шаг, run: [sh, -c, '${SUCCESS_B}'], expect: [{ exit_code: 0 }] }]
`,
    });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-lanes-runs-'));
    const result = await runLanes(project, runsRoot);

    // Дерево остаётся чистым (предусловие сведения): расхождение вносится
    // отдельным коммитом поверх того же файла, а не незакоммиченной правкой.
    writeFileSync(project.path('спорный.txt'), 'строка один\nправка человека\nстрока три\n');
    commit(project, 'человек поправил спорный.txt пока шёл прогон');
    const beforeConflict = readFileSync(project.path('спорный.txt'), 'utf8');

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, `${backlogItem('a-item')}\n${backlogItem('b-item')}`);
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    writeItem(result.journal.paths.dir, 'b', 'b-item', 'B');
    const beforeCount = commitCount(project);

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a', 'b'],
      check: 'exit 0',
      file: backlogFile,
    });

    assert.equal(outcomes[0]?.kind, 'conflict');
    assert.match((outcomes[0] as { reason: string }).reason, /a/);
    assert.match((outcomes[0] as { reason: string }).reason, /worktree|workspace|work-a/);
    assert.equal(outcomes[1]?.kind, 'not_reached');

    assert.equal(readFileSync(project.path('спорный.txt'), 'utf8'), beforeConflict);
    assert.equal(commitCount(project), beforeCount);
    assert.equal(existsSync(project.path('b.txt')), false, 'вторая дорожка не накладывается вовсе');
  });
});

describe('core: mergeLanes — предусловие чистого дерева', () => {
  function bogusPaths(dir: string) {
    return runPaths(join(dir, 'runs'), 'проект', 'r1');
  }

  it('незакоммиченная правка отказывает до первого наложения', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    writeFileSync(project.path('stepcast.yml'), `${twoLanePipeline(SUCCESS_A, SUCCESS_B)}\n# правка\n`);

    await assert.rejects(
      () =>
        mergeLanes({
          paths: bogusPaths(project.root),
          cwd: project.root,
          lanes: ['a'],
          check: 'exit 0',
          file: project.path('backlog.md'),
        }),
      StepcastError,
    );
  });

  it('неотслеживаемый файл отказывает тем же образом', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    writeFileSync(project.path('новый.txt'), 'новое\n');

    await assert.rejects(
      () =>
        mergeLanes({
          paths: bogusPaths(project.root),
          cwd: project.root,
          lanes: ['a'],
          check: 'exit 0',
          file: project.path('backlog.md'),
        }),
      StepcastError,
    );
  });

  it('незакоммиченная отметка очереди сведению не мешает', async () => {
    // Голова петли ставит пункту `in_progress` в начале прогона, а сведение
    // идёт в конце того же прогона: к этому мигу файл очереди закономерно
    // расходится с последним коммитом, и отказывать из-за него нельзя.
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-lanes-runs-'));
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, backlogItem('a-item', 'queued'));
    commit(project, 'добавлена очередь');
    // Правка после коммита — та самая, что делает петля перед прогоном.
    writeFileSync(backlogFile, `${backlogItem('a-item')}started_at: 2026-08-28T00:00:00Z\n`);
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a'],
      check: 'exit 0',
      file: backlogFile,
    });

    assert.equal(outcomes[0]?.kind, 'merged');
    assert.equal(statusOf(readFileSync(backlogFile, 'utf8'), 'a-item'), 'done');
  });

  it('правка вне файла очереди отказывает и при исключённой очереди', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, backlogItem('a-item'));
    writeFileSync(project.path('stepcast.yml'), `${twoLanePipeline(SUCCESS_A, SUCCESS_B)}\n# правка\n`);

    await assert.rejects(
      () =>
        mergeLanes({
          paths: bogusPaths(project.root),
          cwd: project.root,
          lanes: ['a'],
          check: 'exit 0',
          file: backlogFile,
        }),
      StepcastError,
    );
  });

  it('откат красной проверки возвращает незакоммиченную отметку очереди', async () => {
    // `reset --hard` снёс бы `started_at`, проставленный головой петли и
    // никаким коммитом не закреплённый: снимок очереди до наложения обязан
    // вернуть его на место, а исход дорожки лечь уже поверх.
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-lanes-runs-'));
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, backlogItem('a-item', 'queued'));
    commit(project, 'добавлена очередь');
    writeFileSync(backlogFile, `${backlogItem('a-item')}started_at: 2026-08-28T00:00:00Z\n`);
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a'],
      check: 'exit 1',
      file: backlogFile,
    });

    assert.equal(outcomes[0]?.kind, 'check_failed');
    const text = readFileSync(backlogFile, 'utf8');
    assert.equal(statusOf(text, 'a-item'), 'failed');
    assert.equal(fieldOf(text, 'a-item', 'started_at'), '2026-08-28T00:00:00Z');
  });

  it('каталог вне git отказывает, называя причину', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stepcast-lanes-notgit-'));

    await assert.rejects(
      () =>
        mergeLanes({
          paths: bogusPaths(dir),
          cwd: dir,
          lanes: ['a'],
          check: 'exit 0',
          file: join(dir, 'backlog.md'),
        }),
      StepcastError,
    );
  });
});

describe('core: mergeLanes — дорожка без вклада', () => {
  it('годная дорожка, не изменившая дерево, не даёт коммита, помечается failed, обход продолжается', async () => {
    const project = makeProject({
      // work-a ничего не пишет в дерево — applyRun вернёт nothing-to-apply.
      'stepcast.yml': twoLanePipeline(':', SUCCESS_B),
    });
    gitInit(project);
    commit(project, 'начальный');
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-lanes-runs-'));
    const result = await runLanes(project, runsRoot);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, `${backlogItem('a-item')}\n${backlogItem('b-item')}`);
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    writeItem(result.journal.paths.dir, 'b', 'b-item', 'B');
    const before = commitCount(project);

    const outcomes = await mergeLanes({
      paths: result.journal.paths,
      cwd: project.root,
      lanes: ['a', 'b'],
      check: 'exit 0',
      file: backlogFile,
    });

    assert.equal(outcomes[0]?.kind, 'no_contribution');
    assert.match((outcomes[0] as { reason: string }).reason, /не изменила дерево/);
    assert.equal(outcomes[1]?.kind, 'merged');
    assert.equal(commitCount(project), before + 1, 'коммит только у дорожки b');

    const text = readFileSync(backlogFile, 'utf8');
    assert.equal(statusOf(text, 'a-item'), 'failed');
    assert.equal(statusOf(text, 'b-item'), 'done');
  });
});

describe('CLI: stepcast merge-lanes', () => {
  async function cli(cwd: string, home: string, argv: readonly string[]): Promise<{
    code: ExitCodeValue;
    stdout: string;
    stderr: string;
  }> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io: CliIo = { out: (line) => stdout.push(line), err: (line) => stderr.push(line), cwd };
    const code = await withHome(home, () => runCli(['merge-lanes', ...argv], io));
    return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  }

  /** Прогон, чей runsRoot виден команде через глобальный конфиг в project.home. */
  async function preparedRun(project: Project): Promise<{ result: RunResult; runsRoot: string }> {
    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-lanes-runs-'));
    writeFileSync(join(project.home, '.stepcast', 'config.yml'), `runs:\n  root: ${runsRoot}\n`);
    const result = await runLanes(project, runsRoot);
    return { result, runsRoot };
  }

  it('обе дорожки зелёные: код 0, отчёт по каждой и итог', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    const { result } = await preparedRun(project);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, `${backlogItem('a-item')}\n${backlogItem('b-item')}`);
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    writeItem(result.journal.paths.dir, 'b', 'b-item', 'B');

    const out = await cli(project.root, project.home, [
      result.journal.paths.runId,
      '--lanes',
      'a,b',
      '--check',
      'exit 0',
      '--file',
      backlogFile,
    ]);

    assert.equal(out.code, ExitCode.ok, out.stderr);
    assert.match(out.stdout, /дорожка a:.*сведена/);
    assert.match(out.stdout, /дорожка b:.*сведена/);
    assert.match(out.stdout, /итог: сведено 2, не сведено 0/);
  });

  it('красная проверка останавливает обход: код 1', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    const { result } = await preparedRun(project);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, `${backlogItem('a-item')}\n${backlogItem('b-item')}`);
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');
    writeItem(result.journal.paths.dir, 'b', 'b-item', 'B');

    const out = await cli(project.root, project.home, [
      result.journal.paths.runId,
      '--lanes',
      'a,b',
      '--check',
      'test ! -f b.txt',
      '--file',
      backlogFile,
    ]);

    assert.equal(out.code, ExitCode.jobFailed);
  });

  it('неизвестная дорожка: код 2, дерево и очередь не тронуты', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    const { result } = await preparedRun(project);

    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, '# Очередь\n');
    commit(project, 'добавлена очередь');
    const beforeCount = commitCount(project);

    const out = await cli(project.root, project.home, [
      result.journal.paths.runId,
      '--lanes',
      'нет-такой',
      '--check',
      'exit 0',
      '--file',
      backlogFile,
    ]);

    assert.equal(out.code, ExitCode.configError);
    assert.equal(commitCount(project), beforeCount);
    assert.equal(readFileSync(backlogFile, 'utf8'), '# Очередь\n');
  });

  it('пустой перечень дорожек, повтор имени и пустой --check — отказ кодом 2 до правки дерева', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    const { result } = await preparedRun(project);
    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, '# Очередь\n');
    commit(project, 'добавлена очередь');

    const empty = await cli(project.root, project.home, [
      result.journal.paths.runId,
      '--lanes',
      '',
      '--check',
      'exit 0',
      '--file',
      backlogFile,
    ]);
    assert.equal(empty.code, ExitCode.configError);

    const duplicate = await cli(project.root, project.home, [
      result.journal.paths.runId,
      '--lanes',
      'a,a',
      '--check',
      'exit 0',
      '--file',
      backlogFile,
    ]);
    assert.equal(duplicate.code, ExitCode.configError);

    const noCheck = await cli(project.root, project.home, [
      result.journal.paths.runId,
      '--lanes',
      'a,b',
      '--file',
      backlogFile,
    ]);
    assert.equal(noCheck.code, ExitCode.configError);
  });

  it('прогон не назван вовсе — отказ кодом 2, ничего не тронуто', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    await preparedRun(project);
    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, '# Очередь\n');
    commit(project, 'добавлена очередь');

    // Переменную обязательно снять: под самим stepcast (петля саморазвития
    // гоняет `npm run check` внутри шага) она задана, и без очистки команда
    // ушла бы по ветке резолва прогона — отказ был бы тот же кодом, но не
    // тем, который проверяет этот сценарий.
    const previous = process.env.STEPCAST_RUN_ID;
    delete process.env.STEPCAST_RUN_ID;
    try {
      const out = await cli(project.root, project.home, [
        '--lanes',
        'a,b',
        '--check',
        'exit 0',
        '--file',
        backlogFile,
      ]);
      assert.equal(out.code, ExitCode.configError);
      assert.match(out.stderr, /не назван прогон/);
    } finally {
      if (previous !== undefined) process.env.STEPCAST_RUN_ID = previous;
    }
    assert.equal(readFileSync(backlogFile, 'utf8'), '# Очередь\n');
  });

  it('прогон из STEPCAST_RUN_ID: позиционный аргумент не задан', async () => {
    const project = makeProject({ 'stepcast.yml': twoLanePipeline(SUCCESS_A, SUCCESS_B) });
    gitInit(project);
    commit(project, 'начальный');
    const { result } = await preparedRun(project);
    const backlogFile = project.path('backlog.md');
    writeFileSync(backlogFile, backlogItem('a-item'));
    commit(project, 'добавлена очередь');
    writeItem(result.journal.paths.dir, 'a', 'a-item', 'A');

    const previous = process.env.STEPCAST_RUN_ID;
    process.env.STEPCAST_RUN_ID = result.journal.paths.runId;
    try {
      const out = await cli(project.root, project.home, ['--lanes', 'a', '--check', 'exit 0', '--file', backlogFile]);
      assert.equal(out.code, ExitCode.ok, out.stderr);
    } finally {
      if (previous === undefined) delete process.env.STEPCAST_RUN_ID;
      else process.env.STEPCAST_RUN_ID = previous;
    }
  });
});
