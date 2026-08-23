import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';

import type { Config } from '../config/resolve.js';
import { StepcastError } from '../errors.js';
import { parseDuration, parseTokens } from '../units.js';
import { interpolateTree, type Scope } from './interpolate.js';
import { readYamlDocument, rejectWiringKeys, validateDocument } from './load.js';
import { resolveParams, type ParamValue } from './params.js';
import {
  JobDocumentSchema,
  PipelineDocumentSchema,
  type JobEntry,
  type PipelineDocument,
  type RawBudget,
  type RawContextEntry,
  type RawAgentStep,
  type RawPredicate,
  type RawStep,
} from './schema.js';
import type {
  Attempts,
  Budget,
  ContextEntry,
  ContextUpstream,
  ExpandedPipeline,
  Job,
  Pipeline,
  Predicate,
  Step,
  Permissions,
  Substitution,
  Workspace,
} from './model.js';

/** Пространства, чьи значения известны только в прогоне. */
const DEFERRED_NAMESPACES = new Set(['jobs', 'run', 'env']);

export interface ExpandOptions {
  readonly pipelinePath: string;
  readonly config: Config;
  /** Значения `--input`, как их передал пользователь. */
  readonly inputs?: Readonly<Record<string, ParamValue>>;
}

function toBudget(raw: RawBudget, at: string): Budget {
  const onExceed = raw.on_exceed ?? 'stop';

  return {
    ...(raw.tokens === undefined ? {} : { tokens: parseTokens(raw.tokens, `${at}.tokens`) }),
    ...(raw.wallclock === undefined
      ? {}
      : { wallclockMs: parseDuration(raw.wallclock, `${at}.wallclock`) }),
    ...(raw.rate_limit_pct === undefined ? {} : { rateLimitPct: raw.rate_limit_pct }),
    onExceed,
  };
}

function toContext(raw: readonly RawContextEntry[] | undefined): ContextEntry[] {
  return (raw ?? []).map((entry) => {
    if (typeof entry === 'string') return { kind: 'path', path: entry, mode: 'auto' };
    if ('text' in entry) return { kind: 'text', text: entry.text };
    return { kind: 'path', path: entry.path, mode: entry.mode ?? 'auto' };
  });
}

/**
 * Путь схемы разрешается от файла объявления — тем же правилом, что
 * `output_schema` шага и `output.schema` работы. Путь `file_exists` остаётся
 * сырым: он указывает на файл, созданный шагом, а тот появляется в рабочей
 * директории.
 */
function toPredicate(raw: RawPredicate, declaringFile: string): Predicate {
  if ('exit_code' in raw) return { kind: 'exit_code', value: raw.exit_code };
  if ('file_exists' in raw) return { kind: 'file_exists', path: raw.file_exists };
  if ('schema' in raw) {
    return { kind: 'schema', path: resolveDeclaredPath(raw.schema, declaringFile) };
  }
  if ('matches' in raw) return { kind: 'matches', pattern: raw.matches };
  if ('not_matches' in raw) return { kind: 'not_matches', pattern: raw.not_matches };
  if ('changed_only' in raw) return { kind: 'changed_only', globs: raw.changed_only };
  if ('cmd' in raw) return { kind: 'cmd', command: raw.cmd };
  return {
    kind: 'judge',
    claim: raw.judge,
    hard: raw.hard ?? false,
    ...(raw.agent === undefined ? {} : { agent: raw.agent }),
    ...(raw.model === undefined ? {} : { model: raw.model }),
  };
}

function toPermissions(raw: NonNullable<RawAgentStep['permissions']>): Permissions {
  return {
    ...(raw.mode === undefined ? {} : { mode: raw.mode }),
    ...(raw.allow === undefined ? {} : { allow: raw.allow }),
    ...(raw.deny === undefined ? {} : { deny: raw.deny }),
  };
}

