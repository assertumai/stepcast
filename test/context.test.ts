import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runContextCommand } from '../src/cli/commands/context.js';
import {
  assembleContext,
  type AssembleOptions,
  type KnowledgeResolver,
} from '../src/core/context/assemble.js';
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

/** Пайплайн для теста склейки: один и тот же файл на пайплайне и на работе. */
const DEDUP_PIPELINE = `
version: 1
kind: pipeline
name: context-dedup-preview

inputs:
  topic: { type: string, required: true }

context:
  - CLAUDE.md

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
      - CLAUDE.md
    steps:
      - id: write-code
        agent: claude
        prompt: "Тема: \${inputs.topic}"
`;

/** Минимальная сборка контекста: одна текстовая запись шага и ничего больше. */
function assembleBase(): AssembleOptions {
  return {
    workspace: process.cwd(),
    pipeline: [],
    job: [],
    step: [{ kind: 'text', text: 'контекст шага' }],
    upstream: [],
    contextUpstream: 'none',
    inherit: true,
    exclude: [],
    deny: [],
    inlineThreshold: 2000,
    maxTokens: 200_000,
  };
}

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

  // Сценарий: «Предел контекста меньше предела выдержки»
  it('отказывает, когда предел контекста шага меньше предела выдержки', () => {
    assert.throws(
      () => assembleContext({ ...assembleBase(), maxTokens: 100, noteMaxTokens: 4000 }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /100/);
        assert.match(error.message, /4k/i);
        return true;
      },
    );
  });

  // Шага без выдержки противоречие двух пределов не касается: узкий
  // context_max_tokens сам по себе не повод отказывать.
  it('не отказывает шагу с узким пределом, когда выдержки в контексте нет', () => {
    const assembled = assembleContext({ ...assembleBase(), maxTokens: 100 });

    assert.match(assembled.text, /контекст шага/);
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

  // Изменение context-dedup: повтор одного файла на пайплайне и на работе не
  // должен удваивать величину уровня «работа».
  it('повтор одного файла на пайплайне и на работе не удваивает величину уровня', () => {
    const project = makeProject({
      'stepcast.yml': DEDUP_PIPELINE,
      'CLAUDE.md': 'а'.repeat(400),
    });
    const runsRoot = join(project.root, '..', 'runs');
    mkdirSync(runsRoot, { recursive: true });
    writeFileSync(join(project.home, '.stepcast', 'config.yml'), `runs:\n  root: ${runsRoot}\n`);

    const lines: string[] = [];
    const code = withHome(project.home, () =>
      runContextCommand(
        args({ job: 'consumer', step: 'write-code', input: { topic: 'т' } }),
        (line) => lines.push(line),
        project.root,
      ),
    );
    const output = lines.join('\n');

    assert.equal(code, ExitCode.ok);
    const pipelineMatch = /пайплайн\s+(\d+)\s*ток\./.exec(output);
    const jobMatch = /работа consumer\s+(\d+)\s*ток\./.exec(output);
    const totalMatch = /итого\s+(\d+)\s*ток\./.exec(output);
    assert.ok(pipelineMatch !== null && jobMatch !== null && totalMatch !== null, output);

    const pipelineTokens = Number(pipelineMatch![1]);
    const jobTokens = Number(jobMatch![1]);
    const totalTokens = Number(totalMatch![1]);

    assert.ok(pipelineTokens > 0);
    assert.equal(jobTokens, 0);
    assert.equal(totalTokens, pipelineTokens);

    // Ноль у уровня «работа» без перечня склеенных записей не отличить от
    // «на этом уровне ничего не объявлено».
    assert.match(output, /склеенные записи/);
    assert.match(output, /CLAUDE\.md\s+пайплайн, работа/);
  });
});

