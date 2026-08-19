import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { assembleContext, estimateTokens, type AssembleOptions } from '../src/core/context/assemble.js';
import { matchesGlob } from '../src/core/context/glob.js';
import { StepcastError } from '../src/core/errors.js';

function workspace(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'stepcast-context-'));
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

function assemble(dir: string, overrides: Partial<AssembleOptions> = {}) {
  return assembleContext({
    workspace: dir,
    pipeline: [],
    job: [],
    step: [],
    upstream: [],
    contextUpstream: 'all',
    inherit: true,
    exclude: [],
    deny: [],
    inlineThreshold: 1_000,
    maxTokens: 100_000,
    ...overrides,
  });
}

describe('step-context: сборка', () => {
  // Сценарий: «Объединение уровней»
  it('склеивает три уровня в порядке пайплайн, работа, шаг', () => {
    const dir = workspace({ 'a.md': 'из пайплайна', 'b.md': 'из работы', 'c.md': 'из шага' });
    const { report } = assemble(dir, {
      pipeline: [{ kind: 'path', path: 'a.md', mode: 'auto' }],
      job: [{ kind: 'path', path: 'b.md', mode: 'auto' }],
      step: [{ kind: 'path', path: 'c.md', mode: 'auto' }],
    });

    assert.deepEqual(
      report.entries.map((entry) => entry.origin),
      ['pipeline', 'job', 'step'],
    );
  });

  // Сценарий: «Текстовая запись»
  it('включает текстовую запись дословно', () => {
    const { text } = assemble(workspace(), {
      pipeline: [{ kind: 'text', text: 'Не трогать build/.' }],
    });
    assert.match(text, /Не трогать build\/\./);
  });

  // Сценарий: «Выход предыдущей работы виден»
  it('подмешивает выходы предшественников перед остальным контекстом', () => {
    const { text, report } = assemble(workspace(), {
      upstream: [{ job: 'plan', path: '/runs/artifacts/plan.json', value: { tasks: ['a'] } }],
    });

    assert.equal(report.entries[0]?.origin, 'upstream');
    assert.match(text, /Результаты предыдущих работ/);
    assert.match(text, /tasks/);
  });

  // Сценарий: «Отказ от автоматического блока»
  it('не формирует блок при context_upstream: none', () => {
    const { report } = assemble(workspace(), {
      upstream: [{ job: 'plan', path: 'p.json', value: {} }],
      contextUpstream: 'none',
    });
    assert.deepEqual(report.entries, []);
  });

  // Сценарий: «Выборочные предшественники»
  it('оставляет только перечисленных предшественников', () => {
    const { report } = assemble(workspace(), {
      upstream: [
        { job: 'plan', path: 'p.json', value: {} },
        { job: 'review', path: 'r.json', value: {} },
      ],
      contextUpstream: ['plan'],
    });
    assert.equal(report.entries.length, 1);
    assert.match(report.entries[0]?.path ?? '', /p\.json/);
  });

  // Сценарий: «Раскрытие глоба»
  it('раскрывает глоб в отсортированном порядке', () => {
    const dir = workspace({ 'src/b.ts': 'b', 'src/a.ts': 'a', 'src/c.ts': 'c' });
    const { report } = assemble(dir, {
      step: [{ kind: 'path', path: 'src/*.ts', mode: 'auto' }],
    });
    assert.deepEqual(
      report.entries.map((entry) => entry.path),
      ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    );
  });

  // Сценарий: «Повторный прогон даёт тот же контекст»
  it('даёт посимвольно одинаковый результат на неизменном входе', () => {
    const dir = workspace({ 'src/b.ts': 'b', 'src/a.ts': 'a' });
    const options: Partial<AssembleOptions> = {
      step: [{ kind: 'path', path: 'src/*.ts', mode: 'auto' }],
    };
    assert.equal(assemble(dir, options).text, assemble(dir, options).text);
  });

  // Сценарий: «Крупный файл передаётся путём»
  it('передаёт крупный файл путём, а мелкий содержимым', () => {
    const dir = workspace({ 'big.md': 'ы'.repeat(4_000), 'small.md': 'коротко' });
    const { report, text } = assemble(dir, {
      step: [
        { kind: 'path', path: 'big.md', mode: 'auto' },
        { kind: 'path', path: 'small.md', mode: 'auto' },
      ],
      inlineThreshold: 100,
    });

    assert.equal(report.entries[0]?.mode, 'reference');
    assert.equal(report.entries[1]?.mode, 'inline');
    assert.match(text, /Файл big\.md — прочитай сам/);
    assert.match(text, /коротко/);
  });

  // Сценарий: «Явная вставка»
  it('вставляет запись с явным inline независимо от размера', () => {
    const dir = workspace({ 'big.md': 'ы'.repeat(4_000) });
    const { report } = assemble(dir, {
      step: [{ kind: 'path', path: 'big.md', mode: 'inline' }],
      inlineThreshold: 10,
    });
    assert.equal(report.entries[0]?.mode, 'inline');
  });

  // Сценарий: «Только собственный контекст»
  it('отбрасывает унаследованное при context_inherit: false', () => {
    const dir = workspace({ 'a.md': 'пайплайн', 'c.md': 'шаг' });
    const { report } = assemble(dir, {
      pipeline: [{ kind: 'path', path: 'a.md', mode: 'auto' }],
      step: [{ kind: 'path', path: 'c.md', mode: 'auto' }],
      inherit: false,
    });
    assert.deepEqual(
      report.entries.map((entry) => entry.origin),
      ['step'],
    );
  });

  // Сценарий: «Исключение части записей»
  it('исключает записи по context_exclude', () => {
    const dir = workspace({ 'src/a.ts': 'a', 'docs/b.md': 'b' });
    const { report } = assemble(dir, {
      pipeline: [
        { kind: 'path', path: 'src/a.ts', mode: 'auto' },
        { kind: 'path', path: 'docs/b.md', mode: 'auto' },
      ],
      exclude: ['src/**'],
    });
    assert.deepEqual(
      report.entries.map((entry) => entry.path),
      ['docs/b.md'],
    );
  });

  // Сценарий: «Явно объявленный запрещённый путь»
  it('не включает запрещённый путь и сообщает об этом', () => {
    const dir = workspace({ '.env': 'SECRET=1', 'ok.md': 'можно' });
    const denied: Array<[string, string]> = [];

    const { report } = assemble(dir, {
      step: [
        { kind: 'path', path: '.env', mode: 'inline' },
        { kind: 'path', path: 'ok.md', mode: 'auto' },
      ],
      deny: ['**/.env*'],
      onDenied: (path, pattern) => denied.push([path, pattern]),
    });

    assert.deepEqual(
      report.entries.map((entry) => entry.path),
      ['ok.md'],
    );
    assert.deepEqual(denied, [['.env', '**/.env*']]);
  });
});

