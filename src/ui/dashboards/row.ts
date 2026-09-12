import { homedir } from 'node:os';
import { z } from 'zod';

import { isStepcastError } from '../../core/errors.js';
import { readBody, sendJson } from '../http.js';
import { DashboardDocumentSchema, writeDashboard } from '../dashboardsFile.js';
import { screenRow, type ApiHandler } from '../screens/registry.js';

/**
 * Строка состава без экрана: `GET`/`POST /api/dashboards` (`ui-dashboards`,
 * design.md Решение 11). Показ дашборда — вклад браузерной строки
 * `ui/src/plugins/dashboard.tsx` в вид цели `dashboard`, а не отдельный экран,
 * поэтому здесь нет `ctx.screens.register` — только сервис `api`.
 */

const handleGet: ApiHandler = (_req, res, env) => {
  sendJson(res, 200, env.watcher.currentDashboards());
};

const FingerprintSchema = z.object({ mtimeMs: z.number(), size: z.number() }).strict();

const PostBodySchema = z
  .object({
    layer: z.union([z.literal('home'), z.literal('project')]),
    id: z.string().min(1),
    document: DashboardDocumentSchema,
    baseFingerprint: FingerprintSchema.optional(),
  })
  .strict();

const handlePost: ApiHandler = async (req, res, env) => {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 413, { error: 'Тело запроса слишком велико' });
    return;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(body === '' ? '{}' : body) as unknown;
  } catch {
    sendJson(res, 400, { error: 'Тело запроса не разбирается как JSON' });
    return;
  }

  const parsed = PostBodySchema.safeParse(raw);
  if (!parsed.success) {
    sendJson(res, 400, { error: 'Тело запроса не соответствует формату дашборда' });
    return;
  }

  try {
    writeDashboard(parsed.data.layer, parsed.data.id, parsed.data.document, parsed.data.baseFingerprint, {
      home: env.home ?? homedir(),
      ...(env.projectRoot === undefined ? {} : { projectRoot: env.projectRoot }),
    });
    // Наблюдатель опрашивает каталоги раз в секунду — достаточно для правки,
    // сделанной мимо демона, но не для записи, которую демон только что сделал
    // сам (`src/ui/screens/routes/server.ts`, тот же приём).
    env.watcher.poll();
    sendJson(res, 200, { ok: true });
  } catch (error) {
    const message = isStepcastError(error) ? error.message : (error as Error).message;
    sendJson(res, isStepcastError(error) ? 400 : 500, { error: message });
  }
};

export const row = screenRow('ui-dashboards', ['api'], (ctx) => {
  ctx.api.register('GET', '/api/dashboards', handleGet);
  ctx.api.register('POST', '/api/dashboards', handlePost);
});