describe('assembleContext: склейка повторов', () => {
  it('файл, объявленный на пайплайне и на работе, входит один раз — в разделе пайплайна', () => {
    const project = makeProject({ 'CLAUDE.md': '# claude\n' });

    const assembled = assembleContext({
      ...assembleBase(),
      workspace: project.root,
      pipeline: [{ kind: 'path', path: 'CLAUDE.md', mode: 'auto' }],
      job: [{ kind: 'path', path: 'CLAUDE.md', mode: 'auto' }],
      step: [],
    });

    const entries = assembled.report.entries.filter((entry) => entry.path === 'CLAUDE.md');
    assert.equal(entries.length, 1);
    const entry = assembled.report.entries.find((item) => item.path === 'CLAUDE.md');
    assert.equal(entry?.origin, 'pipeline');
    assert.deepEqual(entry?.declared_in, ['pipeline', 'job']);
    assert.equal(assembled.text.split('# claude').length - 1, 1);
  });

  it('повтор внутри одного уровня даёт одну запись', () => {
    const project = makeProject({ 'AGENTS.md': 'привет' });

    const assembled = assembleContext({
      ...assembleBase(),
      workspace: project.root,
      pipeline: [],
      job: [
        { kind: 'path', path: 'AGENTS.md', mode: 'auto' },
        { kind: 'path', path: 'AGENTS.md', mode: 'auto' },
      ],
      step: [],
    });

    const entries = assembled.report.entries.filter((entry) => entry.path === 'AGENTS.md');
    assert.equal(entries.length, 1);
    const entry = assembled.report.entries.find((item) => item.path === 'AGENTS.md');
    assert.equal(entry?.declared_in, undefined);
  });

  it('глоб работы, пересекающийся с явным путём пайплайна, включает пересечение один раз', () => {
    const project = makeProject({
      'docs/plan.md': 'план',
      'docs/other.md': 'другое',
    });

    const assembled = assembleContext({
      ...assembleBase(),
      workspace: project.root,
      pipeline: [{ kind: 'path', path: 'docs/plan.md', mode: 'auto' }],
      job: [{ kind: 'path', path: 'docs/*.md', mode: 'auto' }],
      step: [],
    });

    const planEntries = assembled.report.entries.filter((entry) => entry.path === 'docs/plan.md');
    assert.equal(planEntries.length, 1);
    const planEntry = assembled.report.entries.find((item) => item.path === 'docs/plan.md');
    assert.equal(planEntry?.origin, 'pipeline');
    assert.deepEqual(planEntry?.declared_in, ['pipeline', 'job']);

    const otherEntries = assembled.report.entries.filter((entry) => entry.path === 'docs/other.md');
    assert.equal(otherEntries.length, 1);
    const otherEntry = assembled.report.entries.find((item) => item.path === 'docs/other.md');
    assert.equal(otherEntry?.origin, 'job');
  });

  it('путь выхода предшественника, объявленный вдобавок в context работы, входит один раз — в блоке выходов', () => {
    const project = makeProject({});
    const artifactPath = join(project.root, 'artifacts', 'producer.json');

    const assembled = assembleContext({
      ...assembleBase(),
      workspace: project.root,
      contextUpstream: 'all',
      upstream: [{ job: 'producer', path: artifactPath, value: { fact: 1 } }],
      pipeline: [],
      job: [{ kind: 'path', path: artifactPath, mode: 'auto' }],
      step: [],
    });

    const entries = assembled.report.entries.filter((entry) => entry.path === artifactPath);
    assert.equal(entries.length, 1);
    const entry = assembled.report.entries.find((item) => item.path === artifactPath);
    assert.equal(entry?.origin, 'upstream');
    assert.deepEqual(entry?.declared_in, ['upstream', 'job']);
  });

  // Ключ тождества якорится на рабочей директории шага, а не на process.cwd():
  // выход предшественника, названный относительным путём, обязан склеиваться с
  // тем же относительным объявлением уровня.
  it('выход предшественника с относительным путём склеивается с объявлением уровня', () => {
    const project = makeProject({ 'artifacts/producer.json': '{"fact":1}' });

    const assembled = assembleContext({
      ...assembleBase(),
      workspace: project.root,
      contextUpstream: 'all',
      upstream: [{ job: 'producer', path: 'artifacts/producer.json', value: { fact: 1 } }],
      pipeline: [],
      job: [{ kind: 'path', path: 'artifacts/producer.json', mode: 'auto' }],
      step: [],
    });

    const entries = assembled.report.entries.filter(
      (entry) => entry.path === 'artifacts/producer.json',
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.origin, 'upstream');
    assert.deepEqual(entries[0]?.declared_in, ['upstream', 'job']);
  });

  it('записи text с одинаковым содержимым на двух уровнях остаются двумя записями', () => {
    const assembled = assembleContext({
      ...assembleBase(),
      pipeline: [{ kind: 'text', text: 'то же самое' }],
      job: [{ kind: 'text', text: 'то же самое' }],
      step: [],
    });

    const entries = assembled.report.entries.filter((entry) => entry.kind === 'text');
    assert.equal(entries.length, 2);
    for (const entry of entries) assert.equal(entry.declared_in, undefined);
  });

  it('повтор на нижнем уровне не меняет собранный текст, если он не сильнее первого объявления', () => {
    const project = makeProject({ 'CLAUDE.md': '# claude\n'.repeat(50) });

    const once = assembleContext({
      ...assembleBase(),
      workspace: project.root,
      pipeline: [{ kind: 'path', path: 'CLAUDE.md', mode: 'auto' }],
      job: [],
      step: [],
    });
    const withRepeat = assembleContext({
      ...assembleBase(),
      workspace: project.root,
      pipeline: [{ kind: 'path', path: 'CLAUDE.md', mode: 'auto' }],
      job: [{ kind: 'path', path: 'CLAUDE.md', mode: 'auto' }],
      step: [],
    });

    assert.equal(once.text, withRepeat.text);
  });
});

