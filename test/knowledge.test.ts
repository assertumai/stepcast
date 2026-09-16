import assert from 'node:assert/strict';
import { globSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { estimateTokens } from '../src/parts/pipeline/domain/context/assemble.js';
import { evaluatePredicates } from '../src/parts/pipeline/expect/evaluate.js';
import { createFsKnowledgeSource, globsIntersect, parseUnit } from '../src/parts/pipeline/domain/knowledge/fs.js';
import { createKnowledgeSource } from '../src/parts/pipeline/domain/knowledge/source.js';
import {
  KnowledgeWriteRequestSchema,
  type KnowledgeSource,
} from '../src/parts/pipeline/domain/knowledge/types.js';
import { StepcastError } from '../src/kernel/errors.js';
import { anchorHash, gitCommit, gitInit } from './helpers.js';
import { tempDir } from './tmp.js';

const DAY = 24 * 60 * 60 * 1000;

interface SourceOverrides {
  indexMaxTokens?: number;
  specIndexMaxTokens?: number;
  unitMaxTokens?: number;
  specDir?: string;
  staleAfterMs?: number;
  now?: number;
}

interface Repo {
  readonly root: string;
  write(path: string, content: string): void;
  commit(message: string): void;
  source(overrides?: SourceOverrides): KnowledgeSource;
}

function repo(files: Readonly<Record<string, string>> = {}): Repo {
  const root = tempDir('knowledge-');
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
        ...(overrides.specDir === undefined ? {} : { specDir: overrides.specDir }),
        indexMaxTokens: overrides.indexMaxTokens ?? 2000,
        specIndexMaxTokens: overrides.specIndexMaxTokens ?? 2000,
        unitMaxTokens: overrides.unitMaxTokens ?? 1000,
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

  it('принимает якорь строкой — путь без закрепления', () => {
    const parsed = parseUnit(
      '---\nid: a\ntitle: б\nanchors:\n  - src/a.ts\n---\n\nтело\n',
      'knowledge/a.md',
    );
    assert.deepEqual(parsed.anchors, [
      // Голый скаляр отображением не является: вписать в него поле нельзя, не
      // переписав чужую строку, — датировать такой якорь нечем.
      {
        path: 'src/a.ts',
        hash: undefined,
        legacyRev: false,
        staleSince: undefined,
        staleSinceInvalid: false,
        datable: false,
      },
    ]);
  });

  // Задача 3.6 / Сценарий: «Закрепление из одних цифр проверяется»
  //
  // Значение меньше 2^53 (границы точного целого в double) и потому
  // переживает округление в обе стороны: тест ловит дефект разбора, а не
  // случайность приведения типа.
  it('принимает закрепление, прочитанное YAML числом, строкой', () => {
    const parsed = parseUnit(
      '---\nid: a\ntitle: б\nanchors:\n  - path: src/a.ts\n    hash: 1234567890123456\n---\n\nтело\n',
      'knowledge/a.md',
    );
    assert.deepEqual(parsed.anchors, [
      {
        path: 'src/a.ts',
        hash: '1234567890123456',
        legacyRev: false,
        staleSince: undefined,
        staleSinceInvalid: false,
        datable: true,
      },
    ]);
  });

  // Задача 1.3 / Сценарий: «Якорь без закрепления остаётся законным»
  it('якорь отображением без hash даёт закрепление undefined', () => {
    const parsed = parseUnit(
      '---\nid: a\ntitle: б\nanchors:\n  - path: src/a.ts\n---\n\nтело\n',
      'knowledge/a.md',
    );
    assert.deepEqual(parsed.anchors, [
      {
        path: 'src/a.ts',
        hash: undefined,
        legacyRev: false,
        staleSince: undefined,
        staleSinceInvalid: false,
        datable: true,
      },
    ]);
  });

  // Задача 3.5 / Сценарий: «Единица прежней формы названа»
  it('якорь с rev без hash отмечен прежней формой', () => {
    const parsed = parseUnit(
      '---\nid: a\ntitle: б\nanchors:\n  - path: src/a.ts\n    rev: d5f15e2\n---\n\nтело\n',
      'knowledge/a.md',
    );
    assert.deepEqual(parsed.anchors, [
      {
        path: 'src/a.ts',
        hash: undefined,
        legacyRev: true,
        staleSince: undefined,
        staleSinceInvalid: false,
        datable: true,
      },
    ]);
  });

  // Задача 1.3 / Сценарий: «Непригодное значение закрепления отклонено»
  //
  // Отказом, а не молчаливым `undefined`: у этих значений нет прочтения, при
  // котором единица осмысленна, а `undefined` значил бы «устаревание не
  // считается» — ровно та ложь, из-за которой заведено это изменение.
  for (const [name, hash] of [
    ['логическим значением', 'true'],
    ['списком', '[a, b]'],
    ['отображением', '{}'],
    ['пустым', ''],
  ] as const) {
    it(`отклоняет закрепление, объявленное ${name}`, () => {
      assert.throws(
        () =>
          parseUnit(
            `---\nid: a\ntitle: б\nanchors:\n  - path: src/a.ts\n    hash: ${hash}\n---\n\nтело\n`,
            'knowledge/a.md',
          ),
        (error: unknown) => {
          assert.ok(error instanceof StepcastError);
          assert.match(error.message, /knowledge\/a\.md/);
          assert.equal(error.at, 'anchors.hash');
          return true;
        },
      );
    });
  }

  // Задача 4.3 / Сценарий: «Числовое значение поля названо своей причиной»
  //
  // «Шапка единицы знания без id» при объявленном `id: 1234567` — неправда:
  // человека отправляют искать то, что на месте.
  it('числовой id отклоняется сообщением о типе, а не об отсутствии поля', () => {
    assert.throws(
      () => parseUnit('---\nid: 1234567\ntitle: б\n---\n\nтело\n', 'knowledge/a.md'),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.at, 'id');
        assert.doesNotMatch(error.message, /без id/);
        assert.match(error.message, /строка/);
        assert.match(error.hint ?? '', /число/);
        return true;
      },
    );
  });

  it('числовой title отклоняется сообщением о типе', () => {
    assert.throws(
      () => parseUnit('---\nid: a\ntitle: 1234567\n---\n\nтело\n', 'knowledge/a.md'),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.at, 'title');
        assert.doesNotMatch(error.message, /без title/);
        return true;
      },
    );
  });

  it('числовой элемент scope назван элементом списка', () => {
    assert.throws(
      () =>
        parseUnit('---\nid: a\ntitle: б\nscope:\n  - 1234567\n---\n\nтело\n', 'knowledge/a.md'),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.at, 'scope');
        assert.match(error.hint ?? '', /число/);
        return true;
      },
    );
  });

  it('отсутствующее поле по-прежнему названо отсутствующим', () => {
    assert.throws(
      () => parseUnit('---\ntitle: б\n---\n\nтело\n', 'knowledge/a.md'),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /без id/);
        return true;
      },
    );
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
    const source = box.source({ specDir: 'openspec/changes' });
    const entry = source.index().find((item) => item.id === 'spec:some-change');
    assert.ok(entry !== undefined);
    assert.equal(entry.title, 'Причина изменения.');
    assert.deepEqual(entry.scope, ['openspec/changes/some-change/**']);
  });

  // Задача 1.1 / Сценарий: «Единицы знания переросли предел»
  //
  // Жёлтым, а не красным (design.md, решение 1): переполненное оглавление не
  // сломано, оно полно, и снимается слиянием — работой, отдельной от check.
  it('жёлтое нарушение, когда записи единиц знания перерастают предел, называющее размер, ключ и слияние', () => {
    const box = repo({
      'knowledge/a.md': unit({ id: 'a', title: 'Очень длинный заголовок'.repeat(20) }),
    });
    const verdict = box.source({ indexMaxTokens: 10 }).check();
    assert.equal(verdict.ok, true);
    const problem = verdict.problems.find((item) => item.kind === 'index-overflow');
    assert.ok(problem !== undefined, JSON.stringify(verdict.problems));
    assert.equal(problem.level, 'yellow');
    assert.match(problem.detail, /единиц[аы] знания/i);
    assert.match(problem.detail, /index_max_tokens/);
    assert.match(problem.detail, /слейте|слияни/i);
    assert.doesNotMatch(problem.detail, /каталог/i);
  });

  // Задача 1.1 / Сценарий: «Каталоги изменений предела памяти не переполняют»
  it('единицы знания и множество каталогов изменений вместе не дают нарушения о пределе памяти', () => {
    const specFiles: Record<string, string> = {};
    for (let index = 0; index < 60; index += 1) {
      specFiles[`openspec/changes/change-${index}/proposal.md`] =
        `## Why\n\nПричина изменения номер ${index}, описанная достаточно длинно, чтобы запись в оглавлении практики спецификации репозитория весила заметно.\n`;
    }
    const box = repo({
      'knowledge/a.md': unit({ id: 'a', title: 'Первая' }),
      'knowledge/b.md': unit({ id: 'b', title: 'Вторая' }),
      ...specFiles,
    });
    // Предел производной части поднят намеренно высоко: этот тест — про то,
    // что каталоги изменений не задевают предел памяти, а не про то, что они
    // укладываются в свой собственный (для этого есть отдельный тест).
    const verdict = box
      .source({ specDir: 'openspec/changes', indexMaxTokens: 2000, specIndexMaxTokens: 1_000_000 })
      .check();
    assert.equal(verdict.ok, true);
    assert.ok(
      !verdict.problems.some((problem) => problem.kind === 'index-overflow'),
      JSON.stringify(verdict.problems),
    );
  });

  // Задача 3.3 / Сценарий: «Производная часть переросла предел»
  it('жёлтое нарушение, когда каталоги изменений перерастают свой предел', () => {
    const specFiles: Record<string, string> = {};
    for (let index = 0; index < 60; index += 1) {
      specFiles[`openspec/changes/change-${index}/proposal.md`] =
        `## Why\n\nПричина изменения номер ${index}, описанная достаточно длинно, чтобы запись в оглавлении практики спецификации репозитория весила заметно.\n`;
    }
    const box = repo({
      'knowledge/a.md': unit({ id: 'a', title: 'Первая' }),
      ...specFiles,
    });
    const verdict = box
      .source({ specDir: 'openspec/changes', indexMaxTokens: 1_000_000, specIndexMaxTokens: 2000 })
      .check();
    assert.equal(verdict.ok, true);
    const problem = verdict.problems.find((item) => item.kind === 'spec-index-overflow');
    assert.ok(problem !== undefined, JSON.stringify(verdict.problems));
    assert.equal(problem.level, 'yellow');
    assert.match(problem.detail, /60/);
    assert.match(problem.detail, /spec_index_max_tokens/);
    assert.doesNotMatch(problem.detail, /единиц[аы] знания/i);
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

describe('knowledge-fs: разрешение каталога практики спецификации по имени', () => {
  // Задача 1.1 / Сценарий: «Каждое имя из оглавления разрешается» — падает на
  // сегодняшнем коде: spec:one даёт StepcastError «Единица знания не найдена».
  it('всякое имя из оглавления разрешается отбором по имени', () => {
    const box = repo({
      'knowledge/a.md': unit({ id: 'a', title: 'Первая' }),
      'openspec/changes/one/proposal.md': '## Why\n\nПричина изменения one.\n',
      'openspec/changes/two/proposal.md': '## Why\n\nПричина изменения two.\n',
    });
    const source = box.source({ specDir: 'openspec/changes' });

    for (const entry of source.index()) {
      const entries = source.select({ kind: 'id', id: [entry.id] });
      assert.ok(entries.length > 0, `${entry.id}: отбор обязан отдать хотя бы одну запись`);
      for (const picked of entries) {
        assert.equal(picked.text, undefined);
        assert.ok(picked.path !== undefined, `${entry.id}: запись обязана нести path`);
        assert.doesNotThrow(() => readFileSync(join(box.root, picked.path as string), 'utf8'));
      }
    }
  });

  // Задача 1.2 / Сценарий: «Каталог отдаётся всеми своими документами»
  it('каталог разрешается записью на каждый документ Markdown, порядком по пути', () => {
    const box = repo({
      'openspec/changes/one/proposal.md': '## Why\n\nПричина.\n',
      'openspec/changes/one/design.md': '## Context\n\nКонтекст.\n',
      'openspec/changes/one/specs/some/spec.md': '## ADDED Requirements\n\nТребование.\n',
    });
    const source = box.source({ specDir: 'openspec/changes' });

    const entries = source.select({ kind: 'id', id: ['spec:one'] });

    assert.deepEqual(
      entries.map((entry) => entry.path),
      [
        'openspec/changes/one/design.md',
        'openspec/changes/one/proposal.md',
        'openspec/changes/one/specs/some/spec.md',
      ],
    );
    for (const entry of entries) {
      assert.equal(entry.id, 'spec:one');
      assert.equal(entry.text, undefined);
    }
  });

  it('повторно названный идентификатор каталога записей не удваивает', () => {
    const box = repo({ 'openspec/changes/one/proposal.md': '## Why\n\nПричина.\n' });
    const source = box.source({ specDir: 'openspec/changes' });

    const entries = source.select({ kind: 'id', id: ['spec:one', 'spec:one'] });

    assert.equal(entries.length, 1);
  });

  // То же правило, каким уже режутся тела единиц знания.
  it('предел записи режет по границе документа каталога, оставляя хотя бы одну запись', () => {
    const long = `## Why\n\n${'Очень длинный текст причины изменения. '.repeat(80)}`;
    const box = repo({
      'openspec/changes/one/proposal.md': long,
      'openspec/changes/one/design.md': long,
    });
    const source = box.source({ specDir: 'openspec/changes' });

    const entries = source.select({ kind: 'id', id: ['spec:one'], budget: 10 });

    assert.equal(entries.length, 1);
  });

  // Задача 1.3 / Сценарий: «Отбор по области каталоги не возвращает»
  it('отбор по области не возвращает записи каталогов практики спецификации', () => {
    const box = repo({ 'openspec/changes/one/proposal.md': '## Why\n\nПричина.\n' });
    const source = box.source({ specDir: 'openspec/changes' });

    const entries = source.select({ kind: 'scope', scope: ['openspec/changes/**'] });

    assert.equal(entries.length, 0);
  });

  // Задача 1.4 / Сценарий: «Несуществующий идентификатор по-прежнему отказывает»
  it('отказывает на несуществующем идентификаторе каталога, называя его', () => {
    const box = repo({ 'openspec/changes/one/proposal.md': '## Why\n\nПричина.\n' });
    const source = box.source({ specDir: 'openspec/changes' });

    assert.throws(
      () => source.select({ kind: 'id', id: ['spec:нет-такого'] }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /spec:нет-такого/);
        return true;
      },
    );
  });

  // Область у записи каталога печатается наравне с областью единицы знания, а
  // отбор по области таких записей не возвращает: обещание снимается словами,
  // иначе шаг, объявивший прочитанную в оглавлении область, получил бы не
  // отказ, а пустой ответ — молчание, неотличимое от «знания нет».
  it('оглавление в контексте называет записи каталогов запрашиваемыми только по имени', () => {
    const box = repo({
      'knowledge/a.md': unit({ id: 'a', title: 'Первая' }),
      'openspec/changes/one/proposal.md': '## Why\n\nПричина.\n',
    });

    const text = box.source({ specDir: 'openspec/changes' }).select({ kind: 'index' })[0]?.text ?? '';

    assert.match(text, /spec:one — .*openspec\/changes\/one/);
    assert.match(text, /запрашиваются только по идентификатору/);
    assert.match(text, /отбор по области их не возвращает/);
  });

  it('оговорки нет в оглавлении, где не показано ни одной записи каталога', () => {
    const box = repo({ 'knowledge/a.md': unit({ id: 'a', title: 'Первая' }) });

    const text = box.source().select({ kind: 'index' })[0]?.text ?? '';

    assert.match(text, /a — Первая/);
    assert.doesNotMatch(text, /отбор по области/);
  });

  // `project.spec.dir` держит что угодно, что положила туда практика
  // спецификации: каталог с именем на `.md` попадает в перечень документов
  // наравне с файлом. Отбор зовётся посреди прогона, при сборке контекста, и
  // трасса Node вместо названной причины обрывает работу вместо того, чтобы
  // её назвать.
  it('нечитаемый документ каталога отказывает названной причиной, а не трассой Node', () => {
    const box = repo({ 'openspec/changes/one/proposal.md': '## Why\n\nПричина.\n' });
    mkdirSync(join(box.root, 'openspec/changes/one/notes.md'), { recursive: true });
    const source = box.source({ specDir: 'openspec/changes' });

    assert.throws(
      () => source.select({ kind: 'id', id: ['spec:one'] }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /openspec\/changes\/one\/notes\.md/);
        assert.match(error.hint ?? '', /каталог/);
        return true;
      },
    );
  });

  it('каталог без единого документа Markdown отсутствует и в index, и в отборе по имени', () => {
    const box = repo({ 'openspec/changes/empty/notes.txt': 'не markdown\n' });
    const source = box.source({ specDir: 'openspec/changes' });

    assert.ok(!source.index().some((entry) => entry.id === 'spec:empty'));
    assert.throws(() => source.select({ kind: 'id', id: ['spec:empty'] }), StepcastError);
  });
});

