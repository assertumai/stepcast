import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { Context } from 'cordis';

import { DiffView, ProposalActions, Proposals, groupByRun } from '../src/pages/Proposals';
import { bindRouterKernel } from '../src/router';
import type { ProposalApiRecord, ProposalsOverview } from '../src/api';

/**
 * `TargetLink` (ссылка «прогон …») читает действующую таблицу маршрутов через
 * `bindRouterKernel` вне дерева React, тем же приёмом, что `decisions.test.tsx`.
 */
bindRouterKernel({ routes: { get: () => ({ table: [] }) } } as unknown as Context);

function record(overrides: Partial<ProposalApiRecord> = {}): ProposalApiRecord {
  return {
    id: '2026-09-12T17-15-26Z-widgets-clock',
    target: '.stepcast/widgets/clock.tsx',
    action: 'update',
    content: 'export default 1;\n',
    currentContent: 'export default 0;\n',
    origin: {},
    baseFingerprint: { mtimeMs: 1, size: 10 },
    state: 'pending',
    createdAt: '2026-09-12T17:15:26.000Z',
    ...overrides,
  };
}

function overviewWith(records: readonly ProposalApiRecord[], mode: 'queue' | 'direct' = 'queue'): ProposalsOverview {
  return { projects: [{ projectKey: 'proj', projectPath: '/home/me/proj', mode, records, invalid: [] }] };
}

describe('ui-proposals: группировка по прогону', () => {
  it('записи без прогона идут одной группой «вручную», с прогоном — по его id', () => {
    const groups = groupByRun([
      record({ id: 'a', origin: {} }),
      record({ id: 'b', origin: { run: 'run-1' } }),
      record({ id: 'c', origin: { run: 'run-1' } }),
      record({ id: 'd', origin: {} }),
    ]);
    assert.deepEqual(
      groups.map((g) => [g.runId, g.records.map((r) => r.id)]),
      [
        [undefined, ['a', 'd']],
        ['run-1', ['b', 'c']],
      ],
    );
  });

  it('пустой перечень даёт пустой перечень групп', () => {
    assert.deepEqual(groupByRun([]), []);
  });
});

describe('ui-proposals: диф', () => {
  it('правка в середине содержимого показана added/removed вокруг same', () => {
    const html = renderToStaticMarkup(<DiffView before={'a\nb\nc\n'} after={'a\nX\nc\n'} />);
    assert.match(html, /diff-removed/);
    assert.match(html, /diff-added/);
    assert.match(html, />b</);
    assert.match(html, />X</);
  });

  it('создание файла целиком — пустая база, все строки added', () => {
    const html = renderToStaticMarkup(<DiffView before={''} after={'a\nb\n'} />);
    assert.doesNotMatch(html, /diff-removed/);
    assert.match(html, /diff-added/);
  });
});

describe('ui-proposals: экран — статический рендер', () => {
  it('проект без записей не показывается — вместо перечня хэшей одно пустое состояние с объяснением', () => {
    const html = renderToStaticMarkup(<Proposals overview={overviewWith([])} navigate={() => {}} />);
    assert.match(html, /No proposals yet/);
    assert.doesNotMatch(html, />proj</);
  });

  it('проект подписан последним сегментом пути, полный путь рядом', () => {
    const html = renderToStaticMarkup(<Proposals overview={overviewWith([record()])} navigate={() => {}} />);
    assert.match(html, />proj</);
    assert.match(html, /\/home\/me\/proj/);
  });

  it('шапка объясняет, что это и как сюда попадают записи', () => {
    const html = renderToStaticMarkup(<Proposals overview={overviewWith([record()])} navigate={() => {}} />);
    assert.match(html, /stepcast propose/);
    assert.match(html, /Nothing is written until you accept/);
  });

  it('открытая запись показана дифом, причиной и обеими кнопками', () => {
    const overview = overviewWith([record({ reason: 'имя ушло из таблицы' })]);
    const html = renderToStaticMarkup(<Proposals overview={overview} navigate={() => {}} />);
    assert.match(html, /имя ушло из таблицы/);
    assert.match(html, />Accept</);
    assert.match(html, />Reject</);
    assert.match(html, /diff-line/);
  });

  it('решённая запись свёрнута — без дифа и без кнопок', () => {
    const overview = overviewWith([record({ state: 'accepted', decidedAt: '2026-09-12T18:00:00.000Z' })]);
    const html = renderToStaticMarkup(<Proposals overview={overview} navigate={() => {}} />);
    assert.doesNotMatch(html, />Accept</);
    assert.doesNotMatch(html, /diff-line/);
    assert.match(html, /Resolved \(1\)/);
    assert.match(html, />accepted</);
  });

  it('запись, поставленная вручную, идёт в группе «вручную»', () => {
    const overview = overviewWith([record({ origin: {} })]);
    const html = renderToStaticMarkup(<Proposals overview={overview} navigate={() => {}} />);
    assert.match(html, /proposed manually/);
  });

  it('запись прогона показана ссылкой прогона', () => {
    const overview = overviewWith([record({ origin: { run: 'a1b2' } })]);
    const html = renderToStaticMarkup(<Proposals overview={overview} navigate={() => {}} />);
    assert.match(html, /run a1b2/);
  });

  it('режим direct виден на экране', () => {
    const html = renderToStaticMarkup(<Proposals overview={overviewWith([record()], 'direct')} navigate={() => {}} />);
    assert.match(html, /direct write/);
  });

  it('режим queue назван queue', () => {
    const html = renderToStaticMarkup(<Proposals overview={overviewWith([record()], 'queue')} navigate={() => {}} />);
    assert.match(html, />queue</);
  });

  it('undefined вместо обзора — загрузка, не отказ', () => {
    const html = renderToStaticMarkup(<Proposals overview={undefined} navigate={() => {}} />);
    assert.match(html, /Loading/);
  });
});

describe('ui-proposals: отказ решения локален', () => {
  it('отказ показан на месте записи, без имитации клика', () => {
    const html = renderToStaticMarkup(
      <ProposalActions
        projectKey="proj"
        record={record()}
        onDecided={() => {}}
        initialError="файл изменился с момента предложения"
      />,
    );
    assert.match(html, /файл изменился с момента предложения/);
    assert.match(html, />Accept</);
    assert.match(html, />Reject</);
  });

  it('без отказа — ни одной полосы отказа', () => {
    const html = renderToStaticMarkup(<ProposalActions projectKey="proj" record={record()} onDecided={() => {}} />);
    assert.doesNotMatch(html, /sc-alert--destructive/);
  });
});
