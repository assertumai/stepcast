import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { z } from 'zod';

import { resolveConfig } from '../../../pipeline/config/resolve.js';
import { isStepcastError } from '../../../../kernel/errors.js';
import { listProjects } from '../../../pipeline/run/journal/reader.js';
import type { ProposalRecord } from '../../../pipeline/domain/proposals/entry.js';
import { acceptProposal, rejectProposal, resolveProposalTarget } from '../../../pipeline/domain/proposals/store.js';
import { readBody, sendJson } from '../../daemon/http.js';
import { screenRow, type ApiHandler } from '../registry.js';
import { declaration } from './declaration.js';

/**
 * Серверная половина экрана «Предложения» (`ui-proposals`, design.md Решение
 * 2, 15): `GET /api/proposals` отдаёт записи всех проектов вместе с текущим
 * содержимым цели — диф строит браузер (`src/parts/pipeline/domain/textDiff.ts`); `POST
 * /api/proposals` решает одну названную запись, принятие пишет цель и будит
 * наблюдателя.
 */

/** Запись, отданная маршрутом: та же запись плюс содержимое цели на диске сейчас. `null` — цели ещё нет (действие `create`). */
interface ProposalApiRecord extends ProposalRecord {
  readonly currentContent: string | null;
}

interface ProjectProposalsPayload {
  readonly projectKey: string;
  /** Действующий режим доставки этого проекта — виден на экране, чтобы «прямая запись» не было тихим состоянием (`ui-proposals`, «Действующий режим доставки MUST быть виден на экране»). */
  readonly mode: 'queue' | 'direct';
  readonly records: readonly ProposalApiRecord[];
  readonly invalid: readonly { readonly file: string; readonly reason: string }[];
}

/** Содержимое цели сейчас — `null`, если файла нет либо цель почему-то не разрешилась (гонка, правка руками). */
function currentContentOf(projectPath: string, target: string): string | null {
  try {
    const resolved = resolveProposalTarget(projectPath, target);
    if (!existsSync(resolved.absolutePath)) return null;
    return readFileSync(resolved.absolutePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Действующий режим доставки проекта. Неразбираемый `.stepcast/config.yml`
 * одного проекта не гасит очередь остальных: причина идёт негодной записью с
 * именем файла — тем же правилом, каким негодная запись очереди показывается
 * по имени и не отменяет чтения соседних (`ui-daemon`, «Наблюдение очереди её
 * не изменяет»). Режим при этом считается умолчанием `queue`: настройка
 * `direct` объявляется той самой конфигурацией, которая не прочиталась, а
 * значит, объявленной её считать нельзя.
 */
function deliveryMode(
  projectPath: string,
  home: string,
): { readonly mode: 'queue' | 'direct'; readonly failure?: { readonly file: string; readonly reason: string } } {
  try {
    return { mode: resolveConfig({ cwd: projectPath, home }).config.project.proposals };
  } catch (error) {
    const message = isStepcastError(error) ? error.message : (error as Error).message;
    return {
      mode: 'queue',
      failure: {
        file: '.stepcast/config.yml',
        reason: `конфигурация проекта не разбирается, режим доставки считается умолчанием queue: ${message}`,
      },
    };
  }
}

const handleGet: ApiHandler = (_req, res, env) => {
  const overview = env.watcher.currentProposals();
  const projectPaths = new Map(
    listProjects(env.runsRoot)
      .filter((project): project is { readonly key: string; readonly path: string } => project.path !== undefined)
      .map((project) => [project.key, project.path]),
  );

  const projects: ProjectProposalsPayload[] = [];
  for (const projectOverview of overview.projects) {
    const path = projectPaths.get(projectOverview.projectKey);
    if (path === undefined) continue;
    const delivery = deliveryMode(path, env.home ?? homedir());
    projects.push({
      projectKey: projectOverview.projectKey,
      mode: delivery.mode,
      records: projectOverview.records.map((record) => ({
        ...record,
        currentContent: currentContentOf(path, record.target),
      })),
      invalid: delivery.failure === undefined ? projectOverview.invalid : [...projectOverview.invalid, delivery.failure],
    });
  }

  sendJson(res, 200, { projects });
};

const PostBodySchema = z
  .object({
    project: z.string().min(1),
    id: z.string().min(1),
    decision: z.union([z.literal('accept'), z.literal('reject')]),
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
    sendJson(res, 400, { error: 'Тело запроса не соответствует формату: project, id и decision (accept|reject)' });
    return;
  }

  const project = listProjects(env.runsRoot).find((entry) => entry.key === parsed.data.project);
  if (project?.path === undefined) {
    sendJson(res, 400, { error: `Проект ${parsed.data.project} неизвестен указателю projects.json` });
    return;
  }

  try {
    const decided =
      parsed.data.decision === 'accept'
        ? acceptProposal(project.path, parsed.data.id)
        : rejectProposal(project.path, parsed.data.id);
    // Наблюдатель опрашивает каталог очереди раз в секунду — достаточно для
    // правки, сделанной мимо демона, но не для записи, которую демон только
    // что сделал сам (тот же приём, что у `src/parts/ui/screens/routes/server.ts`).
    env.watcher.poll();
    sendJson(res, 200, { ok: true, record: decided });
  } catch (error) {
    const message = isStepcastError(error) ? error.message : (error as Error).message;
    sendJson(res, isStepcastError(error) ? 400 : 500, { error: message });
  }
};

export const row = screenRow(declaration.id, ['screens', 'api'], (ctx) => {
  ctx.screens.register(declaration);
  ctx.api.register('GET', '/api/proposals', handleGet);
  ctx.api.register('POST', '/api/proposals', handlePost);
});
