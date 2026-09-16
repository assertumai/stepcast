import { screenRow } from '../registry.js';
import { declaration } from './declaration.js';

/**
 * Экран без собственных маршрутов: данные приходят потоком событий
 * (`GET /api/events`, строка `ui-shell`), а содержимое под `/widgets/`
 * остаётся диспетчеризацией сервера (design.md, Решение 16) — экран его лишь
 * показывает.
 */
export const row = screenRow(declaration.id, ['screens'], (ctx) => {
  ctx.screens.register(declaration);
});
