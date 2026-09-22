import { INVALID, readNonNegativeInt, sendJson } from '../../daemon/http.js';
import { MAX_USAGE_DAYS, buildUsage } from '../../usage.js';
import { screenRow, type ApiHandler } from '../registry.js';
import { declaration } from './declaration.js';

/**
 * Расход поперёк прогонов за период.
 *
 * `days` разбирается тем же правилом, что `attempt` у вывода шага: ноль или
 * нецелое число — ошибка клиента, а не молчаливое умолчание (design.md,
 * Решение 4). Сверху период ограничен `MAX_USAGE_DAYS`: ряд дней строится
 * подряд по календарю, и период длиной в миллионы дней занял бы единственный
 * поток демона на минуты — такой запрос отклоняется, а не считается. Без
 * параметра — весь период наблюдений.
 */
const handleUsage: ApiHandler = (req, res, env) => {
  const url = new URL(req.url ?? '/', 'http://internal');
  const days = readNonNegativeInt(url, 'days');
  if (days === INVALID || days === 0 || (days !== undefined && days > MAX_USAGE_DAYS)) {
    sendJson(res, 400, { error: `days must be a positive integer not greater than ${MAX_USAGE_DAYS}` });
    return;
  }
  sendJson(res, 200, buildUsage(env.runsRoot, env.watcher.current(), days === undefined ? {} : { days }));
};

export const row = screenRow(declaration.id, ['screens', 'api'], (ctx) => {
  ctx.screens.register(declaration);
  ctx.api.register('GET', '/api/usage', handleUsage);
});
