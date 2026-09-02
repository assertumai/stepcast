import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { StepcastError } from '../src/core/errors.js';
import { readEvents } from '../src/core/journal/reader.js';
import { RunJournal } from '../src/core/journal/writer.js';
import { createScope } from '../src/core/run/scope.js';
import { makeJournalBed } from './helpers.js';

function journalWithEvents(): RunJournal {
  const bed = makeJournalBed();
  return RunJournal.create({ runsRoot: bed.runsRoot, projectRoot: bed.projectRoot });
}

describe('область ресурсов', () => {
  it('исполняет обратные операции в порядке, обратном регистрации', async () => {
    const order: string[] = [];
    const scope = createScope();

    scope.defer('A', () => {
      order.push('A');
    });
    scope.defer('B', () => {
      order.push('B');
    });
    scope.defer('C', () => {
      order.push('C');
    });

    await scope.dispose();

    assert.deepEqual(order, ['C', 'B', 'A']);
  });

  it('дожидается асинхронной операции до следующей', async () => {
    const order: string[] = [];
    const scope = createScope();

    scope.defer('первая', () => {
      order.push('первая');
    });
    scope.defer('вторая', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('вторая');
    });

    await scope.dispose();

    // Без ожидания «первая» легла бы раньше «второй».
    assert.deepEqual(order, ['вторая', 'первая']);
  });

  it('отказ одной операции не останавливает остальные и попадает в журнал', async () => {
    const journal = journalWithEvents();
    const done: string[] = [];
    const scope = createScope({ journal, job: 'implement', step: 'write' });

    scope.defer('снятие каталога черновиков', () => {
      done.push('черновики');
    });
    scope.defer('снятие индексного файла якоря', () => {
      throw new Error('файл занят');
    });
    scope.defer('снятие слушателя отмены', () => {
      done.push('слушатель');
    });

    await scope.dispose();

    assert.deepEqual(done, ['слушатель', 'черновики']);

    const failures = readEvents(journal.paths).filter((event) => event.kind === 'bookkeeping.failed');
    assert.equal(failures.length, 1);
    const failure = failures[0] as { operation: string; detail: string; job?: string; step?: string };
    assert.equal(failure.operation, 'снятие индексного файла якоря');
    assert.match(failure.detail, /файл занят/);
    assert.equal(failure.job, 'implement');
    assert.equal(failure.step, 'write');
  });

  it('отказ асинхронной операции учитывается так же, как синхронной', async () => {
    const journal = journalWithEvents();
    const scope = createScope({ journal });

    scope.defer('асинхронное снятие', async () => {
      await Promise.resolve();
      throw new Error('не вышло');
    });

    await scope.dispose();

    const failures = readEvents(journal.paths).filter((event) => event.kind === 'bookkeeping.failed');
    assert.equal(failures.length, 1);
    assert.equal((failures[0] as { operation: string }).operation, 'асинхронное снятие');
  });

  it('повторное снятие ничего не исполняет', async () => {
    let calls = 0;
    const scope = createScope();
    scope.defer('однократная', () => {
      calls += 1;
    });

    await scope.dispose();
    await scope.dispose();

    assert.equal(calls, 1);
  });

  it('регистрация после снятия — ошибка движка', async () => {
    const scope = createScope();
    await scope.dispose();

    assert.throws(
      () =>
        scope.defer('поздняя', () => {
          throw new Error('не должна исполниться');
        }),
      (error: unknown) => error instanceof StepcastError && /уже снятой области/.test((error as Error).message),
    );
  });

  it('отпускание очищает стек, ничего не исполняя', async () => {
    let calls = 0;
    const scope = createScope();
    scope.defer('снятие рабочего дерева', () => {
      calls += 1;
    });

    scope.release();
    await scope.dispose();

    assert.equal(calls, 0);
  });

  it('область без журнала пробрасывает исключение операции наружу', async () => {
    const scope = createScope();
    scope.defer('операция без права на отказ', () => {
      throw new Error('дефект');
    });

    await assert.rejects(() => scope.dispose(), /дефект/);
  });

  it('область без журнала не исполняет упавшую операцию повторно', async () => {
    let calls = 0;
    const scope = createScope();
    scope.defer('падающая', () => {
      calls += 1;
      throw new Error('дефект');
    });

    await assert.rejects(() => scope.dispose());
    // Операция снята со стека до вызова, поэтому повторное снятие её не
    // застаёт и завершается без исключения.
    await scope.dispose();

    assert.equal(calls, 1);
  });
});