function toAttempts(raw: RawStep['attempts'], limits: Config['limits'], at: string): Attempts {
  const max = raw?.max ?? 1;
  if (max > limits.attempts) {
    throw new StepcastError(
      `attempts.max = ${max} превышает потолок limits.attempts = ${limits.attempts}`,
      { at: `${at}.attempts.max`, hint: 'Поднимите потолок в конфигурации или уменьшите число попыток' },
    );
  }
  return {
    max,
    escalation: (raw?.escalation ?? []).map((item) => ({
      includeFailure: item.include_failure ?? false,
      ...(item.model === undefined ? {} : { model: item.model }),
    })),
  };
}

/** Путь к файлу, объявленному в документе: разрешается от самого документа. */
function resolveDeclaredPath(value: string, declaringFile: string): string {
  return isAbsolute(value) ? value : resolvePath(dirname(declaringFile), value);
}

function readPrompt(value: string, declaringFile: string, scope: Scope, at: string): {
  text: string;
  source?: string;
} {
  if (!value.startsWith('file:')) {
    return { text: interpolateTree(value, scope, at).value };
  }

  const path = resolveDeclaredPath(value.slice('file:'.length), declaringFile);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new StepcastError(`Не удалось прочитать файл промпта: ${(error as Error).message}`, {
      file: declaringFile,
      at,
      cause: error,
    });
  }
  return { text: interpolateTree(raw, scope, at).value, source: path };
}

interface StepDefaults {
  readonly agent: string;
  readonly model: string | undefined;
  readonly timeoutMs: number;
  readonly sessionMode: 'shared' | 'per_step';
}

function toStep(
  raw: RawStep,
  index: number,
  declaringFile: string,
  scope: Scope,
  defaults: StepDefaults,
  config: Config,
  at: string,
): Step {
  const common = {
    id: raw.id,
    index: index + 1,
    env: raw.env ?? {},
    context: toContext(raw.context),
    contextInherit: raw.context_inherit ?? true,
    contextExclude: raw.context_exclude ?? [],
    ...(raw.context_max_tokens === undefined
      ? {}
      : { contextMaxTokens: parseTokens(raw.context_max_tokens, `${at}.context_max_tokens`) }),
    timeoutMs:
      raw.timeout === undefined ? defaults.timeoutMs : parseDuration(raw.timeout, `${at}.timeout`),
    ...(raw.budget === undefined ? {} : { budget: toBudget(raw.budget, `${at}.budget`) }),
    expect: (raw.expect ?? []).map((entry) => toPredicate(entry, declaringFile)),
    attempts: toAttempts(raw.attempts, config.limits, at),
  };

  if ('run' in raw) {
    return {
      ...common,
      kind: 'run',
      command: raw.run,
      ...(raw.on_fail === undefined
        ? {}
        : {
            onFail: {
              analyze: raw.on_fail.analyze,
              prompt: readPrompt(raw.on_fail.prompt, declaringFile, scope, `${at}.on_fail.prompt`).text,
            },
          }),
    };
  }

  const prompt = readPrompt(raw.prompt, declaringFile, scope, `${at}.prompt`);
  const agent = raw.agent ?? defaults.agent;
  const backend = config.backends[agent];
  const model = raw.model ?? defaults.model ?? backend?.defaultModel;

  return {
    ...common,
    kind: 'agent',
    agent,
    ...(model === undefined ? {} : { model }),
    // Псевдоним сессии: явный побеждает всегда, иначе одна общая на работу
    // либо своя на каждый шаг — по режиму работы.
    session: raw.session ?? (defaults.sessionMode === 'shared' ? 'default' : raw.id),
    prompt: prompt.text,
    ...(prompt.source === undefined ? {} : { promptSource: prompt.source }),
    ...(raw.output_schema === undefined
      ? {}
      : { outputSchemaPath: resolveDeclaredPath(raw.output_schema, declaringFile) }),
    ...(raw.permissions === undefined ? {} : { permissions: toPermissions(raw.permissions) }),
  };
}

/**
 * Раскрыть пайплайн: подставить значения, втянуть подключённые работы,
 * применить умолчания. Результат самодостаточен — исходные документы больше
 * не нужны.
 */
