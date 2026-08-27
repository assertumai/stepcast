import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { StepcastError } from '../src/core/errors.js';
import { parse, effectiveGroup, toRecord, isFree, selectItems, withFields } from '../src/core/backlog/index.js';
import type { BacklogEntry } from '../src/core/backlog/index.js';

/**
 * Ядро очереди не делает ввода-вывода, поэтому тест не заводит ни временных
 * каталогов, ни подпроцессов: фикстуры — обычные строки, проверки — прямые
 * вызовы `parse`/`selectItems`/`withFields`.
 */

function item(slug: string, fields: Readonly<Record<string, string>>): string {
  const body = Object.entries(fields)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');
  return `## ${slug}\n\n${body}\n`;
}

const COMPLETE = { status: 'pending', title: 'т', why: 'з', done_when: 'к' } as const;

function backlogText(...items: readonly string[]): string {
  return `# Очередь\n\nПреамбула: не разбирается.\n\n| ключ | значение |\n|---|---|\n\n${items.join('\n')}`;
}

function entryOf(entries: readonly BacklogEntry[], slug: string): BacklogEntry {
  const entry = entries.find((candidate) => candidate.slug === slug);
  assert.ok(entry !== undefined, `пункт «${slug}» не найден среди разобранных`);
  return entry;
}

describe('backlog: разбор', () => {
  it('разбирает пункты со всеми полями в порядке файла', () => {
    const entries = parse(backlogText(item('first-item', COMPLETE), item('second-item', { ...COMPLETE, title: 'вторая' })));

    assert.deepEqual(
      entries.map((entry) => entry.slug),
      ['first-item', 'second-item'],
    );
    assert.equal(entries[0]?.data.title, 'т');
    assert.equal(entries[1]?.data.title, 'вторая');
  });

  it('преамбула, в том числе с «ключ: значение» и таблицей, не разбирается', () => {
    const entries = parse(backlogText(item('only-item', COMPLETE)));

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.slug, 'only-item');
  });

  it('отказывает на строке, не разбираемой как «ключ: значение», называя её номер', () => {
    const text = `${backlogText(item('broken-item', COMPLETE))}просто текст без двоеточия\n`;
    // Номер считается от самого текста: сценарий спеки требует и слаг, и
    // строку, а строка, названная наугад, хуже неназванной.
    const line = text.split('\n').indexOf('просто текст без двоеточия') + 1;

    assert.throws(() => parse(text), (error: unknown) => {
      assert.ok(error instanceof StepcastError);
      assert.match(error.message, /broken-item/);
      assert.match(error.message, /ключ: значение/);
      assert.match(error.message, new RegExp(`строка ${line}\\b`));
      return true;
    });
  });

  it('пример пункта в огороженном блоке преамбулы пунктом не становится', () => {
    const text = [
      '# Очередь',
      '',
      'Формат пункта:',
      '',
      '```markdown',
      '## example-item',
      '',
      'status: pending',
      '```',
      '',
      item('real-item', COMPLETE),
    ].join('\n');

    assert.deepEqual(parse(text).map((entry) => entry.slug), ['real-item']);
  });

  it('отказывает на неизвестном статусе, называя перечень допустимых', () => {
    const text = backlogText(item('broken-item', { ...COMPLETE, status: 'постановлено' }));

    assert.throws(() => parse(text), (error: unknown) => {
      assert.ok(error instanceof StepcastError);
      assert.match(error.message, /broken-item/);
      assert.match(error.message, /постановлено/);
      assert.match(error.message, /pending/);
      return true;
    });
  });

  it('отказывает при отсутствии обязательного поля, называя его имя', () => {
    const text = backlogText(item('broken-item', { status: 'pending', title: 'т', why: 'з' }));

    assert.throws(() => parse(text), (error: unknown) => {
      assert.ok(error instanceof StepcastError);
      assert.match(error.message, /broken-item/);
      assert.match(error.message, /done_when/);
      return true;
    });
  });

  it('отказывает на заголовке, не являющемся слагом', () => {
    const text = backlogText(item('Формат записи', COMPLETE));

    assert.throws(() => parse(text), (error: unknown) => {
      assert.ok(error instanceof StepcastError);
      assert.match(error.message, /Формат записи/);
      assert.match(error.message, /kebab-case/);
      return true;
    });
  });

  it('отказывает на группе, не являющейся слагом', () => {
    const text = backlogText(item('some-item', { ...COMPLETE, group: 'Не Слаг' }));

    assert.throws(() => parse(text), (error: unknown) => {
      assert.ok(error instanceof StepcastError);
      assert.match(error.message, /some-item/);
      assert.match(error.message, /Не Слаг/);
      return true;
    });
  });

  it('отказывает на повторяющемся слаге', () => {
    const text = backlogText(item('same-item', COMPLETE), item('same-item', COMPLETE));

    assert.throws(() => parse(text), (error: unknown) => {
      assert.ok(error instanceof StepcastError);
      assert.match(error.message, /same-item/);
      assert.match(error.message, /дважды/);
      return true;
    });
  });

  it('действующая группа — объявленный group либо слаг пункта', () => {
    const entries = parse(
      backlogText(item('with-group', { ...COMPLETE, group: 'queue' }), item('without-group', COMPLETE)),
    );

    assert.equal(effectiveGroup(entryOf(entries, 'with-group')), 'queue');
    assert.equal(effectiveGroup(entryOf(entries, 'without-group')), 'without-group');
  });

  it('toRecord несёт слаг, title, why, done_when и действующую группу', () => {
    const entries = parse(backlogText(item('an-item', { ...COMPLETE, group: 'queue' })));

    assert.deepEqual(toRecord(entryOf(entries, 'an-item')), {
      slug: 'an-item',
      title: 'т',
      why: 'з',
      done_when: 'к',
      group: 'queue',
    });
  });
});

