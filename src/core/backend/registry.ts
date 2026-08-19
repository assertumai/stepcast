import type { Config } from '../config/resolve.js';
import { StepcastError } from '../errors.js';
import { createClaudeAdapter } from './claude.js';
import type { BackendAdapter } from './types.js';

/**
 * Подбор адаптера по имени бэкенда. Реестр пока закрытый: расширяемость через
 * плагины отложена, а неизвестное имя должно давать понятную ошибку, а не
 * молчаливое ничего.
 */
export function resolveAdapter(name: string, config: Config): BackendAdapter {
  const backend = config.backends[name];
  if (backend === undefined) {
    throw new StepcastError(`Неизвестный бэкенд ${name}`, {
      hint: `Настроены: ${Object.keys(config.backends).sort().join(', ')}`,
    });
  }
  if (!backend.enabled) {
    throw new StepcastError(`Бэкенд ${name} выключен в конфигурации`);
  }

  switch (name) {
    case 'claude':
      return createClaudeAdapter(backend);
    default:
      throw new StepcastError(`Адаптер для бэкенда ${name} ещё не реализован`, {
        hint: 'В текущем срезе поддержан claude; остальные добавятся отдельными изменениями',
      });
  }
}
