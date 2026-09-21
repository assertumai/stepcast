import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BACKLOG_STATUSES, BACKLOG_STATUS_PATTERN } from '../src/parts/pipeline/domain/backlog/schema.js';
import {
  COLUMN_TITLES,
  DEFAULT_BOARD_COLUMNS,
  SCRUM_COLUMNS,
  STATUS_PATTERN,
  columnOf,
  columnsProblem,
  insertionBefore,
  isDroppable,
  viewBoard,
  withColumn,
  type BoardColumnSpec,
  type BoardItemLike,
} from '../src/parts/ui/scrumView.js';

/**
 * Раскладка доски: что в какой колонке лежит и куда встанет перетащенная
 * карточка. Экрана здесь нет — только правила, которые он рисует.
 */

function item(slug: string, status: string, sourceFile = 'backlog.md'): BoardItemLike {
  return { slug, status, sourceFile };
}

function project(key: string, items: readonly BoardItemLike[], columns?: readonly BoardColumnSpec[]) {
  return {
    projectKey: key,
    projectPath: `/p/${key}`,
    items,
    failures: [] as readonly string[],
    ...(columns === undefined ? {} : { columns }),
  };
}

describe('scrumView: колонки', () => {
  it('каждое состояние формата попадает в какую-то колонку', () => {
    for (const status of BACKLOG_STATUSES) {
      const column = columnOf(item('x', status));
      assert.ok(column !== undefined && (SCRUM_COLUMNS as readonly string[]).includes(column), `status=${status} без колонки`);
      assert.ok(COLUMN_TITLES[column as (typeof SCRUM_COLUMNS)[number]], `колонка ${column} без названия`);
    }
  });

  it('failed показывается в колонке «Сделано»: отказ — исход, а не место в работе', () => {
    assert.equal(columnOf(item('x', 'failed')), 'done');
  });

  it('файл архива решает раньше статуса', () => {
    assert.equal(columnOf(item('x', 'todo', 'archived.md')), 'archive');
  });

  it('в работу доска не переносит: колонка in_progress не принимает, прочие принимают', () => {
    assert.equal(isDroppable('in_progress'), false);
    for (const id of ['todo', 'done', 'archive', 'postponed']) assert.equal(isDroppable(id), true, id);
  });

  it('незнакомый статус без своей колонки не подкладывается в чужую', () => {
    assert.equal(columnOf(item('x', 'postponed')), undefined);
  });

  it('статус со своей колонкой лежит в ней; failed со своей — не в done', () => {
    assert.equal(columnOf(item('x', 'postponed'), ['todo', 'postponed', 'done', 'archive']), 'postponed');
    assert.equal(columnOf(item('x', 'failed'), ['todo', 'done', 'failed', 'archive']), 'failed');
  });

  it('статус archive в backlog.md колонкой архива не считается: архив — файл', () => {
    assert.equal(columnOf(item('x', 'archive')), undefined);
  });

  it('форма статуса совпадает со схемой очереди', () => {
    assert.equal(STATUS_PATTERN.source, BACKLOG_STATUS_PATTERN.source);
  });
});

describe('scrumView: доска проекта', () => {
  const projects = [
    project('p1', [
      item('a', 'todo'),
      item('b', 'todo'),
      item('c', 'in_progress'),
      item('d', 'done'),
      item('old', 'done', 'archived.md'),
    ]),
    project('p2', [item('z', 'todo')]),
  ];

  it('показывает первый проект, когда не выбрано ничего', () => {
    const view = viewBoard(projects, undefined);
    assert.equal(view.projectKey, 'p1');
    assert.deepEqual(
      view.columns.map((column) => column.items.map((entry) => entry.slug)),
      [['a', 'b'], ['c'], ['d'], ['old']],
    );
  });

  it('показывает выбранный проект', () => {
    assert.equal(viewBoard(projects, 'p2').projectKey, 'p2');
  });

  it('выбранный проект не исчезает из меню, когда его очередь пропала из кадра', () => {
    const view = viewBoard(projects, 'gone');
    assert.ok(view.projectOptions.some((option) => option.value === 'gone'));
  });

  it('пустой состав проектов не роняет вид', () => {
    const view = viewBoard([], undefined);
    assert.equal(view.projectKey, '');
    assert.deepEqual(view.columns.map((column) => column.items.length), [0, 0, 0, 0]);
  });

  it('порядок файлов даётся отдельно и по файлам', () => {
    const view = viewBoard(projects, 'p1');
    assert.deepEqual(view.tasksOrder, ['a', 'b', 'c', 'd']);
    assert.deepEqual(view.archiveOrder, ['old']);
  });
});

