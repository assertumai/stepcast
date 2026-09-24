import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  effortOptions,
  modelOptions,
  orderedTierNames,
  tierDraftProblem,
  tierSelectionPatch,
  unavailableReason,
} from '../src/pages/Agents';

/**
 * Экран «Agents» (`ui-overhaul`): поле модели — Combobox со свободным вводом,
 * варианты — перечисленные CLI плюс уже сохранённые в конфигурации имена;
 * причины недоступности перечисления названы словами.
 */
describe('ui-agents: варианты поля модели', () => {
  it('перечисленные CLI идут с подписью, сохранённые в конфигурации добавляются без повторов', () => {
    const options = modelOptions(
      [{ name: 'sonnet', label: 'Sonnet 5', title: 'Balanced model', defaultEffort: 'medium' }, { name: 'opus' }],
      ['opus', 'my-fine-tune', undefined, ' ', 'my-fine-tune'],
    );
    assert.deepEqual(options, [
      { value: 'sonnet', label: 'Sonnet 5', description: 'Balanced model · default effort: medium' },
      { value: 'opus' },
      { value: 'my-fine-tune', description: 'from configuration' },
    ]);
  });

  it('без перечисления остаются только имена из конфигурации', () => {
    assert.deepEqual(modelOptions([], ['gpt-5.6-terra']), [{ value: 'gpt-5.6-terra', description: 'from configuration' }]);
  });

  it('effort зависит от модели и сохраняет кастомное настроенное значение', () => {
    assert.deepEqual(effortOptions([
      {
        name: 'gpt-6-astra', defaultEffort: 'medium',
        efforts: [{ name: 'low', description: 'Faster' }, { name: 'high' }],
      },
    ], 'gpt-6-astra', 'max'), [
      { value: 'low', description: 'Faster' },
      { value: 'high' },
      { value: 'max', description: 'from configuration' },
    ]);
    assert.deepEqual(effortOptions([], 'custom-model', 'high'), [
      { value: 'high', description: 'from configuration' },
    ]);
  });
});

describe('ui-agents: общие tier', () => {
  it('встроенные имена идут первыми, кастомные — один раз по алфавиту', () => {
    assert.deepEqual(orderedTierNames(['review', 'deep', 'nightly', 'review']), [
      'max', 'deep', 'balance', 'fast', 'mini', 'nightly', 'review',
    ]);
  });

  it('патч различает shorthand, объект с effort, очистку и отсутствие изменения', () => {
    assert.equal(tierSelectionPatch({ model: 'opus' }, { model: 'opus', effort: '' }), undefined);
    assert.deepEqual(tierSelectionPatch(undefined, { model: 'opus', effort: '' }), { model: 'opus', effort: null });
    assert.deepEqual(tierSelectionPatch({ model: 'opus' }, { model: 'opus', effort: 'high' }), { model: 'opus', effort: 'high' });
    assert.deepEqual(tierSelectionPatch({ model: 'opus', effort: 'high' }, { model: '', effort: '' }), { model: null });
  });

  it('новый tier требует модель хотя бы одного агента, effort без модели запрещён', () => {
    const empty = {
      claude: { defaultModel: '', modelTiers: { review: { model: '', effort: '' } } },
      codex: { defaultModel: '', modelTiers: { review: { model: '', effort: '' } } },
    };
    assert.match(tierDraftProblem(['review'], [], empty) ?? '', /at least one agent/);
    assert.equal(tierDraftProblem(['review'], [], {
      ...empty,
      codex: { defaultModel: '', modelTiers: { review: { model: 'gpt-review', effort: '' } } },
    }), undefined);
    assert.match(tierDraftProblem(['review'], ['review'], {
      ...empty,
      claude: { defaultModel: '', modelTiers: { review: { model: '', effort: 'high' } } },
    }) ?? '', /model/);
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