export function expandPipeline(options: ExpandOptions): ExpandedPipeline {
  const { config } = options;
  const pipelinePath = resolvePath(options.pipelinePath);

  const document = validateDocument(
    PipelineDocumentSchema,
    readYamlDocument(pipelinePath),
    pipelinePath,
  ) as PipelineDocument;

  const inputs = resolveParams(document.inputs ?? {}, options.inputs ?? {}, {
    file: pipelinePath,
    what: 'inputs',
  });

  const pipelineScope: Scope = {
    values: { inputs },
    deferred: DEFERRED_NAMESPACES,
  };

  const substitutions = new Map<string, readonly Substitution[]>();
  const collect = (map: ReadonlyMap<string, readonly Substitution[]>): void => {
    for (const [path, list] of map) substitutions.set(path, list);
  };

  const pipelineWorkspace: Workspace = {
    mode: document.workspace?.mode ?? config.defaults.workspace.mode,
    ...(document.workspace?.path === undefined ? {} : { path: document.workspace.path }),
  };

  const defaultSession = document.defaults?.session ?? config.defaults.session;
  const defaultAgent = document.defaults?.agent ?? config.defaults.agent;
  const defaultModel = document.defaults?.model ?? config.defaults.model;

  const jobs: Job[] = [];

  for (const [id, entryRaw] of Object.entries(document.jobs)) {
    const at = `jobs.${id}`;
    const entry = entryRaw as JobEntry;

    // Обвязка живёт на месте подключения и подставляется в области пайплайна.
    const wiring = interpolateTree(
      {
        needs: 'needs' in entry ? entry.needs : undefined,
        on: 'on' in entry ? entry.on : undefined,
        if: 'if' in entry ? entry.if : undefined,
      },
      pipelineScope,
      at,
    );
    collect(wiring.substitutions);

    let body: Record<string, unknown>;
    let declaringFile: string;
    let bodyScope: Scope;

    if ('uses' in entry) {
      const usesPath = resolveDeclaredPath(
        interpolateTree(entry.uses, pipelineScope, `${at}.uses`).value,
        pipelinePath,
      );
      const rawDocument = readYamlDocument(usesPath);
      rejectWiringKeys(rawDocument, usesPath);
      const jobDocument = validateDocument(JobDocumentSchema, rawDocument, usesPath);

      const withValues = interpolateTree(entry.with ?? {}, pipelineScope, `${at}.with`);
      collect(withValues.substitutions);

      const params = resolveParams(jobDocument.params ?? {}, withValues.value, {
        file: pipelinePath,
        what: 'with',
        owner: at,
      });

      declaringFile = usesPath;
      bodyScope = {
        values: { params },
        deferred: DEFERRED_NAMESPACES,
        hints: {
          // Работа не видит inputs намеренно: иначе она привязана к одному
          // пайплайну и перестаёт быть переиспользуемой.
          inputs: 'Работе недоступны inputs пайплайна — передайте значение через with и объявите его в params',
        },
      };

      const { params: _params, kind: _kind, version: _version, ...rest } = jobDocument;
      const interpolated = interpolateTree(rest as Record<string, unknown>, bodyScope, at);
      collect(interpolated.substitutions);
      body = interpolated.value;

      // Переопределения с места подключения накладываются поверх файла работы.
      const overrides = interpolateTree(
        {
          ...(entry.description === undefined ? {} : { description: entry.description }),
          ...(entry.session === undefined ? {} : { session: entry.session }),
          ...(entry.workspace === undefined ? {} : { workspace: entry.workspace }),
          ...(entry.env === undefined ? {} : { env: { ...(body.env as object), ...entry.env } }),
          ...(entry.context === undefined ? {} : { context: entry.context }),
          ...(entry.context_upstream === undefined ? {} : { context_upstream: entry.context_upstream }),
          ...(entry.budget === undefined ? {} : { budget: entry.budget }),
        },
        pipelineScope,
        at,
      );
      collect(overrides.substitutions);
      body = { ...body, ...overrides.value };
    } else {
      declaringFile = pipelinePath;
      bodyScope = pipelineScope;
      const { needs: _needs, on: _on, if: _if, ...rest } = entry;
      const interpolated = interpolateTree(rest as Record<string, unknown>, pipelineScope, at);
      collect(interpolated.substitutions);
      body = interpolated.value;
    }

    const sessionMode = (body.session as 'shared' | 'per_step' | undefined) ?? defaultSession;
    const workspace = (body.workspace as Workspace | undefined) ?? pipelineWorkspace;
    const rawSteps = body.steps as RawStep[];

    const until = body.until as { max_iterations?: number; check: RawPredicate[] } | undefined;
    if (until !== undefined && until.max_iterations === undefined) {
      throw new StepcastError('Цикл until объявлен без max_iterations', {
        file: declaringFile,
        at: `${at}.until.max_iterations`,
        hint: 'Без предела итераций худший случай работы неограничен',
      });
    }
    if (until !== undefined && until.check.length === 0) {
      throw new StepcastError('Цикл until объявлен с пустым check', {
        file: declaringFile,
        at: `${at}.until.check`,
        hint: 'Условие выхода из цикла должно быть хотя бы одно',
      });
    }

    const output = body.output as { from?: string; schema?: string } | undefined;
    if (output !== undefined && output.from === undefined) {
      const lastAgent = [...rawSteps].reverse().find((step) => !('run' in step));
      if (lastAgent === undefined) {
        throw new StepcastError('Работа объявляет output без from и не содержит агентских шагов', {
          file: declaringFile,
          at: `${at}.output`,
          hint: 'Укажите output.from или добавьте агентский шаг',
        });
      }
    }

    jobs.push({
      id,
      ...(body.description === undefined ? {} : { description: body.description as string }),
      source: declaringFile,
      needs: (wiring.value.needs as readonly string[] | 'all' | undefined) ?? [],
      on: (wiring.value.on as Job['on'] | undefined) ?? 'success',
      ...(wiring.value.if === undefined ? {} : { if: wiring.value.if as string }),
      session: sessionMode,
      workspace,
      env: (body.env as Record<string, string> | undefined) ?? {},
      context: toContext(body.context as RawContextEntry[] | undefined),
      contextUpstream:
        (body.context_upstream as ContextUpstream | undefined) ?? document.context_upstream ?? 'all',
      inputs: (body.inputs as readonly string[] | undefined) ?? [],
      ...(until === undefined
        ? {}
        : {
            until: {
              maxIterations: until.max_iterations as number,
              check: until.check.map((entry) => toPredicate(entry, declaringFile)),
            },
          }),
      ...(output === undefined
        ? {}
        : {
            output: {
              ...(output.from === undefined ? {} : { from: output.from }),
              ...(output.schema === undefined
                ? {}
                : { schemaPath: resolveDeclaredPath(output.schema, declaringFile) }),
            },
          }),
      ...(body.budget === undefined
        ? {}
        : { budget: toBudget(body.budget as RawBudget, `${at}.budget`) }),
      steps: rawSteps.map((step, index) =>
        toStep(
          step,
          index,
          declaringFile,
          bodyScope,
          {
            agent: defaultAgent,
            model: defaultModel,
            timeoutMs: config.defaults.stepTimeoutMs,
            sessionMode,
          },
          config,
          `${at}.steps.${index}`,
        ),
      ),
    });
  }

  const pipeline: Pipeline = {
    name: document.name ?? 'pipeline',
    file: pipelinePath,
    inputs,
    workspace: pipelineWorkspace,
    env: document.env ?? {},
    envFiles: document.env_files ?? [],
    envDeny: [...config.envDeny, ...(document.env_deny ?? [])],
    context: toContext(document.context),
    contextUpstream: document.context_upstream ?? 'all',
    ...(document.budget === undefined ? {} : { budget: toBudget(document.budget, 'budget') }),
    concurrency: document.concurrency ?? config.defaults.concurrency,
    failFast: document.fail_fast ?? config.defaults.failFast,
    jobs,
  };

  return { pipeline, substitutions };
}
