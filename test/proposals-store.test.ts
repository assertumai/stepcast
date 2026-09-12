import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { StepcastError } from '../src/core/errors.js';
import {
  acceptProposal,
  findProposal,
  proposalsDirPath,
  proposeEntry,
  readProposalsDir,
  rejectProposal,
  writeProposalTargetDirect,
} from '../src/core/proposals/store.js';
import { tempDir } from './tmp.js';

function project(): string {
  const dir = tempDir('proposals-store-');
  mkdirSync(join(dir, '.stepcast'), { recursive: true });
  return dir;
}

describe('proposals/store: чтение каталога очереди', () => {
  it('отсутствие каталога — пустой перечень, не отказ', () => {
    const result = readProposalsDir(project());
    assert.deepEqual(result.records, []);
    assert.deepEqual(result.invalid, []);
  });

  it('запись читается после постановки', () => {
    const dir = project();
    proposeEntry(dir, { target: '.stepcast/widgets/clock.tsx', content: 'export default 1;\n' });
    const result = readProposalsDir(dir);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0]?.target, '.stepcast/widgets/clock.tsx');
    assert.equal(result.records[0]?.state, 'pending');
  });

  it('негодная запись не стирается и не гасит чтение остальных', () => {
    const dir = project();
    proposeEntry(dir, { target: '.stepcast/widgets/clock.tsx', content: 'a' });
    mkdirSync(proposalsDirPath(dir), { recursive: true });
    writeFileSync(join(proposalsDirPath(dir), 'broken.json'), '{not json');
    const result = readProposalsDir(dir);
    assert.equal(result.records.length, 1);
    assert.equal(result.invalid.length, 1);
    assert.equal(result.invalid[0]?.file, 'broken.json');
    assert.ok(existsSync(join(proposalsDirPath(dir), 'broken.json')));
  });
});

describe('proposals/store: постановка', () => {
  it('постановка новой цели — pending, действие create, отпечатка нет', () => {
    const dir = project();
    const record = proposeEntry(dir, { target: '.stepcast/dashboards/release.yml', content: 'title: x\n' });
    assert.equal(record.action, 'create');
    assert.equal(record.baseFingerprint, null);
    assert.equal(record.state, 'pending');
  });

  it('постановка правки существующего файла — действие update, несёт отпечаток', () => {
    const dir = project();
    mkdirSync(join(dir, '.stepcast', 'widgets'), { recursive: true });
    writeFileSync(join(dir, '.stepcast', 'widgets', 'clock.tsx'), 'export default 0;\n');
    const record = proposeEntry(dir, { target: '.stepcast/widgets/clock.tsx', content: 'export default 1;\n' });
    assert.equal(record.action, 'update');
    assert.notEqual(record.baseFingerprint, null);
  });

  it('недопустимая цель отказывает и не создаёт файл очереди', () => {
    const dir = project();
    assert.throws(() => proposeEntry(dir, { target: '.stepcast/config.yml', content: 'x' }), StepcastError);
    assert.equal(existsSync(proposalsDirPath(dir)), false);
  });

  /**
   * Цель, которую `parseProposalTarget` отклоняет ещё по форме, до реального
   * пути не доходит вовсе — и ветвь сравнения реальных путей ей не проверить.
   * Достижимый выход по ссылке — каталог плагина, сделанный ссылкой наружу:
   * форма цели законна (файл внутри `.stepcast/plugins/<id>/` на любой
   * глубине), а реальный путь ведёт за кабинет (`ui-proposals`, «Выход по
   * символической ссылке»).
   */
  it('каталог плагина, подменённый ссылкой наружу, отказывает; файл вне кабинета не тронут', () => {
    const dir = project();
    const outside = tempDir('proposals-outside-');
    writeFileSync(join(outside, 'plugin.json'), 'secret');
    mkdirSync(join(dir, '.stepcast', 'plugins'), { recursive: true });
    symlinkSync(outside, join(dir, '.stepcast', 'plugins', 'escape'));

    assert.throws(
      () => proposeEntry(dir, { target: '.stepcast/plugins/escape/plugin.json', content: 'x' }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /за пределы кабинета/);
        return true;
      },
    );
    assert.equal(readFileSync(join(outside, 'plugin.json'), 'utf8'), 'secret');
    assert.equal(existsSync(proposalsDirPath(dir)), false);
  });

  /** Тот же выход, но ссылкой подменён сам каталог виджетов — форма цели при этом обычная. */
  it('каталог виджетов, подменённый ссылкой наружу, отказывает', () => {
    const dir = project();
    const outside = tempDir('proposals-outside-widgets-');
    writeFileSync(join(outside, 'clock.tsx'), 'secret');
    symlinkSync(outside, join(dir, '.stepcast', 'widgets'));

    assert.throws(
      () => proposeEntry(dir, { target: '.stepcast/widgets/clock.tsx', content: 'x' }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /за пределы кабинета/);
        return true;
      },
    );
    assert.equal(readFileSync(join(outside, 'clock.tsx'), 'utf8'), 'secret');
  });

  /**
   * Штамп в имени записи — до секунды, поэтому два предложения одной цели в
   * пределах одной секунды обязаны разойтись суффиксом: иначе второе молча
   * переписало бы первое, и правило повтора этого не заметило бы — оно про
   * отклонённые записи.
   */
  it('два предложения одной цели в одну секунду дают две записи, а не одну', () => {
    const dir = project();
    const now = new Date('2026-09-12T17:15:26.100Z');
    const first = proposeEntry(dir, { target: '.stepcast/widgets/clock.tsx', content: 'v1', now });
    const second = proposeEntry(dir, {
      target: '.stepcast/widgets/clock.tsx',
      content: 'v2',
      now: new Date('2026-09-12T17:15:26.900Z'),
    });

    assert.notEqual(second.id, first.id);
    const records = readProposalsDir(dir).records;
    assert.deepEqual(
      records.map((record) => record.content),
      ['v1', 'v2'],
      'порядок сортировки имён обязан остаться порядком постановки',
    );
  });

  it('повтор отклонённой записи (та же цель и то же содержимое) отказывает с её именем', () => {
    const dir = project();
    const record = proposeEntry(dir, { target: '.stepcast/widgets/clock.tsx', content: 'v1' });
    rejectProposal(dir, record.id);
    assert.throws(
      () => proposeEntry(dir, { target: '.stepcast/widgets/clock.tsx', content: 'v1' }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, new RegExp(record.id));
        return true;
      },
    );
  });

  it('повтор с другим содержимым после отказа встаёт в очередь', () => {
    const dir = project();
    const record = proposeEntry(dir, { target: '.stepcast/widgets/clock.tsx', content: 'v1' });
    rejectProposal(dir, record.id);
    const second = proposeEntry(dir, { target: '.stepcast/widgets/clock.tsx', content: 'v2' });
    assert.equal(second.state, 'pending');
  });
});

