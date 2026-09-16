import { claudeModelDiscovery, createClaudeAdapter } from './adapter.js';
import { partRow } from '../../pipeline/services.js';

/**
 * Строка встроенного слоя: бэкенд `claude`. Реализация лежит рядом
 * (`./adapter.ts`, `source-tree-microkernel-layout`, ступень 3) — адаптер
 * написан внутренними импортами и публичной поверхностью (`stepcast/plugin`)
 * не пользуется, поэтому граница плагинов поставки названа перечнем каталогов
 * (`parts/backends/codex/**`, `parts/pipeline/steps/decision/**`), а не деревом
 * `parts/backends/**`: этот каталог в перечне не значится вовсе — ни в `files`,
 * ни в `ignores`, — и правило его не касается (design.md, Решение 8;
 * `eslint.config.js`). Переписывание адаптера на публичный подпуть — с ним
 * правило стало бы деревом — названо открытым в плане.
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
