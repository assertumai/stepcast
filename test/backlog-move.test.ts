import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { moveBetween, moveWithin, withStatus } from '../src/core/backlog/index.js';
import { parse } from '../src/core/backlog/parse.js';

/**
 * Перенос пункта — текстовая правка очереди, которой доска витрины двигает
 * карточки. Проверяется то, чем перенос отличается от переписывания файла
 * целиком: порядок меняется, а всё, чего не касались, остаётся байт в байт.
 */

const PREAMBLE = '# Очередь\n\nВводный текст.\n\n';

function item(slug: string, status = 'todo'): string {
  return `## ${slug}\n\nstatus: ${status}\ntitle: т\nwhy: з\ndone_when: к\n`;
}

function bed(...items: readonly string[]): string {
  return PREAMBLE + items.join('\n');
}

function slugs(text: string): readonly string[] {
  return parse(text).map((entry) => entry.slug);
}

describe('backlog: перестановка пункта внутри файла', () => {
  it('поднимает пункт перед названным', () => {
    const text = bed(item('one'), item('two'), item('three'));
    assert.deepEqual(slugs(moveWithin(text, 'three', 'one', 'backlog.md')), ['three', 'one', 'two']);
  });

  it('без названного соседа уводит пункт в конец', () => {
    const text = bed(item('one'), item('two'), item('three'));
    assert.deepEqual(slugs(moveWithin(text, 'one', undefined, 'backlog.md')), ['two', 'three', 'one']);
  });

  it('перестановка перед самим собой ничего не меняет', () => {
    const text = bed(item('one'), item('two'));
    assert.equal(moveWithin(text, 'two', 'two', 'backlog.md'), text);
  });

  it('преамбула и поля соседей остаются как были', () => {
    const text = bed(item('one'), item('two'));
    const moved = moveWithin(text, 'two', 'one', 'backlog.md');
    assert.ok(moved.startsWith(PREAMBLE), 'преамбула не трогается');
    assert.match(moved, /## two\n\nstatus: todo\ntitle: т\nwhy: з\ndone_when: к/);
  });

  it('неизвестный слаг — отказ с именем файла', () => {
    const text = bed(item('one'));
    assert.throws(() => moveWithin(text, 'no-such', undefined, 'backlog.md'), /no-such/);
  });
});

describe('backlog: перенос пункта между файлами', () => {
  it('убирает пункт из источника и кладёт в конец получателя', () => {
    const from = bed(item('one'), item('two'));
    const to = bed(item('old'));

    const result = moveBetween(from, to, 'one', undefined, 'backlog.md', 'archived.md');

    assert.deepEqual(slugs(result.from), ['two']);
    assert.deepEqual(slugs(result.to), ['old', 'one']);
  });

  it('заводит получателя из пустоты: архива может ещё не быть', () => {
    const result = moveBetween(bed(item('one')), '', 'one', undefined, 'backlog.md', 'archived.md');

    assert.deepEqual(slugs(result.to), ['one']);
    assert.ok(!result.to.startsWith('\n'), 'ведущей пустой строки быть не должно');
    assert.deepEqual(slugs(result.from), []);
  });

  it('ставит пункт перед названным в получателе', () => {
    const result = moveBetween(bed(item('one')), bed(item('a'), item('b')), 'one', 'b', 'backlog.md', 'archived.md');
    assert.deepEqual(slugs(result.to), ['a', 'one', 'b']);
  });
});

describe('backlog: смена статуса пункта', () => {
  it('переписывает поле на месте, не трогая остальные', () => {
    const text = bed(item('one'), item('two'));
    const changed = withStatus(text, 'two', 'todo');

    const entries = parse(changed);
    assert.equal(entries.find((entry) => entry.slug === 'two')?.data.status, 'todo');
    assert.equal(entries.find((entry) => entry.slug === 'one')?.data.status, 'todo');
  });
});