describe('knowledge-fs: усечение производной части в отборе', () => {
  function specChangeFiles(count: number): Record<string, string> {
    const files: Record<string, string> = {};
    for (let index = 0; index < count; index += 1) {
      files[`openspec/changes/change-${index}/proposal.md`] =
        `## Why\n\nПричина изменения номер ${index}, описанная достаточно длинно, чтобы запись в оглавлении практики спецификации репозитория весила заметно.\n`;
    }
    return files;
  }

  // Задача 1.4 / Сценарий: «Оглавление в контексте усечено с названным остатком»
  it('отбор index укладывает записи каталогов в предел и называет остаток', () => {
    const box = repo({
      'knowledge/a.md': unit({ id: 'a', title: 'Первая' }),
      'knowledge/b.md': unit({ id: 'b', title: 'Вторая' }),
      ...specChangeFiles(60),
    });
    const source = box.source({
      specDir: 'openspec/changes',
      indexMaxTokens: 1_000_000,
      specIndexMaxTokens: 300,
    });
    const text = source.select({ kind: 'index' })[0]?.text ?? '';

    assert.match(text, /a — Первая/);
    assert.match(text, /b — Вторая/);
    assert.match(text, /не показано/);
    assert.match(text, /openspec\/changes/);

    const shownSpecs = (text.match(/spec:change-/g) ?? []).length;
    assert.ok(shownSpecs > 0, 'хотя бы одна запись каталога обязана поместиться');
    assert.ok(shownSpecs < 60, 'усечение обязано было сработать');
  });

  // Задача 1.5 / Сценарий: «Глагол index отдаёт полный список»
  it('глагол index перечисляет все записи каталогов независимо от предела', () => {
    const box = repo({
      'knowledge/a.md': unit({ id: 'a', title: 'Первая' }),
      ...specChangeFiles(60),
    });
    const source = box.source({ specDir: 'openspec/changes', specIndexMaxTokens: 300 });
    const specIds = source.index().map((entry) => entry.id).filter((id) => id.startsWith('spec:'));
    assert.equal(specIds.length, 60);
  });

  // Задача 1.5 / Сценарий: «Усечение воспроизводимо»
  it('два вызова отбора index на неизменном дереве совпадают посимвольно', () => {
    const box = repo({
      'knowledge/a.md': unit({ id: 'a', title: 'Первая' }),
      ...specChangeFiles(60),
    });
    const source = box.source({ specDir: 'openspec/changes', specIndexMaxTokens: 300 });
    const once = source.select({ kind: 'index' })[0]?.text;
    const twice = source.select({ kind: 'index' })[0]?.text;
    assert.equal(once, twice);
  });

  it('единицы знания не усекаются ни при каком пределе', () => {
    const box = repo({
      'knowledge/a.md': unit({ id: 'a', title: 'Первая' }),
      'knowledge/b.md': unit({ id: 'b', title: 'Вторая' }),
      ...specChangeFiles(60),
    });
    const source = box.source({ specDir: 'openspec/changes', specIndexMaxTokens: 1 });
    const text = source.select({ kind: 'index' })[0]?.text ?? '';
    assert.match(text, /a — Первая/);
    assert.match(text, /b — Вторая/);
  });

  /** Строки производной части из готового текста оглавления — вместе с хвостом усечения. */
  function specSection(text: string): string {
    return text
      .split('\n')
      .filter((line) => line.startsWith('spec:') || line.startsWith('…'))
      .join('\n');
  }

  // Порог усечения и порог жёлтого нарушения — одна величина, а не две
  // близкие: сумма построчных округлений больше цельного замера, и между
  // двумя мерами открывалась полоса, где отбор уже усекает, а `check` молчит.
  it('усечение начинается ровно там, где check желтит производную часть', () => {
    const box = repo({
      'knowledge/a.md': unit({ id: 'a', title: 'Первая' }),
      ...specChangeFiles(60),
    });

    const whole = box.source({ specDir: 'openspec/changes', specIndexMaxTokens: 1_000_000 });
    const full = estimateTokens(specSection(whole.select({ kind: 'index' })[0]?.text ?? ''));

    const atLimit = box.source({ specDir: 'openspec/changes', specIndexMaxTokens: full });
    assert.doesNotMatch(atLimit.select({ kind: 'index' })[0]?.text ?? '', /не показано/);
    assert.ok(
      !atLimit.check().problems.some((problem) => problem.kind === 'spec-index-overflow'),
      'ровно на пределе не усекает и не желтит',
    );

    const belowLimit = box.source({ specDir: 'openspec/changes', specIndexMaxTokens: full - 1 });
    assert.match(belowLimit.select({ kind: 'index' })[0]?.text ?? '', /не показано/);
    assert.ok(
      belowLimit.check().problems.some((problem) => problem.kind === 'spec-index-overflow'),
      'на токен ниже усекает и желтит одновременно',
    );
  });

  it('усечённая производная часть вместе с хвостовой строкой укладывается в предел', () => {
    const box = repo({
      'knowledge/a.md': unit({ id: 'a', title: 'Первая' }),
      ...specChangeFiles(60),
    });
    for (const limit of [300, 200, 120]) {
      const text = box
        .source({ specDir: 'openspec/changes', specIndexMaxTokens: limit })
        .select({ kind: 'index' })[0]?.text;
      const section = specSection(text ?? '');
      assert.match(section, /не показано/);
      assert.ok(
        estimateTokens(section) <= limit,
        `предел ${limit}: секция весит ${estimateTokens(section)}`,
      );
    }
  });

  // Единственное исключение из предыдущего: предел меньше самой хвостовой
  // строки. Строка всё равно выводится — она отличает усечение от молчаливой
  // пропажи записей, и менять её на соблюдение предела значит соврать о
  // полноте списка.
  it('хвостовая строка выводится даже при пределе, в который она не помещается', () => {
    const box = repo({
      'knowledge/a.md': unit({ id: 'a', title: 'Первая' }),
      ...specChangeFiles(60),
    });
    const text =
      box
        .source({ specDir: 'openspec/changes', specIndexMaxTokens: 1 })
        .select({ kind: 'index' })[0]?.text ?? '';
    assert.equal(specSection(text), specSection(text).split('\n')[0]);
    assert.match(text, /не показано ещё 60 записей/);
  });
});

