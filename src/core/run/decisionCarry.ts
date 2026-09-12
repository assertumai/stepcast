import { existsSync, readFileSync } from 'node:fs';

import { decisionRecordPath, type RunPaths } from '../journal/paths.js';
import { readEvents } from '../journal/reader.js';
import { DecisionRequestFileSchema, type DecisionRequestFile } from '../journal/schema.js';

/**
 * Решения, записанные прогону, чей процесс их уже не применил (дельта
 * `run-resume`, требование «Решение, записанное мёртвому прогону, применяется
 * при возобновлении»).
 *
 * `stepcast decide` пишет решение в каталог ИСХОДНОГО прогона и адресует его
 * ожиданию этого прогона; возобновление заводит новый каталог и новое
 * ожидание, а идентификатор ожидания несёт момент его начала (`decision.ts`,
 * `computeWaitId`) и совпасть не может даже при общем каталоге. Без переноса
 * возобновлённый прогон спросил бы человека второй раз — притом что команда
 * прямо сказала ему, что решение не потеряно.
 *
 * Перенос идёт по журналу исходного прогона, а не по его состоянию:
 * закончившийся прогон ничего не ждёт и перечень ожиданий в состоянии пуст
 * (дельта `step-execution`), а события помнят и объявленные ожидания, и
 * применённые решения. Решение считается неприменённым, если ожидание
 * объявлено, а события применения по нему нет.
 */

/** Решение исходного прогона, ждущее применения в новом. */
export interface CarriedDecision {
  readonly job: string;
  readonly step: string;
  /** Прогон, которому решение было записано. */
  readonly source: string;
  /** Ожидание исходного прогона, которому решение адресовано. */
  readonly waitId: string;
  readonly record: DecisionRequestFile;
}

/** Ключ переноса — работа и шаг: попытка и итерация у нового прогона свои. */
export function carriedKey(job: string, step: string): string {
  return `${job}/${step}`;
}

/**
 * Неприменённые решения исходного прогона. Помимо записей на диске переносятся
 * и решения, перенесённые в исходный прогон самого — иначе цепочка из двух
 * возобновлений теряла бы решение на втором звене.
 */
export function collectPendingDecisions(source: RunPaths, sourceRunId: string): CarriedDecision[] {
  /** Объявленные ожидания исходного прогона: идентификатор → работа и шаг. */
  const awaiting = new Map<string, { readonly job: string; readonly step: string }>();
  const pending = new Map<string, CarriedDecision>();

  for (const event of readEvents(source)) {
    if (event.kind === 'decision.awaiting') {
      awaiting.set(event.wait_id, { job: event.job, step: event.step });
      continue;
    }
    if (event.kind === 'decision.carried') {
      pending.set(carriedKey(event.job, event.step), {
        job: event.job,
        step: event.step,
        source: event.source,
        waitId: event.wait_id,
        record: {
          outcome: event.outcome,
          ...(event.reason === undefined ? {} : { reason: event.reason }),
          ...(event.restart_from === undefined ? {} : { restart_from: event.restart_from }),
        },
      });
      continue;
    }
    if (event.kind === 'decision.applied') {
      awaiting.delete(event.wait_id);
      pending.delete(carriedKey(event.job, event.step));
    }
  }

  // Запись на диске сильнее перенесённой: она свежее и адресована ожиданию
  // самого исходного прогона.
  for (const [waitId, identity] of awaiting) {
    const record = readDecisionRecord(source, waitId);
    if (record === undefined) continue;
    pending.set(carriedKey(identity.job, identity.step), {
      job: identity.job,
      step: identity.step,
      source: sourceRunId,
      waitId,
      record,
    });
  }

  return [...pending.values()];
}

/** Запись решения исходного прогона, если она есть и разбирается. */
function readDecisionRecord(paths: RunPaths, waitId: string): DecisionRequestFile | undefined {
  const path = decisionRecordPath(paths, waitId);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = DecisionRequestFileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    // Нечитаемая запись исходного прогона не отказывает возобновление: новый
    // прогон просто заведёт ожидание и спросит человека.
    return undefined;
  }
}
