import { claudeModelDiscovery, createClaudeAdapter } from '../../../core/backend/claude.js';
import type { BuiltinRow } from '../../../core/plugins/load.js';

/**
 * Строка встроенного слоя: бэкенд `claude`. Реализация остаётся на прежнем
 * месте (`src/core/backend/claude.ts`) — её физический переезд в этот каталог
 * шаг 5 плана `docs/microkernel-target.md`; здесь заводится только модуль
 * строки по адресу целевой структуры (`plugin-tree`, design.md, Решение 2).
 *
 * Вклад вносится на корневой области ядра, а не через `kernel.ctx.plugin`:
 * владелец встроенного вклада — признак области ядра (`BUILTIN_OWNER`), а не
 * имя строки (`plugin-tree`, design.md, Решение 1).
 */
export const row: BuiltinRow = {
  id: 'backend-claude',
  apply(kernel) {
    kernel.ctx.backends.register('claude', {
      create: (config) => createClaudeAdapter(config),
      models: claudeModelDiscovery,
    });
  },
};
