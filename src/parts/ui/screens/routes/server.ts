import { homedir } from 'node:os';
import { z } from 'zod';

import { isStepcastError } from '../../../../kernel/errors.js';
import { readBody, sendJson } from '../../daemon/http.js';
import { RouteRowSchema, routesPayload, writeRouteRow } from '../../routesFile.js';
import { screenRow, type ApiHandler } from '../registry.js';
import { declaration } from './declaration.js';

/**
 * Серверная половина экрана «Маршруты» (`ui-routes`, design.md Решение 12):
 * `GET /api/routes` отдаёт действующую таблицу с источниками и диагностикой,
 * `POST /api/routes` пишет строку в названный файл слоя через `Document`
 * `writeRouteRow` (Решение 11) — единственная запись демона в каталог
 * проекта или домашний каталог, и происходит только по этому запросу.
 */

const handleGet: ApiHandler = (_req, res, env) => {
  const result = env.watcher.currentRoutes();
  const buildError = env.watcher.currentRoutesError();
  sendJson(res, 200, {
    routes: routesPayload(result),
    // Отключённые строки идут рядом с действующими: без них маршрут,
    // выключенный из витрины, исчезал бы из перечня совсем, и включить его
    // обратно можно было бы только правкой файла руками (`ui-routes`,
    // «Витрина показывает маршруты с источником и правит файл слоя»).
    disabled: result.disabled,
    ...(buildError === undefined ? {} : { buildError }),
  });
};

const PostBodySchema = z
  .object({
    layer: z.union([z.literal('home'), z.literal('project')]),
    route: RouteRowSchema,
  })
  .strict();

const handlePost: ApiHandler = async (req, res, env) => {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 413, { error: 'Request body is too large' });
    return;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(body === '' ? '{}' : body) as unknown;
  } catch {
    sendJson(res, 400, { error: 'Request body is not valid JSON' });
    return;
  }

  const parsed = PostBodySchema.safeParse(raw);
  if (!parsed.success) {
    sendJson(res, 400, { error: 'Request body does not match the format of a route row and layer' });
    return;
  }

  try {
    writeRouteRow(parsed.data.layer, parsed.data.route, {
      home: env.home ?? homedir(),
      ...(env.projectRoot === undefined ? {} : { projectRoot: env.projectRoot }),
    });
    // Наблюдатель опрашивает файлы раз в секунду (`ui-routes`, Решение 10) —
    // достаточно для правки, сделанной мимо демона, но не для записи, которую
    // демон только что сделал сам: без немедленного опроса собственный ответ
    // ``GET /api/routes`` расходился бы со своей же записью до следующего такта.
    env.watcher.poll();
    sendJson(res, 200, { ok: true });
  } catch (error) {
    const message = isStepcastError(error) ? error.message : (error as Error).message;
    sendJson(res, isStepcastError(error) ? 400 : 500, { error: message });
  }
};

export const row = screenRow(declaration.id, ['screens', 'api'], (ctx) => {
  ctx.screens.register(declaration);
  ctx.api.register('GET', '/api/routes', handleGet);
  ctx.api.register('POST', '/api/routes', handlePost);
});
