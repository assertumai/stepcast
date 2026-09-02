import type { Config } from '../config/resolve.js';
import { StepcastError } from '../errors.js';
import { builtinRegistry } from '../plugins/builtin.js';
import { availableNames, type Registry } from '../plugins/registry.js';
import type { BackendAdapter } from './types.js';

/**
 * Подбор адаптера по имени бэкенда.
 *
 * Реестр открыт: адаптер даёт либо встроенный вклад, либо плагин
 * (`docs/plugins.md`). Два условия остались прежними и проверяются по
 * отдельности, потому что чинятся по-разному: имя должно быть настроено в
 * `backends` и включено — это конфигурация пользователя, — и для него должен
 * найтись вклад — это состав плагинов.
 */
export function resolveAdapter(
  name: string,
  config: Config,
  registry: Registry = builtinRegistry(),
): BackendAdapter {
  const backend = config.backends[name];
  if (backend === undefined) {
    throw new StepcastError(`Неизвестный бэкенд ${name}`, {
      hint: `Настроены: ${Object.keys(config.backends).sort().join(', ')}`,
    });
  }
  if (!backend.enabled) {
    throw new StepcastError(`Бэкенд ${name} выключен в конфигурации`);
  }

  const contribution = registry.backends.get(name);
  if (contribution === undefined) {
    throw new StepcastError(`Адаптер бэкенда ${name} не предоставлен ни встроенно, ни плагином`, {
      hint: `Доступны: ${availableNames(registry, 'backends').join(', ')}. Плагин, дающий адаптер, объявляется ключом plugins (docs/plugins.md)`,
    });
  }

  return contribution.create(backend);
}
