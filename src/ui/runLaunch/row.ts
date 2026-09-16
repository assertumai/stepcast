import { relative } from 'node:path';
import { z } from 'zod';

import { listProjects } from '../../core/journal/reader.js';
import { packagedPipelineNames, STEPCAST_PIPELINE_PREFIX } from '../../core/package-schema.js';
import { listPipelineFiles } from '../../core/project/pipelines.js';
import { readBody, sendJson } from '../http.js';
import { screenRow, type ApiHandler } from '../screens/registry.js';

/**
 * Строка состава без экрана: `POST /api/run` (`ui-daemon`, design.md Решение
 * 13). Проект и файл пайплайна проверяются тем же обходом, каким их
 * перечисляет витрина (`listProjects`, `listPipelineFiles`) — маршрут не
 * принимает ничего сверх ключа проекта и имени файла, и запустить
 * произвольную команду через него нельзя.
 *
 * Необязательные `inputs` доезжают до `stepcast run` ключами `--input`: так
 * доска запускает пайплайн для названного пункта очереди. Значения не
 * исполняются оболочкой — дочерний процесс порождается списком argv, — но
 * форма их всё равно проверена: имя входа и одна строка значения.
 *
 * `pipeline` формы `stepcast:<имя>` — пайплайн поставки (`ui-daemon`, «Запуск
 * прогона принимает пайплайн поставки»): проверяется закрытым перечнем
 * `packagedPipelineNames()`, а не обходом файлов проекта — иначе кнопке
 * «Мигрировать» (`ui-widgets`) нечего было бы запускать.
 */

/**
 * Имя входа — то же, чем его объявляет документ пайплайна; значение
 * однострочно, как и всё, что доезжает ключом командной строки. Перевод
 * строки в значении отвергается здесь, а не рассекается дочерним процессом:
 * `--input` принимает одну пару `имя=значение`, и вторая строка стала бы
 * невесть чем.
 */
const InputsSchema = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]*$/, 'имя входа: буквы, цифры, дефис и подчёркивание'),
  z.string().max(500).refine((value) => !/[\n\r]/.test(value), 'значение входа обязано занимать одну строку'),
);

const PostBodySchema = z
  .object({
    project: z.string().min(1),
    pipeline: z.string().min(1),
    /**
     * Входы пайплайна: доска передаёт сюда `item: <слаг>`. Ключ необязателен —
     * кнопка «Запустить» на экране пайплайнов шлёт запрос без него, и её
     * поведение этой возможностью не меняется.
     */
    inputs: InputsSchema.optional(),
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
    sendJson(res, 400, {
      error: `Тело запроса не соответствует формату: ${parsed.error.issues[0]?.message ?? 'только project, pipeline и inputs'}`,
    });
    return;
  }

  const project = listProjects(env.runsRoot).find((entry) => entry.key === parsed.data.project);
  if (project?.path === undefined) {
    sendJson(res, 400, { error: `Проект ${parsed.data.project} неизвестен указателю projects.json` });
    return;
  }

  if (parsed.data.pipeline.startsWith(STEPCAST_PIPELINE_PREFIX)) {
    const name = parsed.data.pipeline.slice(STEPCAST_PIPELINE_PREFIX.length);
    const known = packagedPipelineNames();
    if (!known.includes(name)) {
      sendJson(res, 400, { error: `Пайплайн stepcast:${name} не поставляется пакетом stepcast. Пакет поставляет: ${known.join(', ')}` });
      return;
    }
  } else {
    const files = listPipelineFiles(project.path).map((file) => relative(project.path as string, file).replace(/\\/g, '/'));
    if (!files.includes(parsed.data.pipeline)) {
      sendJson(res, 400, {
        error: `Пайплайн ${parsed.data.pipeline} не найден среди файлов проекта ${parsed.data.project}`,
      });
      return;
    }
  }

  env.launchRun({
    cwd: project.path,
    runsRoot: env.runsRoot,
    projectKey: parsed.data.project,
    pipeline: parsed.data.pipeline,
    ...(parsed.data.inputs === undefined ? {} : { inputs: parsed.data.inputs }),
  });
  // 202: подтверждение запуска, не обещание идентификатора прогона — он
  // появится в обзоре обычным тактом наблюдателя, когда дочерний процесс
  // напишет журнал (`ui-daemon`, Решение 13).
  sendJson(res, 202, { ok: true });
};

export const row = screenRow('ui-run-launch', ['api'], (ctx) => {
  ctx.api.register('POST', '/api/run', handlePost);
});
