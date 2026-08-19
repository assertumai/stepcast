import type { RunStatus, StepRecord } from '../journal/schema.js';
import { readExpectReports } from '../journal/reader.js';
import type { RunPaths } from '../journal/paths.js';

/**
 * Выдержка о прошлом отказе для первого переисполняемого шага.
 *
 * Переносится ровно то, что помогает починить причину: какой шаг упал, какие
 * предикаты не прошли и что они увидели. Протокол попыток не переносится
 * намеренно — три неудачных подхода прошлого прогона в контексте нового дают
 * шум и подталкивают повторить их же.
 */
export interface PreviousFailure {
  readonly text: string;
  readonly job: string;
  readonly step: string;
}

export function buildPreviousFailure(
  paths: RunPaths,
  status: RunStatus,
): PreviousFailure | undefined {
  const job = status.jobs.find((item) => item.status === 'failed' || item.status === 'canceled');
  if (job === undefined) return undefined;

  const step = job.steps.find((item) => item.status !== 'success' && item.status !== 'skipped');
  if (step === undefined) return undefined;

  const lines = [
    '# Прошлый прогон не дошёл до конца',
    '',
    `Работа \`${job.id}\`, шаг \`${step.id}\`: ${step.status}${
      step.cause === undefined ? '' : ` (${step.cause})`
    }.`,
  ];

  if (step.reason !== undefined) {
    lines.push('', `Причина: ${step.reason}`);
  }

  const failed = failedPredicates(paths, job.id, step);
  if (failed.length > 0) {
    lines.push('', '## Непройденные проверки', '');
    for (const item of failed) lines.push(`- \`${item.predicate}\`: ${item.detail}`);
  }

  lines.push(
    '',
    'Почини причину, а не симптом. Протокол попыток прошлого прогона сюда не переносится намеренно.',
  );

  return { text: lines.join('\n'), job: job.id, step: step.id };
}

function failedPredicates(
  paths: RunPaths,
  jobId: string,
  step: StepRecord,
): { predicate: string; detail: string }[] {
  const reports = readExpectReports(paths, jobId, step.id);
  const last = reports.at(-1);
  if (last === undefined) return [];

  return last.results
    .filter((result) => !result.passed && result.hard)
    .map((result) => ({
      predicate: result.predicate,
      detail:
        result.detail ??
        (result.expected === undefined
          ? 'не пройдена'
          : `ожидалось ${JSON.stringify(result.expected)}, получено ${JSON.stringify(result.actual)}`),
    }));
}
