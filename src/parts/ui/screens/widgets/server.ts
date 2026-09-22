import { existsSync } from 'node:fs';
import { z } from 'zod';

import { listProjects } from '../../../pipeline/run/journal/reader.js';
import { readBody, sendJson } from '../../daemon/http.js';
import { installBuiltinWidget, listBuiltinWidgets } from '../../widgets.js';
import { screenRow, type ApiHandler } from '../registry.js';
import { declaration } from './declaration.js';

/**
 * Состав виджетов проектов приходит потоком событий (`GET /api/events`,
 * строка `ui-shell`), а модули под `/widgets/` остаются диспетчеризацией
 * сервера (design.md, Решение 16). Свои маршруты у экрана — про каталог
 * поставки (`ui-overhaul`): перечень образцов и копирование образца в проект.
 */

const handleCatalog: ApiHandler = (_req, res) => {
  sendJson(res, 200, { widgets: listBuiltinWidgets() });
};

const InstallBodySchema = z.object({ projectKey: z.string().min(1), id: z.string().min(1) }).strict();

const handleInstall: ApiHandler = async (req, res, env) => {
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

  const parsed = InstallBodySchema.safeParse(raw);
  if (!parsed.success) {
    sendJson(res, 400, { error: 'Request body must carry projectKey and id' });
    return;
  }

  const project = listProjects(env.runsRoot).find((entry) => entry.key === parsed.data.projectKey);
  if (project?.path === undefined || !existsSync(project.path)) {
    sendJson(res, 404, { error: 'Project not found' });
    return;
  }

  const outcome = installBuiltinWidget(project.path, parsed.data.id);
  if (outcome.status === 'unknown') {
    sendJson(res, 404, { error: `Widget “${parsed.data.id}” is not in the catalog` });
    return;
  }
  if (outcome.status === 'exists') {
    sendJson(res, 409, { error: `Widget “${parsed.data.id}” already exists in this project`, file: outcome.file });
    return;
  }
  sendJson(res, 200, { installed: { projectKey: project.key, id: parsed.data.id, file: outcome.file } });
};

export const row = screenRow(declaration.id, ['screens', 'api'], (ctx) => {
  ctx.screens.register(declaration);
  ctx.api.register('GET', '/api/widgets/catalog', handleCatalog);
  ctx.api.register('POST', '/api/widgets/install', handleInstall);
});