describe('step-context: предел размера', () => {
  // Сценарий: «Неудачный глоб собрал слишком много»
  it('понижает записи auto от самой крупной, пока не уложится', () => {
    const dir = workspace({
      'big.md': 'a'.repeat(40_000),
      'mid.md': 'b'.repeat(8_000),
      'small.md': 'c'.repeat(100),
    });
    const downgraded: string[] = [];

    const { report } = assemble(dir, {
      step: [
        { kind: 'path', path: 'big.md', mode: 'auto' },
        { kind: 'path', path: 'mid.md', mode: 'auto' },
        { kind: 'path', path: 'small.md', mode: 'auto' },
      ],
      inlineThreshold: 100_000,
      maxTokens: 3_000,
      onDowngraded: (path) => downgraded.push(path),
    });

    assert.deepEqual(downgraded, ['big.md'], 'понижается самая крупная и только она');
    assert.equal(report.entries[0]?.mode, 'reference');
    assert.equal(report.entries[2]?.mode, 'inline');
  });

  // Сценарий: «Явная вставка не понижается»
  it('не понижает записи с явным inline', () => {
    const dir = workspace({ 'pinned.md': 'a'.repeat(40_000), 'auto.md': 'b'.repeat(40_000) });
    const downgraded: string[] = [];

    assemble(dir, {
      step: [
        { kind: 'path', path: 'pinned.md', mode: 'inline' },
        { kind: 'path', path: 'auto.md', mode: 'auto' },
      ],
      // Порог выше обеих записей: обе начинают вставленными, и понижение
      // происходит именно из-за предела, а не из-за размера одной записи.
      inlineThreshold: 100_000,
      maxTokens: 11_000,
      onDowngraded: (path) => downgraded.push(path),
    });

    assert.deepEqual(downgraded, ['auto.md']);
  });

  // Сценарий: «Предел недостижим понижениями»
  it('отказывает шагу, когда понижения не помогли, и называет крупнейшие записи', () => {
    const dir = workspace({ 'huge.md': 'a'.repeat(40_000) });
    assert.throws(
      () =>
        assemble(dir, {
          step: [{ kind: 'path', path: 'huge.md', mode: 'inline' }],
          maxTokens: 100,
        }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /превышает предел/);
        assert.match(error.hint ?? '', /huge\.md/);
        return true;
      },
    );
  });
});

describe('step-context: вспомогательное', () => {
  it('оценивает размер, различая письменности', () => {
    assert.ok(estimateTokens('ы'.repeat(100)) > estimateTokens('a'.repeat(100)));
    assert.equal(estimateTokens(''), 0);
  });

  it('сопоставляет пути с глобами', () => {
    assert.equal(matchesGlob('.env', '**/.env*'), true);
    assert.equal(matchesGlob('config/.env.local', '**/.env*'), true);
    assert.equal(matchesGlob('src/a.ts', 'src/**'), true);
    assert.equal(matchesGlob('src/deep/a.ts', 'src/*'), false);
    assert.equal(matchesGlob('certs/key.pem', '**/*.pem'), true);
    assert.equal(matchesGlob('key.pem', '**/*.pem'), true, 'ноль сегментов тоже считается');
  });
});
