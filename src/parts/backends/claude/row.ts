import { claudeModelDiscovery, createClaudeAdapter } from '../../../core/backend/claude.js';
import { partRow } from '../../pipeline/services.js';

/**
 * Строка встроенного слоя: бэкенд `claude`. Реализация остаётся на прежнем
 * месте (`src/core/backend/claude.ts`) — её физический переезд в этот каталог
 * шаг 5 плана `docs/microkernel-target.md`; здесь заводится только модуль
 * строки по адресу целевой структуры (`plugin-tree`, design.md, Решение 2).
 *
 * Строка-потребитель сервиса `backends` (design.md `pipeline-owns-services`,
 * Решение 2): применяется собственной областью с объявленным `inject`, а не
 * прямо на корне, — порядок относительно строки-поставщика (`pipeline`) в
 * перечне (`src/parts/rows.ts`) её применения не решает, `partRow` дожидается
 * сервиса. Владелец вклада при этом остаётся «встроенным»: признак — не
 * корневая область, а пометка области строки этого каталога (Решение 3).
 */
export const row = partRow('backend-claude', ['backends'], (ctx) => {
  ctx.backends.register('claude', {
    create: (config) => createClaudeAdapter(config),
    models: claudeModelDiscovery,
  });
});
