import { relative } from 'node:path';
import { z } from 'zod';

import { listProjects } from '../../core/journal/reader.js';
import { listPipelineFiles } from '../../core/project/pipelines.js';
import { readBody, sendJson } from '../http.js';
import { screenRow, type ApiHandler } from '../screens/registry.js';

/**
 * Строка состава без экрана: `POST /api/run` (`ui-daemon`, design.md Решение
 * 13). Проект и файл пайплайна проверяются тем же обходом, каким их
 * перечисляет витрина (`listProjects`, `listPipelineFiles`) — маршрут не
 * принимает ничего сверх ключа проекта и имени файла, и запустить
 * произвольную команду через него нельзя.
 */

const PostBodySchema = z
  .object({
    project: z.string().min(1),
    pipeline: z.string().min(1),
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
    sendJson(res, 400, { error: 'Тело запроса не соответствует формату: только project и pipeline' });
    return;
  }

  const project = listProjects(env.runsRoot).find((entry) => entry.key === parsed.data.project);
  if (project?.path === undefined) {
    sendJson(res, 400, { error: `Проект ${parsed.data.project} неизвестен указателю projects.json` });
    return;
  }

  const files = listPipelineFiles(project.path).map((file) => relative(project.path as string, file).replace(/\\/g, '/'));
  if (!files.includes(parsed.data.pipeline)) {
    sendJson(res, 400, {
      error: `Пайплайн ${parsed.data.pipeline} не найден среди файлов проекта ${parsed.data.project}`,
    });
    return;
  }

  env.launchRun({ cwd: project.path, pipeline: parsed.data.pipeline });
  // 202: подтверждение запуска, не обещание идентификатора прогона — он
  // появится в обзоре обычным тактом наблюдателя, когда дочерний процесс
  // напишет журнал (`ui-daemon`, Решение 13).
  sendJson(res, 202, { ok: true });
};

export const row = screenRow('ui-run-launch', ['api'], (ctx) => {
  ctx.api.register('POST', '/api/run', handlePost);
});