describe('backlog: свобода пункта', () => {
  const NOW = Date.parse('2026-08-23T12:00:00.000Z');
  const STALE_MS = 6 * 3600_000;

  function freeOf(status: string, fields: Readonly<Record<string, string>> = {}): boolean {
    const entries = parse(backlogText(item('some-item', { ...COMPLETE, status, ...fields })));
    return isFree(entryOf(entries, 'some-item'), NOW, STALE_MS);
  }

  it('pending свободен', () => {
    assert.equal(freeOf('pending'), true);
  });

  it('свежий in_progress занят', () => {
    assert.equal(freeOf('in_progress', { started_at: '2026-08-23T11:00:00.000Z' }), false);
  });

  it('зависший in_progress снова свободен', () => {
    assert.equal(freeOf('in_progress', { started_at: '2026-08-23T05:00:00.000Z' }), true);
  });

  it('in_progress без started_at свободен', () => {
    assert.equal(freeOf('in_progress'), true);
  });

  it('in_progress с неразбираемым started_at свободен', () => {
    assert.equal(freeOf('in_progress', { started_at: 'не дата' }), true);
  });

  it('done и failed не свободны независимо от started_at', () => {
    for (const status of ['done', 'failed']) {
      assert.equal(freeOf(status, { started_at: '2026-08-23T05:00:00.000Z' }), false, `status=${status}`);
      assert.equal(freeOf(status), false, `status=${status} без started_at`);
    }
  });
});

describe('backlog: отбор по действующим группам', () => {
  const NOW = Date.parse('2026-08-23T12:00:00.000Z');
  const STALE_MS = 6 * 3600_000;

  function select(text: string, slots: number): readonly BacklogEntry[] {
    return selectItems(parse(text), slots, NOW, STALE_MS);
  }

  it('пункт без группы образует свою и отбирается', () => {
    const chosen = select(backlogText(item('lonely-item', COMPLETE)), 1);
    assert.deepEqual(chosen.map((entry) => entry.slug), ['lonely-item']);
  });

  it('занятая группа не выдаётся: свободный пункт той же группы ниже пропускается', () => {
    const text = backlogText(
      item('busy-in-queue', {
        ...COMPLETE,
        status: 'in_progress',
        started_at: '2026-08-23T11:50:00.000Z',
        group: 'queue',
      }),
      item('free-in-queue', { ...COMPLETE, group: 'queue' }),
      item('other', COMPLETE),
    );

    const chosen = select(text, 2);
    assert.deepEqual(chosen.map((entry) => entry.slug), ['other']);
  });

  it('занятый пункт ниже места отбора всё равно запирает свою группу', () => {
    const text = backlogText(
      item('free-in-queue', { ...COMPLETE, group: 'queue' }),
      item('busy-in-queue', {
        ...COMPLETE,
        status: 'in_progress',
        started_at: '2026-08-23T11:50:00.000Z',
        group: 'queue',
      }),
      item('other', COMPLETE),
    );

    const chosen = select(text, 2);
    assert.deepEqual(chosen.map((entry) => entry.slug), ['other']);
  });

  it('два свободных пункта одной группы за проход: берётся только верхний, второй — из другой группы', () => {
    const text = backlogText(
      item('queue-a', { ...COMPLETE, group: 'queue' }),
      item('queue-b', { ...COMPLETE, group: 'queue' }),
      item('other', COMPLETE),
    );

    const chosen = select(text, 2);
    assert.deepEqual(chosen.map((entry) => entry.slug), ['queue-a', 'other']);
  });

  it('завершённый пункт группу не запирает', () => {
    for (const status of ['done', 'failed']) {
      const text = backlogText(
        item('finished', { ...COMPLETE, status, ...(status === 'failed' ? { reason: 'п' } : {}), group: 'queue' }),
        item('free-in-queue', { ...COMPLETE, group: 'queue' }),
      );

      const chosen = select(text, 1);
      assert.deepEqual(chosen.map((entry) => entry.slug), ['free-in-queue'], `status=${status}`);
    }
  });

  it('свободных пунктов меньше запрошенного — не отказ, а частичная выдача', () => {
    const text = backlogText(item('only-free', { ...COMPLETE, group: 'a' }), item('done-item', { ...COMPLETE, status: 'done' }));

    const chosen = select(text, 2);
    assert.deepEqual(chosen.map((entry) => entry.slug), ['only-free']);
  });

  it('порядок в файле — единственный приоритет: свободных пунктов нет', () => {
    const text = backlogText(item('done-item', { ...COMPLETE, status: 'done' }));
    assert.deepEqual(select(text, 3), []);
  });
});

