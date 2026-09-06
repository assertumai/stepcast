import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { globSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { estimateTokens } from '../src/core/context/assemble.js';
import { evaluatePredicates } from '../src/core/expect/evaluate.js';
import { createFsKnowledgeSource, globsIntersect, parseUnit } from '../src/core/knowledge/fs.js';
import { createKnowledgeSource } from '../src/core/knowledge/source.js';
import {
  KnowledgeWriteRequestSchema,
  type KnowledgeSource,
} from '../src/core/knowledge/types.js';
import { StepcastError } from '../src/core/errors.js';
import { gitCommit, gitInit } from './helpers.js';
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

  it('принимает якорь строкой — путь без ревизии', () => {
    const parsed = parseUnit(
      '---\nid: a\ntitle: б\nanchors:\n  - src/a.ts\n---\n\nтело\n',
      'knowledge/a.md',
    );
    assert.deepEqual(parsed.anchors, [{ path: 'src/a.ts', rev: undefined }]);
  });

  // Задача 2.3 / Сценарий: «Ревизия из одних цифр проверяется»
  it('принимает ревизию, прочитанную YAML числом, строкой', () => {
    const parsed = parseUnit(
      '---\nid: a\ntitle: б\nanchors:\n  - path: src/a.ts\n    rev: 9517869\n---\n\nтело\n',
      'knowledge/a.md',
    );
    assert.deepEqual(parsed.anchors, [{ path: 'src/a.ts', rev: '9517869' }]);
  });

  // Задача 2.3 / Сценарий: «Якорь без ревизии остаётся законным»
  it('якорь отображением без rev даёт ревизию undefined', () => {
    const parsed = parseUnit(
      '---\nid: a\ntitle: б\nanchors:\n  - path: src/a.ts\n---\n\nтело\n',
      'knowledge/a.md',
    );
    assert.deepEqual(parsed.anchors, [{ path: 'src/a.ts', rev: undefined }]);
  });

  // Задача 2.3 / Сценарий: «Непригодное значение ревизии отклонено»
  //
  // Отказом, а не молчаливым `undefined`: у этих значений нет прочтения, при
  // котором единица осмысленна, а `undefined` значил бы «устаревание не
  // считается» — ровно та ложь, из-за которой заведено это изменение.
  for (const [name, rev] of [
    ['логическим значением', 'true'],
    ['списком', '[a, b]'],
    ['отображением', '{}'],
    ['пустым', ''],
  ] as const) {
    it(`отклоняет ревизию, объявленную ${name}`, () => {
      assert.throws(
        () =>
          parseUnit(
            `---\nid: a\ntitle: б\nanchors:\n  - path: src/a.ts\n    rev: ${rev}\n---\n\nтело\n`,
            'knowledge/a.md',
          ),
        (error: unknown) => {
          assert.ok(error instanceof StepcastError);
          assert.match(error.message, /knowledge\/a\.md/);
          assert.equal(error.at, 'anchors.rev');
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
        // Ревизия в кавычках: этот тест про устаревание, а не про то, каким
        // типом YAML читает скаляр. Без кавычек хеш из одних цифр приходил бы
        // числом, и тест падал бы примерно раз в двадцать семь прогонов —
        // случай проверяется тестом «ревизия из одних цифр».
        anchors: `anchors:\n  - path: src/a.ts\n    rev: '${stale.slice(0, 7)}'`,
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
        // Ревизия в кавычках: этот тест про устаревание, а не про то, каким
        // типом YAML читает скаляр. Без кавычек хеш из одних цифр приходил бы
        // числом, и тест падал бы примерно раз в двадцать семь прогонов —
        // случай проверяется тестом «ревизия из одних цифр».
        anchors: `anchors:\n  - path: src/a.ts\n    rev: '${stale.slice(0, 7)}'`,
      }),
    );

    const verdict = box.source({ now: Date.now() + 30 * DAY }).check();
    assert.equal(verdict.ok, false);
    const overdue = verdict.problems.find((problem) => problem.kind === 'stale-anchor');
    assert.ok(overdue !== undefined, JSON.stringify(verdict.problems));
    assert.equal(overdue.level, 'red');
  });

  // Задача 1.1 / Сценарий: «Ревизия из одних цифр проверяется»
  //
  // Короткий хеш git — семь шестнадцатеричных символов, и из одних цифр он
  // состоит примерно в 3.7 % случаев. YAML типизирует такой скаляр числом, и
  // разбор, бравший `rev` только строкой, молча превращал его в «якорь без
  // ревизии»: устаревание по нему не проверялось никогда. Ревизия здесь
  // задана буквально, а не срезом настоящего хеша, — иначе тест ловил бы
  // дефект с той же вероятностью 3.7 %, то есть выглядел бы флаком.
  it('ревизия из одних цифр проверяется на устаревание', () => {
    const box = repo({ 'src/a.ts': 'export const a = 1;\n' });
    box.commit('первый');
    box.write('src/a.ts', 'export const a = 2;\n');
    box.commit('второй');
    box.write(
      'knowledge/a.md',
      unit({
        id: 'a',
        title: 'Первая',
        anchors: 'anchors:\n  - path: src/a.ts\n    rev: 9517869',
      }),
    );

    const verdict = box.source().check();
    const found = verdict.problems.find((problem) => problem.kind === 'stale-anchor');
    assert.ok(found !== undefined, JSON.stringify(verdict.problems));
    assert.equal(found.level, 'yellow');
  });

  // Задача 3.3 / Сценарий: «Опечатка в ревизии названа»
  //
  // Жёлтым, а не отказом: похожесть на хеш — догадка, и значение может
  // оказаться тегом или именем ветки. Но молчать нельзя — иначе опечатка в
  // ревизии неотличима от устаревшего якоря.
  it('жёлтым на ревизии, не похожей на хеш git', () => {
    const box = repo({ 'src/a.ts': 'export const a = 1;\n' });
    box.commit('первый');
    box.write(
      'knowledge/a.md',
      unit({
        id: 'a',
        title: 'Первая',
        anchors: 'anchors:\n  - path: src/a.ts\n    rev: d5f15e2-fix',
      }),
    );

    const verdict = box.source().check();
    assert.equal(verdict.ok, true);
    const found = verdict.problems.find((problem) => problem.kind === 'anchor-bad-rev');
    assert.ok(found !== undefined, JSON.stringify(verdict.problems));
    assert.equal(found.level, 'yellow');
    assert.match(found.detail, /src\/a\.ts/);
    assert.match(found.detail, /d5f15e2-fix/);
  });

  // Задача 3.3 / Сценарий: «Непохожая ревизия не выдаётся за устаревание»
  it('непохожая ревизия не даёт нарушения об устаревании', () => {
    const box = repo({ 'src/a.ts': 'export const a = 1;\n' });
    box.commit('первый');
    box.write('src/a.ts', 'export const a = 2;\n');
    box.commit('второй');
    box.write(
      'knowledge/a.md',
      unit({
        id: 'a',
        title: 'Первая',
        anchors: 'anchors:\n  - path: src/a.ts\n    rev: релиз-осень',
      }),
    );

    const verdict = box.source().check();
    const kinds = verdict.problems.map((problem) => problem.kind);
    assert.ok(kinds.includes('anchor-bad-rev'), JSON.stringify(verdict.problems));
    assert.ok(!kinds.includes('stale-anchor'), JSON.stringify(verdict.problems));
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
        // Кавычки — по той же причине, что в тестах устаревания.
        anchors: `anchors:\n  - path: src/a.ts\n    rev: '${head.slice(0, 7)}'`,
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
