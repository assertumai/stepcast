import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runInitCommand } from '../src/cli/commands/init.js';
import type { ParsedArgs } from '../src/cli/args.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { hasErrors, lintPipeline } from '../src/core/lint.js';
import { runPipeline } from '../src/core/run/runner.js';
import { ExitCode, StepcastError } from '../src/core/errors.js';
import { makeProject } from './helpers.js';

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

    const runsRoot = mkdtempSync(join(tmpdir(), 'stepcast-runs-'));
    const result = await runPipeline({
      expanded,
      config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
    });

    assert.equal(result.status, 'success');
  });
});