describe('knowledge-fs: предел тела единицы', () => {
  // Задача 1.6 / Сценарий: «Тело переросло предел»
  it('красное нарушение, когда тело активной единицы перерастает предел', () => {
    const long = 'Очень длинное тело единицы знания. '.repeat(50);
    const box = repo({ 'knowledge/a.md': unit({ id: 'a', title: 'Первая', body: long }) });
    const verdict = box.source({ unitMaxTokens: 10 }).check();
    assert.equal(verdict.ok, false);
    const problem = verdict.problems.find((item) => item.kind === 'unit-too-large');
    assert.ok(problem !== undefined, JSON.stringify(verdict.problems));
    assert.equal(problem.level, 'red');
    assert.equal(problem.id, 'a');
    assert.match(problem.detail, /a/);
    assert.match(problem.detail, /unit_max_tokens/);
  });

  // Задача 1.6 / Сценарий: «Тело инвалидированной единицы не проверяется»
  it('тело единицы со status: superseded нарушения не даёт', () => {
    const long = 'Очень длинное тело единицы знания. '.repeat(50);
    const box = repo({
      'knowledge/a.md': unit({ id: 'a', title: 'Первая', body: long, status: 'superseded' }),
    });
    const verdict = box.source({ unitMaxTokens: 10 }).check();
    assert.equal(verdict.ok, true);
    assert.ok(!verdict.problems.some((problem) => problem.kind === 'unit-too-large'));
  });

  // Задача 1.7 / Сценарий: «Запись раздутой единицы откатывается»
  it('write раздутого тела отвечает ok: false и не оставляет файла', () => {
    const box = repo({});
    const result = box.source({ unitMaxTokens: 10 }).write({
      id: 'a',
      title: 'Первая',
      scope: ['src/**'],
      anchors: [],
      body: 'Очень длинное тело единицы знания. '.repeat(50),
    });
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => problem.kind === 'unit-too-large'));
    assert.throws(() => readFileSync(join(box.root, 'knowledge/a.md'), 'utf8'));
  });

  // Сценарий: «Путь, содержимое которого не читается, назван отказом записи».
  // Записать такой якорь без закрепления значило бы завести форму «якорь есть,
  // а по нему не проверяется ничего» — ту самую, которой быть не должно.
  it('write якоря, содержимое которого не читается, отвечает ok: false и не оставляет файла', () => {
    const box = repo({ 'src/nested/a.ts': 'export const a = 1;\n' });
    const result = box.source().write({
      id: 'a',
      title: 'Первая',
      scope: ['src/**'],
      anchors: ['src/nested'],
      body: 'Тело.',
    });

    assert.equal(result.ok, false);
    const problem = result.problems.find((item) => item.kind === 'anchor-unreadable');
    assert.ok(problem !== undefined, JSON.stringify(result.problems));
    assert.equal(problem.level, 'red');
    assert.match(problem.detail, /src\/nested/);
    assert.throws(() => readFileSync(join(box.root, 'knowledge/a.md'), 'utf8'));
  });

  // Задача 1.7 / Сценарий: «Запись раздутой единицы откатывается» — перезапись
  it('write раздутого тела поверх существующей единицы возвращает прежнее содержимое', () => {
    const box = repo({ 'knowledge/a.md': unit({ id: 'a', title: 'Прежняя' }) });
    const before = readFileSync(join(box.root, 'knowledge/a.md'), 'utf8');

    const result = box.source({ unitMaxTokens: 10 }).write({
      id: 'a',
      title: 'Новая',
      scope: ['src/**'],
      anchors: [],
      body: 'Очень длинное тело единицы знания. '.repeat(50),
    });

    assert.equal(result.ok, false);
    assert.equal(readFileSync(join(box.root, 'knowledge/a.md'), 'utf8'), before);
  });

  // Сценарий: «Раздутая единица запирает запись остальных». Поведение то же,
  // каким уже живут `missing-anchor` и `duplicate-id`: `write` откатывается на
  // любом красном по всему дереву, а не только на относящемся к записываемой
  // единице. Проверяется явно, потому что новый предел тела делает это
  // состояние достижимым при обновлении репозитория, где предела не было.
  it('раздутая единица в дереве запирает запись другой, называя виновную', () => {
    const box = repo({
      'knowledge/a.md': unit({
        id: 'a',
        title: 'Первая',
        body: 'Очень длинное тело единицы знания. '.repeat(50),
      }),
    });

    const result = box.source({ unitMaxTokens: 10 }).write({
      id: 'b',
      title: 'Вторая',
      scope: ['src/**'],
      anchors: [],
      body: 'Короткое тело.',
    });

    assert.equal(result.ok, false);
    const problem = result.problems.find((item) => item.kind === 'unit-too-large');
    assert.ok(problem !== undefined, JSON.stringify(result.problems));
    assert.equal(problem.id, 'a');
    assert.throws(() => readFileSync(join(box.root, 'knowledge/b.md'), 'utf8'));
  });
});

