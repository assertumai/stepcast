import { existsSync } from 'node:fs';
import type { ServerResponse } from 'node:http';

import { isRunAlive } from '../../../pipeline/run/journal/reader.js';
import { runPaths } from '../../../pipeline/run/journal/paths.js';
import { catchUpUsageRecords, catchUpUsageStore, readUsageStore } from '../../../pipeline/run/journal/usageStore.js';
import {
  removeRunWithStats,
  removeRuns,
  selectByAddresses,
  selectCandidates,
  type AddressedCandidate,
  type RunAddress,
  type SelectTraits,
  type StatsDisposition,
} from '../../../pipeline/run/cleanup.js';
import { isStepcastError } from '../../../../kernel/errors.js';
import { parseDuration } from '../../../../kernel/units.js';
import { INVALID, readBody, sendJson } from '../../daemon/http.js';
import { parseRunAddress } from '../../runAddress.js';
import { isSafeSegment } from '../../routes.js';
import { screenRow, type ApiHandler } from '../registry.js';
import { declaration } from './declaration.js';

/** Потолок числа адресов в групповом удалении: список сверх него — ошибка, не частичная работа. */
const MAX_RUN_ADDRESSES = 500;

const KNOWN_TRAITS = new Set(['abandoned', 'failed']);

/**
 * Судьба статистики при удалении файлов — `keep` умолчанием (design.md
 * изменения `run-stats-retention`, Решение 10): запрос, не назвавший её,
 * сохраняет статистику, а не отказывает и не снимает молча.
 */
function readStatsDisposition(url: URL): StatsDisposition | typeof INVALID {
  const raw = url.searchParams.get('stats');
  if (raw === null || raw === 'keep') return 'keep';
  return raw === 'drop' ? 'drop' : INVALID;
}

/**
 * Ответ на любой отбор — по признаку или по явным адресам: адрес, размер
 * каталога, возраст, число прогонов и суммарный объём. Общая точка, потому
 * что подтверждению группового удаления нужен ровно этот состав независимо
 * от того, чем прогоны названы.
 */
function sendRunSelection(
  res: ServerResponse,
  runsRoot: string,
  selected: readonly AddressedCandidate[],
  uncheckedCount: number,
): void {
  // Читается один раз на весь отбор: подтверждение должно отличать прогон, у
  // которого есть что сохранить сверх файлов, от того, у которого нет
  // (ui-dashboard, «Прогон без записи в хранилище»).
  const { records } = readUsageStore(runsRoot);

  sendJson(res, 200, {
    runs: selected.map((candidate) => ({
      address: candidate.address,
      sizeBytes: candidate.sizeBytes,
      ageMs: candidate.ageMs,
      endedAt: candidate.endedAt,
      unreadable: candidate.unreadable,
      hasUsageRecord: records.has(candidate.address),
    })),
    count: selected.length,
    totalBytes: selected.reduce((sum, candidate) => sum + candidate.sizeBytes, 0),
    uncheckedCount,
  });
}

/**
 * Отбор прогонов к групповому удалению — по признаку либо по явному списку
 * адресов, увиденных пользователем в списке прогонов (`run=<адрес>`,
 * повторяемый). Только отчёт: ничего не удаляется здесь.
 */
const handleSelectRuns: ApiHandler = (req, res, env) => {
  const url = new URL(req.url ?? '/', 'http://internal');
  const addressParams = url.searchParams.getAll('run');
  const hasTraitParams =
    url.searchParams.has('trait') || url.searchParams.has('older-than') || url.searchParams.has('project');

  if (addressParams.length > 0) {
    if (hasTraitParams) {
      sendJson(res, 400, {
        error: 'Параметр run не сочетается с trait, older-than или project: список адресов и признак — разные способы отбора',
      });
      return;
    }

    const distinct = [...new Set(addressParams)];
    if (distinct.length > MAX_RUN_ADDRESSES) {
      sendJson(res, 413, { error: `Список адресов превышает предел в ${MAX_RUN_ADDRESSES}` });
      return;
    }

    const addresses: RunAddress[] = [];
    for (const value of distinct) {
      const address = parseRunAddress(value);
      if (address === undefined) {
        sendJson(res, 400, { error: `Адрес прогона должен иметь вид <проект>/<прогон>: ${value}` });
        return;
      }
      addresses.push(address);
    }

    catchUpUsageRecords(env.runsRoot, addresses);
    sendRunSelection(res, env.runsRoot, selectByAddresses(env.runsRoot, addresses), 0);
    return;
  }

  const traits: { -readonly [K in keyof SelectTraits]: SelectTraits[K] } = {};

  for (const trait of url.searchParams.getAll('trait')) {
    if (!KNOWN_TRAITS.has(trait)) {
      sendJson(res, 400, {
        error: `Неизвестный признак отбора: ${trait}`,
        hint: 'Допустимые признаки: abandoned, failed',
      });
      return;
    }
    if (trait === 'abandoned') traits.abandoned = true;
    if (trait === 'failed') traits.failed = true;
  }

  const olderThan = url.searchParams.get('older-than');
  if (olderThan !== null) {
    try {
      traits.olderThanMs = parseDuration(olderThan, 'older-than');
    } catch (error) {
      const message = isStepcastError(error) ? error.message : 'Не удалось разобрать срок';
      sendJson(res, 400, { error: message });
      return;
    }
  }

  const project = url.searchParams.get('project');
  // Ключ проекта уходит в путь так же, как ключ из адреса прогона: без этой
  // проверки `?project=../..` перечислял бы каталоги вне корня прогонов.
  if (project !== null && !isSafeSegment(project)) {
    sendJson(res, 400, { error: 'Ключ проекта должен быть одним сегментом раскладки' });
    return;
  }

  const asked = traits.abandoned === true || traits.failed === true || traits.olderThanMs !== undefined;
  if (asked) catchUpUsageStore(env.runsRoot, project === null ? {} : { project });
  const { selected, uncheckedCount } = selectCandidates(env.runsRoot, traits, project === null ? {} : { project });
  sendRunSelection(res, env.runsRoot, selected, uncheckedCount);
};

