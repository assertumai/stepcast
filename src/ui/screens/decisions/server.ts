import { z } from 'zod';

import { listProjects, readStatus } from '../../../core/journal/reader.js';
import { runPaths } from '../../../core/journal/paths.js';
import { isStepcastError } from '../../../core/errors.js';
import { selectAwaiting, validateDecision } from '../../../core/run/decision.js';
import { readBody, sendJson } from '../../http.js';
import { parseRunAddress } from '../../runAddress.js';
import { screenRow, type ApiHandler } from '../registry.js';
import { declaration } from './declaration.js';

/**
 * `POST /api/run/decision` (`user-decision-steps`, design.md решение 5, 11):
 * демон не пишет ни одного файла прогона — он проверяет запрос по его
 * состоянию (ожидание существует, исход в перечне, `reject` несёт причину,
 * `restart` называет шаг) и порождает `stepcast decide` отсоединённым
 * процессом, тем же приёмом, каким `POST /api/run` порождает `stepcast run`.
 *
 * Проверка здесь лёгкая: существование названного шага перезапуска в составе
 * пайплайна не проверяется — это значило бы разворачивать пайплайн ради
 * одного маршрута. Настоящая проверка — в `stepcast decide`, которую этот
 * маршрут порождает следом, по свежему состоянию (design.md, риски).
 */

const PostBodySchema = z
  .object({
    run: z.string().min(1),
    outcome: z.string().min(1),
    step: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
    from: z.string().min(1).optional(),
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
    sendJson(res, 400, { error: 'Тело запроса не соответствует формату: run, outcome и, по надобности, step, reason, from' });
    return;
  }

  const address = parseRunAddress(parsed.data.run);
  if (address === undefined) {
    sendJson(res, 400, { error: 'run должен иметь вид <проект>/<прогон>' });
    return;
  }

  const project = listProjects(env.runsRoot).find((entry) => entry.key === address.key);
  if (project?.path === undefined) {
    sendJson(res, 400, { error: `Проект ${address.key} неизвестен указателю projects.json` });
    return;
  }

  const paths = runPaths(env.runsRoot, address.key, address.runId);
  let awaiting: ReturnType<typeof readStatus>['awaiting'];
  try {
    awaiting = readStatus(paths).awaiting;
  } catch {
    sendJson(res, 404, { error: `Прогон ${address.runId} не найден` });
    return;
  }

  try {
    const found = selectAwaiting(awaiting ?? [], parsed.data.step);
    validateDecision(
      found,
      {
        outcome: parsed.data.outcome,
        ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }),
        ...(parsed.data.from === undefined ? {} : { restartFrom: parsed.data.from }),
      },
      // Без knownSteps: существование шага проверит `stepcast decide`.
      undefined,
    );
  } catch (error) {
    sendJson(res, 400, { error: isStepcastError(error) ? error.message : 'Решение не проходит проверку' });
    return;
  }

  env.launchDecide({
    cwd: project.path,
    run: address.runId,
    outcome: parsed.data.outcome,
    ...(parsed.data.step === undefined ? {} : { step: parsed.data.step }),
    ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }),
    ...(parsed.data.from === undefined ? {} : { from: parsed.data.from }),
  });
  // 202: подтверждение приёма, не обещание применения (design.md, риски) —
  // настоящую проверку и запись сделает порождённая команда.
  sendJson(res, 202, { ok: true });
};

export const row = screenRow(declaration.id, ['screens', 'api'], (ctx) => {
  ctx.screens.register(declaration);
  ctx.api.register('POST', '/api/run/decision', handlePost);
});
