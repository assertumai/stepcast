import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BACKLOG_STATUSES as SCHEMA_STATUSES } from '../src/core/backlog/schema.js';
import {
  viewBacklog,
  BACKLOG_STATUSES,
  DEFAULT_ORDER,
  EMPTY_BACKLOG_FILTERS,
  type BacklogFilters,
  type BacklogItemLike,
  type BacklogSectionLike,
} from '../src/ui/backlogView.js';

function item(slug: string, status: BacklogItemLike['status'] = 'pending'): BacklogItemLike {
  return { slug, status };
}

function section(
  projectKey: string,
  items: readonly BacklogItemLike[],
  overrides: Partial<BacklogSectionLike<BacklogItemLike>> = {},
): BacklogSectionLike<BacklogItemLike> {
  return { projectKey, projectPath: `/repo/${projectKey}`, items, ...overrides };
}

describe('backlogView: нумерация', () => {
  it('номер — место в файле, считая с единицы и по всем пунктам, включая done', () => {
    const sections = [section('p1', [item('a', 'done'), item('b', 'pending'), item('c', 'done')])];
    const view = viewBacklog(sections, EMPTY_BACKLOG_FILTERS);
    assert.deepEqual(
      view.sections[0]?.items.map((entry) => [entry.item.slug, entry.planNumber]),
      [['a', 1], ['b', 2], ['c', 3]],
    );
  });

  it('отбор сохраняет пропуски номеров, а не сжимает их в 1, 2, 3', () => {
    const sections = [
      section('p1', [item('a', 'done'), item('b', 'pending'), item('c', 'done'), item('d', 'pending')]),
    ];
    const view = viewBacklog(sections, { status: 'pending' });
    assert.deepEqual(
      view.sections[0]?.items.map((entry) => [entry.item.slug, entry.planNumber]),
      [['b', 2], ['d', 4]],
    );
  });

  it('обратный порядок не перенумеровывает пункты', () => {
    const sections = [section('p1', [item('a'), item('b'), item('c')])];
    const view = viewBacklog(sections, EMPTY_BACKLOG_FILTERS, 'desc');
    assert.deepEqual(
      view.sections[0]?.items.map((entry) => [entry.item.slug, entry.planNumber]),
      [['c', 3], ['b', 2], ['a', 1]],
    );
  });

  it('нумерация второго проекта начинается заново', () => {
    const sections = [section('p1', [item('a'), item('b')]), section('p2', [item('x'), item('y'), item('z')])];
    const view = viewBacklog(sections, EMPTY_BACKLOG_FILTERS);
    assert.deepEqual(
      view.sections.map((s) => s.items.map((entry) => entry.planNumber)),
      [[1, 2], [1, 2, 3]],
    );
  });

  it('пункты из двух файлов очереди, объединённые в один список, фильтруются и нумеруются как один', () => {
    // Модуль вида не знает о `backlog.md`/`resolved.md` — `sourceFile` для него
    // всего лишь ещё одно поле пункта, и на отбор с нумерацией не влияет.
    interface ItemWithSource extends BacklogItemLike {
      readonly sourceFile: string;
    }
    const merged: readonly ItemWithSource[] = [
      { slug: 'a', status: 'pending', sourceFile: 'backlog.md' },
      { slug: 'b', status: 'done', sourceFile: 'backlog.md' },
      { slug: 'c', status: 'pending', sourceFile: 'resolved.md' },
    ];
    const sections: readonly BacklogSectionLike<ItemWithSource>[] = [
      { projectKey: 'p1', projectPath: '/repo/p1', items: merged },
    ];
    const view = viewBacklog(sections, { status: 'pending' });
    assert.deepEqual(
      view.sections[0]?.items.map((entry) => [entry.item.slug, entry.item.sourceFile, entry.planNumber]),
      [['a', 'backlog.md', 1], ['c', 'resolved.md', 3]],
      'план-номер продолжает нумеровать оба файла как один список, sourceFile переживает отбор',
    );
  });
});

describe('backlogView: перечень статусов', () => {
  it('перечень витрины совпадает со схемой очереди', () => {
    // Модуль вида собирается в браузер и потому держит свою копию перечня
    // (`node:path` схемы туда не пустить). Сверка здесь — единственное, что не
    // даёт копиям разойтись: новый статус формата обязан уронить этот тест, а
    // не выпасть молча из меню фильтра и из подсчёта.
    assert.deepEqual([...BACKLOG_STATUSES], [...SCHEMA_STATUSES]);
  });
});

describe('backlogView: фильтры', () => {
  it('статус и проект объединяются по «и»', () => {
    const sections = [
      section('p1', [item('a', 'pending'), item('b', 'done')]),
      section('p2', [item('c', 'pending')]),
    ];
    const filters: BacklogFilters = { project: 'p1', status: 'pending' };
    const view = viewBacklog(sections, filters);
    assert.deepEqual(
      view.sections.map((s) => s.items.map((entry) => entry.item.slug)),
      [['a']],
    );
  });

  it('все четыре статуса присутствуют всегда, пустой — нулём', () => {
    const sections = [section('p1', [item('a', 'pending'), item('b', 'done')])];
    const view = viewBacklog(sections, EMPTY_BACKLOG_FILTERS);
    assert.deepEqual(
      view.statusCounts,
      [
        { status: 'pending', count: 1 },
        { status: 'in_progress', count: 0 },
        { status: 'done', count: 1 },
        { status: 'failed', count: 0 },
      ],
    );
  });

  it('число у статуса считается по выбранному проекту', () => {
    const sections = [
      section('p1', [item('a', 'pending'), item('b', 'pending')]),
      section('p2', [item('c', 'pending'), item('d', 'pending'), item('e', 'pending'), item('f', 'pending'), item('g', 'pending')]),
    ];
    const view = viewBacklog(sections, { project: 'p1' });
    const pending = view.statusCounts.find((entry) => entry.status === 'pending');
    assert.equal(pending?.count, 2);
  });

  it('выбранный проект, ушедший из очереди, даёт пустой список, а не другую линзу', () => {
    const sections = [section('p1', [item('a')])];
    const view = viewBacklog(sections, { project: 'ушедший-проект' });
    assert.deepEqual(view.sections, []);
    assert.equal(view.projectOptions.some((option) => option.value === 'ушедший-проект'), true);
  });
});

