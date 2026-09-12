import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runInitCommand } from '../src/cli/commands/init.js';
import { runProposeCommand } from '../src/cli/commands/propose.js';
import { resolveConfig } from '../src/core/config/resolve.js';
import { createKnowledgeSource } from '../src/core/knowledge/source.js';
import { assertCleanTree } from '../src/core/lanes/tree.js';
import type { ParsedArgs } from '../src/cli/args.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { hasErrors, lintPipeline } from '../src/core/lint.js';
import { runPipeline } from '../src/core/run/runner.js';
import { ExitCode, StepcastError } from '../src/core/errors.js';
import { gitCommit, gitInit, makeProject, withHome } from './helpers.js';
import { tempDir } from './tmp.js';

function args(flags: ParsedArgs['flags'] = {}): ParsedArgs {
  return { command: 'init', positional: [], flags };
}

describe('CLI: stepcast init', () => {
  // Сценарий: «Файлы созданы»
  it('создаёт stepcast.yml и файл примера работы', () => {
    const project = makeProject();
    const lines: string[] = [];

    const code = runInitCommand(args(), (line) => lines.push(line), project.root);

    assert.equal(code, ExitCode.ok);
    assert.ok(existsSync(project.path('stepcast.yml')));
    assert.ok(existsSync(project.path('.stepcast/jobs/example.yml')));
    assert.match(readFileSync(project.path('stepcast.yml'), 'utf8'), /uses: \.stepcast\/jobs\/example\.yml/);
  });

  // Сценарий: «Отказ без флага»
  it('отказывается перезаписывать существующий stepcast.yml без --force', () => {
    const project = makeProject({ 'stepcast.yml': 'исходное содержимое\n' });

    assert.throws(() => runInitCommand(args(), () => {}, project.root), StepcastError);
    assert.equal(readFileSync(project.path('stepcast.yml'), 'utf8'), 'исходное содержимое\n');
  });

  // Сценарий: «Перезапись с флагом»
  it('перезаписывает stepcast.yml с --force', () => {
    const project = makeProject({ 'stepcast.yml': 'исходное содержимое\n' });

    const code = runInitCommand(args({ force: true }), () => {}, project.root);

    assert.equal(code, ExitCode.ok);
    assert.notEqual(readFileSync(project.path('stepcast.yml'), 'utf8'), 'исходное содержимое\n');
  });

  // Интеграционный тест: init → раскрытие/линт без ошибок → run завершается успехом
  it('шаблон линтуется и исполняется без агентского бэкенда', async () => {
    const project = makeProject();
    runInitCommand(args(), () => {}, project.root);

    const expanded = expandPipeline({
      pipelinePath: project.path('stepcast.yml'),
      config: project.config,
    });
    const diagnostics = lintPipeline(expanded, { config: project.config });
    assert.equal(hasErrors(diagnostics), false);

    const runsRoot = tempDir('runs-');
    const result = await runPipeline({
      expanded,
      config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
    });

    assert.equal(result.status, 'success');
  });
});