describe('scrumView: колонки проекта', () => {
  const columns: readonly BoardColumnSpec[] = [
    { id: 'todo' },
    { id: 'postponed', title: 'Отложено' },
    { id: 'in_progress' },
    { id: 'done' },
    { id: 'archive' },
  ];

  it('пункты статуса без колонки собираются отдельно, по статусу, в порядке файла', () => {
    const view = viewBoard(
      [project('p', [item('a', 'todo'), item('b', 'postponed'), item('c', 'review'), item('d', 'postponed')])],
      undefined,
    );
    assert.deepEqual(
      view.unplaced.map((entry) => [entry.status, entry.items.map((it) => it.slug)]),
      [
        ['postponed', ['b', 'd']],
        ['review', ['c']],
      ],
    );
    assert.deepEqual(view.columns.map((column) => column.id), [...SCRUM_COLUMNS]);
  });

  it('заведённая колонка встаёт на своё место и забирает свои пункты', () => {
    const view = viewBoard([project('p', [item('a', 'todo'), item('b', 'postponed')], columns)], undefined);
    assert.deepEqual(view.columns.map((column) => column.id), ['todo', 'postponed', 'in_progress', 'done', 'archive']);
    assert.equal(view.columns[1]?.title, 'Отложено');
    assert.deepEqual(view.columns[1]?.items.map((it) => it.slug), ['b']);
    assert.deepEqual(view.unplaced, []);
  });

  it('withColumn вставляет колонку на названное место', () => {
    const next = withColumn(DEFAULT_BOARD_COLUMNS, { id: 'postponed' }, 1);
    assert.ok(typeof next !== 'string');
    assert.deepEqual(next.map((column) => column.id), ['todo', 'postponed', 'in_progress', 'done', 'archive']);
  });

  it('withColumn отказывает на повторе, на archive, на чужой форме и на месте вне доски', () => {
    assert.equal(typeof withColumn(DEFAULT_BOARD_COLUMNS, { id: 'todo' }, 0), 'string');
    assert.equal(typeof withColumn(DEFAULT_BOARD_COLUMNS, { id: 'archive' }, 0), 'string');
    assert.equal(typeof withColumn(DEFAULT_BOARD_COLUMNS, { id: 'Отложено' }, 0), 'string');
    assert.equal(typeof withColumn(DEFAULT_BOARD_COLUMNS, { id: 'later' }, 5), 'string');
  });

  it('раскладка без встроенной колонки негодна', () => {
    assert.match(columnsProblem([{ id: 'todo' }, { id: 'done' }, { id: 'archive' }]) ?? '', /in_progress/);
    assert.equal(columnsProblem(DEFAULT_BOARD_COLUMNS), undefined);
  });
});

describe('scrumView: место вставки при переносе', () => {
  const fileOrder = ['a', 'b', 'c', 'd'];

  it('внутри колонки — сосед, стоящий на этом месте', () => {
    assert.equal(insertionBefore(fileOrder, ['a', 'b'], 1), 'b');
  });

  it('в конец колонки — перед тем, что идёт в файле следом', () => {
    assert.equal(insertionBefore(fileOrder, ['a', 'b'], 2), 'c');
  });

  it('в конец последней колонки — в конец файла', () => {
    assert.equal(insertionBefore(fileOrder, ['c', 'd'], 2), undefined);
  });

  it('пустая колонка — в конец файла', () => {
    assert.equal(insertionBefore(fileOrder, [], 0), undefined);
  });
});
