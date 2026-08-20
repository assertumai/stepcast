import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runContextCommand } from '../src/cli/commands/context.js';
import type { ParsedArgs } from '../src/cli/args.js';
import { ExitCode, StepcastError } from '../src/core/errors.js';
import { RunJournal } from '../src/core/journal/writer.js';
import { listRuns } from '../src/core/journal/reader.js';
import { makeProject, type Project } from './helpers.js';

const PIPELINE = `
version: 1
kind: pipeline
name: context-preview

inputs:
  topic: { type: string, required: true }

context:
  - text: "контекст пайплайна"

defaults:
  agent: claude

jobs:
  producer:
    output:
      from: emit
    steps:
      - id: emit
        run: [echo, ok]
        expect: [{ exit_code: 0 }]

  consumer:
    needs: [producer]
    context:
      - text: "контекст работы про consumer"
    steps:
      - id: write-code
        agent: claude
        prompt: "Тема: \${inputs.topic}"
        context:
          - text: "контекст шага write-code"
      - id: verify
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
`;

function args(flags: ParsedArgs['flags'] = {}): ParsedArgs {
  return { command: 'context', positional: [], flags };
}

function withHome<T>(home: string, fn: () => T): T {
  const original = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
  }
}

interface Bed {
  readonly project: Project;
  readonly runsRoot: string;
  readonly home: string;
}

function bed(): Bed {
  const project = makeProject({ 'stepcast.yml': PIPELINE });
  const runsRoot = join(project.home, '..', 'runs');
  mkdirSync(runsRoot, { recursive: true });
  writeFileSync(join(project.home, '.stepcast', 'config.yml'), `runs:\n  root: ${runsRoot}\n`);
  return { project, runsRoot, home: project.home };
}

function call(b: Bed, flags: ParsedArgs['flags'] = {}): { code: number; lines: string[] } {
  const lines: string[] = [];
  const code = withHome(b.home, () => runContextCommand(args(flags), (line) => lines.push(line), b.project.root));
  return { code, lines };
}

describe('CLI: stepcast context', () => {
  // Сценарии: «Отчёт без прогона» и «Прогонов ещё не было»
  it('без предварительного прогона помечает выходы предшественников неизвестными', () => {
    const b = bed();

    const { code, lines } = call(b, { job: 'consumer', step: 'write-code', input: { topic: 'сессии' } });

    assert.equal(code, ExitCode.ok);
    assert.match(lines.join('\n'), /выходы предшественников\s+неизвестно/);
    assert.deepEqual(listRuns(b.runsRoot, b.project.root), []);
  });

  // Сценарии: «Разрез по уровням» и «Оценка по прошлому прогону»
  it('после прогона показывает оценку по каждому уровню', () => {
    const b = bed();
    const journal = RunJournal.create({ runsRoot: b.runsRoot, projectRoot: b.project.root });
    journal.writeManifest({
      run_id: journal.paths.runId,
      pipeline: 'context-preview',
      pipeline_file: b.project.path('stepcast.yml'),
      lock_hash: 'abc',
      project_root: b.project.root,
      workspace: { mode: 'cwd' },
      inputs: { topic: 'сессии' },
      git: {},
      backends: {},
      started_at: '2026-08-01T00:00:00.000Z',
      finished_at: '2026-08-01T00:05:00.000Z',
    });
    journal.writeArtifact('producer', { fact: 'три ключевых факта' });

    const { code, lines } = call(b, { job: 'consumer', step: 'write-code', input: { topic: 'сессии' } });
    const output = lines.join('\n');

    assert.equal(code, ExitCode.ok);
    assert.doesNotMatch(output, /неизвестно/);
    assert.match(output, /выходы предшественников\s+\d+ ток\./);
    assert.match(output, /пайплайн\s+\d+ ток\./);
    assert.match(output, /работа consumer\s+\d+ ток\./);
    assert.match(output, /шаг write-code\s+\d+ ток\./);
    assert.match(output, /итого\s+\d+ ток\./);
  });

  // Сценарий: «Раскрытие требует объявленных входов»
  it('прокидывает ошибку раскрытия при отсутствующем обязательном входе', () => {
    const b = bed();

    assert.throws(
      () => call(b, { job: 'consumer', step: 'write-code' }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /topic/);
        return true;
      },
    );
  });

  // Сценарий: «Командный шаг»
  it('отказывает для командного шага вместо пустого отчёта', () => {
    const b = bed();

    assert.throws(
      () => call(b, { job: 'consumer', step: 'verify', input: { topic: 'сессии' } }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /командный/);
        return true;
      },
    );
  });
});
