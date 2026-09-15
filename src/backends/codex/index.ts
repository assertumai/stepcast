import { defineBackend, definePlugin } from '../../plugin.js';
import { createCodexAdapter } from './adapter.js';

/**
 * Плагин Codex: `plugins: [stepcast/backends/codex]`.
 *
 * Поставляется в пакете, но не встроен: `builtinPlugin()` его не знает, и без
 * объявления бэкенда `codex` не существует. Умолчания — то, что пользователь
 * иначе переписывал бы из README: возможности, которые CLI действительно
 * умеет, и вес чтения кеша как у `claude` (кешированный ввод у OpenAI тоже
 * дешевле обычного примерно на порядок).
 */
const plugin = definePlugin({
  name: 'codex',
  version: '0.1.0',
  backends: {
    codex: defineBackend({
      create: (config) => createCodexAdapter(config),
      defaults: {
        command: 'codex',
        default_model: 'gpt-5.6-terra',
        sessions: true,
        structured_output: true,
        // Ни пооперационного запрета, ни отсечения чужих серверов у CLI нет.
        strict_permissions: false,
        // Подтверждено записью `test/fixtures/codex/mcp.jsonl`.
        mcp: true,
        concurrency: 2,
        cache_read_weight: 0.1,
      },
    }),
  },
});

export default plugin;
export { createCodexAdapter, SANDBOX_MODES } from './adapter.js';
