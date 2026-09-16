import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BACKLOG_STATUSES } from '../src/parts/pipeline/domain/backlog/schema.js';
import {
  COLUMN_TITLES,
  DROPPABLE_COLUMNS,
  SCRUM_COLUMNS,
  columnOf,
  insertionBefore,
  viewBoard,
  type BoardItemLike,
} from '../src/parts/ui/scrumView.js';

/**
 * Раскладка доски: что в какой колонке лежит и куда встанет перетащенная
 * карточка. Экрана здесь нет — только правила, которые он рисует.
 */

function item(slug: string, status: string, sourceFile = 'backlog.md'): BoardItemLike {
  return { slug, status, sourceFile };
}

function project(key: string, items: readonly BoardItemLike[]) {
  return { projectKey: key, projectPath: `/p/${key}`, items, failures: [] as readonly string[] };
}

describe('scrumView: колонки', () => {
  it('каждое состояние формата попадает в какую-то колонку', () => {
    for (const status of BACKLOG_STATUSES) {
      const column = columnOf(item('x', status));
      assert.ok(SCRUM_COLUMNS.includes(column), `status=${status} без колонки`);
      assert.ok(COLUMN_TITLES[column], `колонка ${column} без названия`);
    }
  });

  it('failed показывается в колонке «Сделано»: отказ — исход, а не место в работе', () => {
    assert.equal(columnOf(item('x', 'failed')), 'done');
  });

  it('файл архива решает раньше статуса', () => {
    assert.equal(columnOf(item('x', 'todo', 'archived.md')), 'archive');
  });

  it('в работу доска не переносит: колонки in_progress среди принимающих нет', () => {
    assert.ok(!DROPPABLE_COLUMNS.includes('in_progress'));
    assert.deepEqual([...DROPPABLE_COLUMNS].sort(), ['archive', 'done', 'todo']);
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