describe('CLI: stepcast init — очередь предложений не грязнит дерево', () => {
  // Сценарий: «Заведённый проект игнорирует очередь»
  it('вносит .stepcast/proposals/ в .gitignore проекта', () => {
    const project = makeProject();
    runInitCommand(args(), () => {}, project.root);
    const text = readFileSync(project.path('.gitignore'), 'utf8');
    assert.ok(text.split('\n').some((line) => line.trim() === '.stepcast/proposals/'));
  });

  it('повторный вызов не дублирует строку и не переписывает остальное содержимое', () => {
    const project = makeProject();
    project.write('.gitignore', 'node_modules/\ndist/\n');
    runInitCommand(args({ force: true }), () => {}, project.root);
    runInitCommand(args({ force: true }), () => {}, project.root);
    const text = readFileSync(project.path('.gitignore'), 'utf8');
    const proposalsLines = text.split('\n').filter((line) => line.trim() === '.stepcast/proposals/');
    assert.equal(proposalsLines.length, 1);
    assert.match(text, /node_modules\//);
    assert.match(text, /dist\//);
  });

  // Сценарий: «Предложение не делает дерево грязным»
  it('дерево остаётся чистым после постановки предложения', async () => {
    const project = makeProject();
    runInitCommand(args(), () => {}, project.root);
    gitInit(project.root);
    gitCommit(project.root, 'первый коммит');

    // Снять окружение прогона на время вызова: эта проверка может сама
    // гоняться внутри stepcast и унаследовать `STEPCAST_RUN_DIR` от внешнего
    // прогона (`test/helpers.ts`, `testBaseEnv`).
    const runEnvNames = ['STEPCAST_RUN_DIR', 'STEPCAST_RUN_ID', 'STEPCAST_JOB', 'STEPCAST_STEP'] as const;
    const previous = runEnvNames.map((name) => [name, process.env[name]] as const);
    for (const name of runEnvNames) delete process.env[name];
    try {
      await withHome(project.home, () =>
        runProposeCommand(
          { command: 'propose', positional: ['.stepcast/widgets/clock.tsx'], flags: {} },
          () => {},
          project.root,
          async () => 'export default 1;\n',
        ),
      );
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }

    assert.ok(existsSync(join(project.root, '.stepcast', 'proposals')));
    assert.doesNotThrow(() => assertCleanTree(project.root));
  });
});

describe('CLI: stepcast init --knowledge fs', () => {
  // Задача 7.3 / Сценарий: «Разворачивание встроенного источника»
  it('создаёт каталог знания, файл правил, единицу-образец и конфигурацию', () => {
    const project = makeProject();
    const lines: string[] = [];

    const code = runInitCommand(args({ knowledge: 'fs' }), (line) => lines.push(line), project.root);

    assert.equal(code, ExitCode.ok);
    assert.ok(existsSync(project.path('knowledge')));
    assert.ok(existsSync(project.path('.stepcast/prompts/knowledge-rules.md')));
    assert.ok(existsSync(project.path('knowledge/knowledge-index-is-derived.md')));
    assert.match(
      readFileSync(project.path('.stepcast/config.yml'), 'utf8'),
      /provider: fs\n\s+dir: knowledge/,
    );
  });

  // Задача 7.3 / Сценарий: «Развёрнутое проходит собственную проверку»
  it('развёрнутое сразу проходит проверку целостности', () => {
    const project = makeProject();
    runInitCommand(args({ knowledge: 'fs' }), () => {}, project.root);

    const config = resolveConfig({
      cwd: project.root,
      home: project.home,
      globalPath: join(project.home, '.stepcast', 'config.yml'),
      projectPath: project.path('.stepcast/config.yml'),
    }).config;

    const source = createKnowledgeSource({
      knowledge: {
        provider: config.project.knowledge.provider,
        command: config.project.knowledge.command,
        dir: config.project.knowledge.dir,
        rules: config.project.knowledge.rules,
        indexMaxTokens: config.project.knowledge.indexMaxTokens,
        specIndexMaxTokens: config.project.knowledge.specIndexMaxTokens,
        unitMaxTokens: config.project.knowledge.unitMaxTokens,
        staleAfterMs: config.project.knowledge.staleAfterMs,
        timeoutMs: config.project.knowledge.timeoutMs,
      },
      root: project.root,
    });

    assert.ok(source !== undefined);
    assert.equal(source.check().ok, true);
    assert.deepEqual(
      source.index().map((entry) => entry.id),
      ['knowledge-index-is-derived'],
    );
  });

  // Задача 7.2 / Сценарий: «Каталог знания уже есть»
  it('отказывается разворачивать поверх занятого каталога, называя путь', () => {
    const project = makeProject({ 'knowledge/своё.md': 'своё\n' });

    assert.throws(
      () => runInitCommand(args({ knowledge: 'fs' }), () => {}, project.root),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /knowledge/);
        return true;
      },
    );
    assert.equal(existsSync(project.path('.stepcast/prompts/knowledge-rules.md')), false);
  });

  // Задача 7.2: конфигурация с уже объявленной секцией не трогается.
  it('отказывается, когда секция project.knowledge уже объявлена', () => {
    const project = makeProject({
      '.stepcast/config.yml': 'project:\n  knowledge:\n    provider: cmd\n    command: своё\n',
    });

    assert.throws(
      () => runInitCommand(args({ knowledge: 'fs' }), () => {}, project.root),
      StepcastError,
    );
  });

  // Задача 7.1: конфигурация есть, секции нет — движок не правит чужой YAML,
  // а называет, что дописать.
  it('не правит существующую конфигурацию, а печатает, что в неё дописать', () => {
    const project = makeProject({ '.stepcast/config.yml': 'project:\n  check: npm run check\n' });
    const lines: string[] = [];

    const code = runInitCommand(args({ knowledge: 'fs' }), (line) => lines.push(line), project.root);

    assert.equal(code, ExitCode.ok);
    assert.equal(
      readFileSync(project.path('.stepcast/config.yml'), 'utf8'),
      'project:\n  check: npm run check\n',
    );
    assert.ok(lines.some((line) => /provider: fs/.test(line)));
  });

  // Задача 7.1 / Сценарий: «Инициализация без флага»
  it('без флага практику памяти не создаёт', () => {
    const project = makeProject();
    runInitCommand(args(), () => {}, project.root);

    assert.equal(existsSync(project.path('knowledge')), false);
  });

  // Ревью: подсказка «передайте --force» адресована занятому каталогу, и
  // стоить она не должна ни команды проверки, ни границ правок, ни бюджетов.
  it('--force перезаписывает каталог знания, но не трогает существующую конфигурацию', () => {
    const CONFIG = 'project:\n  check: npm run check\n  edit_paths: [src/**]\n';
    const project = makeProject({ '.stepcast/config.yml': CONFIG, 'knowledge/своё.md': 'своё\n' });
    const lines: string[] = [];

    const code = runInitCommand(
      args({ knowledge: 'fs', force: true }),
      (line) => lines.push(line),
      project.root,
    );

    assert.equal(code, ExitCode.ok);
    assert.equal(readFileSync(project.path('.stepcast/config.yml'), 'utf8'), CONFIG);
    assert.ok(existsSync(project.path('.stepcast/prompts/knowledge-rules.md')));
    assert.ok(lines.some((line) => /provider: fs/.test(line)));
  });

  it('--force не переписывает конфигурацию и когда секция в ней уже объявлена', () => {
    const CONFIG = 'project:\n  check: npm run check\n  knowledge:\n    provider: cmd\n    command: своё\n';
    const project = makeProject({ '.stepcast/config.yml': CONFIG });

    const code = runInitCommand(args({ knowledge: 'fs', force: true }), () => {}, project.root);

    assert.equal(code, ExitCode.ok);
    assert.equal(readFileSync(project.path('.stepcast/config.yml'), 'utf8'), CONFIG);
  });

  it('отклоняет неизвестный источник', () => {
    const project = makeProject();
    assert.throws(
      () => runInitCommand(args({ knowledge: 'graph' }), () => {}, project.root),
      StepcastError,
    );
  });
});
