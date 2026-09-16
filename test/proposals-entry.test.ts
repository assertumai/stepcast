import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PROPOSAL_MAX_CONTENT_BYTES,
  ProposalError,
  buildProposalId,
  checkProposalContentSize,
  parseProposalTarget,
} from '../src/parts/pipeline/domain/proposals/entry.js';

describe('proposals/entry: разбор и проверка цели', () => {
  it('три законные цели разбираются на вид кабинета и id', () => {
    assert.deepEqual(parseProposalTarget('.stepcast/widgets/clock.tsx'), {
      kind: 'widget',
      segments: ['widgets', 'clock.tsx'],
      id: 'clock',
    });
    assert.deepEqual(parseProposalTarget('.stepcast/dashboards/release.yml'), {
      kind: 'dashboard',
      segments: ['dashboards', 'release.yml'],
      id: 'release',
    });
    assert.deepEqual(parseProposalTarget('.stepcast/plugins/board/plugin.json'), {
      kind: 'plugin',
      segments: ['plugins', 'board', 'plugin.json'],
      id: 'board',
    });
  });

  it('файл плагина на любой глубине остаётся законной целью', () => {
    const parsed = parseProposalTarget('.stepcast/plugins/board/src/widget.tsx');
    assert.equal(parsed.kind, 'plugin');
    assert.equal(parsed.id, 'board');
  });

  for (const target of ['.stepcast/config.yml', 'src/index.ts', '.stepcast/widgets/../../secret']) {
    it(`цель за пределами кабинета отказывает: ${target}`, () => {
      assert.throws(() => parseProposalTarget(target), ProposalError);
    });
  }

  it('чужое расширение виджета отказывает', () => {
    assert.throws(() => parseProposalTarget('.stepcast/widgets/clock.js'), ProposalError);
  });

  it('вложенный каталог виджетов отказывает', () => {
    assert.throws(() => parseProposalTarget('.stepcast/widgets/sub/clock.tsx'), ProposalError);
  });

  it('голый каталог плагина без файла внутри отказывает', () => {
    assert.throws(() => parseProposalTarget('.stepcast/plugins/board'), ProposalError);
  });
});

describe('proposals/entry: предел содержимого', () => {
  it('содержимое в пределах проходит', () => {
    checkProposalContentSize('x'.repeat(1000));
  });

  it('содержимое сверх предела отказывает, называя предел', () => {
    const oversized = 'x'.repeat(PROPOSAL_MAX_CONTENT_BYTES + 1);
    assert.throws(() => checkProposalContentSize(oversized), (error: unknown) => {
      assert.ok(error instanceof ProposalError);
      assert.match(error.message, new RegExp(String(PROPOSAL_MAX_CONTENT_BYTES)));
      assert.match(error.message, /256 КиБ/);
      return true;
    });
  });
});

describe('proposals/entry: идентификатор записи', () => {
  it('момент идёт первым, цель — сегментом без расширения', () => {
    const id = buildProposalId(new Date('2026-09-12T17:15:26.000Z'), '.stepcast/widgets/clock.tsx');
    assert.equal(id, '2026-09-12T17-15-26Z-widgets-clock');
  });

  it('сортировка id по постановке — сортировка по имени', () => {
    const first = buildProposalId(new Date('2026-09-12T17:15:26.000Z'), '.stepcast/widgets/clock.tsx');
    const second = buildProposalId(new Date('2026-09-12T17:15:27.000Z'), '.stepcast/widgets/clock.tsx');
    assert.ok(first < second);
  });

  it('id недопустимой цели отказывает той же причиной, что и разбор', () => {
    assert.throws(() => buildProposalId(new Date(), '.stepcast/config.yml'), ProposalError);
  });
});
