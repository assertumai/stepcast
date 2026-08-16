import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';

import { compileNameGlob } from '../lint.js';

/**
 * Сборка окружения шага.
 *
 * Окружение процесса наследуется целиком: агентский CLI и сборочные
 * инструменты нуждаются в JAVA_HOME, NVM_DIR, SSH_AUTH_SOCK, прокси и десятке
 * других переменных, и отсечение по списку ломает первый же реальный шаг.
 * Единственный фильтр — env_deny, и он применяется последним.
 */

export interface EnvLayers {
  /** Окружение процесса scarp. */
  readonly base: Readonly<Record<string, string | undefined>>;
  readonly envFiles: readonly string[];
  readonly pipeline: Readonly<Record<string, string>>;
  readonly job: Readonly<Record<string, string>>;
  readonly step: Readonly<Record<string, string>>;
  /** Переменные бэкенда: их добавляет адаптер, запрету они тоже подчиняются. */
  readonly backend?: Readonly<Record<string, string>>;
  /** Переменные scarp: добавляются последними и не переопределяются. */
  readonly injected: Readonly<Record<string, string>>;
  readonly deny: readonly string[];
  /** Каталог, от которого разрешаются относительные пути env_files. */
  readonly cwd: string;
}

export interface DeniedVariable {
  readonly name: string;
  readonly pattern: string;
}

export interface BuiltEnv {
  readonly env: Record<string, string>;
  readonly denied: readonly DeniedVariable[];
}

export function buildStepEnv(layers: EnvLayers): BuiltEnv {
  const env: Record<string, string> = {};

  for (const [name, value] of Object.entries(layers.base)) {
    if (value !== undefined) env[name] = value;
  }

  for (const file of layers.envFiles) {
    const path = isAbsolute(file) ? file : resolvePath(layers.cwd, file);
    Object.assign(env, parseEnvFile(path));
  }

  Object.assign(env, layers.pipeline, layers.job, layers.backend ?? {}, layers.step);

  // Инжектируемые последними: шаг не должен подменять сведения о самом себе.
  Object.assign(env, layers.injected);

  const matchers = layers.deny.map((pattern) => ({ pattern, matcher: compileNameGlob(pattern) }));
  const denied: DeniedVariable[] = [];

  for (const name of Object.keys(env)) {
    // Собственные переменные scarp под запрет не попадают: они описывают
    // прогон, а не несут учётных данных.
    if (name.startsWith('SCARP_')) continue;
    const hit = matchers.find(({ matcher }) => matcher.test(name));
    if (hit === undefined) continue;
    delete env[name];
    denied.push({ name, pattern: hit.pattern });
  }

  return { env, denied };
}

/** Минимальный разбор файла окружения: `KEY=value`, комментарии, кавычки. */
export function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};

  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator === -1) continue;

    const name = line.slice(0, separator).trim().replace(/^export\s+/, '');
    let value = line.slice(separator + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    out[name] = value;
  }

  return out;
}

export interface InjectedContext {
  readonly runId: string;
  readonly runDir: string;
  readonly jobId: string;
  readonly jobDir: string;
  readonly stepId: string;
  readonly stepDir: string;
  readonly attempt: number;
  readonly workspace: string;
  readonly artifacts: string;
  readonly iteration?: number;
  readonly previousFailurePath?: string;
}

export function injectedVariables(context: InjectedContext): Record<string, string> {
  return {
    SCARP_RUN_ID: context.runId,
    SCARP_RUN_DIR: context.runDir,
    SCARP_JOB: context.jobId,
    SCARP_JOB_DIR: context.jobDir,
    SCARP_STEP: context.stepId,
    SCARP_STEP_DIR: context.stepDir,
    SCARP_ATTEMPT: String(context.attempt),
    SCARP_WORKSPACE: context.workspace,
    SCARP_ARTIFACTS: context.artifacts,
    ...(context.iteration === undefined ? {} : { SCARP_ITERATION: String(context.iteration) }),
    ...(context.previousFailurePath === undefined
      ? {}
      : { SCARP_PREV_FAILURE: context.previousFailurePath }),
  };
}
