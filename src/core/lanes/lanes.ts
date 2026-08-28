import type { JobRecord, StatusValue } from '../journal/schema.js';

/**
 * Годность дорожки к сведению — решается по меткам `job.lane` и их исходам,
 * никогда по имени работы. Имя работы автор пайплайна волен выбрать как
 * угодно, и решение о сведении не должно зависеть от угаданного суффикса —
 * именно такая склейка (`verify-${lane}`) молча теряла зелёную дорожку до
 * этого модуля.
 */

export interface LaneJobStatus {
  readonly id: string;
  readonly status: StatusValue;
}

export type LaneOutcome =
  /** Каждая работа дорожки завершилась `success`. */
  | { readonly kind: 'ready' }
  /** Хотя бы одна работа завершилась иначе, чем `success`, но не все — `skipped`. */
  | { readonly kind: 'unfit'; readonly jobs: readonly LaneJobStatus[] }
  /** Все работы дорожки `skipped` — слот, которому не достался пункт очереди. */
  | { readonly kind: 'empty' }
  /** В прогоне нет ни одной работы с этой меткой `lane`. */
  | { readonly kind: 'unknown'; readonly known: readonly string[] };

/** Работы дорожки в порядке `status.jobs`. */
export function laneJobs(jobs: readonly JobRecord[], lane: string): readonly JobRecord[] {
  return jobs.filter((job) => job.lane === lane);
}

/** Дорожки, известные прогону: метки `lane`, встреченные хотя бы у одной работы. */
export function knownLanes(jobs: readonly JobRecord[]): readonly string[] {
  const lanes = new Set<string>();
  for (const job of jobs) {
    if (job.lane !== undefined) lanes.add(job.lane);
  }
  return [...lanes];
}

export function evaluateLane(jobs: readonly JobRecord[], lane: string): LaneOutcome {
  const records = laneJobs(jobs, lane);
  if (records.length === 0) return { kind: 'unknown', known: knownLanes(jobs) };

  if (records.every((job) => job.status === 'skipped')) return { kind: 'empty' };
  if (records.every((job) => job.status === 'success')) return { kind: 'ready' };

  return {
    kind: 'unfit',
    jobs: records
      .filter((job) => job.status !== 'success')
      .map((job) => ({ id: job.id, status: job.status })),
  };
}
