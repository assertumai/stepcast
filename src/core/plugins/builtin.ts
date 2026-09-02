import { createClaudeAdapter } from '../backend/claude.js';
import type { CommandContribution, StepcastPlugin } from './contract.js';
import { createRegistry, type Registry } from './registry.js';

/**
 * Встроенные вклады движка.
 *
 * Бэкенд и команды описаны тем же контрактом, что и плагинные, — это
 * единственный способ проверить, что контракта достаточно: если через вклад
 * нельзя выразить `claude`, через него нельзя выразить и второй бэкенд.
 *
 * Встроенные предикаты — исключение, и оно осознанное. Их модель
 * (`Predicate`) — размеченное объединение с типизированными полями, а
 * вычисление — `switch` по `kind`, полноту которого проверяет компилятор.
 * Вклад с сигнатурой `evaluate(value: unknown, …)` заменил бы девять
 * проверенных ветвей на девять приведений типа — обмен не в пользу движка.
 * Реестру от встроенных предикатов нужно только их имена: перечень
 * доступного в диагностике и запрет занять то же имя плагином. Ветви схемы
 * документа остаются в `pipeline/schema.ts`, где и были.
 */

/**
 * Имена встроенных предикатов. Плагин не вправе занять ни одно: предикат под
 * знакомым именем, ведущий себя иначе, — то же, что подменённый `claude`.
 */
export const BUILTIN_PREDICATE_NAMES: readonly string[] = [
  'exit_code',
  'file_exists',
  'schema',
  'matches',
  'not_matches',
  'changed_only',
  'knowledge_valid',
  'cmd',
  'judge',
];

/**
 * Встроенные вклады как плагин: тот же контракт, что у любого другого.
 *
 * Команды приходят параметром, а не объявлены здесь: они живут в `src/cli`, а
 * ядру запрещено зависеть от поверхности. Точка входа передаёт их при сборке
 * реестра; ядро, вызванное как библиотека, обходится без них.
 */
export function builtinPlugin(commands: readonly CommandContribution[] = []): StepcastPlugin {
  return {
    name: 'stepcast',
    backends: {
      claude: { create: (config) => createClaudeAdapter(config) },
    },
    ...(commands.length === 0 ? {} : { commands }),
  };
}

/**
 * Реестр из одних встроенных вкладов. Заводится заново на каждый вызов:
 * реестр живёт ровно столько, сколько команда, и общий изменяемый экземпляр
 * протёк бы между тестами.
 */
export function builtinRegistry(commands: readonly CommandContribution[] = []): Registry {
  return createRegistry(builtinPlugin(commands), BUILTIN_PREDICATE_NAMES);
}
