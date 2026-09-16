import { sendJson } from '../../daemon/http.js';
import { buildSteps } from '../../steps.js';
import { screenRow, type ApiHandler } from '../registry.js';
import { declaration } from './declaration.js';

/** Каталог переиспользуемых шагов: чтение файлов, синхронно, как и остальной обход манифестов. */
const handleSteps: ApiHandler = (_req, res, env) => {
  try {
    sendJson(res, 200, buildSteps(env.runsRoot, env.home === undefined ? {} : { home: env.home }));
  } catch (error) {
    sendJson(res, 500, { error: (error as Error).message });
  }
};

export const row = screenRow(declaration.id, ['screens', 'api'], (ctx) => {
  ctx.screens.register(declaration);
  ctx.api.register('GET', '/api/steps', handleSteps);
});
