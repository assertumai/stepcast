import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { stringify } from 'yaml';

import { formatDuration, formatTokens } from '../units.js';
import type { Budget, Job, Pipeline, Step, Triggers } from './model.js';

/**
 * Сериализация раскрытого пайплайна в `pipeline.lock.yml`.
 *
 * Файл существует, чтобы прогон был воспроизводим и объясним: в нём нет ни
 * ссылок `uses`, ни подстановок `${inputs.*}` и `${params.*}`, ни умолчаний,
 * оставленных «где-то в конфигурации». Всё, чем движок руководствовался при
 * сборке пайплайна, видно в одном месте.
 *
 * Отложенные подстановки — `${run.*}`, `${jobs.*}`, `${env.*}` — остаются в
 * локе текстом: их значения появляются только по ходу прогона, у работы, а не
 * у пайплайна. Фактические пути и значения, с которыми шаг пошёл в файловую
 * систему, лежат в `jobs/<job>/resolved.json`. То же состояние — до раскрытия
 * отложенных подстановок — берётся ключом шага, и потому `jobLockHash`
 * считается от нераскрытого определения работы.
 */

function budgetToPlain(budget: Budget | undefined): Record<string, unknown> | undefined {
  if (budget === undefined) return undefined;
  return {
    ...(budget.tokens === undefined ? {} : { tokens: formatTokens(budget.tokens) }),
    ...(budget.wallclockMs === undefined ? {} : { wallclock: formatDuration(budget.wallclockMs) }),
    ...(budget.rateLimitPct === undefined ? {} : { rate_limit_pct: budget.rateLimitPct }),
    on_exceed: budget.onExceed,
  };
}

function triggersToPlain(triggers: Triggers | undefined): Record<string, unknown> | undefined {
  if (triggers === undefined) return undefined;
  return {
    schedule: triggers.schedule.map((entry) => ({
      ...(entry.cron === undefined ? {} : { cron: entry.cron }),
      ...(entry.timezone === undefined ? {} : { timezone: entry.timezone }),
    })),
  };
}

function stepToPlain(step: Step): Record<string, unknown> {
  const common = {
    id: step.id,
    index: step.index,
    timeout: formatDuration(step.timeoutMs),
    ...(Object.keys(step.env).length === 0 ? {} : { env: step.env }),
    ...(step.context.length === 0 ? {} : { context: step.context }),
    ...(step.contextInherit ? {} : { context_inherit: false }),
    ...(step.contextExclude.length === 0 ? {} : { context_exclude: step.contextExclude }),
    ...(step.contextMaxTokens === undefined
      ? {}
      : { context_max_tokens: formatTokens(step.contextMaxTokens) }),
    ...(step.budget === undefined ? {} : { budget: budgetToPlain(step.budget) }),
    ...(step.expect.length === 0 ? {} : { expect: step.expect }),
    attempts: {
      max: step.attempts.max,
      ...(step.attempts.escalation.length === 0 ? {} : { escalation: step.attempts.escalation }),
    },
  };

  if (step.kind === 'run') {
    return {
      ...common,
      run: step.command,
      ...(step.onFail === undefined ? {} : { on_fail: step.onFail }),
    };
  }

  return {
    ...common,
    agent: step.agent,
    ...(step.model === undefined ? {} : { model: step.model }),
    session: step.session,
    // Промпт кладётся целиком: без него по локу нельзя понять, что уйдёт агенту.
    prompt: step.prompt,
    ...(step.promptSource === undefined ? {} : { prompt_source: step.promptSource }),
    ...(step.outputSchemaPath === undefined ? {} : { output_schema: step.outputSchemaPath }),
    ...(step.permissions === undefined ? {} : { permissions: step.permissions }),
  };
}

export function jobToPlain(job: Job): Record<string, unknown> {
  return {
    id: job.id,
    ...(job.description === undefined ? {} : { description: job.description }),
    source: job.source,
    needs: job.needs,
    on: job.on,
    ...(job.if === undefined ? {} : { if: job.if }),
    session: job.session,
    workspace: job.workspace,
    ...(Object.keys(job.env).length === 0 ? {} : { env: job.env }),
    ...(job.context.length === 0 ? {} : { context: job.context }),
    context_upstream: job.contextUpstream,
    ...(job.output === undefined ? {} : { output: job.output }),
    ...(job.budget === undefined ? {} : { budget: budgetToPlain(job.budget) }),
    steps: job.steps.map(stepToPlain),
  };
}

export function pipelineToPlain(pipeline: Pipeline): Record<string, unknown> {
  return {
    version: 1,
    kind: 'pipeline.lock',
    name: pipeline.name,
    file: pipeline.file,
    inputs: pipeline.inputs,
    workspace: pipeline.workspace,
    ...(Object.keys(pipeline.env).length === 0 ? {} : { env: pipeline.env }),
    ...(pipeline.envFiles.length === 0 ? {} : { env_files: pipeline.envFiles }),
    env_deny: pipeline.envDeny,
    ...(pipeline.context.length === 0 ? {} : { context: pipeline.context }),
    context_upstream: pipeline.contextUpstream,
    ...(pipeline.budget === undefined ? {} : { budget: budgetToPlain(pipeline.budget) }),
    concurrency: pipeline.concurrency,
    fail_fast: pipeline.failFast,
    ...(pipeline.triggers === undefined ? {} : { triggers: triggersToPlain(pipeline.triggers) }),
    jobs: pipeline.jobs.map(jobToPlain),
  };
}

export function serializeLock(pipeline: Pipeline): string {
  return stringify(pipelineToPlain(pipeline), { lineWidth: 0 });
}

/**
 * Хеш определения одной работы: пайплайновые настройки, общие для всех
 * работ, плюс определение именно этой. Ключ шага держится на нём, а не на
 * хеше всего пайплайна, — иначе правка файла одной работы меняла бы ключи
 * шагов всех остальных, чьи определения не менялись.
 */
export function jobLockHash(pipeline: Pipeline, job: Job): string {
  const { jobs: _jobs, ...shared } = pipelineToPlain(pipeline);
  return createHash('sha256')
    .update(JSON.stringify({ shared, job: jobToPlain(job) }))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Хеш определения всего пайплайна. Ключ шага на нём больше не держится, но он
 * остаётся отпечатком прогона в манифесте и опорой совместимости с записями,
 * сделанными до перехода на хеш отдельной работы.
 */
export function pipelineLockHash(pipeline: Pipeline): string {
  return createHash('sha256').update(serializeLock(pipeline)).digest('hex').slice(0, 16);
}

export function writeLock(pipeline: Pipeline, path: string): void {
  writeFileSync(path, serializeLock(pipeline), { mode: 0o600 });
}