describe('assembleContext: способ передачи по силе объявления', () => {
  it('reference на пайплайне и inline на работе дают вставку', () => {
    const project = makeProject({ 'file.md': 'содержимое файла' });

    const assembled = assembleContext({
      ...assembleBase(),
      workspace: project.root,
      pipeline: [{ kind: 'path', path: 'file.md', mode: 'reference' }],
      job: [{ kind: 'path', path: 'file.md', mode: 'inline' }],
      step: [],
    });

    const entry = assembled.report.entries.find((item) => item.path === 'file.md');
    assert.equal(entry?.mode, 'inline');
    assert.match(assembled.text, /содержимое файла/);
  });

  it('inline на пайплайне и reference на шаге оставляют вставку', () => {
    const project = makeProject({ 'file.md': 'содержимое файла' });

    const assembled = assembleContext({
      ...assembleBase(),
      workspace: project.root,
      pipeline: [{ kind: 'path', path: 'file.md', mode: 'inline' }],
      job: [],
      step: [{ kind: 'path', path: 'file.md', mode: 'reference' }],
    });

    const entry = assembled.report.entries.find((item) => item.path === 'file.md');
    assert.equal(entry?.mode, 'inline');
    assert.match(assembled.text, /содержимое файла/);
  });

  it('два auto дают тот же исход, что одно auto', () => {
    const project = makeProject({ 'big.md': 'ы'.repeat(20_000) });

    const once = assembleContext({
      ...assembleBase(),
      workspace: project.root,
      pipeline: [{ kind: 'path', path: 'big.md', mode: 'auto' }],
      job: [],
      step: [],
    });
    const twice = assembleContext({
      ...assembleBase(),
      workspace: project.root,
      pipeline: [{ kind: 'path', path: 'big.md', mode: 'auto' }],
      job: [{ kind: 'path', path: 'big.md', mode: 'auto' }],
      step: [],
    });

    assert.equal(once.text, twice.text);
    const entry = twice.report.entries.find((item) => item.path === 'big.md');
    assert.equal(entry?.mode, 'reference');
  });

  // Сценарий спеки «Крупный файл, объявленный вставкой на одном из уровней»:
  // сверх порога `auto` даёт передачу путём (сила 0), а `inline` на работе —
  // непонижаемую вставку (сила 2). Пара с контрольным случаем нужна, чтобы
  // тест ловил именно закрепление: без него запись понизилась бы и уложилась.
  it('inline на работе закрепляет вставку крупного файла, объявленного на пайплайне как auto', () => {
    const project = makeProject({ 'big.md': 'ы'.repeat(20_000) });
    const downgraded: string[] = [];

    assert.throws(
      () =>
        assembleContext({
          ...assembleBase(),
          workspace: project.root,
          pipeline: [{ kind: 'path', path: 'big.md', mode: 'auto' }],
          job: [{ kind: 'path', path: 'big.md', mode: 'inline' }],
          step: [],
          maxTokens: 1000,
          onDowngraded: (path) => downgraded.push(path),
        }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /big\.md|превышает предел/);
        return true;
      },
    );
    assert.deepEqual(downgraded, []);
  });

  it('inline с нижнего уровня превращает понижаемую вставку в непонижаемую', () => {
    const project = makeProject({ 'small.md': 'а'.repeat(400) });

    // Без `inline` запись — обычная вставка из `auto`: предел достигается
    // понижением, отказа нет.
    const downgraded: string[] = [];
    const assembled = assembleContext({
      ...assembleBase(),
      workspace: project.root,
      pipeline: [{ kind: 'path', path: 'small.md', mode: 'auto' }],
      job: [{ kind: 'path', path: 'small.md', mode: 'auto' }],
      step: [],
      maxTokens: 100,
      onDowngraded: (path) => downgraded.push(path),
    });
    assert.deepEqual(downgraded, ['small.md']);
    assert.equal(
      assembled.report.entries.find((item) => item.path === 'small.md')?.mode,
      'reference',
    );

    // С `inline` на работе та же запись понижению не подлежит.
    const pinnedDowngraded: string[] = [];
    assert.throws(
      () =>
        assembleContext({
          ...assembleBase(),
          workspace: project.root,
          pipeline: [{ kind: 'path', path: 'small.md', mode: 'auto' }],
          job: [{ kind: 'path', path: 'small.md', mode: 'inline' }],
          step: [],
          maxTokens: 100,
          onDowngraded: (path) => pinnedDowngraded.push(path),
        }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        return true;
      },
    );
    assert.deepEqual(pinnedDowngraded, []);
  });
});

