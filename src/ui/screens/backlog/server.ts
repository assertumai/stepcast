import { sendJson } from '../../http.js';
import { screenRow, type ApiHandler } from '../registry.js';
import { declaration } from './declaration.js';

const handleBacklog: ApiHandler = (_req, res, env) => {
  sendJson(res, 200, env.watcher.currentBacklog());
};

export const row = screenRow(declaration.id, ['screens', 'api'], (ctx) => {
  ctx.screens.register(declaration);
  ctx.api.register('GET', '/api/backlog', handleBacklog);
});
