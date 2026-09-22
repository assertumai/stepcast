import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { modelOptions, unavailableReason } from '../src/pages/Agents';

/**
 * Экран «Agents» (`ui-overhaul`): поле модели — Combobox со свободным вводом,
 * варианты — перечисленные CLI плюс уже сохранённые в конфигурации имена;
 * причины недоступности перечисления названы словами.
 */
describe('ui-agents: варианты поля модели', () => {
  it('перечисленные CLI идут с подписью, сохранённые в конфигурации добавляются без повторов', () => {
    const options = modelOptions(
      [{ name: 'sonnet', title: 'Sonnet 5' }, { name: 'opus' }],
      ['opus', 'my-fine-tune', undefined, ' ', 'my-fine-tune'],
    );
    assert.deepEqual(options, [
      { value: 'sonnet', description: 'Sonnet 5' },
      { value: 'opus' },
      { value: 'my-fine-tune', description: 'from configuration' },
    ]);
  });

  it('без перечисления остаются только имена из конфигурации', () => {
    assert.deepEqual(modelOptions([], ['gpt-5.6-terra']), [{ value: 'gpt-5.6-terra', description: 'from configuration' }]);
  });
});

describe('ui-agents: причина недоступности перечисления', () => {
  it('каждый статус отказа назван словами, успех — без причины', () => {
    assert.equal(unavailableReason({ status: 'ok', models: [] }), undefined);
    assert.match(unavailableReason({ status: 'unsupported' }) ?? '', /cannot list/);
    assert.match(unavailableReason({ status: 'not_installed', command: 'codex' }) ?? '', /“codex” not found/);
    assert.match(unavailableReason({ status: 'timeout' }) ?? '', /did not answer/);
    assert.equal(unavailableReason({ status: 'failed', message: '' }), 'The agent failed without saying why');
    assert.equal(unavailableReason({ status: 'failed', message: 'boom' }), 'The agent failed: boom');
    assert.match(unavailableReason({ status: 'unparsed' }) ?? '', /could not be parsed/);
    assert.equal(unavailableReason({ status: 'probe_error', message: 'x' }), 'Listing crashed: x');
  });
});