describe('assembleContext: отсев путей до склейки', () => {
  it('путь под context.deny не порождает записи ни на одном уровне', () => {
    const project = makeProject({ 'secret.env': 'КЛЮЧ=1', 'plain.md': 'обычный' });

    const assembled = assembleContext({
      ...assembleBase(),
      workspace: project.root,
      deny: ['*.env'],
      pipeline: [{ kind: 'path', path: 'secret.env', mode: 'auto' }],
      job: [
        { kind: 'path', path: 'secret.env', mode: 'inline' },
        { kind: 'path', path: 'plain.md', mode: 'auto' },
      ],
      step: [],
    });

    assert.equal(
      assembled.report.entries.filter((entry) => entry.path === 'secret.env').length,
      0,
    );
    assert.doesNotMatch(assembled.text, /КЛЮЧ=1/);
    assert.equal(assembled.report.entries.filter((entry) => entry.path === 'plain.md').length, 1);
  });

  it('отклонённый путь даёт одно событие об отказе, сколько бы раз он ни был объявлен', () => {
    const project = makeProject({ 'secret.env': 'КЛЮЧ=1' });
    const events: Array<[string, string]> = [];

    assembleContext({
      ...assembleBase(),
      workspace: project.root,
      deny: ['*.env'],
      pipeline: [{ kind: 'path', path: 'secret.env', mode: 'auto' }],
      job: [{ kind: 'path', path: 'secret.env', mode: 'auto' }],
      step: [{ kind: 'path', path: '*.env', mode: 'auto' }],
      onDenied: (path, pattern) => events.push([path, pattern]),
    });

    assert.deepEqual(events, [['secret.env', '*.env']]);
  });

  it('путь под context_exclude не порождает записи ни на одном уровне', () => {
    const project = makeProject({ 'docs/plan.md': 'план', 'docs/draft.md': 'черновик' });

    const assembled = assembleContext({
      ...assembleBase(),
      workspace: project.root,
      exclude: ['docs/draft.md'],
      pipeline: [{ kind: 'path', path: 'docs/draft.md', mode: 'inline' }],
      job: [{ kind: 'path', path: 'docs/*.md', mode: 'auto' }],
      step: [],
    });

    assert.equal(
      assembled.report.entries.filter((entry) => entry.path === 'docs/draft.md').length,
      0,
    );
    assert.doesNotMatch(assembled.text, /черновик/);
    assert.equal(assembled.report.entries.filter((entry) => entry.path === 'docs/plan.md').length, 1);
  });
});