describe('backlog: правка полей', () => {
  it('переписывает существующее поле на месте, не меняя число строк пункта', () => {
    const before = backlogText(item('some-item', COMPLETE));
    const linesBefore = before.split('\n').length;

    const after = withFields(before, 'some-item', { status: 'in_progress' });

    assert.equal(after.split('\n').length, linesBefore);
    assert.equal(entryOf(parse(after), 'some-item').data.status, 'in_progress');
  });

  it('дописывает новое поле сразу за последним полем пункта', () => {
    const before = backlogText(item('some-item', COMPLETE));
    const after = withFields(before, 'some-item', { started_at: '2026-08-23T12:00:00.000Z' });

    const entry = entryOf(parse(after), 'some-item');
    assert.equal(entry.data.started_at, '2026-08-23T12:00:00.000Z');
    assert.equal(entry.fields.get('started_at')?.line, entry.fields.get('done_when')!.line + 1);
  });

  it('неизвестное поле переживает правку', () => {
    const before = backlogText(item('some-item', { ...COMPLETE, custom_field: 'значение' }));
    const after = withFields(before, 'some-item', { status: 'done' });

    assert.match(after, /custom_field: значение/);
    assert.equal(entryOf(parse(after), 'some-item').data.status, 'done');
  });

  it('соседние пункты и преамбула остаются посимвольно неизменными', () => {
    const before = backlogText(item('alpha', COMPLETE), item('beta', { ...COMPLETE, group: 'g' }), item('gamma', COMPLETE));
    const after = withFields(before, 'beta', { status: 'done' });

    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');
    const betaEntry = entryOf(parse(before), 'beta');
    const betaAfterEntry = entryOf(parse(after), 'beta');

    for (let index = 0; index < beforeLines.length; index += 1) {
      const insideBeta = index >= betaEntry.headingLine && index <= betaAfterEntry.lastFieldLine;
      if (insideBeta) continue;
      assert.equal(afterLines[index], beforeLines[index], `строка ${index} изменилась вне правки`);
    }
  });

  it('отказывает на значении с переводом строки: поле очереди однострочно', () => {
    const before = backlogText(item('some-item', COMPLETE));

    for (const value of ['первая\nвторая', 'первая\r\nвторая']) {
      assert.throws(() => withFields(before, 'some-item', { reason: value }), (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /reason/);
        assert.match(error.message, /одну строку/);
        return true;
      });
    }
  });

  it('отказывает на отсутствующем слаге', () => {
    const before = backlogText(item('some-item', COMPLETE));
    assert.throws(() => withFields(before, 'missing-item', { status: 'done' }), (error: unknown) => {
      assert.ok(error instanceof StepcastError);
      assert.match(error.message, /missing-item/);
      return true;
    });
  });
});

describe('backlog: очередь этого репозитория', () => {
  it('backlog.md разбирается движком как есть, без единого отказа схемы', () => {
    const path = fileURLToPath(new URL('../../backlog.md', import.meta.url));
    const text = readFileSync(path, 'utf8');

    const entries = parse(text);
    assert.ok(entries.length > 0);
  });
});
