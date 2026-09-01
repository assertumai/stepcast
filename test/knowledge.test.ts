import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { createFsKnowledgeSource, globsIntersect, parseUnit } from '../src/core/knowledge/fs.js';
import { createKnowledgeSource } from '../src/core/knowledge/source.js';
import {
  KnowledgeWriteRequestSchema,
  type KnowledgeSource,
} from '../src/core/knowledge/types.js';
import { StepcastError } from '../src/core/errors.js';
import { gitCommit, gitInit } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;

interface Repo {
  readonly root: string;
  write(path: string, content: string): void;
  commit(message: string): void;
  source(overrides?: { indexMaxTokens?: number; staleAfterMs?: number; now?: number }): KnowledgeSource;
}

function repo(files: Readonly<Record<string, string>> = {}): Repo {
  const root = mkdtempSync(join(tmpdir(), 'stepcast-knowledge-'));
  gitInit(root);

  const write = (path: string, content: string): void => {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };

  for (const [name, content] of Object.entries(files)) write(name, content);

  return {
    root,
    write,
    commit: (message) => gitCommit(root, message),
    source: (overrides = {}) =>
      createFsKnowledgeSource({
        root,
        dir: 'knowledge',
        indexMaxTokens: overrides.indexMaxTokens ?? 2000,
        staleAfterMs: overrides.staleAfterMs ?? 14 * DAY,
        ...(overrides.now === undefined ? {} : { now: overrides.now }),
      }),
  };
}

function unit(options: {
  id: string;
  title: string;
  scope?: readonly string[];
  anchors?: string;
  status?: string;
  body?: string;
}): string {
  const scope = (options.scope ?? ['src/**']).map((item) => `  - ${item}`).join('\n');
  return [
    '---',
    `id: ${options.id}`,
    `title: ${options.title}`,
    'scope:',
    scope,
    ...(options.anchors === undefined ? [] : [options.anchors]),
    `status: ${options.status ?? 'active'}`,
    '---',
    '',
    options.body ?? 'Тело единицы знания.',
    '',
  ].join('\n');
}

describe('knowledge-fs: разбор единицы знания', () => {
  // Задача 4.1 / Сценарий: «Единица знания прочитана»
  it('читает шапку и тело', () => {
    const parsed = parseUnit(unit({ id: 'a', title: 'Заголовок' }), 'knowledge/a.md');
    assert.equal(parsed.id, 'a');
    assert.equal(parsed.title, 'Заголовок');
    assert.deepEqual(parsed.scope, ['src/**']);
    assert.equal(parsed.status, 'active');
    assert.match(parsed.body, /Тело единицы знания/);
  });

  // Задача 4.1 / Сценарий: «Файл без шапки»
  it('отклоняет файл без шапки, называя путь', () => {
    assert.throws(
      () => parseUnit('Просто текст без шапки.\n', 'knowledge/a.md'),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /knowledge\/a\.md/);
        return true;
      },
    );
  });

  it('отклоняет шапку без title', () => {
    assert.throws(
      () => parseUnit('---\nid: a\n---\n\nтело\n', 'knowledge/a.md'),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.at, 'title');
        return true;
      },
    );
  });

  it('отклоняет неизвестный status', () => {
    assert.throws(
      () => parseUnit('---\nid: a\ntitle: б\nstatus: draft\n---\n\nтело\n', 'knowledge/a.md'),
      StepcastError,
    );
  });

  it('принимает якорь строкой — путь без ревизии', () => {
    const parsed = parseUnit(
      '---\nid: a\ntitle: б\nanchors:\n  - src/a.ts\n---\n\nтело\n',
      'knowledge/a.md',
    );
    assert.deepEqual(parsed.anchors, [{ path: 'src/a.ts', rev: undefined }]);
  });
});

