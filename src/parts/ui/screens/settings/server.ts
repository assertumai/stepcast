import { isStepcastError } from '../../../../kernel/errors.js';
import { readBody, sendJson } from '../../daemon/http.js';
import { readSettings, writeSettings } from '../../settings.js';
import { screenRow, type ApiHandler } from '../registry.js';
import { declaration } from './declaration.js';

const handleRead: ApiHandler = async (_req, res, env) => {
  try {
    sendJson(res, 200, await readSettings(env.home, env.kernelCache));
  } catch (error) {
    sendJson(res, 500, { error: (error as Error).message });
  }
};

const handleWrite: ApiHandler = async (req, res, env) => {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 413, { error: 'Тело запроса слишком велико' });
    return;
  }

  let patch: unknown;
  try {
    patch = JSON.parse(body === '' ? '{}' : body) as unknown;
  } catch {
    sendJson(res, 400, { error: 'Тело запроса не разбирается как JSON' });
    return;
  }

  try {
    sendJson(res, 200, await writeSettings(patch, env.home, env.kernelCache));
  } catch (error) {
    const message = isStepcastError(error) ? error.message : (error as Error).message;
    sendJson(res, isStepcastError(error) ? 400 : 500, { error: message });
  }
};

export const row = screenRow(declaration.id, ['screens', 'api'], (ctx) => {
  ctx.screens.register(declaration);
  ctx.api.register('GET', '/api/settings', handleRead);
  ctx.api.register('PUT', '/api/settings', handleWrite);
});
