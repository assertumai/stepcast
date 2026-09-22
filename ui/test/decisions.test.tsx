import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { Context } from 'cordis';

import { canSubmit, restartCandidates, rows, Decisions } from '../src/pages/Decisions';
import { bindRouterKernel } from '../src/router';
import type { Overview, RunOverview, RunSnapshot } from '../src/api';

/**
 * `TargetLink` (внутри строки действий и внутри карточки шага) читает
 * действующую таблицу маршрутов через `bindRouterKernel` — вне дерева React,
 * тем же приёмом, что и `main.tsx` (`ui/src/router.tsx`). Статическому
 * рендеру нужен только `ctx.routes.get().table`; пустая таблица не мешает —
 * `TargetLink` без совпавшего маршрута всё равно рисует children, только
 * называет причину рядом (`ui/src/routeLink.tsx`).
 */
bindRouterKernel({ routes: { get: () => ({ table: [] }) } } as unknown as Context);

/**
 * Экран «Решения» (`user-decision-steps`, design.md решение 11).
 *
 * Правило допуска отправки формы (`canSubmit`), сбор таблицы из обзора
 * (`rows`) и выбор кандидатов перезапуска (`restartCandidates`) — чистые
 * функции, вынесенные из компонента ровно затем, чтобы их можно было
 * проверить без DOM и без имитации клика: у витрины нет инфраструктуры
 * интерактивных проверок (`fireEvent`/`act`) — только `renderToStaticMarkup`,
 * поэтому кнопки и формы проверяются статическим рендером первого состояния,
 * а поведение при вводе — этими чистыми функциями напрямую.
 */

function run(overrides: Partial<RunOverview> = {}): RunOverview {
  return {
    runId: 'run-1',
    shortId: 'run-1',
    pipeline: 'demo',
    status: 'running',
    running: true,
    abandoned: false,
    swept: false,
    filesGone: false,
    unreadable: false,
    ...overrides,
  };
}

function overviewWith(runs: readonly RunOverview[]): Overview {
  return { generatedAt: '2026-01-01T00:00:00.000Z', projects: [{ key: 'proj', runs }] };
}

const AWAITING = {
  wait_id: 'w1',
  job: 'apply',
  step: 'gate',
  outcomes: {
    approve: { effect: 'continue' as const },
    deny: { effect: 'reject' as const, label: 'Reject' },
    redo: { effect: 'restart' as const, label: 'Restart' },
  },
  prompt: 'merge into main?',
  since: '2026-01-01T00:00:00.000Z',
  deadline: '2026-01-02T00:00:00.000Z',
};

describe('user-decision-steps: экран «Решения» — сбор таблицы', () => {
  it('собирает по одной строке на каждое ожидание, по всем проектам и прогонам', () => {
    const overview: Overview = {
      generatedAt: '2026-01-01T00:00:00.000Z',
      projects: [
        { key: 'a', runs: [run({ runId: 'r1', awaiting: [AWAITING] })] },
        { key: 'b', runs: [run({ runId: 'r2' }), run({ runId: 'r3', awaiting: [AWAITING] })] },
      ],
    };

    const collected = rows(overview);
    assert.equal(collected.length, 2);
    assert.deepEqual(
      collected.map((row) => `${row.projectKey}/${row.run.runId}`),
      ['a/r1', 'b/r3'],
    );
  });

  it('прогон без ожиданий не даёт ни одной строки', () => {
    const collected = rows(overviewWith([run({ runId: 'plain' })]));
    assert.deepEqual(collected, []);
  });

  it('живое исчезновение записи: тот же обзор без awaiting даёт пустую таблицу', () => {
    // Страница подписана на живой обзор и перечитывает его на каждое
    // событие потока (`live.ts`) — `rows()` беспамятна и просто отвечает по
    // тому, что дано; смена входа между двумя вызовами и есть «исчезновение
    // записи по событию».
    const before = rows(overviewWith([run({ runId: 'r1', awaiting: [AWAITING] })]));
    const after = rows(overviewWith([run({ runId: 'r1' })]));
    assert.equal(before.length, 1);
    assert.equal(after.length, 0);
  });

  it('undefined вместо обзора — пустая таблица, а не отказ', () => {
    assert.deepEqual(rows(undefined), []);
  });
});

describe('user-decision-steps: экран «Решения» — допуск отправки формы', () => {
  it('пустая или пробельная строка не допускает отправку', () => {
    assert.equal(canSubmit(''), false);
    assert.equal(canSubmit('   '), false);
  });

  it('непустое значение допускает отправку', () => {
    assert.equal(canSubmit('не готово'), true);
    assert.equal(canSubmit('prep/build'), true);
  });
});

describe('user-decision-steps: экран «Решения» — кандидаты перезапуска', () => {
  function snapshot(): RunSnapshot {
    return {
      runId: 'run-1',
      projectKey: 'proj',
      pipeline: 'demo',
      swept: false,
      filesGone: false,
      graph: { nodes: [], edges: [], columns: 0 },
      jobs: [
        {
          id: 'prep',
          status: 'success',
          needs: [],
          on: 'success',
          context: [],
          inputs: [],
          outputDeclared: false,
          usage: { billableTokens: null, wallclockMs: null, costUsd: null },
          steps: [
            {
              id: 'build',
              kind: 'run',
              attemptModels: [],
              status: 'success',
              attempts: 1,
              context: [],
              files: [],
              usage: { billableTokens: null, wallclockMs: null, costUsd: null },
            },
          ],
        },
        {
          id: 'apply',
          status: 'running',
          needs: ['prep'],
          on: 'success',
          context: [],
          inputs: [],
          outputDeclared: false,
          usage: { billableTokens: null, wallclockMs: null, costUsd: null },
          steps: [
            {
              id: 'gate',
              kind: 'plugin',
              attemptModels: [],
              attempts: 0,
              context: [],
              files: [],
              usage: { billableTokens: null, wallclockMs: null, costUsd: null },
            },
          ],
        },
      ],
    };
  }

  it('предлагает только уже исполнившиеся шаги — ожидающий шаг без статуса исключён', () => {
    const candidates = restartCandidates(snapshot());
    assert.deepEqual(
      candidates.map((candidate) => candidate.address),
      ['prep/build'],
    );
  });

  it('пустой снимок (ещё не загружен) не даёт кандидатов', () => {
    assert.deepEqual(restartCandidates(undefined), []);
  });
});

describe('user-decision-steps: экран «Решения» — статический рендер', () => {
  it('таблица пуста — сообщение о том, что решений не ждут', () => {
    const html = renderToStaticMarkup(<Decisions overview={overviewWith([])} navigate={() => {}} />);
    assert.match(html, /waiting for a decision/);
  });

  it('кнопки строятся только по объявленным исходам, подписями из ожидания', () => {
    const overview = overviewWith([run({ runId: 'r1', awaiting: [AWAITING] })]);
    const html = renderToStaticMarkup(<Decisions overview={overview} navigate={() => {}} />);

    assert.match(html, />Reject</);
    assert.match(html, />Restart</);
    // continue без label — подписан именем исхода.
    assert.match(html, />approve</);
    assert.match(html, /merge into main\?/);
    assert.match(html, /apply\/gate/);
  });

  it('прогон с мёртвым процессом помечен и называет команду возобновления', () => {
    const overview = overviewWith([run({ runId: 'r1', abandoned: true, awaiting: [AWAITING] })]);
    const html = renderToStaticMarkup(<Decisions overview={overview} navigate={() => {}} />);

    assert.match(html, /process is not responding/);
    assert.match(html, /stepcast resume/);
    assert.match(html, /--from apply\/gate/);
  });
});