describe('knowledge-fs: оглавление', () => {
  // Задача 4.2 / Сценарий: «Новая единица видна в индексе без правки индекса»
  it('собирается из шапок, файла индекса в дереве нет', () => {
    const box = repo({ 'knowledge/a.md': unit({ id: 'a', title: 'Первая' }) });
    assert.deepEqual(
      box.source().index().map((entry) => entry.id),
      ['a'],
    );

    box.write('knowledge/b.md', unit({ id: 'b', title: 'Вторая' }));
    assert.deepEqual(
      box.source().index().map((entry) => entry.id),
      ['a', 'b'],
    );
  });

  // Задача 4.3 / Сценарий: «Инвалидированное не попадает в оглавление»
  it('не перечисляет инвалидированное', () => {
    const box = repo({
      'knowledge/a.md': unit({ id: 'a', title: 'Первая' }),
      'knowledge/b.md': unit({ id: 'b', title: 'Вторая', status: 'superseded' }),
    });
    assert.deepEqual(
      box.source().index().map((entry) => entry.id),
      ['a'],
    );
  });

  // Задача 4.2 / Сценарий: «Спека попадает в оглавление»
  it('включает каталоги практики спецификации по одной записи на каталог', () => {
    const box = repo({
      'knowledge/a.md': unit({ id: 'a', title: 'Первая' }),
      'openspec/changes/some-change/proposal.md': '## Why\n\nПричина изменения.\n',
    });
    const source = createFsKnowledgeSource({
      root: box.root,
      dir: 'knowledge',
      specDir: 'openspec/changes',
      indexMaxTokens: 2000,
      staleAfterMs: 14 * DAY,
    });
    const entry = source.index().find((item) => item.id === 'spec:some-change');
    assert.ok(entry !== undefined);
    assert.equal(entry.title, 'Причина изменения.');
    assert.deepEqual(entry.scope, ['openspec/changes/some-change/**']);
  });

  // Задача 4.2 / Сценарий: «Индекс перерос предел»
  it('красное нарушение, когда оглавление перерастает предел', () => {
    const box = repo({
      'knowledge/a.md': unit({ id: 'a', title: 'Очень длинный заголовок'.repeat(20) }),
    });
    const verdict = box.source({ indexMaxTokens: 10 }).check();
    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((problem) => problem.kind === 'index-overflow'));
  });
});

describe('knowledge-fs: отбор', () => {
  // Задача 4.3 / Сценарий: «Отбор по области»
  it('отдаёт единицы, чья область пересекается с запрошенной', () => {
    const box = repo({
      'knowledge/judge.md': unit({ id: 'judge', title: 'Судья', scope: ['src/judge/**'] }),
      'knowledge/lanes.md': unit({ id: 'lanes', title: 'Дорожки', scope: ['src/lanes/**'] }),
    });
    const entries = box.source().select({ kind: 'scope', scope: ['src/judge/**'] });
    assert.deepEqual(
      entries.map((entry) => entry.id),
      ['judge'],
    );
    assert.equal(entries[0]?.path, 'knowledge/judge.md');
  });

  it('область шире отбирает вложенную', () => {
    const box = repo({
      'knowledge/judge.md': unit({ id: 'judge', title: 'Судья', scope: ['src/judge/**'] }),
    });
    const entries = box.source().select({ kind: 'scope', scope: ['src/**'] });
    assert.equal(entries.length, 1);
  });

  // Задача 4.3 / Сценарий: «Повторный отбор совпадает»
  it('детерминирован: перечень и порядок не зависят от обхода дерева', () => {
    const box = repo({
      'knowledge/b.md': unit({ id: 'b', title: 'Вторая' }),
      'knowledge/a.md': unit({ id: 'a', title: 'Первая' }),
      'knowledge/nested/c.md': unit({ id: 'c', title: 'Третья' }),
    });
    const once = box.source().select({ kind: 'scope', scope: ['src/**'] });
    const twice = box.source().select({ kind: 'scope', scope: ['src/**'] });
    assert.deepEqual(once.map((entry) => entry.id), ['a', 'b', 'c']);
    assert.deepEqual(once, twice);
  });

  // Задача 4.3 / Сценарий: «Инвалидированное читается поимённо»
  it('отбор по области не отдаёт инвалидированное, а поимённый отдаёт', () => {
    const box = repo({
      'knowledge/a.md': unit({ id: 'a', title: 'Первая', status: 'superseded' }),
    });
    assert.equal(box.source().select({ kind: 'scope', scope: ['src/**'] }).length, 0);
    assert.equal(box.source().select({ kind: 'id', id: ['a'] }).length, 1);
  });

  it('отказывает на неизвестном идентификаторе', () => {
    const box = repo({});
    assert.throws(() => box.source().select({ kind: 'id', id: ['нет'] }), StepcastError);
  });

  it('оглавление отдаётся одной текстовой записью', () => {
    const box = repo({ 'knowledge/a.md': unit({ id: 'a', title: 'Первая' }) });
    const entries = box.source().select({ kind: 'index' });
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.path, undefined);
    assert.match(entries[0]?.text ?? '', /a — Первая/);
  });

  it('предел записи режет по границе единицы, оставляя хотя бы одну', () => {
    const long = 'Очень длинное тело единицы знания. '.repeat(50);
    const box = repo({
      'knowledge/a.md': unit({ id: 'a', title: 'Первая', body: long }),
      'knowledge/b.md': unit({ id: 'b', title: 'Вторая', body: long }),
    });
    const entries = box.source().select({ kind: 'scope', scope: ['src/**'], budget: 10 });
    assert.equal(entries.length, 1);
  });
});

