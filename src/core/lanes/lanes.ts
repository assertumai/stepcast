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
  /** Каждая непропущенная работа дорожки завершилась `success`, и такая работа есть. */
  | { readonly kind: 'ready' }
  /** Хотя бы одна работа завершилась иначе, чем `success` или `skipped`. */
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

/**
 * Пропуск по решению графа годности не отменяет: у дорожки может быть
 * объявлено больше работ, чем ей положено пройти. Облегчённый пункт очереди
 * (`track: express`) ведёт свою ветку графа, а работы полной ветки — той же
 * метки `lane` — пропускаются условием `if`, и требование «все до одной
 * success» объявляло бы такую дорожку негодной ровно за то, ради чего она
 * заведена.
 *
 * Пропуск по остановке прогона (`skip: halted` — остановка после отказа,
 * неразрешённые зависимости) считается наравне с отказом: там дорожка не
 * прошла свою ветку до конца, и свести её значило бы наложить недоделанное.
 * Различает их журнал (`SKIP_KINDS`), а не догадка по тексту причины;
 * запись прошлого прогона, снятая до появления этого поля, пропуска не
 * объясняет — и трактуется строго, как прежде.
 */
export function evaluateLane(jobs: readonly JobRecord[], lane: string): LaneOutcome {
  const records = laneJobs(jobs, lane);
  if (records.length === 0) return { kind: 'unknown', known: knownLanes(jobs) };

  // Дорожка, пропущенная целиком, — прежний случай незаполненного слота, и
  // решается он до разбора происхождения: у записи старого прогона поля
  // `skip` нет вовсе, и различать там нечего.
  if (records.every((job) => job.status === 'skipped')) return { kind: 'empty' };

  const attempted = records.filter((job) => !(job.status === 'skipped' && job.skip === 'condition'));
  if (attempted.every((job) => job.status === 'success')) return { kind: 'ready' };

  return {
    kind: 'unfit',
    jobs: attempted
      .filter((job) => job.status !== 'success')
      .map((job) => ({ id: job.id, status: job.status })),
  };
}