describe('assembleContext: отчёт о составе после склейки', () => {
  it('повтор на двух уровнях даёт одну запись с declared_in из двух уровней', () => {
    const project = makeProject({ 'CLAUDE.md': 'текст' });

    const assembled = assembleContext({
      ...assembleBase(),
      workspace: project.root,
      pipeline: [{ kind: 'path', path: 'CLAUDE.md', mode: 'auto' }],
      job: [{ kind: 'path', path: 'CLAUDE.md', mode: 'auto' }],
      step: [],
    });

    const entry = assembled.report.entries.find((item) => item.path === 'CLAUDE.md');
    assert.deepEqual(entry?.declared_in, ['pipeline', 'job']);
  });

  it('запись без повторов не несёт declared_in', () => {
    const project = makeProject({ 'CLAUDE.md': 'текст' });

    const assembled = assembleContext({
      ...assembleBase(),
      workspace: project.root,
      pipeline: [{ kind: 'path', path: 'CLAUDE.md', mode: 'auto' }],
      job: [],
      step: [],
    });

    const entry = assembled.report.entries.find((item) => item.path === 'CLAUDE.md');
    assert.equal(entry?.declared_in, undefined);
  });
});

describe('assembleContext: предел размера считается по составу после склейки', () => {
  it('файл, чей двойной учёт вывел бы контекст за предел, укладывается в предел без понижений и без отказа', () => {
    const project = makeProject({ 'CLAUDE.md': 'а'.repeat(400) });
    const downgraded: string[] = [];

    const assembled = assembleContext({
      ...assembleBase(),
      workspace: project.root,
      pipeline: [{ kind: 'path', path: 'CLAUDE.md', mode: 'auto' }],
      job: [{ kind: 'path', path: 'CLAUDE.md', mode: 'auto' }],
      step: [],
      maxTokens: 250,
      onDowngraded: (path) => downgraded.push(path),
    });

    assert.deepEqual(downgraded, []);
    assert.equal(assembled.report.total_tokens, 200);
  });

  it('сообщение об отказе не называет один путь дважды', () => {
    const project = makeProject({ 'CLAUDE.md': 'а'.repeat(4000) });

    assert.throws(
      () =>
        assembleContext({
          ...assembleBase(),
          workspace: project.root,
          pipeline: [{ kind: 'path', path: 'CLAUDE.md', mode: 'inline' }],
          job: [{ kind: 'path', path: 'CLAUDE.md', mode: 'inline' }],
          step: [],
          maxTokens: 10,
        }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        const hint = (error as StepcastError).hint ?? '';
        assert.equal(hint.match(/CLAUDE\.md/g)?.length ?? 0, 1);
        return true;
      },
    );
  });
});

/**
 * Требование совпадений. Пустой глоб — единственный способ получить контекст
 * беднее объявленного, ничего об этом не узнав: путь без глоба роняет сборку
 * сам, а отсев по `deny` и `context_exclude` сопровождается событием.
 */
describe('assembleContext: required у записи контекста', () => {
  it('глоб без совпадений роняет сборку, называя путь', () => {
    const project = makeProject({ 'docs/other.txt': 'не markdown' });

    assert.throws(
      () =>
        assembleContext({
          ...assembleBase(),
          workspace: project.root,
          pipeline: [],
          job: [{ kind: 'path', path: 'changes/demo/**/*.md', mode: 'auto', required: true }],
          step: [],
        }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /changes\/demo\/\*\*\/\*\.md/);
        return true;
      },
    );
  });

  it('глоб без совпадений без требования по-прежнему даёт пустую запись', () => {
    const project = makeProject({ 'docs/other.txt': 'не markdown' });

    const assembled = assembleContext({
      ...assembleBase(),
      workspace: project.root,
      pipeline: [],
      job: [{ kind: 'path', path: 'changes/demo/**/*.md', mode: 'auto' }],
      step: [],
    });

    assert.deepEqual(
      assembled.report.entries.filter((entry) => entry.kind === 'path'),
      [],
    );
  });

  // Частичный набор документов практика допускает — требование его пропускает:
  // речь о записи, не нашедшей вообще ничего.
  it('хотя бы одно совпадение требование удовлетворяет', () => {
    const project = makeProject({ 'changes/demo/proposal.md': 'предложение' });

    const assembled = assembleContext({
      ...assembleBase(),
      workspace: project.root,
      pipeline: [],
      job: [{ kind: 'path', path: 'changes/demo/**/*.md', mode: 'auto', required: true }],
      step: [],
    });

    assert.deepEqual(
      assembled.report.entries.filter((entry) => entry.kind === 'path').map((entry) => entry.path),
      ['changes/demo/proposal.md'],
    );
  });
});