describe('knowledge-fs: дрейф', () => {
  // Задача 4.4 / Сценарий: «Якорь указывает в пустоту»
  it('красным на несуществующем якоре', () => {
    const box = repo({
      'knowledge/a.md': unit({
        id: 'a',
        title: 'Первая',
        anchors: 'anchors:\n  - path: src/missing.ts\n    rev: abc1234',
      }),
    });
    const verdict = box.source().check();
    assert.equal(verdict.ok, false);
    const missing = verdict.problems.find((problem) => problem.kind === 'missing-anchor');
    assert.ok(missing !== undefined, JSON.stringify(verdict.problems));
    assert.equal(missing.level, 'red');
  });

  // Задача 4.4 / Сценарий: «Задетый файл делает единицу жёлтой»
  it('жёлтым, когда файл изменён позже зафиксированной ревизии', () => {
    const box = repo({ 'src/a.ts': 'export const a = 1;\n' });
    box.commit('первый');
    const stale = execFileSync('git', ['-C', box.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    box.write('src/a.ts', 'export const a = 2;\n');
    box.commit('второй');
    box.write(
      'knowledge/a.md',
      unit({
        id: 'a',
        title: 'Первая',
        anchors: `anchors:\n  - path: src/a.ts\n    rev: ${stale.slice(0, 7)}`,
      }),
    );

    const verdict = box.source().check();
    assert.equal(verdict.ok, true);
    // По виду нарушения, а не по позиции в списке: непрочитанная история даёт
    // соседнее жёлтое, и падение по индексу пряталось бы за «ожидали другое».
    const found = verdict.problems.find((problem) => problem.kind === 'stale-anchor');
    assert.ok(found !== undefined, JSON.stringify(verdict.problems));
    assert.equal(found.level, 'yellow');
  });

  // Задача 4.4 / Сценарий: «Просроченное жёлтое становится красным»
  it('красным, когда устаревание держится дольше объявленного срока', () => {
    const box = repo({ 'src/a.ts': 'export const a = 1;\n' });
    box.commit('первый');
    const stale = execFileSync('git', ['-C', box.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    box.write('src/a.ts', 'export const a = 2;\n');
    box.commit('второй');
    box.write(
      'knowledge/a.md',
      unit({
        id: 'a',
        title: 'Первая',
        anchors: `anchors:\n  - path: src/a.ts\n    rev: ${stale.slice(0, 7)}`,
      }),
    );

    const verdict = box.source({ now: Date.now() + 30 * DAY }).check();
    assert.equal(verdict.ok, false);
    const overdue = verdict.problems.find((problem) => problem.kind === 'stale-anchor');
    assert.ok(overdue !== undefined, JSON.stringify(verdict.problems));
    assert.equal(overdue.level, 'red');
  });

  it('свежий якорь не даёт нарушения', () => {
    const box = repo({ 'src/a.ts': 'export const a = 1;\n' });
    box.commit('первый');
    const head = execFileSync('git', ['-C', box.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    box.write(
      'knowledge/a.md',
      unit({
        id: 'a',
        title: 'Первая',
        anchors: `anchors:\n  - path: src/a.ts\n    rev: ${head.slice(0, 7)}`,
      }),
    );
    const verdict = box.source().check();
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.problems, []);
  });

  // Ревью: проверять якоря отменённого — значит требовать от
  // инвалидированного утверждения оставаться верным, и архив со временем
  // делает гейт вечно красным. Тогда инвалидация выталкивает к удалению,
  // которое она и заводилась заменить.
  it('якоря инвалидированной единицы не проверяются', () => {
    const box = repo({
      'knowledge/a.md': unit({
        id: 'a',
        title: 'Отменённая',
        status: 'superseded',
        anchors: 'anchors:\n  - path: src/удалённый.ts\n    rev: abc1234',
      }),
    });

    const verdict = box.source().check();

    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.problems, []);
  });

  // Занятый идентификатор — исключение: по нему отменённое достаётся
  // поимённым отбором, и двусмысленность там настоящая.
  it('занятый идентификатор проверяется и у отменённой единицы', () => {
    const box = repo({
      'knowledge/a.md': unit({ id: 'a', title: 'Действующая' }),
      'knowledge/b.md': unit({ id: 'a', title: 'Отменённая', status: 'superseded' }),
    });

    const verdict = box.source().check();

    assert.equal(verdict.ok, false);
    assert.ok(verdict.problems.some((problem) => problem.kind === 'duplicate-id'));
  });

  // Ревью нашло это флейком собственного теста: сорвавшийся вызов git молча
  // превращал нарушение в «память цела». Непроверенное обязано быть видно.
  it('жёлтым, когда историю пути прочитать не удалось', () => {
    const box = repo({
      'knowledge/a.md': unit({
        id: 'a',
        title: 'Первая',
        anchors: 'anchors:\n  - path: src/a.ts\n    rev: abc1234',
      }),
      'src/a.ts': 'export const a = 1;\n',
    });
    // Каталог перестаёт быть репозиторием: `git log` отказывает целиком.
    rmSync(join(box.root, '.git'), { recursive: true, force: true });

    const verdict = box.source().check();

    assert.equal(verdict.ok, true);
    assert.ok(verdict.problems.some((problem) => problem.kind === 'anchor-unknown'));
  });

  it('предупреждает о совпадающем заголовке при пересекающейся области', () => {
    const box = repo({
      'knowledge/a.md': unit({ id: 'a', title: 'Одно и то же', scope: ['src/judge/**'] }),
      'knowledge/b.md': unit({ id: 'b', title: 'Одно и то же', scope: ['src/**'] }),
    });
    const verdict = box.source().check();
    assert.equal(verdict.ok, true);
    assert.ok(verdict.problems.some((problem) => problem.kind === 'duplicate-title'));
  });
});

describe('knowledge-fs: запись', () => {
  // Задача 4.5 / Сценарий: «Запись фиксирует ревизии якорей»
  it('подставляет ревизию последнего коммита, тронувшего путь', () => {
    const box = repo({ 'src/a.ts': 'export const a = 1;\n' });
    box.commit('первый');
    const head = execFileSync('git', ['-C', box.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    const result = box.source().write({
      id: 'a',
      title: 'Первая',
      scope: ['src/**'],
      anchors: ['src/a.ts'],
      body: 'Тело.',
    });

    assert.equal(result.ok, true);
    const text = readFileSync(join(box.root, 'knowledge/a.md'), 'utf8');
    assert.match(text, new RegExp(head.slice(0, 7)));
  });

  // Задача 4.5 / Сценарий: «Отклонённая запись не оставляет файла»
  it('отказывает на якоре в пустоту и файла не оставляет', () => {
    const box = repo({});
    const result = box.source().write({
      id: 'a',
      title: 'Первая',
      scope: ['src/**'],
      anchors: ['src/missing.ts'],
      body: 'Тело.',
    });

    assert.equal(result.ok, false);
    assert.throws(() => readFileSync(join(box.root, 'knowledge/a.md'), 'utf8'));
  });

  it('откатывает перезапись существующей единицы до прежнего содержимого', () => {
    const box = repo({ 'knowledge/a.md': unit({ id: 'a', title: 'Прежняя' }) });
    const before = readFileSync(join(box.root, 'knowledge/a.md'), 'utf8');

    const result = box.source().write({
      id: 'a',
      title: 'Новая',
      scope: ['src/**'],
      anchors: ['src/missing.ts'],
      body: 'Тело.',
    });

    assert.equal(result.ok, false);
    assert.equal(readFileSync(join(box.root, 'knowledge/a.md'), 'utf8'), before);
  });

  // Ревью: идентификатор превращается в путь, и `../../` записал бы за
  // пределы каталога знания — поверх кода, мимо всякой проверки.
  it('отклоняет идентификатор, который является путём, и ничего не пишет', () => {
    const box = repo({ 'src/a.ts': 'export const a = 1;\n' });

    assert.throws(
      () =>
        box.source().write({
          id: '../../src/a',
          title: 'Первая',
          scope: ['src/**'],
          anchors: [],
          body: 'Тело.',
        }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /Недопустимый идентификатор/);
        return true;
      },
    );
    assert.equal(readFileSync(join(box.root, 'src/a.ts'), 'utf8'), 'export const a = 1;\n');
  });

  it('контракт записи отклоняет такой идентификатор ещё разбором', () => {
    assert.equal(
      KnowledgeWriteRequestSchema.safeParse({
        id: '../x',
        title: 'т',
        scope: [],
        anchors: [],
        body: 'т',
      }).success,
      false,
    );
    assert.equal(
      KnowledgeWriteRequestSchema.safeParse({
        id: 'judge-verdict.v2_1',
        title: 'т',
        scope: [],
        anchors: [],
        body: 'т',
      }).success,
      true,
    );
  });

  it('записанное сразу проходит собственную проверку', () => {
    const box = repo({});
    const result = box.source().write({
      id: 'a',
      title: 'Первая',
      scope: ['src/**'],
      anchors: [],
      body: 'Тело.',
    });
    assert.equal(result.ok, true);
    assert.equal(box.source().check().ok, true);
  });
});

describe('knowledge-source: пересечение областей', () => {
  it('вложенная область пересекается с объемлющей в обе стороны', () => {
    assert.equal(globsIntersect('src/judge/**', 'src/**'), true);
    assert.equal(globsIntersect('src/**', 'src/judge/**'), true);
  });

  it('соседние области не пересекаются', () => {
    assert.equal(globsIntersect('src/judge/**', 'src/lanes/**'), false);
    assert.equal(globsIntersect('docs/**', 'src/**'), false);
  });

  it('одинаковый путь без шаблона пересекается сам с собой', () => {
    assert.equal(globsIntersect('package.json', 'package.json'), true);
    assert.equal(globsIntersect('package.json', 'src/**'), false);
  });
});

describe('knowledge-source: контракт внешней команды', () => {
  interface Box {
    readonly root: string;
    readonly command: string;
  }

  function stub(script: string, timeoutMs = 10_000): { box: Box; source: KnowledgeSource } {
    const root = mkdtempSync(join(tmpdir(), 'stepcast-knowledge-cmd-'));
    const file = join(root, 'source.mjs');
    writeFileSync(file, script);
    const command = `node ${JSON.stringify(file)}`;
    const source = createKnowledgeSource({
      knowledge: {
        provider: 'cmd',
        command,
        dir: undefined,
        rules: undefined,
        indexMaxTokens: 2000,
        staleAfterMs: 14 * DAY,
        timeoutMs,
      },
      root,
    });
    assert.ok(source !== undefined);
    return { box: { root, command }, source };
  }

  // Задача 2.4: успешный отбор — глагол первым аргументом, запрос на stdin.
  it('передаёт глагол первым аргументом и запрос стандартным вводом', () => {
    const { source } = stub(
      `const chunks = [];
       for await (const chunk of process.stdin) chunks.push(chunk);
       const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
       process.stdout.write(JSON.stringify({
         entries: [{ id: process.argv[2], title: JSON.stringify(request.scope), text: 'тело', tokens: 3 }],
       }));`,
    );
    const entries = source.select({ kind: 'scope', scope: ['src/**'] });
    assert.equal(entries[0]?.id, 'select');
    assert.equal(entries[0]?.title, '["src/**"]');
  });

  // Задача 2.4 / Сценарий: «Отказ источника» — по коду возврата
  it('отказывает шагу на ненулевом коде возврата, а не отдаёт пустоту', () => {
    const { source } = stub(`process.stderr.write('источник сломался'); process.exit(3);`);
    assert.throws(
      () => source.index(),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /кодом 3/);
        assert.match(error.hint ?? '', /источник сломался/);
        return true;
      },
    );
  });

  // Задача 2.4 / Сценарий: «Отказ источника» — по схеме ответа
  it('отказывает на ответе, не проходящем контракт', () => {
    const { source } = stub(`process.stdout.write(JSON.stringify({ entries: [{ id: 'a' }] }));`);
    assert.throws(
      () => source.index(),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /не соответствует контракту/);
        return true;
      },
    );
  });

  it('отказывает на ответе, который не JSON', () => {
    const { source } = stub(`process.stdout.write('не json');`);
    assert.throws(() => source.index(), StepcastError);
  });

  // Задача 2.4 / Сценарий: «Источник не отвечает»
  it('отказывает по таймауту, называя его причиной', () => {
    const { source } = stub(`setTimeout(() => {}, 60_000);`, 200);
    assert.throws(
      () => source.index(),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /за отведённое время/);
        return true;
      },
    );
  });

  it('практика не объявлена — источника нет, и это не ошибка', () => {
    const source = createKnowledgeSource({
      knowledge: {
        provider: undefined,
        command: undefined,
        dir: undefined,
        rules: undefined,
        indexMaxTokens: 2000,
        staleAfterMs: 14 * DAY,
        timeoutMs: 10_000,
      },
      root: mkdtempSync(join(tmpdir(), 'stepcast-knowledge-none-')),
    });
    assert.equal(source, undefined);
  });
});

describe('knowledge-fs: каталог знания отсутствует', () => {
  it('пустое оглавление и целая память, а не отказ', () => {
    const box = repo({});
    rmSync(join(box.root, 'knowledge'), { recursive: true, force: true });
    assert.deepEqual(box.source().index(), []);
    assert.equal(box.source().check().ok, true);
  });
});
