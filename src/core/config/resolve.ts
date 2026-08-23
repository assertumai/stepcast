import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { StepcastError } from '../errors.js';
import {
  GLOBAL_ONLY_KEYS,
  RawConfigSchema,
  TIGHTEN_ONLY_KEYS,
  UNION_LIST_KEYS,
  type RawConfig,
} from './schema.js';
import { BUILTIN_CONFIG } from './defaults.js';
import {
  flatten,
  matchesKeyPattern,
  mergeLayers,
  unflatten,
  type DenyContribution,
  type Layer,
  type Source,
} from './merge.js';

export interface BackendConfig {
  readonly command: string;
  readonly enabled: boolean;
  readonly defaultModel: string | undefined;
  readonly concurrency: number;
  readonly cacheReadWeight: number;
  readonly sessions: boolean;
  readonly structuredOutput: boolean;
  readonly permissions:
    | { readonly mode?: string; readonly allow?: readonly string[]; readonly deny?: readonly string[] }
    | undefined;
  readonly env: Readonly<Record<string, string>>;
}

export interface Config {
  readonly runs: { readonly root: string; readonly keepMs: number };
  readonly defaults: {
    readonly agent: string;
    readonly model: string | undefined;
    readonly workspace: { readonly mode: 'cwd' | 'worktree' | 'copy'; readonly path?: string };
    readonly session: 'shared' | 'per_step';
    readonly concurrency: number;
    readonly failFast: boolean;
    readonly stepTimeoutMs: number;
    readonly stallTimeoutMs: number;
    /** Предел суммарного ожидания сброса окна лимита за прогон. */
    readonly maxWaitMs: number;
  };
  readonly limits: {
    readonly tokens: number;
    readonly wallclockMs: number;
    readonly concurrency: number;
    readonly attempts: number;
    readonly iterations: number;
  };
  readonly envDeny: readonly string[];
  readonly context: {
    readonly inlineThreshold: number;
    readonly maxTokens: number;
    readonly deny: readonly string[];
  };
  readonly backends: Readonly<Record<string, BackendConfig>>;
  readonly ui: { readonly port: number };
}

export interface ResolvedConfig {
  readonly config: Config;
  /**
   * Слитые значения в том же виде «точечный путь → значение», в каком шло
   * слияние. Отчёт `stepcast config` читает их напрямую: любая попытка вывести
   * его из типизированной конфигурации требует таблицы соответствия имён и
   * начинает врать на первом же ключе, который назван по-разному.
   */
  readonly values: ReadonlyMap<string, unknown>;
  readonly provenance: ReadonlyMap<string, Source>;
  readonly denyContributions: ReadonlyMap<string, readonly DenyContribution[]>;
}

export interface ResolveOptions {
  /** Каталог проекта. Проектный конфиг ищется в `<cwd>/.stepcast/config.yml`. */
  readonly cwd: string;
  /** Домашний каталог. Глобальный конфиг ищется в `<home>/.stepcast/config.yml`. */
  readonly home?: string;
  /** Значения из флагов в виде «точечный путь → значение». */
  readonly flags?: Readonly<Record<string, unknown>>;
  /** Явный путь к глобальному конфигу, в обход домашнего каталога. */
  readonly globalPath?: string;
  /** Явный путь к проектному конфигу. */
  readonly projectPath?: string;
}

/** Развернуть `~` в начале пути. Пути конфигурации пишутся людьми. */
export function expandHome(input: string, home: string): string {
  if (input === '~') return home;
  if (input.startsWith('~/')) return join(home, input.slice(2));
  return input;
}

function readConfigFile(path: string): RawConfig | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw new StepcastError(`Не удалось прочитать конфигурацию: ${(error as Error).message}`, {
      file: path,
      cause: error,
    });
  }

  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (error) {
    throw new StepcastError(`Конфигурация не разбирается как YAML: ${(error as Error).message}`, {
      file: path,
      cause: error,
    });
  }

  if (document === null || document === undefined) return {};

  const parsed = RawConfigSchema.safeParse(document);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const at = first === undefined ? undefined : first.path.join('.');
    throw new StepcastError(
      `Конфигурация не соответствует схеме: ${first?.message ?? 'неизвестная ошибка'}`,
      {
        file: path,
        ...(at === undefined || at === '' ? {} : { at }),
        hint: 'Неизвестный ключ почти всегда опечатка — сверьтесь с docs/config.md',
      },
    );
  }

  return parsed.data;
}

/** Проектный конфиг лежит в репозитории, поэтому машинно-зависимым путям в нём не место. */
function rejectGlobalOnlyKeys(config: RawConfig, path: string): void {
  for (const [keyPath] of flatten(config as Record<string, unknown>)) {
    for (const pattern of GLOBAL_ONLY_KEYS) {
      if (matchesKeyPattern(keyPath, pattern)) {
        throw new StepcastError(`Ключ ${keyPath} допустим только в глобальной конфигурации`, {
          file: path,
          at: keyPath,
          hint: 'Проектный конфиг попадает в репозиторий — перенесите значение в ~/.stepcast/config.yml',
        });
      }
    }
  }
}

function requireNumber(values: ReadonlyMap<string, unknown>, path: string): number {
  const value = values.get(path);
  if (typeof value !== 'number') {
    throw new StepcastError(`Внутренняя ошибка: значение ${path} не разрешилось в число`);
  }
  return value;
}