describe('proposals/store: решение', () => {
  it('принятие пишет цель и переводит запись в accepted', () => {
    const dir = project();
    const record = proposeEntry(dir, { target: '.stepcast/widgets/clock.tsx', content: 'export default 1;\n' });
    const decided = acceptProposal(dir, record.id);
    assert.equal(decided.state, 'accepted');
    assert.equal(typeof decided.decidedAt, 'string');
    assert.equal(readFileSync(join(dir, '.stepcast', 'widgets', 'clock.tsx'), 'utf8'), 'export default 1;\n');
  });

  it('принятие создаёт недостающий каталог кабинета', () => {
    const dir = project();
    const record = proposeEntry(dir, { target: '.stepcast/dashboards/release.yml', content: 'title: r\n' });
    assert.equal(existsSync(join(dir, '.stepcast', 'dashboards')), false);
    acceptProposal(dir, record.id);
    assert.equal(readFileSync(join(dir, '.stepcast', 'dashboards', 'release.yml'), 'utf8'), 'title: r\n');
  });

  it('отклонение не трогает цель', () => {
    const dir = project();
    mkdirSync(join(dir, '.stepcast', 'widgets'), { recursive: true });
    writeFileSync(join(dir, '.stepcast', 'widgets', 'clock.tsx'), 'original\n');
    const record = proposeEntry(dir, { target: '.stepcast/widgets/clock.tsx', content: 'proposed\n' });
    const decided = rejectProposal(dir, record.id);
    assert.equal(decided.state, 'rejected');
    assert.equal(readFileSync(join(dir, '.stepcast', 'widgets', 'clock.tsx'), 'utf8'), 'original\n');
  });

  it('расхождение отпечатка отменяет принятие: запись остаётся pending, файл не тронут', () => {
    const dir = project();
    mkdirSync(join(dir, '.stepcast', 'widgets'), { recursive: true });
    writeFileSync(join(dir, '.stepcast', 'widgets', 'clock.tsx'), 'original\n');
    const record = proposeEntry(dir, { target: '.stepcast/widgets/clock.tsx', content: 'proposed\n' });
    // Файл правят руками после постановки.
    writeFileSync(join(dir, '.stepcast', 'widgets', 'clock.tsx'), 'изменено руками\n');
    assert.throws(() => acceptProposal(dir, record.id), StepcastError);
    const stillPending = findProposal(dir, record.id);
    assert.equal(stillPending?.state, 'pending');
    assert.equal(readFileSync(join(dir, '.stepcast', 'widgets', 'clock.tsx'), 'utf8'), 'изменено руками\n');
  });

  it('предложение создания файла, который уже появился, отказывает тем же правилом', () => {
    const dir = project();
    const record = proposeEntry(dir, { target: '.stepcast/dashboards/release.yml', content: 'title: r\n' });
    mkdirSync(join(dir, '.stepcast', 'dashboards'), { recursive: true });
    writeFileSync(join(dir, '.stepcast', 'dashboards', 'release.yml'), 'title: созданный руками\n');
    assert.throws(() => acceptProposal(dir, record.id), StepcastError);
    assert.equal(
      readFileSync(join(dir, '.stepcast', 'dashboards', 'release.yml'), 'utf8'),
      'title: созданный руками\n',
    );
  });
});

describe('proposals/store: режим direct', () => {
  it('пишет цель немедленно и не создаёт запись очереди', () => {
    const dir = project();
    const path = writeProposalTargetDirect(dir, '.stepcast/widgets/clock.tsx', 'export default 1;\n');
    assert.equal(readFileSync(path, 'utf8'), 'export default 1;\n');
    assert.equal(existsSync(proposalsDirPath(dir)), false);
  });
});
