import { claudeModelDiscovery, createClaudeAdapter } from '../backend/claude.js';
import type { CommandContribution } from './contract.js';
import { createKernel, type Kernel } from './kernel.js';
import { registryFromKernel, type Registry } from './registry.js';

/**
 * Встроенные вклады движка.
 *
 * Регистрируются тем же вызовом, что и плагинные — `ctx.backends.register` —
 * это единственный способ проверить, что контракта
 * достаточно: если через вклад нельзя выразить `claude`, через него нельзя
 * выразить и второй бэкенд. Разница только в том, на каком контексте вызов
 * исполняется: на корневом, а не внутри `ctx.plugin()`, — поэтому владелец
 * вклада выходит «встроенным», а не «плагином» (kernel.ts, идентичность
 * корневой области).
 *
 * Встроенные предикаты — исключение, и оно осознанное. Их модель
 * (`Predicate`) — размеченное объединение с типизированными полями, а
 * вычисление — `switch` по `kind`, полноту которого проверяет компилятор.
 * Вклад с сигнатурой `evaluate(value: unknown, …)` заменил бы девять
 * проверенных ветвей на девять приведений типа — обмен не в пользу движка.
 * Реестру от встроенных предикатов нужно только их имена: перечень
 * доступного в диагностике и запрет занять то же имя плагином. Резерв имени
 * делается через ядро (`kernel.reservePredicate`), а не через сервис: сервис
 * виден плагину, и публичный `reserve` на нём дал бы любому плагину занять
 * произвольное имя несъёмным резервом. Ветви схемы документа остаются в
 * `pipeline/schema.ts`, где и были.
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
 * Ядро со встроенными вкладами. Команды приходят параметром, а не объявлены
 * здесь: они живут в `src/cli`, а ядру запрещено зависеть от поверхности.
 * Точка входа передаёт их при сборке; ядро, вызванное как библиотека,
 * обходится без них.
 */
export function createBuiltinKernel(commands: readonly CommandContribution[] = []): Kernel {
  const kernel = createKernel();
  for (const name of BUILTIN_PREDICATE_NAMES) kernel.reservePredicate(name);
  kernel.ctx.backends.register('claude', {
    create: (config) => createClaudeAdapter(config),
    models: claudeModelDiscovery,
  });
  for (const command of commands) kernel.ctx.commands.register(command.name, command);
  return kernel;
}

/**
 * Реестр из одних встроенных вкладов. Заводится заново на каждый вызов:
 * реестр живёт ровно столько, сколько команда, и общий изменяемый экземпляр
 * протёк бы между тестами.
 */
export function builtinRegistry(commands: readonly CommandContribution[] = []): Registry {
  return registryFromKernel(createBuiltinKernel(commands));
}
