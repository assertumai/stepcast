import { sendJson } from '../../daemon/http.js';
import { buildPipelines } from '../../pipelines.js';
import { screenRow, type ApiHandler } from '../registry.js';
import { declaration } from './declaration.js';

/**
 * Пайплайны проектов: реестр каждого проекта собирается импортом чужого кода
 * (`buildPipelines` асинхронна). Перенесена без изменений из прежнего
 * `src/parts/ui/daemon/server.ts` (`ui-screens`, «Переведённые экраны не меняют поведения»).
 */
const handlePipelines: ApiHandler = async (_req, res, env) => {
  if (env.config === undefined) {
    sendJson(res, 200, { pipelines: [], generatedAt: new Date().toISOString() });
    return;
  }

  try {
    // `home` доезжает сюда, потому что секцию `project` витрина читает у
    // каждого проекта своей: команда проверки объявлена в репозитории.
    const overview = await buildPipelines(env.runsRoot, env.config, {
      ...(env.home === undefined ? {} : { home: env.home }),
      kernelCache: env.kernelCache,
    });
    sendJson(res, 200, overview);
  } catch (error) {
    sendJson(res, 500, { error: (error as Error).message });
  }
};

export const row = screenRow(declaration.id, ['screens', 'api'], (ctx) => {
  ctx.screens.register(declaration);
  ctx.api.register('GET', '/api/pipelines', handlePipelines);
});