describe('step-context: запись знания', () => {
  /** Источник-заглушка: отбор без репозитория, каталога и подпроцессов. */
  function stubKnowledge(
    entries: readonly { id: string; title: string; path?: string; text?: string; tokens: number }[],
  ): KnowledgeResolver {
    return (selector, budget) =>
      selector.kind === 'index'
        ? [{ id: 'index', title: 'Оглавление', text: 'a — Первая', tokens: 4 }]
        : entries.filter((_, index) => budget === undefined || index === 0);
  }

  // Задача 3.7 / Сценарий: «Оглавление»
  it('оглавление приходит записью знания с идентификатором в отчёте', () => {
    const assembled = assembleContext({
      ...assembleBase(),
      pipeline: [{ kind: 'knowledge', selector: { kind: 'index' } }],
      step: [],
      knowledge: stubKnowledge([]),
    });

    const entry = assembled.report.entries.find((item) => item.kind === 'knowledge');
    assert.equal(entry?.id, 'index');
    assert.equal(entry?.origin, 'pipeline');
    assert.match(assembled.text, /a — Первая/);
  });

  // Задача 3.7 / Сценарий: «Отбор по области»
  it('тела приходят путём и проходят порог вставки как файловые', () => {
    const project = makeProject({ 'knowledge/a.md': 'тело единицы' });

    const assembled = assembleContext({
      ...assembleBase(),
      workspace: project.root,
      job: [{ kind: 'knowledge', selector: { kind: 'scope', scope: ['src/**'] } }],
      step: [],
      knowledge: stubKnowledge([
        { id: 'a', title: 'Первая', path: 'knowledge/a.md', tokens: 3 },
      ]),
    });

    const entry = assembled.report.entries.find((item) => item.kind === 'knowledge');
    assert.equal(entry?.id, 'a');
    assert.equal(entry?.path, 'knowledge/a.md');
    assert.equal(entry?.mode, 'inline');
    assert.match(assembled.text, /тело единицы/);
  });

  // Задача 3.3: запрет действует и на то, что вернул источник, — иначе запись
  // знания стала бы законным обходом политики.
  it('путь под context.deny не проходит, даже когда его вернул источник', () => {
    const project = makeProject({ '.env.local': 'SECRET=1' });
    const denied: string[] = [];

    const assembled = assembleContext({
      ...assembleBase(),
      workspace: project.root,
      deny: ['**/.env*'],
      job: [{ kind: 'knowledge', selector: { kind: 'scope', scope: ['src/**'] } }],
      step: [],
      knowledge: stubKnowledge([{ id: 'a', title: 'Первая', path: '.env.local', tokens: 3 }]),
      onDenied: (path) => denied.push(path),
    });

    assert.deepEqual(
      assembled.report.entries.filter((entry) => entry.kind === 'knowledge'),
      [],
    );
    assert.deepEqual(denied, ['.env.local']);
  });

  // Задача 3.3: крупная единица уезжает ссылкой тем же порогом, что файл.
  it('крупная единица передаётся путём, а не вставкой', () => {
    const project = makeProject({ 'knowledge/a.md': 'очень длинное тело '.repeat(500) });

    const assembled = assembleContext({
      ...assembleBase(),
      workspace: project.root,
      inlineThreshold: 10,
      job: [{ kind: 'knowledge', selector: { kind: 'scope', scope: ['src/**'] } }],
      step: [],
      knowledge: stubKnowledge([
        { id: 'a', title: 'Первая', path: 'knowledge/a.md', tokens: 3 },
      ]),
    });

    assert.equal(
      assembled.report.entries.find((item) => item.kind === 'knowledge')?.mode,
      'reference',
    );
  });

  // Задача 3.2: место записи в порядке сборки задаёт уровень объявления.
  it('стоит на месте своего объявления, между записями соседних уровней', () => {
    const assembled = assembleContext({
      ...assembleBase(),
      pipeline: [{ kind: 'text', text: 'перед' }],
      job: [{ kind: 'knowledge', selector: { kind: 'index' } }],
      step: [{ kind: 'text', text: 'после' }],
      knowledge: stubKnowledge([]),
    });

    assert.deepEqual(
      assembled.report.entries.map((entry) => entry.origin),
      ['pipeline', 'job', 'step'],
    );
  });

  // Задача 3.2: одна и та же единица, названная двумя уровнями, — промах
  // адресации, а не осознанное повторение: склеивается по идентификатору.
  it('склеивает повтор единицы по идентификатору и отмечает уровни объявления', () => {
    const assembled = assembleContext({
      ...assembleBase(),
      pipeline: [{ kind: 'knowledge', selector: { kind: 'index' } }],
      job: [{ kind: 'knowledge', selector: { kind: 'index' } }],
      step: [],
      knowledge: stubKnowledge([]),
    });

    const entries = assembled.report.entries.filter((entry) => entry.kind === 'knowledge');
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.origin, 'pipeline');
    assert.deepEqual(entries[0]?.declared_in, ['pipeline', 'job']);
    assert.equal(assembled.text.split('a — Первая').length - 1, 1);
  });

  // Задача 3.4 / Сценарий: «Отказ от наследования»
  it('context_inherit: false отменяет запись знания наравне с прочими', () => {
    const assembled = assembleContext({
      ...assembleBase(),
      pipeline: [{ kind: 'knowledge', selector: { kind: 'index' } }],
      step: [{ kind: 'text', text: 'только шаг' }],
      inherit: false,
      knowledge: stubKnowledge([]),
    });

    assert.deepEqual(
      assembled.report.entries.filter((entry) => entry.kind === 'knowledge'),
      [],
    );
  });

  // Задача 3.2: источника нет — отказ, а не молча пустой контекст.
  it('отказывает, когда запись знания объявлена без источника', () => {
    assert.throws(
      () =>
        assembleContext({
          ...assembleBase(),
          job: [{ kind: 'knowledge', selector: { kind: 'index' } }],
          step: [],
        }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /без источника/);
        return true;
      },
    );
  });

  // Задача 3.2 / Сценарий: «Собственный предел записи»
  it('собственный предел записи доезжает до источника', () => {
    const project = makeProject({ 'knowledge/a.md': 'первая', 'knowledge/b.md': 'вторая' });

    const assembled = assembleContext({
      ...assembleBase(),
      workspace: project.root,
      job: [{ kind: 'knowledge', selector: { kind: 'scope', scope: ['src/**'] }, budget: 4000 }],
      step: [],
      knowledge: stubKnowledge([
        { id: 'a', title: 'Первая', path: 'knowledge/a.md', tokens: 3 },
        { id: 'b', title: 'Вторая', path: 'knowledge/b.md', tokens: 3 },
      ]),
    });

    assert.deepEqual(
      assembled.report.entries.filter((entry) => entry.kind === 'knowledge').map((entry) => entry.id),
      ['a'],
    );
  });

  // Задача 3.3: общий предел считает знание наравне с файлами — крупная
  // единица понижается до ссылки тем же проходом, что и файл, а не остаётся
  // вставкой сверх бюджета.
  it('вклад знания учитывается в проверке общего предела и понижается наравне с файлом', () => {
    const project = makeProject({ 'knowledge/a.md': 'очень длинное тело '.repeat(2000) });
    const downgraded: string[] = [];

    const assembled = assembleContext({
      ...assembleBase(),
      workspace: project.root,
      // Порог вставки заведомо выше единицы, предел контекста — заведомо ниже:
      // так проверяется именно проход бюджета, а не порог, который отправил бы
      // её ссылкой ещё при разрешении.
      inlineThreshold: 1_000_000,
      maxTokens: 100,
      job: [{ kind: 'knowledge', selector: { kind: 'scope', scope: ['src/**'] } }],
      step: [],
      knowledge: stubKnowledge([{ id: 'a', title: 'Первая', path: 'knowledge/a.md', tokens: 3 }]),
      onDowngraded: (path) => downgraded.push(path),
    });

    assert.deepEqual(downgraded, ['knowledge/a.md']);
    assert.equal(
      assembled.report.entries.find((entry) => entry.kind === 'knowledge')?.mode,
      'reference',
    );
  });

  // Задача 3.3: понижать нечего — отказ, тот же, что у файловых записей.
  it('отказывает, когда знание не влезает даже ссылками', () => {
    assert.throws(
      () =>
        assembleContext({
          ...assembleBase(),
          maxTokens: 1,
          job: [{ kind: 'knowledge', selector: { kind: 'index' } }],
          step: [],
          knowledge: stubKnowledge([]),
        }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /превышает предел/);
        return true;
      },
    );
  });
});
