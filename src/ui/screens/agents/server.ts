import { sendJson } from '../../http.js';
import { readModels } from '../../models.js';
import { screenRow, type ApiHandler } from '../registry.js';
import { declaration } from './declaration.js';

/**
 * Списки моделей агентов — отдельный проход от `/api/settings` (design.md
 * изменения `ui-dashboard`, решение 5): состав агентов читает `readModels`
 * (`../../models.js`) вызовом `readSettings`, тем же, каким пользуется и
 * маршрут `screen-settings`, — общая функция, а не запрос через HTTP: маршрут
 * здесь один, `/api/models`, и он принадлежит только этой строке.
 * `?refresh=1` обходит удержанное демоном и перечисляет заново.
 */
const handleModels: ApiHandler = async (req, res, env) => {
  try {
    const url = new URL(req.url ?? '/', 'http://internal');
    const refresh = url.searchParams.get('refresh') === '1';
    sendJson(res, 200, await readModels(env.home, { refresh }, env.kernelCache));
  } catch (error) {
    sendJson(res, 500, { error: (error as Error).message });
  }
};

export const row = screenRow(declaration.id, ['screens', 'api'], (ctx) => {
  ctx.screens.register(declaration);
  ctx.api.register('GET', '/api/models', handleModels);
});