describe('knowledge-fs: дрейф', () => {
  // Задача 4.4 / Сценарий: «Якорь указывает в пустоту»
  it('красным на несуществующем якоре', () => {
    const box = repo({
      'knowledge/a.md': unit({
        id: 'a',
        title: 'Первая',
        anchors: 'anchors:\n  - src/missing.ts',
      }),
    });
    const verdict = box.source().check();
    assert.equal(verdict.ok, false);
    const missing = verdict.problems.find((problem) => problem.kind === 'missing-anchor');
    assert.ok(missing !== undefined, JSON.stringify(verdict.problems));
    assert.equal(missing.level, 'red');
  });

  // Задача 3.2 / Сценарий: «Коммит того же содержимого расхождения не создаёт»
  //
  // Свойство, ради которого заведён весь дайджест (design.md, решение 1):
  // коммит, не менявший байтов пути, не создаёт расхождения. До этого
  // изменения ровно этот коммит и делал единицу расходящейся.
  it('коммит неизменённого содержимого расхождения не создаёт', () => {
    const box = repo({ 'src/a.ts': 'export const a = 1;\n' });
    const hash = anchorHash(join(box.root, 'src/a.ts'));
    box.write(
      'knowledge/a.md',
      unit({
        id: 'a',
        title: 'Первая',
        anchors: `anchors:\n  - path: src/a.ts\n    hash: '${hash}'`,
      }),
    );

    box.commit('фиксирует путь якоря без правки байтов');

    const verdict = box.source().check();
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.problems, []);
  });

  // Задача 3.3 / Сценарий: «Свежесозданный файл закрепляется наравне с прочими»
  it('якорь на файл без единого коммита получает закрепление и ловит правку', () => {
    const box = repo({ 'src/new.ts': 'export const b = 1;\n' });
    // Файл ни разу не закоммичен: раньше это давало якорь без закрепления, по
    // которому не проверялось ничего вовсе (design.md, Context).
    const result = box.source().write({
      id: 'a',
      title: 'Первая',
      scope: ['src/**'],
      anchors: ['src/new.ts'],
      body: 'Тело.',
    });
    assert.equal(result.ok, true);
    const hash = anchorHash(join(box.root, 'src/new.ts'));
    assert.match(readFileSync(join(box.root, 'knowledge/a.md'), 'utf8'), new RegExp(`hash: '${hash}'`));

    box.write('src/new.ts', 'export const b = 2;\n');
    const verdict = box.source().check();
    const found = verdict.problems.find((problem) => problem.kind === 'stale-anchor');
    assert.ok(found !== undefined, JSON.stringify(verdict.problems));
    assert.equal(found.level, 'yellow');
  });

  // Задача 3.4 / Сценарий: «Дерево без git проверяется наравне с прочими»
  it('дерево без git даёт то же жёлтое об устаревании', () => {
    const root = tempDir('knowledge-no-git-');
    const write = (path: string, content: string): void => {
      const full = join(root, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    };
    write('src/a.ts', 'export const a = 1;\n');
    const hash = anchorHash(join(root, 'src/a.ts'));
    write('src/a.ts', 'export const a = 2;\n');
    write(
      'knowledge/a.md',
      unit({
        id: 'a',
        title: 'Первая',
        anchors: `anchors:\n  - path: src/a.ts\n    hash: '${hash}'`,
      }),
    );

    const source = createFsKnowledgeSource({
      root,
      dir: 'knowledge',
      indexMaxTokens: 2000,
      specIndexMaxTokens: 2000,
      unitMaxTokens: 1000,
      staleAfterMs: 14 * DAY,
    });
    const verdict = source.check();
    assert.equal(verdict.ok, true);
    const found = verdict.problems.find((problem) => problem.kind === 'stale-anchor');
    assert.ok(found !== undefined, JSON.stringify(verdict.problems));
    assert.equal(found.level, 'yellow');
    assert.ok(!verdict.problems.some((problem) => problem.kind === 'anchor-unknown'));
  });

  // Задача 4.4 / Сценарий: «Изменённое содержимое делает единицу жёлтой»
  it('жёлтым, когда содержимое разошлось с закреплением', () => {
    const box = repo({ 'src/a.ts': 'export const a = 1;\n' });
    const hash = anchorHash(join(box.root, 'src/a.ts'));
    box.write('src/a.ts', 'export const a = 2;\n');
    box.write(
      'knowledge/a.md',
      unit({
        id: 'a',
        title: 'Первая',
        anchors: `anchors:\n  - path: src/a.ts\n    hash: '${hash}'`,
      }),
    );

    const verdict = box.source().check();
    assert.equal(verdict.ok, true);
    const found = verdict.problems.find((problem) => problem.kind === 'stale-anchor');
    assert.ok(found !== undefined, JSON.stringify(verdict.problems));
    assert.equal(found.level, 'yellow');
  });

  // Задача 4.1 / Сценарий: «Месяц простоя не даёт красного» — тест написан до
  // правки уровня и падает на прежнем коде (там красное): срок отсчитывается
  // от возраста коммита, а не от того, увидел ли кто-нибудь расхождение.
  it('месяц простоя без датирования не даёт красного, только жёлтое', () => {
    const box = repo({ 'src/a.ts': 'export const a = 1;\n' });
    const hash = anchorHash(join(box.root, 'src/a.ts'));
    box.write('src/a.ts', 'export const a = 2;\n');
    box.write(
      'knowledge/a.md',
      unit({
        id: 'a',
        title: 'Первая',
        anchors: `anchors:\n  - path: src/a.ts\n    hash: '${hash}'`,
      }),
    );

    // Правке месяц, а расхождение никто ни разу не датировал: жёлтая фаза
    // не кончается сама, чужой активностью (design.md, решение 1).
    const verdict = box.source({ now: Date.now() + 30 * DAY }).check();
    assert.equal(verdict.ok, true);
    const found = verdict.problems.find((problem) => problem.kind === 'stale-anchor');
    assert.ok(found !== undefined, JSON.stringify(verdict.problems));
    assert.equal(found.level, 'yellow');
  });

  // Задача 4.3 / Сценарий: «Просроченное жёлтое становится красным»
  it('красным становится расхождение, датированное дольше stale_after назад', () => {
    const box = repo({ 'src/a.ts': 'export const a = 1;\n' });
    const hash = anchorHash(join(box.root, 'src/a.ts'));
    box.write('src/a.ts', 'export const a = 2;\n');
    box.write(
      'knowledge/a.md',
      unit({
        id: 'a',
        title: 'Первая',
        anchors: `anchors:\n  - path: src/a.ts\n    hash: '${hash}'`,
      }),
    );

    box.source({ now: Date.now() }).check({ record: true });
    // `stale_since` пишется секундной точностью ISO-8601; читаем записанное
    // значение обратно, а не полагаемся на исходный `Date.now()`, — иначе
    // усечение до секунды сдвигало бы границу теста на до тысячи миллисекунд.
    const recorded = readFileSync(join(box.root, 'knowledge/a.md'), 'utf8').match(/stale_since: (\S+)/)?.[1];
    assert.ok(recorded !== undefined);
    const staleSinceMs = Date.parse(recorded as string);

    const withinTerm = box.source({ now: staleSinceMs + 14 * DAY }).check();
    assert.equal(withinTerm.ok, true);
    const yellow = withinTerm.problems.find((problem) => problem.kind === 'stale-anchor');
    assert.ok(yellow !== undefined, JSON.stringify(withinTerm.problems));
    assert.equal(yellow.level, 'yellow');
    assert.match(yellow.detail, /известно с/);

    const overdue = box.source({ now: staleSinceMs + 14 * DAY + 1 }).check();
    assert.equal(overdue.ok, false);
    const red = overdue.problems.find((problem) => problem.kind === 'stale-anchor');
    assert.ok(red !== undefined, JSON.stringify(overdue.problems));
    assert.equal(red.level, 'red');
    assert.match(red.detail, /известно с/);
  });

  // Задача 4.2 / Сценарий: «Первое наблюдение датирует расхождение»
  it('check({record: true}) вписывает stale_since, остальная часть файла побайтово прежняя', () => {
    const box = repo({ 'src/a.ts': 'export const a = 1;\n' });
    const hash = anchorHash(join(box.root, 'src/a.ts'));
    box.write('src/a.ts', 'export const a = 2;\n');
    box.write(
      'knowledge/a.md',
      unit({
        id: 'a',
        title: 'Первая',
        anchors: `anchors:\n  - path: src/a.ts\n    hash: '${hash}'`,
      }),
    );
    const before = readFileSync(join(box.root, 'knowledge/a.md'), 'utf8');

    box.source({ now: Date.now() }).check({ record: true });

    const after = readFileSync(join(box.root, 'knowledge/a.md'), 'utf8');
    assert.match(after, /stale_since: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
    assert.equal(after.replace(/\n[ \t]*stale_since:[^\n]*/, ''), before);
  });

  // Задача 4.4 / Сценарий: «Повторная правка пути не сдвигает дату»
  it('повторная правка пути после датирования не сдвигает дату', () => {
    const box = repo({ 'src/a.ts': 'export const a = 1;\n' });
    const hash = anchorHash(join(box.root, 'src/a.ts'));
    box.write('src/a.ts', 'export const a = 2;\n');
    box.write(
      'knowledge/a.md',
      unit({
        id: 'a',
        title: 'Первая',
        anchors: `anchors:\n  - path: src/a.ts\n    hash: '${hash}'`,
      }),
    );

    const t0 = Date.now();
    box.source({ now: t0 }).check({ record: true });
    const firstDate = readFileSync(join(box.root, 'knowledge/a.md'), 'utf8').match(/stale_since: (\S+)/)?.[1];
    assert.ok(firstDate !== undefined);

    box.write('src/a.ts', 'export const a = 3;\n');
    box.source({ now: t0 + DAY }).check({ record: true });

    const secondDate = readFileSync(join(box.root, 'knowledge/a.md'), 'utf8').match(/stale_since: (\S+)/)?.[1];
    assert.equal(secondDate, firstDate);

    // Срок до красного не начался заново от чужой правки пути.
    assert.equal(box.source({ now: t0 + 14 * DAY + 1 }).check().ok, false);
  });

  // Задача 4.5 / Сценарий: «Исчезнувшее расхождение теряет дату»
  it('check({record: true}) снимает stale_since, когда расхождение исчезло', () => {
    const box = repo({ 'src/a.ts': 'export const a = 1;\n' });
    const hash = anchorHash(join(box.root, 'src/a.ts'));
    box.write('src/a.ts', 'export const a = 2;\n');
    box.write(
      'knowledge/a.md',
      unit({
        id: 'a',
        title: 'Первая',
        anchors: `anchors:\n  - path: src/a.ts\n    hash: '${hash}'`,
      }),
    );
    box.source({ now: Date.now() }).check({ record: true });
    assert.match(readFileSync(join(box.root, 'knowledge/a.md'), 'utf8'), /stale_since:/);

    // Содержимое пути правится обратно на закреплённое — расхождения больше нет.
    box.write('src/a.ts', 'export const a = 1;\n');

    const removal = box.source().check({ record: true });
    assert.doesNotMatch(readFileSync(join(box.root, 'knowledge/a.md'), 'utf8'), /stale_since:/);
    assert.deepEqual(removal.recorded, { dated: [], cleared: [{ id: 'a', path: 'src/a.ts' }] });
  });

  // Правка дерева обязана быть названа в самом ответе: перечитывать дерево
  // вторым вызовом ради того же знания значило бы удвоить хеширование файлов,
  // а для источника `cmd` — дважды запустить внешнюю команду.
  it('check({record: true}) отдаёт отчёт о датировании, check без record — нет', () => {
    const box = repo({ 'src/a.ts': 'export const a = 1;\n' });
    const hash = anchorHash(join(box.root, 'src/a.ts'));
    box.write('src/a.ts', 'export const a = 2;\n');
    box.write(
      'knowledge/a.md',
      unit({
        id: 'a',
        title: 'Первая',
        anchors: `anchors:\n  - path: src/a.ts\n    hash: '${hash}'`,
      }),
    );

    const now = Date.parse('2026-09-06T09:12:33Z');
    const verdict = box.source({ now }).check({ record: true });
    assert.deepEqual(verdict.recorded, {
      dated: [{ id: 'a', path: 'src/a.ts', since: '2026-09-06T09:12:33Z' }],
      cleared: [],
    });
    // Нарушения посчитаны на дереве до правки: датирование не влияет на исход
    // того же вызова, и вновь поставленной даты в детали ещё нет.
    const found = verdict.problems.find((problem) => problem.kind === 'stale-anchor');
    assert.ok(found !== undefined, JSON.stringify(verdict.problems));
    assert.doesNotMatch(found.detail, /известно с/);

    // Следующая проверка видит дату и называет её, а отчёта не несёт вовсе.
    const next = box.source({ now }).check();
    assert.equal(next.recorded, undefined);
    const dated = next.problems.find((problem) => problem.kind === 'stale-anchor');
    assert.ok(dated !== undefined, JSON.stringify(next.problems));
    assert.match(dated.detail, /известно с 2026-09-06T09:12:33Z/);
  });

  // Задача 4.6, вторая половина: пропавший путь якоря не снимает уже
  // поставленную дату — missing-anchor обрывает разбор якоря раньше сравнения
  // содержимого, и снятие даты через него не проходит.
  it('несуществующий путь якоря не снимает уже поставленную дату', () => {
    const box = repo({ 'src/a.ts': 'export const a = 1;\n' });
    const hash = anchorHash(join(box.root, 'src/a.ts'));
    box.write('src/a.ts', 'export const a = 2;\n');
    box.write(
      'knowledge/a.md',
      unit({
        id: 'a',
        title: 'Первая',
        anchors: `anchors:\n  - path: src/a.ts\n    hash: '${hash}'`,
      }),
    );
    box.source({ now: Date.now() }).check({ record: true });
    const dated = readFileSync(join(box.root, 'knowledge/a.md'), 'utf8');
    assert.match(dated, /stale_since:/);

    rmSync(join(box.root, 'src/a.ts'), { force: true });
    box.source().check({ record: true });
    assert.equal(readFileSync(join(box.root, 'knowledge/a.md'), 'utf8'), dated);
  });

  // Задача 4.7 / Сценарий: «Испорченная дата не роняет отбор»
  it('испорченная stale_since — жёлтое, а не отказ разбора; index и select работают', () => {
    const box = repo({ 'src/a.ts': 'export const a = 1;\n' });
    const hash = anchorHash(join(box.root, 'src/a.ts'));
    box.write('src/a.ts', 'export const a = 2;\n');
    box.write(
      'knowledge/a.md',
      unit({
        id: 'a',
        title: 'Первая',
        anchors: `anchors:\n  - path: src/a.ts\n    hash: '${hash}'\n    stale_since: не-дата`,
      }),
    );

    const verdict = box.source().check();
    assert.equal(verdict.ok, true);
    const badSince = verdict.problems.find((problem) => problem.kind === 'anchor-bad-since');
    assert.ok(badSince !== undefined, JSON.stringify(verdict.problems));
    assert.equal(badSince.level, 'yellow');
    assert.match(badSince.detail, /knowledge\/a\.md/);
    assert.match(badSince.detail, /src\/a\.ts/);
    const stale2 = verdict.problems.find((problem) => problem.kind === 'stale-anchor');
    assert.ok(stale2 !== undefined, JSON.stringify(verdict.problems));
    assert.equal(stale2.level, 'yellow');

    assert.doesNotThrow(() => box.source().index());
    assert.doesNotThrow(() => box.source().select({ kind: 'scope', scope: ['src/**'] }));
  });

  // Задача 1.5 / Сценарий: «якорь потоковым стилем не поддаётся точечной правке»
  it('якорь потоковым стилем не датируется, файл остаётся нетронутым', () => {
    const box = repo({ 'src/a.ts': 'export const a = 1;\n' });
    const hash = anchorHash(join(box.root, 'src/a.ts'));
    box.write('src/a.ts', 'export const a = 2;\n');
    const text = [
      '---',
      'id: a',
      'title: Первая',
      'scope:',
      '  - src/**',
      'anchors:',
      `  - {path: src/a.ts, hash: '${hash}'}`,
      'status: active',
      '---',
      '',
      'Тело.',
      '',
    ].join('\n');
    box.write('knowledge/a.md', text);

    const recorded = box.source({ now: Date.now() }).check({ record: true });

    assert.equal(readFileSync(join(box.root, 'knowledge/a.md'), 'utf8'), text);
    assert.deepEqual(recorded.recorded, { dated: [], cleared: [] });
    const found = recorded.problems.find((problem) => problem.kind === 'stale-anchor');
    assert.ok(found !== undefined, JSON.stringify(recorded.problems));
    assert.equal(found.level, 'yellow');

    // Молчать о недатируемом якоре нельзя: `--record` не сделает по нему
    // ничего ни в этот заход, ни в любой следующий, и без отдельного
    // нарушения эта деградация памяти ничем не отличается от расхождения,
    // которое просто ещё не датировали.
    for (const verdict of [recorded, box.source().check()]) {
      const undatable = verdict.problems.find((problem) => problem.kind === 'anchor-not-datable');
      assert.ok(undatable !== undefined, JSON.stringify(verdict.problems));
      assert.equal(undatable.level, 'yellow');
      assert.equal(undatable.id, 'a');
      assert.match(undatable.detail, /knowledge\/a\.md/);
      assert.match(undatable.detail, /src\/a\.ts/);
    }
    // Жёлтое, не красное: гейт этим не проваливается.
    assert.equal(box.source().check().ok, true);
  });

  // Задача 1.5, вторая половина: снять дату с недатируемого якоря так же
  // нельзя, как и поставить, — и оставленная дата сделала бы следующее
  // расхождение красным в момент возникновения.
  it('недатируемый якорь с датой при сошедшемся закреплении виден жёлтым', () => {
    const box = repo({ 'src/a.ts': 'export const a = 1;\n' });
    const hash = anchorHash(join(box.root, 'src/a.ts'));
    const text = [
      '---',
      'id: a',
      'title: Первая',
      'scope:',
      '  - src/**',
      'anchors:',
      `  - {path: src/a.ts, hash: '${hash}', stale_since: '2026-01-01T00:00:00Z'}`,
      'status: active',
      '---',
      '',
      'Тело.',
      '',
    ].join('\n');
    box.write('knowledge/a.md', text);

    const verdict = box.source({ now: Date.now() }).check({ record: true });

    assert.equal(readFileSync(join(box.root, 'knowledge/a.md'), 'utf8'), text);
    const undatable = verdict.problems.find((problem) => problem.kind === 'anchor-not-datable');
    assert.ok(undatable !== undefined, JSON.stringify(verdict.problems));
    assert.equal(undatable.level, 'yellow');
    assert.match(undatable.detail, /src\/a\.ts/);
  });

  // Задача 4.7: испорченная дата — свойство шапки, а не исхода сравнения
  // содержимого. Ветвь сошедшегося закрепления выходит раньше подтверждённого
  // расхождения, и порча в ней была не видна вовсе.
  it('испорченная stale_since видна и на сошедшемся закреплении, без нарушения об устаревании', () => {
    const box = repo({ 'src/a.ts': 'export const a = 1;\n' });
    const hash = anchorHash(join(box.root, 'src/a.ts'));
    box.write(
      'knowledge/a.md',
      unit({
        id: 'a',
        title: 'Первая',
        anchors: `anchors:\n  - path: src/a.ts\n    hash: '${hash}'\n    stale_since: не-дата`,
      }),
    );

    const matched = box.source().check();
    assert.equal(matched.ok, true);
    assert.equal(matched.problems.filter((problem) => problem.kind === 'anchor-bad-since').length, 1);
    // Закрепление сошлось — расхождения нет, и жёлтое здесь ровно одно: порча даты.
    assert.equal(matched.problems.some((problem) => problem.kind === 'stale-anchor'), false);
  });

  // Задача 3.6 / Сценарий: «Закрепление из одних цифр проверяется»
  //
  // Дайджест из шестнадцати шестнадцатеричных символов состоит из одних цифр
  // примерно в одном случае из тысячи восьмисот. YAML типизирует такой скаляр
  // числом, и разбор, бравший `hash` только строкой, молча превращал бы его в
  // «якорь без закрепления»: устаревание по нему не проверялось бы вовсе.
  // Значение здесь меньше 2^53 и потому переживает округление double в оба
  // конца — тест ловит дефект разбора, а не случайность приведения типа.
  it('закрепление из одних цифр читается строкой и проверяется на устаревание', () => {
    const box = repo({ 'src/a.ts': 'export const a = 1;\n' });
    box.write(
      'knowledge/a.md',
      unit({
        id: 'a',
        title: 'Первая',
        anchors: 'anchors:\n  - path: src/a.ts\n    hash: 1234567890123456',
      }),
    );

    const verdict = box.source().check();
    const found = verdict.problems.find((problem) => problem.kind === 'stale-anchor');
    assert.ok(found !== undefined, JSON.stringify(verdict.problems));
    assert.equal(found.level, 'yellow');
  });

  // Задача 3.6 / Сценарий: «Непригодное значение закрепления отклонено» —
  // форма, не отказ разбора
  //
  // Жёлтым, а не отказом (design.md, решение 6): у поля закрепления, в
  // отличие от прежней ревизии, нет осмысленных значений, кроме дайджеста, но
  // отказ здесь обрушил бы вместе с проверкой отбор и оглавление.
  it('жёлтым на закреплении, не похожем на дайджест', () => {
    const box = repo({ 'src/a.ts': 'export const a = 1;\n' });
    box.write(
      'knowledge/a.md',
      unit({
        id: 'a',
        title: 'Первая',
        anchors: 'anchors:\n  - path: src/a.ts\n    hash: d5f15e2-fix',
      }),
    );

    const verdict = box.source().check();
    assert.equal(verdict.ok, true);
    const found = verdict.problems.find((problem) => problem.kind === 'anchor-bad-hash');
    assert.ok(found !== undefined, JSON.stringify(verdict.problems));
    assert.equal(found.level, 'yellow');
    assert.match(found.detail, /src\/a\.ts/);
    assert.match(found.detail, /d5f15e2-fix/);
  });

  // Терпимость к числовой типизации объявлена безусловной, и оговорок про
  // «кроме значений за границей точного целого» у неё нет. Обратное приведение
  // `String(Number(...))` такие значения теряет — 16 девяток не умещаются в
  // мантиссу double, — поэтому закрепление читается исходным текстом скаляра.
  for (const [name, hash] of [
    ['за границей точного целого', '9999999999999999'],
    ['с ведущими нулями', '0000123456789012'],
  ] as const) {
    it(`закрепление ${name} проверяется на устаревание, а не объявляется непригодным`, () => {
      const box = repo({ 'src/a.ts': 'export const a = 1;\n' });
      box.write(
        'knowledge/a.md',
        unit({
          id: 'a',
          title: 'Первая',
          anchors: `anchors:\n  - path: src/a.ts\n    hash: ${hash}`,
        }),
      );

      const verdict = box.source().check();
      assert.equal(verdict.ok, true);
      const found = verdict.problems.find((problem) => problem.kind === 'stale-anchor');
      assert.ok(found !== undefined, JSON.stringify(verdict.problems));
      assert.equal(found.level, 'yellow');
      // Значение названо ровно тем, чем набрано: округлённое или потерявшее
      // нули закрепление в сообщении отправило бы человека сверять не то.
      assert.match(found.detail, new RegExp(hash));
      assert.ok(!verdict.problems.some((problem) => problem.kind === 'anchor-bad-hash'));
    });
  }

  // Значение, которое YAML типизирует числом, а дайджестом оно не является:
  // форма проверяется по исходному тексту, и запись показателем степени сквозь
  // неё не проходит.
  it('жёлтым на числовом закреплении, не имеющем формы дайджеста', () => {
    const box = repo({ 'src/a.ts': 'export const a = 1;\n' });
    box.write(
      'knowledge/a.md',
      unit({
        id: 'a',
        title: 'Первая',
        anchors: 'anchors:\n  - path: src/a.ts\n    hash: 1e16',
      }),
    );

    const verdict = box.source().check();
    assert.equal(verdict.ok, true);
    const found = verdict.problems.find((problem) => problem.kind === 'anchor-bad-hash');
    assert.ok(found !== undefined, JSON.stringify(verdict.problems));
    assert.equal(found.level, 'yellow');
    assert.match(found.detail, /1e16/);
  });

  // Дайджест этот источник печатает только строчными: набранное заглавными
  // значение его дайджестом не является ни при каком содержимом. Признай
  // проверка формы его годным — вышло бы `stale-anchor`, то есть нарушение с
  // неверной причиной.
  it('жёлтым о форме на закреплении, набранном заглавными', () => {
    const box = repo({ 'src/a.ts': 'export const a = 1;\n' });
    const hash = anchorHash(join(box.root, 'src/a.ts')).toUpperCase();
    box.write(
      'knowledge/a.md',
      unit({
        id: 'a',
        title: 'Первая',
        anchors: `anchors:\n  - path: src/a.ts\n    hash: '${hash}'`,
      }),
    );

    const verdict = box.source().check();
    assert.equal(verdict.ok, true);
    const found = verdict.problems.find((problem) => problem.kind === 'anchor-bad-hash');
    assert.ok(found !== undefined, JSON.stringify(verdict.problems));
    assert.equal(found.level, 'yellow');
    assert.ok(!verdict.problems.some((problem) => problem.kind === 'stale-anchor'));
  });

  // Задача 3.6 / Сценарий: «Непригодное закрепление не выдаётся за устаревание»
  it('непохожее закрепление не даёт нарушения об устаревании', () => {
    const box = repo({ 'src/a.ts': 'export const a = 1;\n' });
    box.write('src/a.ts', 'export const a = 2;\n');
    box.write(
      'knowledge/a.md',
      unit({
        id: 'a',
        title: 'Первая',
        anchors: 'anchors:\n  - path: src/a.ts\n    hash: релиз-осень',
      }),
    );

    const verdict = box.source().check();
    const kinds = verdict.problems.map((problem) => problem.kind);
    assert.ok(kinds.includes('anchor-bad-hash'), JSON.stringify(verdict.problems));
    assert.ok(!kinds.includes('stale-anchor'), JSON.stringify(verdict.problems));
  });

  // Задача 3.5 / Сценарий: «Единица прежней формы названа», «Прежняя форма не
  // сравнивается с историей»
  it('якорь с rev без hash даёт жёлтое о прежней форме и не считает устаревание', () => {
    const box = repo({ 'src/a.ts': 'export const a = 1;\n' });
    box.commit('первый');
    box.write('src/a.ts', 'export const a = 2;\n');
    box.commit('второй');
    box.write(
      'knowledge/a.md',
      unit({
        id: 'a',
        title: 'Первая',
        anchors: 'anchors:\n  - path: src/a.ts\n    rev: d5f15e2',
      }),
    );

    const verdict = box.source().check();
    assert.equal(verdict.ok, true);
    const legacy = verdict.problems.find((problem) => problem.kind === 'anchor-legacy-rev');
    assert.ok(legacy !== undefined, JSON.stringify(verdict.problems));
    assert.equal(legacy.level, 'yellow');
    assert.match(legacy.detail, /knowledge\/a\.md/);
    assert.match(legacy.detail, /src\/a\.ts/);
    assert.ok(!verdict.problems.some((problem) => problem.kind === 'stale-anchor'));
  });

  // Путь существует, а байтов у него нет: каталог проходит проверку
  // существования и роняет чтение. `check` стоит гейтом, и трасса Node вместо
  // уровня нарушения обрывала бы работу вместо того, чтобы её назвать.
  it('жёлтым на якоре, содержимое которого не читается', () => {
    const box = repo({ 'src/nested/a.ts': 'export const a = 1;\n' });
    box.write(
      'knowledge/a.md',
      unit({
        id: 'a',
        title: 'Первая',
        anchors: "anchors:\n  - path: src/nested\n    hash: '1234567890123456'",
      }),
    );

    const verdict = box.source().check();
    assert.equal(verdict.ok, true);
    const found = verdict.problems.find((problem) => problem.kind === 'anchor-unreadable');
    assert.ok(found !== undefined, JSON.stringify(verdict.problems));
    assert.equal(found.level, 'yellow');
    assert.match(found.detail, /src\/nested/);
    assert.ok(!verdict.problems.some((problem) => problem.kind === 'stale-anchor'));
  });

  // Якорь голым скаляром — законная форма: существование пути проверяется,
  // устаревание не считается. Проверяется на уровне `check`, а не только
  // разбора: провались `undefined` в сравнение, всякий такой якорь начал бы
  // давать ложное жёлтое, а тесты разбора остались бы зелёными.
  for (const [name, anchors] of [
    ['голым скаляром', 'anchors:\n  - src/a.ts'],
    ['отображением без hash', 'anchors:\n  - path: src/a.ts'],
  ] as const) {
    it(`якорь ${name} нарушений об устаревании не даёт при любом содержимом`, () => {
      const box = repo({ 'src/a.ts': 'export const a = 1;\n' });
      box.write('knowledge/a.md', unit({ id: 'a', title: 'Первая', anchors }));
      box.write('src/a.ts', 'export const a = 2;\n');

      const verdict = box.source().check();
      assert.equal(verdict.ok, true);
      assert.deepEqual(verdict.problems, []);
    });
  }

  // Якорь на каталог у голого скаляра остаётся законным: закрепления у него
  // нет, читать нечего, и проверяется по нему одно существование пути.
  it('якорь голым скаляром на каталог нарушения не даёт', () => {
    const box = repo({ 'src/nested/a.ts': 'export const a = 1;\n' });
    box.write('knowledge/a.md', unit({ id: 'a', title: 'Первая', anchors: 'anchors:\n  - src/nested' }));

    const verdict = box.source().check();
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.problems, []);
  });

  it('свежий якорь не даёт нарушения', () => {
    const box = repo({ 'src/a.ts': 'export const a = 1;\n' });
    const hash = anchorHash(join(box.root, 'src/a.ts'));
    box.write(
      'knowledge/a.md',
      unit({
        id: 'a',
        title: 'Первая',
        anchors: `anchors:\n  - path: src/a.ts\n    hash: '${hash}'`,
      }),
    );
    const verdict = box.source().check();
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.problems, []);
  });

  // Ревью: проверять якоря отменённого — значит требовать от
  // инвалидированного утверждения оставаться верным, и архив со временем
  // делает гейт вечно красным. Тогда инвалидация выталкивает к удалению,
  // которое она и заводилась заменить. Форма закрепления (здесь — прежняя,
  // `rev` без `hash`) по той же причине не проверяется тоже.
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

  // Задача 4.10: check без record остаётся чтением даже при недатированном
  // расхождении — половина ценности команды объявлена гейтом CI/pre-commit,
  // а гейт, правящий рабочую копию, непригоден там, где он полезнее всего.
  it('check без record не меняет каталог знания ни одним байтом', () => {
    const box = repo({ 'src/a.ts': 'export const a = 1;\n' });
    const hash = anchorHash(join(box.root, 'src/a.ts'));
    box.write('src/a.ts', 'export const a = 2;\n');
    box.write(
      'knowledge/a.md',
      unit({
        id: 'a',
        title: 'Первая',
        anchors: `anchors:\n  - path: src/a.ts\n    hash: '${hash}'`,
      }),
    );
    const before = readFileSync(join(box.root, 'knowledge/a.md'), 'utf8');

    box.source().check();

    assert.equal(readFileSync(join(box.root, 'knowledge/a.md'), 'utf8'), before);
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
  // Задача 1.4, 1.5 / Сценарий: «Запись закрепляет содержимое якорей»
  it('закрепляет содержимое якоря дайджестом, закавыченным', () => {
    const box = repo({ 'src/a.ts': 'export const a = 1;\n' });
    const hash = anchorHash(join(box.root, 'src/a.ts'));

    const result = box.source().write({
      id: 'a',
      title: 'Первая',
      scope: ['src/**'],
      anchors: ['src/a.ts'],
      body: 'Тело.',
    });

    assert.equal(result.ok, true);
    const text = readFileSync(join(box.root, 'knowledge/a.md'), 'utf8');
    assert.match(text, new RegExp(`hash: '${hash}'`));
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

  // Задача 4.9 / Сценарий: «Запись единицы дат не оставляет»
  it('write перезаписывает единицу без stale_since, закрепление якорей свежее', () => {
    const box = repo({ 'src/a.ts': 'export const a = 1;\n' });
    const staleHash = anchorHash(join(box.root, 'src/a.ts'));
    box.write('src/a.ts', 'export const a = 2;\n');
    box.write(
      'knowledge/a.md',
      unit({
        id: 'a',
        title: 'Первая',
        anchors: `anchors:\n  - path: src/a.ts\n    hash: '${staleHash}'`,
      }),
    );
    box.source({ now: Date.now() }).check({ record: true });
    assert.match(readFileSync(join(box.root, 'knowledge/a.md'), 'utf8'), /stale_since:/);

    const result = box.source().write({
      id: 'a',
      title: 'Первая',
      scope: ['src/**'],
      anchors: ['src/a.ts'],
      body: 'Тело.',
    });

    assert.equal(result.ok, true);
    const text = readFileSync(join(box.root, 'knowledge/a.md'), 'utf8');
    assert.doesNotMatch(text, /stale_since/);
    const freshHash = anchorHash(join(box.root, 'src/a.ts'));
    assert.match(text, new RegExp(`hash: '${freshHash}'`));
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

  // Задача 1.2 / Сценарий: «Заход, которому не хватило места, сохраняет
  // узнанное» — откат в write завязан на verdict.ok, то есть на красное:
  // переполнение больше не откатывает запись (design.md, решение 5).
  it('запись новой единицы в заведомо переполненное оглавление проходит и остаётся в дереве', () => {
    const box = repo({
      'knowledge/a.md': unit({ id: 'a', title: 'Очень длинный заголовок'.repeat(20) }),
    });
    const result = box.source({ indexMaxTokens: 10 }).write({
      id: 'b',
      title: 'Вторая',
      scope: ['src/**'],
      anchors: [],
      body: 'Тело.',
    });
    assert.equal(result.ok, true);
    assert.equal(readFileSync(join(box.root, 'knowledge/b.md'), 'utf8').includes('Вторая'), true);
    assert.ok(result.problems.some((problem) => problem.kind === 'index-overflow' && problem.level === 'yellow'));
  });

  // Контраст с предыдущим: красное нарушение по-прежнему откатывает запись.
  it('якорь в пустоту по-прежнему откатывает запись', () => {
    const box = repo({});
    const result = box.source().write({
      id: 'a',
      title: 'Первая',
      scope: ['src/**'],
      anchors: ['src/нет.ts'],
      body: 'Тело.',
    });
    assert.equal(result.ok, false);
    assert.throws(() => readFileSync(join(box.root, 'knowledge/a.md'), 'utf8'));
  });
});

describe('knowledge-fs: предикат видит переполнение жёлтым', () => {
  // Задача 4.1 (продолжение): knowledge_valid проходит на переполненном
  // оглавлении и показывает переполнение в отчёте жёлтых.
  it('check().ok true, а knowledge_valid проходит с переполнением в detail', async () => {
    const box = repo({
      'knowledge/a.md': unit({ id: 'a', title: 'Очень длинный заголовок'.repeat(20) }),
    });
    const source = box.source({ indexMaxTokens: 10 });
    assert.equal(source.check().ok, true);

    const [result] = await evaluatePredicates([{ kind: 'knowledge_valid' }], {
      exitCode: 0,
      text: '',
      structured: undefined,
      cwd: box.root,
      env: { PATH: process.env['PATH'] ?? '' },
      knowledge: source,
    });
    assert.equal(result?.passed, true);
    assert.equal(result?.hard, true);
    assert.match(result?.detail ?? '', /index-overflow/);
  });
});

describe('knowledge-fs: отмена по supersedes', () => {
  // Задача 4.3 / Сценарий: «Слияние описано одним объектом»
  it('слияние: названные единицы получают status: superseded, тело и шапка прежние', () => {
    const box = repo({
      'knowledge/a.md': unit({ id: 'a', title: 'Первая', anchors: 'anchors:\n  - src/a.ts' }),
      'knowledge/b.md': unit({ id: 'b', title: 'Вторая', scope: ['src/b/**'] }),
    });
    const beforeA = readFileSync(join(box.root, 'knowledge/a.md'), 'utf8');
    const beforeB = readFileSync(join(box.root, 'knowledge/b.md'), 'utf8');

    const result = box.source().write({
      id: 'merged',
      title: 'Слитая',
      scope: ['src/**'],
      anchors: [],
      supersedes: ['a', 'b'],
      body: 'Слитое тело.',
    });

    assert.equal(result.ok, true);
    assert.equal(
      readFileSync(join(box.root, 'knowledge/a.md'), 'utf8'),
      beforeA.replace('status: active', 'status: superseded'),
    );
    assert.equal(
      readFileSync(join(box.root, 'knowledge/b.md'), 'utf8'),
      beforeB.replace('status: active', 'status: superseded'),
    );

    const source = box.source();
    assert.deepEqual(
      source.index().map((entry) => entry.id).sort(),
      ['merged'],
    );
    assert.equal(source.select({ kind: 'scope', scope: ['src/**'] }).some((e) => e.id === 'a'), false);
    assert.equal(source.select({ kind: 'id', id: ['a'] })[0]?.id, 'a');
  });

  // Задача 4.4 / Сценарий: «supersedes называет несуществующее»
  it('supersedes в пустоту — отказ, ни один файл не изменён', () => {
    const box = repo({ 'knowledge/a.md': unit({ id: 'a', title: 'Первая' }) });
    const before = readFileSync(join(box.root, 'knowledge/a.md'), 'utf8');

    const result = box.source().write({
      id: 'merged',
      title: 'Слитая',
      scope: ['src/**'],
      anchors: [],
      supersedes: ['a', 'нет-такой'],
      body: 'Слитое тело.',
    });

    assert.equal(result.ok, false);
    assert.ok(
      result.problems.some((problem) => problem.id === 'нет-такой' && problem.level === 'red'),
      JSON.stringify(result.problems),
    );
    assert.equal(readFileSync(join(box.root, 'knowledge/a.md'), 'utf8'), before);
    assert.throws(() => readFileSync(join(box.root, 'knowledge/merged.md'), 'utf8'));
  });

  // Задача 4.6: запрет самоотмены
  it('единица не может отменять сама себя', () => {
    const box = repo({ 'knowledge/a.md': unit({ id: 'a', title: 'Первая' }) });
    const result = box.source().write({
      id: 'a',
      title: 'Первая',
      scope: ['src/**'],
      anchors: [],
      supersedes: ['a'],
      body: 'Тело.',
    });
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => problem.id === 'a' && problem.level === 'red'));
  });

  // Задача 4.6: идемпотентность
  it('повторная отмена уже отменённой единицы не отказ', () => {
    const box = repo({
      'knowledge/a.md': unit({ id: 'a', title: 'Первая', status: 'superseded' }),
    });
    const before = readFileSync(join(box.root, 'knowledge/a.md'), 'utf8');

    const result = box.source().write({
      id: 'merged',
      title: 'Слитая',
      scope: ['src/**'],
      anchors: [],
      supersedes: ['a'],
      body: 'Тело.',
    });

    assert.equal(result.ok, true);
    // Уже отменённая единица не переписывается вовсе — файл не тронут.
    assert.equal(readFileSync(join(box.root, 'knowledge/a.md'), 'utf8'), before);
  });

  // Задача 4.4 / Сценарий: «Отказ откатывает все задетые файлы»
  it('слитое тело переросло unit_max_tokens — отказ, обе отменяемые единицы остаются активными', () => {
    const box = repo({
      'knowledge/a.md': unit({ id: 'a', title: 'Первая' }),
      'knowledge/b.md': unit({ id: 'b', title: 'Вторая' }),
    });
    const beforeA = readFileSync(join(box.root, 'knowledge/a.md'), 'utf8');
    const beforeB = readFileSync(join(box.root, 'knowledge/b.md'), 'utf8');

    const result = box.source({ unitMaxTokens: 10 }).write({
      id: 'merged',
      title: 'Слитая',
      scope: ['src/**'],
      anchors: [],
      supersedes: ['a', 'b'],
      body: 'Очень длинное тело единицы знания. '.repeat(50),
    });

    assert.equal(result.ok, false);
    assert.equal(readFileSync(join(box.root, 'knowledge/a.md'), 'utf8'), beforeA);
    assert.equal(readFileSync(join(box.root, 'knowledge/b.md'), 'utf8'), beforeB);
    assert.throws(() => readFileSync(join(box.root, 'knowledge/merged.md'), 'utf8'));
  });

  // Ревью: имя файла единицы не обязано совпадать с её идентификатором, и
  // тогда запись метила в тот же файл, куда шла пометка отменяемой. Снимок
  // прежнего содержимого затирал только что записанное, `check` красного не
  // находил, и `write` возвращал зелёный ответ на запись, которой в дереве
  // нет. Отказ — до первой правки дерева.
  it('отменяемая единица в файле записываемой — отказ, дерево не тронуто', () => {
    const box = repo({ 'knowledge/b.md': unit({ id: 'a', title: 'Первая' }) });
    const before = readFileSync(join(box.root, 'knowledge/b.md'), 'utf8');

    const result = box.source().write({
      id: 'b',
      title: 'Вторая',
      scope: ['src/**'],
      anchors: [],
      supersedes: ['a'],
      body: 'Тело.',
    });

    assert.equal(result.ok, false);
    assert.ok(
      result.problems.some(
        (problem) =>
          problem.id === 'a' &&
          problem.level === 'red' &&
          problem.detail.includes('knowledge/b.md'),
      ),
      JSON.stringify(result.problems),
    );
    assert.equal(readFileSync(join(box.root, 'knowledge/b.md'), 'utf8'), before);
  });

  // Задача 2.4: откат идёт по одному списку задетых файлов, а не по
  // записываемому отдельно и отменяемым отдельно, — после отказа каталог
  // знания обязан быть побайтово прежним целиком.
  it('после отказа каталог знания побайтово равен исходному', () => {
    const box = repo({
      'knowledge/a.md': unit({ id: 'a', title: 'Первая' }),
      'knowledge/b.md': unit({ id: 'b', title: 'Вторая' }),
      'knowledge/вложенная/c.md': unit({ id: 'c', title: 'Третья' }),
    });
    const snapshot = (): Record<string, string> =>
      Object.fromEntries(
        (globSync('**/*.md', { cwd: join(box.root, 'knowledge') }) as string[])
          .sort()
          .map((name) => [name, readFileSync(join(box.root, 'knowledge', name), 'utf8')]),
      );
    const before = snapshot();

    const result = box.source().write({
      id: 'merged',
      title: 'Слитая',
      scope: ['src/**'],
      anchors: ['src/нет.ts'],
      supersedes: ['a', 'b', 'c'],
      body: 'Слитое тело.',
    });

    assert.equal(result.ok, false);
    assert.deepEqual(snapshot(), before);
  });

  // Задача 4.5: слитая единица уменьшает записи единиц знания и снимает
  // переполнение оглавления.
  it('слияние по группе снимает жёлтое нарушение index-overflow', () => {
    const longTitle = 'Очень длинный заголовок единицы номер '.repeat(10);
    const box = repo({
      'knowledge/a.md': unit({ id: 'a', title: `${longTitle}1` }),
      'knowledge/b.md': unit({ id: 'b', title: `${longTitle}2` }),
      'knowledge/c.md': unit({ id: 'c', title: `${longTitle}3` }),
    });
    const overflowing = box.source({ indexMaxTokens: 200 }).check();
    assert.ok(overflowing.problems.some((problem) => problem.kind === 'index-overflow'));

    const before = box.source({ indexMaxTokens: 200 }).index().length;

    const result = box.source({ indexMaxTokens: 200 }).write({
      id: 'merged',
      title: 'Слитая',
      scope: ['src/**'],
      anchors: [],
      supersedes: ['a', 'b', 'c'],
      body: 'Слитое тело.',
    });
    assert.equal(result.ok, true);

    const source = box.source({ indexMaxTokens: 200 });
    assert.ok(source.index().length < before);
    assert.ok(!result.problems.some((problem) => problem.kind === 'index-overflow'), JSON.stringify(result.problems));
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
    const root = tempDir('knowledge-cmd-');
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
        specIndexMaxTokens: 2000,
        unitMaxTokens: 1000,
        staleAfterMs: 14 * DAY,
        timeoutMs,
      },
      root,
    });
    assert.ok(source !== undefined);
    return { box: { root, command }, source };
  }

  /**
   * Источник-заглушка, пишущий в лог-файл вызванный глагол и полученный
   * запрос — по одной строке JSON на вызов. `handler` отвечает на stdout;
   * переменные `verb` и `request` доступны ему по имени.
   */
  function loggingStub(handler: string): {
    source: KnowledgeSource;
    readLog: () => Array<{ verb: string; request: unknown }>;
  } {
    const root = tempDir('knowledge-cmd-log-');
    const file = join(root, 'source.mjs');
    const log = join(root, 'log.jsonl');
    writeFileSync(
      file,
      `import { appendFileSync } from 'node:fs';
       const chunks = [];
       for await (const chunk of process.stdin) chunks.push(chunk);
       const request = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
       const verb = process.argv[2];
       appendFileSync(${JSON.stringify(log)}, JSON.stringify({ verb, request }) + '\\n');
       ${handler}`,
    );
    const command = `node ${JSON.stringify(file)}`;
    const source = createKnowledgeSource({
      knowledge: {
        provider: 'cmd',
        command,
        dir: undefined,
        rules: undefined,
        indexMaxTokens: 2000,
        specIndexMaxTokens: 2000,
        unitMaxTokens: 1000,
        staleAfterMs: 14 * DAY,
        timeoutMs: 10_000,
      },
      root,
    });
    assert.ok(source !== undefined);
    const readLog = (): Array<{ verb: string; request: unknown }> =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as { verb: string; request: unknown });
    return { source: source as KnowledgeSource, readLog };
  }

  // Задача 1.1: запись `knowledge: index` разрешается глаголом `index`, а не
  // `select` с полем вне контракта.
  it('запись `knowledge: index` вызывает глагол index, а не select', () => {
    const { source, readLog } = loggingStub(
      `if (verb === 'index') {
         process.stdout.write(JSON.stringify({ entries: [{ id: 'a', title: 'A', scope: [] }] }));
       } else {
         process.stdout.write(JSON.stringify({ entries: [] }));
       }`,
    );
    const entries = source.select({ kind: 'index' });
    const log = readLog();
    assert.equal(log.length, 1);
    assert.equal(log[0]?.verb, 'index');
    assert.deepEqual(log[0]?.request, {});
    assert.ok(log.every((call) => call.verb !== 'select'));
    assert.ok(entries[0]?.text?.includes('a — A'));
  });

  it('оглавление пустое — текст говорит об этом, а не молчит', () => {
    const { source } = loggingStub(
      `process.stdout.write(JSON.stringify({ entries: [] }));`,
    );
    const entries = source.select({ kind: 'index' });
    assert.equal(entries[0]?.text, 'Знание репозитория пусто.');
  });

  // Задача 1.2: запрос select по области и по идентификаторам несёт только
  // документированные поля — без `index`.
  it('запрос select по области и по id не несёт поля вне scope/id/budget', () => {
    const { source, readLog } = loggingStub(
      `process.stdout.write(JSON.stringify({ entries: [] }));`,
    );
    source.select({ kind: 'scope', scope: ['src/**'], budget: 500 });
    source.select({ kind: 'id', id: ['a', 'b'] });
    const log = readLog();
    assert.equal(log.length, 2);
    assert.ok(log.every((call) => call.verb === 'select'));
    assert.deepEqual(
      Object.keys(log[0]?.request as Record<string, unknown>).sort(),
      ['budget', 'scope'],
    );
    assert.deepEqual(Object.keys(log[1]?.request as Record<string, unknown>).sort(), ['id']);
  });

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
        specIndexMaxTokens: 2000,
        unitMaxTokens: 1000,
        staleAfterMs: 14 * DAY,
        timeoutMs: 10_000,
      },
      root: tempDir('knowledge-none-'),
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
