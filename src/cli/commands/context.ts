import { existsSync, readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

import { resolveConfig } from '../../core/config/resolve.js';
import type { Registry } from '../../core/plugins/registry.js';
import { expandPipeline } from '../../core/pipeline/expand.js';
import type { Job } from '../../core/pipeline/model.js';
import { assembleContext, type Origin, type UpstreamOutput } from '../../core/context/assemble.js';
import { createKnowledgeSource } from '../../core/knowledge/source.js';
import { findProjectRoot } from '../../core/journal/paths.js';
import { resolveRun } from '../../core/journal/reader.js';
import { formatTokens } from '../../core/units.js';
import { StepcastError, ExitCode, type ExitCodeValue } from '../../core/errors.js';
import { formatColumns } from '../output.js';
import type { ParsedArgs } from '../args.js';

const LEVEL_LABEL: Record<Origin, string> = {
  upstream: 'выходы предшественников',
  pipeline: 'пайплайн',
  job: 'работа',
  step: 'шаг',
};

/**
 * `stepcast context` вычисляет состав и размер контекста агентского шага без
 * запуска пайплайна и без обращения к бэкенду — тот же `assembleContext`, что
 * формирует `context.json` при живом прогоне.
 */
export function runContextCommand(
  args: ParsedArgs,
  write: (line: string) => void,
  cwd: string,
  registry?: Registry,
): ExitCodeValue {
  const jobId = args.flags.job as string | undefined;
  const stepId = args.flags.step as string | undefined;
  if (jobId === undefined || stepId === undefined) {
    throw new StepcastError('Команда context требует --job и --step', {
      hint: 'stepcast context --job <job> --step <step>',
    });
  }

  const target = args.positional[0] ?? 'stepcast.yml';
  const pipelinePath = resolvePath(cwd, target);
  const { config } = resolveConfig({ cwd });
  const inputs = (args.flags.input as Record<string, string> | undefined) ?? {};

  // Ошибка на отсутствующем обязательном входе прокидывается как есть — то же
  // сообщение, что дал бы lint.
  const { pipeline } = expandPipeline({ pipelinePath, config, inputs, ...(registry === undefined ? {} : { registry }) });

  const job = pipeline.jobs.find((item) => item.id === jobId);
  if (job === undefined) {
    throw new StepcastError(`Работа ${jobId} не найдена`, { file: pipelinePath });
  }
  const step = job.steps.find((item) => item.id === stepId);
  if (step === undefined) {
    throw new StepcastError(`Шаг ${stepId} не найден в работе ${jobId}`, { file: pipelinePath });
  }
  if (step.kind !== 'agent') {
    throw new StepcastError(`Шаг ${stepId} командный, контекст не собирается`, {
      hint: 'context доступен только для агентских шагов',
    });
  }

  const { outputs, known } = readUpstreamOutputs(config.runs.root, findProjectRoot(cwd), pipeline.jobs, job);

  const knowledgeSource = createKnowledgeSource({
    knowledge: pipeline.knowledge,
    root: cwd,
    specDir: config.project.spec.dir,
  });

  const assembled = assembleContext({
    workspace: cwd,
    pipeline: pipeline.context,
    job: job.context,
    step: step.context,
    upstream: outputs,
    contextUpstream: job.contextUpstream,
    inherit: step.contextInherit,
    exclude: step.contextExclude,
    deny: config.context.deny,
    inlineThreshold: config.context.inlineThreshold,
    // Выдержки о прошлой итерации в предпросмотре нет — её собирает прогон,
    // так что и предел выдержки здесь ничего не ограничивает.
    maxTokens: step.contextMaxTokens ?? config.context.maxTokens,
    // Источник тот же, что в прогоне: предпросмотр, не зовущий его, врал бы
    // о составе ровно на тех записях, ради которых память и заводили.
    ...(knowledgeSource === undefined
      ? {}
      : {
          knowledge: (selector, budget) =>
            knowledgeSource.select(
              budget === undefined || selector.kind === 'index' ? selector : { ...selector, budget },
            ),
        }),
  });

  const totals = new Map<Origin, number>();
  for (const entry of assembled.report.entries) {
    totals.set(entry.origin, (totals.get(entry.origin) ?? 0) + entry.tokens);
  }

  const rows: string[][] = [
    [
      LEVEL_LABEL.upstream,
      known ? `${formatTokens(totals.get('upstream') ?? 0)} ток.` : 'неизвестно',
    ],
    [LEVEL_LABEL.pipeline, `${formatTokens(totals.get('pipeline') ?? 0)} ток.`],
    [`${LEVEL_LABEL.job} ${job.id}`, `${formatTokens(totals.get('job') ?? 0)} ток.`],
    [`${LEVEL_LABEL.step} ${step.id}`, `${formatTokens(totals.get('step') ?? 0)} ток.`],
    ['итого', `${formatTokens(assembled.report.total_tokens)} ток.`],
  ];
  for (const line of formatColumns(rows)) write(line);

  // Разрез по уровням относит склеенную запись целиком к уровню её места,
  // поэтому уровень повторного объявления выглядит тоньше, чем объявлено.
  // Без этого перечня разница между «не объявлено» и «объявлено, но склеено»
  // из вывода не читается.
  const merged = assembled.report.entries.filter((entry) => entry.declared_in !== undefined);
  if (merged.length > 0) {
    write('');
    write('склеенные записи (объявлены на нескольких уровнях):');
    const mergedRows = merged.map((entry) => [
      // У записи знания пути может не быть вовсе (оглавление), и называть её
      // пустой строкой значило бы показать склейку, не сказав, чего именно.
      `  ${entry.path ?? entry.id ?? ''}`,
      (entry.declared_in ?? []).map((level) => LEVEL_LABEL[level]).join(', '),
    ]);
    for (const line of formatColumns(mergedRows)) write(line);
  }

  return ExitCode.ok;
}

/**
 * Выходы предшественников из `artifacts/<job>.json` последнего прогона.
 * Если прогонов ещё не было или ни один предшественник ничего не
 * опубликовал — уровень помечается неизвестным, а не нулевым.
 */
function readUpstreamOutputs(
  runsRoot: string,
  projectRoot: string,
  jobs: readonly Job[],
  target: Job,
): { outputs: UpstreamOutput[]; known: boolean } {
  let paths;
  try {
    paths = resolveRun(runsRoot, projectRoot, 'latest');
  } catch {
    return { outputs: [], known: false };
  }

  const outputs: UpstreamOutput[] = [];
  for (const job of jobs) {
    if (job.id === target.id) continue;
    const path = join(paths.artifacts, `${job.id}.json`);
    if (!existsSync(path)) continue;
    outputs.push({ job: job.id, path, value: JSON.parse(readFileSync(path, 'utf8')) as unknown });
  }

  return { outputs, known: outputs.length > 0 };
}