describe('backlogView: порядок', () => {
  it('умолчание равно порядку файла', () => {
    assert.equal(DEFAULT_ORDER, 'asc');
    const sections = [section('p1', [item('a'), item('b')])];
    const view = viewBacklog(sections, EMPTY_BACKLOG_FILTERS);
    assert.deepEqual(view.sections[0]?.items.map((entry) => entry.item.slug), ['a', 'b']);
  });

  it('обратное направление переворачивает раздел, не меняя состав', () => {
    const sections = [section('p1', [item('a'), item('b'), item('c')])];
    const forward = viewBacklog(sections, EMPTY_BACKLOG_FILTERS, 'asc');
    const backward = viewBacklog(sections, EMPTY_BACKLOG_FILTERS, 'desc');
    assert.deepEqual(backward.sections[0]?.items.map((entry) => entry.item.slug).sort(), [
      ...(forward.sections[0]?.items.map((entry) => entry.item.slug) ?? []),
    ].sort());
    assert.deepEqual(backward.sections[0]?.items.map((entry) => entry.item.slug), ['c', 'b', 'a']);
  });

  it('пункты двух проектов не перемешиваются', () => {
    const sections = [section('p1', [item('a'), item('b')]), section('p2', [item('x'), item('y')])];
    const view = viewBacklog(sections, EMPTY_BACKLOG_FILTERS, 'desc');
    assert.deepEqual(view.sections[0]?.items.map((entry) => entry.item.slug), ['b', 'a']);
    assert.deepEqual(view.sections[1]?.items.map((entry) => entry.item.slug), ['y', 'x']);
  });
});

describe('backlogView: видимость разделов', () => {
  it('раздел с отказом разбора виден при выбранном статусе', () => {
    const sections = [section('p1', [], { failures: [{ error: 'не распознан' }] })];
    const view = viewBacklog(sections, { status: 'pending' });
    assert.equal(view.sections.length, 1);
    assert.deepEqual(view.sections[0]?.failures, [{ error: 'не распознан' }]);
  });

  it('раздел с отказом одного файла несёт пункты другого, прошедшие фильтр по статусу', () => {
    const sections = [section('p1', [item('a', 'pending'), item('b', 'done')], { failures: [{ error: 'не распознан' }] })];
    const view = viewBacklog(sections, { status: 'pending' });
    assert.equal(view.sections.length, 1);
    assert.deepEqual(view.sections[0]?.failures, [{ error: 'не распознан' }]);
    assert.deepEqual(view.sections[0]?.items.map((entry) => entry.item.slug), ['a']);
  });

  it('отбор по чужому проекту скрывает сломанный раздел', () => {
    const sections = [section('p1', [], { failures: [{ error: 'не распознан' }] }), section('p2', [item('a')])];
    const view = viewBacklog(sections, { project: 'p2' });
    assert.equal(view.sections.some((s) => s.failures.length > 0), false);
  });

  it('раздел, где ни один пункт не прошёл статус, скрыт, а прошедшие разделы остаются', () => {
    const sections = [section('p1', [item('a', 'pending')]), section('p2', [item('b', 'done')])];
    const view = viewBacklog(sections, { status: 'done' });
    assert.deepEqual(
      view.sections.map((s) => s.projectKey),
      ['p2'],
    );
  });

  it('пустой файл виден в умолчании статуса и скрыт при суженном', () => {
    const sections = [section('p1', [])];
    const atDefault = viewBacklog(sections, EMPTY_BACKLOG_FILTERS);
    assert.equal(atDefault.sections.length, 1);
    assert.deepEqual(atDefault.sections[0]?.failures, []);

    const narrowed = viewBacklog(sections, { status: 'pending' });
    assert.deepEqual(narrowed.sections, []);
  });
});

describe('backlogView: «показано N из M»', () => {
  it('total считает все пункты, shown — прошедшие фильтр', () => {
    const sections = [section('p1', [item('a', 'pending'), item('b', 'done')]), section('p2', [item('c', 'done')])];
    const view = viewBacklog(sections, { status: 'pending' });
    assert.equal(view.total, 3);
    assert.equal(view.shown, 1);
  });

  it('total считает и пункты очередей, отсечённых фильтром по проекту', () => {
    // Пара чисел отвечает на вопрос «сколько очереди сейчас не видно», и
    // фильтр по проекту прячет пункты наравне с фильтром по статусу; числа у
    // значений статуса считаются иначе — по остальным действующим фильтрам.
    const sections = [
      section('p1', [item('a', 'pending'), item('b', 'done')]),
      section('p2', [item('c', 'pending'), item('d', 'pending')]),
    ];
    const view = viewBacklog(sections, { project: 'p1' });
    assert.equal(view.total, 4);
    assert.equal(view.shown, 2);
    assert.equal(view.statusCounts.find((entry) => entry.status === 'pending')?.count, 1);
  });
});