function requireString(values: ReadonlyMap<string, unknown>, path: string): string {
  const value = values.get(path);
  if (typeof value !== 'string') {
    throw new StepcastError(`Внутренняя ошибка: значение ${path} не разрешилось в строку`);
  }
  return value;
}

function buildBackends(
  values: ReadonlyMap<string, unknown>,
  home: string,
): Record<string, BackendConfig> {
  const tree = unflatten(values);
  const rawBackends = (tree.backends ?? {}) as Record<string, Record<string, unknown>>;
  const out: Record<string, BackendConfig> = {};

  for (const [name, raw] of Object.entries(rawBackends)) {
    const command = typeof raw.command === 'string' ? expandHome(raw.command, home) : name;
    out[name] = {
      command,
      enabled: raw.enabled !== false,
      defaultModel: typeof raw.default_model === 'string' ? raw.default_model : undefined,
      concurrency: typeof raw.concurrency === 'number' ? raw.concurrency : 1,
      cacheReadWeight: typeof raw.cache_read_weight === 'number' ? raw.cache_read_weight : 1,
      sessions: raw.sessions === true,
      structuredOutput: raw.structured_output === true,
      permissions: (raw.permissions as BackendConfig['permissions']) ?? undefined,
      env: (raw.env as Record<string, string> | undefined) ?? {},
    };
  }

  return out;
}

/**
 * Собрать действующую конфигурацию из встроенных умолчаний, глобального и
 * проектного файлов и флагов. Каждый следующий источник перекрывает
 * предыдущий; исключения — объединяемые списки запретов и потолки `limits`,
 * которые снизу можно только ужесточить.
 */
export function resolveConfig(options: ResolveOptions): ResolvedConfig {
  const home = options.home ?? homedir();
  const globalPath = options.globalPath ?? join(home, '.stepcast', 'config.yml');
  const projectPath = options.projectPath ?? join(options.cwd, '.stepcast', 'config.yml');

  const layers: Layer[] = [{ source: { kind: 'builtin' }, values: BUILTIN_CONFIG as Record<string, unknown> }];

  const globalConfig = readConfigFile(globalPath);
  if (globalConfig !== undefined) {
    layers.push({ source: { kind: 'file', path: globalPath }, values: globalConfig as Record<string, unknown> });
  }

  const projectConfig = readConfigFile(projectPath);
  if (projectConfig !== undefined) {
    rejectGlobalOnlyKeys(projectConfig, projectPath);
    layers.push({ source: { kind: 'file', path: projectPath }, values: projectConfig as Record<string, unknown> });
  }

  for (const [name, value] of Object.entries(options.flags ?? {})) {
    if (value === undefined) continue;
    layers.push({
      source: { kind: 'flag', name: `--${name.split('.').pop() ?? name}` },
      values: unflatten(new Map([[name, value]])),
    });
  }

  const merged = mergeLayers(layers, {
    unionLists: UNION_LIST_KEYS,
    tightenOnly: TIGHTEN_ONLY_KEYS,
  });

  const values = merged.values;
  const workspaceMode = (values.get('defaults.workspace.mode') ?? 'cwd') as 'cwd' | 'worktree' | 'copy';
  const workspacePath = values.get('defaults.workspace.path');
  const model = values.get('defaults.model');
  const runsRoot = expandHome(requireString(values, 'runs.root'), home);

  const config: Config = {
    runs: {
      root: isAbsolute(runsRoot) ? runsRoot : resolvePath(options.cwd, runsRoot),
      keepMs: requireNumber(values, 'runs.keep'),
    },
    defaults: {
      agent: requireString(values, 'defaults.agent'),
      model: typeof model === 'string' ? model : undefined,
      workspace: {
        mode: workspaceMode,
        ...(typeof workspacePath === 'string' ? { path: workspacePath } : {}),
      },
      session: (values.get('defaults.session') ?? 'shared') as 'shared' | 'per_step',
      concurrency: requireNumber(values, 'defaults.concurrency'),
      failFast: values.get('defaults.fail_fast') !== false,
      stepTimeoutMs: requireNumber(values, 'defaults.step_timeout'),
      stallTimeoutMs: requireNumber(values, 'defaults.stall_timeout'),
      maxWaitMs: requireNumber(values, 'defaults.max_wait'),
    },
    limits: {
      tokens: requireNumber(values, 'limits.tokens'),
      wallclockMs: requireNumber(values, 'limits.wallclock'),
      concurrency: requireNumber(values, 'limits.concurrency'),
      attempts: requireNumber(values, 'limits.attempts'),
      iterations: requireNumber(values, 'limits.iterations'),
    },
    envDeny: (values.get('env_deny') as string[] | undefined) ?? [],
    context: {
      inlineThreshold: requireNumber(values, 'context.inline_threshold'),
      maxTokens: requireNumber(values, 'context.max_tokens'),
      deny: (values.get('context.deny') as string[] | undefined) ?? [],
    },
    backends: buildBackends(values, home),
    ui: { port: requireNumber(values, 'ui.port') },
  };

  return {
    config,
    values,
    provenance: merged.provenance,
    denyContributions: merged.denyContributions,
  };
}