/**
 * Удаление прогона из истории.
 *
 * Идущий прогон не удаляется: снести каталог под работающим движком значит
 * оставить его писать в никуда и потерять уже сделанное.
 */
const handleDelete: ApiHandler = (req, res, env) => {
  const url = new URL(req.url ?? '/', 'http://internal');
  const parsed = parseRunAddress(url.searchParams.get('run'));
  if (parsed === undefined) {
    sendJson(res, 400, { error: 'Адрес прогона должен иметь вид <проект>/<прогон>' });
    return;
  }

  const stats = readStatsDisposition(url);
  if (stats === INVALID) {
    sendJson(res, 400, { error: 'stats должен быть keep или drop' });
    return;
  }

  const paths = runPaths(env.runsRoot, parsed.key, parsed.runId);
  if (!existsSync(paths.dir)) {
    sendJson(res, 404, { error: `Прогон ${parsed.runId} не найден` });
    return;
  }

  if (isRunAlive(paths)) {
    sendJson(res, 409, { error: 'Прогон идёт: остановите его, прежде чем удалять' });
    return;
  }

  const result = removeRunWithStats(env.runsRoot, parsed.key, parsed.runId, stats);
  // Обзор пересобирается сразу: иначе удалённый прогон повисит на экране до
  // следующего опроса, и пользователь решит, что удаление не сработало.
  env.watcher.poll();
  sendJson(res, 200, {
    removed: `${parsed.key}/${parsed.runId}`,
    stats: result.stats,
    ...(result.unresolvedWorktrees.length === 0 ? {} : { unresolvedWorktrees: result.unresolvedWorktrees }),
    ...(result.preservedWorkspaces.length === 0 ? {} : { preservedWorkspaces: result.preservedWorkspaces }),
  });
};

/**
 * Групповое удаление по явному списку адресов.
 *
 * Список приходит с отбора, увиденного пользователем в подтверждении, а не с
 * признака: между показом и принятием отбор мог измениться, а удалиться
 * должно ровно то, что пользователь видел.
 */
const handleDeleteRuns: ApiHandler = async (req, res, env) => {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 413, { error: 'Тело запроса слишком велико' });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body === '' ? '{}' : body);
  } catch {
    sendJson(res, 400, { error: 'Тело запроса не разбирается как JSON' });
    return;
  }

  const list = (parsed as { runs?: unknown }).runs;
  if (!Array.isArray(list) || list.some((item) => typeof item !== 'string')) {
    sendJson(res, 400, { error: 'Тело запроса должно нести список адресов: { "runs": string[] }' });
    return;
  }

  const statsField = (parsed as { stats?: unknown }).stats;
  if (statsField !== undefined && statsField !== 'keep' && statsField !== 'drop') {
    sendJson(res, 400, { error: 'Поле stats должно быть keep или drop' });
    return;
  }
  const stats: StatsDisposition = statsField === 'drop' ? 'drop' : 'keep';

  if (list.length > MAX_RUN_ADDRESSES) {
    sendJson(res, 413, { error: `Список адресов превышает предел в ${MAX_RUN_ADDRESSES}` });
    return;
  }

  const addresses: RunAddress[] = [];
  for (const value of list as string[]) {
    const address = parseRunAddress(value);
    if (address === undefined) {
      sendJson(res, 400, { error: `Адрес прогона должен иметь вид <проект>/<прогон>: ${value}` });
      return;
    }
    addresses.push(address);
  }

  const summary = removeRuns(env.runsRoot, addresses, stats);
  // Одна пересборка на всю группу, а не на каждый прогон: наблюдатель не
  // должен просыпаться сотни раз за один запрос.
  env.watcher.poll();
  sendJson(res, 200, summary);
};

export const row = screenRow(declaration.id, ['screens', 'api'], (ctx) => {
  ctx.screens.register(declaration);
  ctx.api.register('GET', '/api/runs', handleSelectRuns);
  ctx.api.register('DELETE', '/api/run', handleDelete);
  ctx.api.register('DELETE', '/api/runs', handleDeleteRuns);
});
