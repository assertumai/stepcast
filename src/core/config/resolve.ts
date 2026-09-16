import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { StepcastError } from '../errors.js';
import { packagedWrapperNames } from '../package-schema.js';
import { describeSchemaFailure } from '../pipeline/load.js';
import { BUILTIN_ROW_IDS } from '../../parts/rows.js';
import { discoverPluginDirectories, pluginsDirPath } from '../plugins/discover.js';
import {
  applyOperations,
  builtinSeedRows,
  isBuiltinUse,
  keyOperations,
  patchOperations,
  type TreeOperation,
  type TreeRow,
} from '../plugins/tree.js';
import {
  GLOBAL_ONLY_KEYS,
  PluginsPatchDocumentSchema,
  PROJECT_ONLY_KEYS,
  RawConfigSchema,
  TIGHTEN_ONLY_KEYS,
  UNION_LIST_KEYS,
  type PluginsPatchDocument,
  type RawConfig,
} from './schema.js';
import { BUILTIN_CONFIG } from './defaults.js';
import type { ModelTiers } from './modelTiers.js';
import {
  flatten,
  matchesKeyPattern,
  mergeLayers,
  unflatten,
  type DenyContribution,
  type Layer,
  type Source,
} from './merge.js';

/** Объявление вложенного репозитория объектной формой — то, что не несёт строковая форма. */
export interface NestedRepoDeclaration {
  readonly check: string | undefined;
  /** Инструменты сверх корневого перечня, а не вместо него (см. `project/repos.ts`). */
  readonly tools: readonly string[] | undefined;
  readonly spec: {
    readonly dir: string | undefined;
    readonly rules: string | undefined;
    readonly tool: string | undefined;
    readonly check: string | undefined;
  };
}

/** Запись действующей таблицы раннеров: «имя → argv-префикс». */
export interface RunnerConfig {
  readonly command: readonly string[];
  readonly extensions: readonly string[];
  /**
   * Объявленное значение `wrapper` — `stepcast:<имя>` либо путь, ещё не
   * разрешённый в абсолютный (design.md, решение 7): разрешение бере́т слои
   * script-каталогов, которых у конфигурации на своём этапе нет, и потому
   * дописывается позже, рядом с разрешением скрипта (`expand.ts`).
   * `none` и необъявленное значение одинаково дают `undefined` здесь: обе
   * формы значат «обёртки нет».
   */
  readonly wrapper?: string;
  /**
   * Файл, объявивший `wrapper`, — только для формы «путь»: она разрешается
   * от места объявления, как и значение `script` (design.md, решение 7).
   */
  readonly wrapperFile?: string;
}

export interface BackendConfig {
  readonly command: string;
  readonly enabled: boolean;
  readonly defaultModel: string | undefined;
  readonly modelTiers?: ModelTiers;
  readonly concurrency: number;
  readonly cacheReadWeight: number;
  readonly sessions: boolean;
  readonly structuredOutput: boolean;
  /** Умеет применять `enforce: strict` — отсекать настройки вне репозитория и запрещать неназванное. */
  readonly strictPermissions: boolean;
  /** Объявлена возможность работать с MCP-серверами (`backends.<name>.mcp`). */
  readonly mcp: boolean;
  readonly permissions:
    | {
        readonly mode?: string;
        readonly allow?: readonly string[];
        readonly deny?: readonly string[];
        readonly enforce?: 'inherit' | 'strict';
      }
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
    readonly costMicroUsd: number;
    readonly wallclockMs: number;
    readonly concurrency: number;
    readonly attempts: number;
    readonly iterations: number;
  };
  readonly envDeny: readonly string[];
  /**
   * Модули действующих строк дерева плагинов (`plugin-tree`), в порядке
   * дерева, — проекция `ResolvedConfig.pluginTree`, а не отдельно собранный
   * список (design.md, Решение 7). Второе представление того же состава
   * разошлось бы с деревом на первом же патче, и `stepcast config` стал бы
   * врать; файл объявления здесь по той же причине не хранится — он есть в
   * дереве, у каждой строки своей.
   *
   * Строки встроенного слоя (`use: stepcast:<имя>`) в проекцию не входят:
   * поле объявлено списком модулей (docs/config.md), а `stepcast:backend-claude`
   * модулем не является и `resolveModulePath` обычным путём не разрешается —
   * такую запись потребитель поля разрешить бы не смог. Состав встроенных
   * строк виден там, где он и должен быть виден целиком, — в дереве и в
   * выводе `stepcast plugins`.
   */
  readonly plugins: readonly string[];
  readonly context: {
    readonly inlineThreshold: number;
    readonly maxTokens: number;
    readonly noteMaxTokens: number;
    readonly deny: readonly string[];
  };
  readonly backends: Readonly<Record<string, BackendConfig>>;
  /** Таблица раннеров шага `script`, слои слиты по листьям (`buildRunners`). */
  readonly runners: Readonly<Record<string, RunnerConfig>>;
  /**
   * Индекс «расширение → раннер», собранный из таблицы: ближний слой
   * побеждает, спор внутри слоя — отказ разбора конфигурации
   * (design.md, решение 6).
   */
  readonly runnersByExtension: ReadonlyMap<string, string>;
  readonly ui: { readonly port: number };
  readonly project: {
    /** Команда проверки репозитория. Нет встроенного умолчания: неверная угадка исполнялась бы в чужом дереве. */
    readonly check: string | undefined;
    /** Имена инструментов репозитория, в объявленном порядке. Нет встроенного умолчания — та же причина, что у `check`. */
    readonly tools: readonly string[] | undefined;
    /** Границы правок репозитория, в объявленном порядке. Нет встроенного умолчания — та же причина, что у `check`. */
    readonly editPaths: readonly string[] | undefined;
    /**
     * Вложенные репозитории дерева, в каноническом порядке (без хвостового
     * разделителя, отсортирован) независимо от того, как они объявлены —
     * форма состояния дерева не зависит от порядка объявления. Повтор
     * каталога — отказ разбора (`canonicalizeNestedRepos`), а не молчаливый
     * дубликат. Нет встроенного умолчания — та же причина, что у `check`.
     */
    readonly nestedRepos: readonly string[] | undefined;
    /**
     * Режим доставки правки кабинета агентом (`ui-proposals`, Решение 7):
     * `queue` ставит предложение в очередь, `direct` пишет цель немедленно.
     * Умолчание `queue` — тем же приёмом, что и у прочих величин поведения
     * движка (в отличие от `check`/`tools`, у которых умолчания нет).
     */
    readonly proposals: 'queue' | 'direct';
    /**
     * Объявления вложенных репозиториев объектной формой, по каталогу.
     * Каталог, названный строкой (без объекта), в карте отсутствует —
     * `project/repos.ts` обязан увидеть отсутствующую запись как неполное
     * объявление, а не подставить за него пустую. Определена ровно тогда,
     * когда определён `nestedRepos` (обе — проекции одного и того же
     * значения `project.nested_repos`).
     */
    readonly nestedRepoDeclarations: ReadonlyMap<string, NestedRepoDeclaration> | undefined;
    /**
     * Практика спецификации репозитория: место документов изменения, файл
     * правил их написания, имя инструмента. Умолчаний нет по той же причине,
     * что у `check`, — угаданное значение указывало бы в чужом репозитории на
     * несуществующее.
     */
    readonly spec: {
      readonly dir: string | undefined;
      readonly rules: string | undefined;
      readonly tool: string | undefined;
      readonly check: string | undefined;
    };
    /**
     * Практика памяти репозитория. `provider` неопределён — практики нет:
     * записи контекста `knowledge:` и предикат `knowledge_valid` в таком
     * репозитории отклоняет линт, а не молча отдаёт пустоту. Величины
     * определены всегда (встроенный слой), потому что описывают поведение
     * движка, а не устройство чужого дерева.
     */
    readonly knowledge: {
      readonly provider: 'fs' | 'cmd' | undefined;
      readonly command: string | undefined;
      readonly dir: string | undefined;
      readonly rules: string | undefined;
      readonly indexMaxTokens: number;
      readonly specIndexMaxTokens: number;
      readonly unitMaxTokens: number;
      readonly staleAfterMs: number;
      readonly timeoutMs: number;
    };
  };
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
  /**
   * Дерево плагинов (`plugin-tree`): встроенный слой, свёрнутый с домашним и
   * проектным — каждый из ключа `plugins` и патча `plugins.patch.yml` своего
   * каталога, в этом порядке (design.md, Решение 3, 4). Единственный вход
   * загрузчика (`loadPlugins`) и единственный источник `Config.plugins`.
   */
  readonly pluginTree: readonly TreeRow[];
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
  /**
   * Явный путь к проектному конфигу. `null` — проектного слоя нет вовсе:
   * так конфигурацию читает демон витрины, который не привязан к проекту и
   * иначе подхватил бы чужой `.stepcast/config.yml` по случайному `cwd`.
   */
  readonly projectPath?: string | null;
  /**
   * Умолчания, объявленные плагинами для своих бэкендов, — слой сразу после
   * встроенного. Заполняется вторым проходом разрешения: список плагинов
   * называет сама конфигурация, а прочитать её надо раньше, чем плагины
   * загружены (`parts/resolve.ts`).
   */
  readonly pluginDefaults?: readonly {
    readonly plugin: string;
    readonly values: Record<string, unknown>;
  }[];
  /**
   * Id строк поставки вызывающего — во встроенный слой семени, рядом с
   * `BUILTIN_ROW_IDS` (`plugin-tree`, design.md Решение 2): витрина добавляет
   * сюда строку каркаса (`ui-shell`) и по строке на экран. Патч и ключ
   * `plugins` домашнего и проектного слоёв заменяют и отключают их тем же
   * правилом, что и строки движка. Отсутствие поля даёт дерево, каким оно было
   * до появления строк поставки, — состав и порядок не меняются.
   */
  readonly builtinRows?: readonly string[];
  /**
   * Корень проекта, каталоги плагинов которого обходятся проектным слоем
   * (`user-plugins`, design.md, Решение 13). По умолчанию — `cwd`, тот же
   * каталог, из которого читается проектный конфиг: для обычного вызова CLI
   * это один и тот же проект. Демон витрины разрешает собственное ядро с
   * `projectPath: null` (свой конфиг — не проектный), но каталог, в котором он
   * поднят, всё равно обязан быть проектным слоем каталогов плагинов — это
   * поле называет его в обход отсутствующего `projectPath`. `projectPath: null`
   * без этого поля — обхода проектного слоя нет вовсе (собственное ядро
   * демона, запасной встроенный состав, `src/ui/kernel.ts`).
   */
  readonly pluginsProjectRoot?: string;
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
    // Разбор дерева замечаний zod общий с документами пайплайна: правило
    // «называй лишний ключ и спускайся в подходящий вариант объединения» не
    // зависит от того, какая схема отказала, а две его копии разошлись бы.
    const failure = describeSchemaFailure(parsed.error);
    throw new StepcastError(`Конфигурация не соответствует схеме: ${failure.message}`, {
      file: path,
      ...(failure.at === undefined ? {} : { at: failure.at }),
      hint: 'Неизвестный ключ почти всегда опечатка — сверьтесь с docs/config.md',
    });
  }

  return parsed.data;
}

/**
 * Прочитать `plugins.patch.yml` слоя. Отсутствие файла — обычное состояние,
 * не ошибка (`stepcast-configuration`): дерево в этом случае складывается из
 * встроенного слоя и ключа `plugins`, как и до появления патчей. Патч не
 * участвует в `mergeLayers` — он не про точечные пути, а про порядок и
 * идентичность строк (design.md, Решение 9), и потому разбирается отдельно
 * от `readConfigFile`.
 */
function readPluginsPatchFile(path: string): PluginsPatchDocument | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw new StepcastError(`Не удалось прочитать патч плагинов: ${(error as Error).message}`, {
      file: path,
      cause: error,
    });
  }

  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (error) {
    throw new StepcastError(`Патч плагинов не разбирается как YAML: ${(error as Error).message}`, {
      file: path,
      cause: error,
    });
  }

  const parsed = PluginsPatchDocumentSchema.safeParse(document ?? {});
  if (!parsed.success) {
    const failure = describeSchemaFailure(parsed.error);
    throw new StepcastError(`Патч плагинов не соответствует схеме: ${failure.message}`, {
      file: path,
      ...(failure.at === undefined ? {} : { at: failure.at }),
      hint: 'Формат описан в docs/plugins.md: version: 1, kind: plugins-patch, список plugins',
    });
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

/** Глобальный конфиг общий всем репозиториям машины, поэтому команда одного из них там не место. */
function rejectProjectOnlyKeys(config: RawConfig, path: string): void {
  for (const [keyPath] of flatten(config as Record<string, unknown>)) {
    for (const pattern of PROJECT_ONLY_KEYS) {
      if (matchesKeyPattern(keyPath, pattern)) {
        throw new StepcastError(`Ключ ${keyPath} допустим только в проектной конфигурации`, {
          file: path,
          at: keyPath,
          hint: 'Перенесите значение в .stepcast/config.yml',
        });
      }
    }
  }
}

interface CanonicalNestedRepos {
  readonly dirs: readonly string[];
  readonly declarations: ReadonlyMap<string, NestedRepoDeclaration>;
}

/**
 * Приводит объявленный состав вложенных репозиториев (строки и объекты
 * вперемешку) к каноническому виду: хвостовой разделитель отброшен, порядок
 * один и тот же независимо от объявления. Составной якорь строит отпечаток
 * состава из списка каталогов (`anchor/composite.ts`) — несортированный
 * порядок дал бы разный отпечаток для одного и того же дерева.
 *
 * Повтор каталога — отказ, а не молчаливый дубликат (в отличие от прежнего
 * поведения): два объявления одного каталога, из которых объектная форма
 * несёт `check`/`spec`, несравнимы по приоритету между собой, и решать за
 * автора конфигурации, какое из них главнее, движку не с руки.
 */
function canonicalizeNestedRepos(value: unknown): CanonicalNestedRepos | undefined {
  if (!Array.isArray(value)) return undefined;

  const dirs: string[] = [];
  const declarations = new Map<string, NestedRepoDeclaration>();

  for (const item of value) {
    let rawDir: string;
    let declaration: NestedRepoDeclaration | undefined;

    if (typeof item === 'string') {
      rawDir = item;
    } else if (
      item !== null &&
      typeof item === 'object' &&
      typeof (item as Record<string, unknown>).dir === 'string'
    ) {
      const raw = item as Record<string, unknown>;
      rawDir = raw.dir as string;
      const spec = (raw.spec ?? {}) as Record<string, unknown>;
      declaration = {
        check: typeof raw.check === 'string' ? raw.check : undefined,
        tools:
          Array.isArray(raw.tools) && raw.tools.every((tool) => typeof tool === 'string')
            ? (raw.tools as readonly string[])
            : undefined,
        spec: {
          dir: typeof spec.dir === 'string' ? spec.dir : undefined,
          rules: typeof spec.rules === 'string' ? spec.rules : undefined,
          tool: typeof spec.tool === 'string' ? spec.tool : undefined,
          check: typeof spec.check === 'string' ? spec.check : undefined,
        },
      };
    } else {
      return undefined;
    }

    const dir = rawDir.replace(/\/+$/, '');
    if (dirs.includes(dir)) {
      throw new StepcastError(`Каталог ${dir} назван в project.nested_repos дважды`, {
        at: 'project.nested_repos',
      });
    }
    dirs.push(dir);
    if (declaration !== undefined) declarations.set(dir, declaration);
  }

  return { dirs: [...dirs].sort(), declarations };
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
      modelTiers: (raw.model_tiers as ModelTiers | undefined) ?? {},
      concurrency: typeof raw.concurrency === 'number' ? raw.concurrency : 1,
      cacheReadWeight: typeof raw.cache_read_weight === 'number' ? raw.cache_read_weight : 1,
      sessions: raw.sessions === true,
      structuredOutput: raw.structured_output === true,
      strictPermissions: raw.strict_permissions === true,
      mcp: raw.mcp === true,
      permissions: (raw.permissions as BackendConfig['permissions']) ?? undefined,
      env: (raw.env as Record<string, string> | undefined) ?? {},
    };
  }

  return out;
}

/**
 * Действующая таблица раннеров из слитых значений. Отдельный слой вправе
 * назвать одни `extensions` (схема `RawRunnerSchema` этого не запрещает —
 * слияние идёт по листьям), но запись, ни в одном слое не получившая
 * `command`, — отказ разбора, а не пустой префикс argv: пустая команда дала
 * бы argv из одного пути скрипта, то есть попытку запустить файл напрямую,
 * ровно то, что запрещает правило выбора раннера. Слой умолчаний плагина
 * схемы файлов не проходит вовсе, и эта проверка — единственное, что стоит
 * между его неполной записью и таким запуском.
 */
const STEPCAST_WRAPPER_PREFIX = 'stepcast:';

/**
 * Объявленный `wrapper` записи, слитой из всех слоёв, в действующее значение:
 * `none` и необъявленное значение — `undefined`, `stepcast:<имя>` —
 * проверяется по перечню поставляемых здесь же (единственная форма, чья
 * корректность не зависит от каталога прогона), путь — переносится как есть
 * для разрешения при раскрытии пайплайна (design.md, решение 7).
 */
function resolveDeclaredWrapper(name: string, value: string): string | undefined {
  if (value === 'none') return undefined;
  if (value.startsWith(STEPCAST_WRAPPER_PREFIX)) {
    const wrapperName = value.slice(STEPCAST_WRAPPER_PREFIX.length);
    if (!packagedWrapperNames().includes(wrapperName)) {
      throw new StepcastError(`Обёртка stepcast:${wrapperName} не поставляется пакетом stepcast`, {
        at: `runners.${name}.wrapper`,
        hint: `Пакет поставляет: ${packagedWrapperNames().join(', ')}`,
      });
    }
    return value;
  }
  return value;
}

function buildRunners(
  values: ReadonlyMap<string, unknown>,
  provenance: ReadonlyMap<string, Source>,
): Record<string, RunnerConfig> {
  const tree = unflatten(values);
  const rawRunners = (tree.runners ?? {}) as Record<
    string,
    { readonly command?: readonly string[]; readonly extensions?: readonly string[]; readonly wrapper?: string }
  >;
  const out: Record<string, RunnerConfig> = {};

  for (const [name, raw] of Object.entries(rawRunners)) {
    if (raw.command === undefined || raw.command.length === 0) {
      throw new StepcastError(`Раннер ${name} объявлен без команды`, {
        at: `runners.${name}.command`,
        hint: 'Назовите command списком argv — например, command: [uv, run, --script]',
      });
    }
    const wrapper = raw.wrapper === undefined ? undefined : resolveDeclaredWrapper(name, raw.wrapper);
    const wrapperSource =
      wrapper === undefined || wrapper.startsWith(STEPCAST_WRAPPER_PREFIX)
        ? undefined
        : provenance.get(`runners.${name}.wrapper`);
    out[name] = {
      command: raw.command,
      extensions: raw.extensions ?? [],
      ...(wrapper === undefined ? {} : { wrapper }),
      ...(wrapperSource?.kind === 'file' ? { wrapperFile: wrapperSource.path } : {}),
    };
  }

  return out;
}

/**
 * Индекс «расширение → раннер»: собирается от происхождения записей, а не от
 * порядка ключей объекта — происхождение известно из карты слияния и решает
 * спор воспроизводимо (design.md, решение 6).
 *
 * Ранг записи — позиция слоя, задавшего `runners.<имя>.extensions`, в общем
 * списке слоёв слияния: слой, объявленный позже (ближе к делу), имеет больший
 * ранг. Две записи одного слоя, назвавшие одно расширение, несут одинаковый
 * ранг — тот же объект источника, — и это и есть неразрешимый спор.
 */
function buildRunnersByExtension(
  runners: Readonly<Record<string, RunnerConfig>>,
  provenance: ReadonlyMap<string, Source>,
  layers: readonly Layer[],
): ReadonlyMap<string, string> {
  const rank = new Map<Source, number>();
  layers.forEach((layer, index) => rank.set(layer.source, index));

  const claims = new Map<string, Array<{ readonly runner: string; readonly rank: number }>>();
  for (const [name, runner] of Object.entries(runners)) {
    if (runner.extensions.length === 0) continue;
    const source = provenance.get(`runners.${name}.extensions`);
    const claimRank = source === undefined ? -1 : (rank.get(source) ?? -1);
    for (const extension of runner.extensions) {
      const forExtension = claims.get(extension) ?? [];
      forExtension.push({ runner: name, rank: claimRank });
      claims.set(extension, forExtension);
    }
  }

  const index = new Map<string, string>();
  for (const [extension, contenders] of claims) {
    const nearestRank = Math.max(...contenders.map((item) => item.rank));
    const nearest = contenders.filter((item) => item.rank === nearestRank);
    if (nearest.length > 1) {
      const names = [...new Set(nearest.map((item) => item.runner))].sort();
      throw new StepcastError(
        `Расширение ${extension} закреплено за несколькими раннерами одного слоя конфигурации: ${names.join(', ')}`,
        {
          at: 'runners',
          hint: 'Оставьте расширение ровно за одним раннером в этом слое — либо назовите runner на самом шаге',
        },
      );
    }
    index.set(extension, nearest[0]!.runner);
  }

  return index;
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
  const projectPath =
    options.projectPath === null
      ? undefined
      : (options.projectPath ?? join(options.cwd, '.stepcast', 'config.yml'));

  const layers: Layer[] = [{ source: { kind: 'builtin' }, values: BUILTIN_CONFIG as Record<string, unknown> }];

  // Умолчания плагинов ложатся сразу после встроенных: пользовательские файлы
  // обязаны их перекрывать, а сами они — быть видны в отчёте своим источником,
  // а не притворяться встроенными.
  for (const layer of options.pluginDefaults ?? []) {
    layers.push({ source: { kind: 'plugin', name: layer.plugin }, values: layer.values });
  }

  const globalConfig = readConfigFile(globalPath);
  if (globalConfig !== undefined) {
    rejectProjectOnlyKeys(globalConfig, globalPath);
    layers.push({ source: { kind: 'file', path: globalPath }, values: globalConfig as Record<string, unknown> });
  }

  const projectConfig = projectPath === undefined ? undefined : readConfigFile(projectPath);
  if (projectConfig !== undefined && projectPath !== undefined) {
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

  // Дерево плагинов (`plugin-tree`, `user-plugins`): встроенный слой, затем
  // домашний и проектный — каждый из обхода своего каталога плагинов, своего
  // ключа `plugins` (сокращённая форма, design.md Решение 4) и своего патча, в
  // этом порядке (design.md, Решение 3). Патч не проходит через `mergeLayers`:
  // он не про точечные пути, а про порядок и идентичность строк (Решение 9), и
  // потому сворачивается отдельно.
  const reservedRowIds = [...BUILTIN_ROW_IDS, ...(options.builtinRows ?? [])];
  const homePatchPath = join(dirname(globalPath), 'plugins.patch.yml');
  const homePatch = readPluginsPatchFile(homePatchPath);
  // Каталог плагинов домашнего слоя — рядом с глобальным конфигом, а не под
  // домашним каталогом машины: сборка с подставным путём конфигурации
  // (запасное встроенное ядро демона, `src/ui/kernel.ts`) обязана остаться
  // встроенной и не подхватывать настоящие `~/.stepcast/plugins`.
  let pluginTree = applyOperations(builtinSeedRows(reservedRowIds), [
    ...discoverPluginDirectories(join(dirname(globalPath), 'plugins'), 'home', reservedRowIds),
    ...keyOperations(globalConfig?.plugins ?? [], globalPath),
    ...patchOperations(homePatch?.plugins ?? [], homePatchPath),
  ]);

  // Корень обхода проектного слоя каталогов плагинов — независим от того,
  // читается ли проектный файл конфигурации: демон разрешает собственное ядро
  // с `projectPath: null`, но каталог, в котором он поднят, всё равно обязан
  // дать проектный слой плагинов (`ui-daemon`, Решение 13).
  const pluginsProjectRoot = options.pluginsProjectRoot ?? (options.projectPath === null ? undefined : options.cwd);
  const projectOperations: TreeOperation[] = [];
  if (pluginsProjectRoot !== undefined) {
    projectOperations.push(
      ...discoverPluginDirectories(pluginsDirPath(pluginsProjectRoot), 'project', reservedRowIds),
    );
  }
  if (projectPath !== undefined) {
    const projectPatchPath = join(dirname(projectPath), 'plugins.patch.yml');
    const projectPatch = readPluginsPatchFile(projectPatchPath);
    projectOperations.push(
      ...keyOperations(projectConfig?.plugins ?? [], projectPath),
      ...patchOperations(projectPatch?.plugins ?? [], projectPatchPath),
    );
  }
  if (projectOperations.length > 0) {
    pluginTree = applyOperations(pluginTree, projectOperations);
  }

  const values = merged.values;
  const workspaceMode = (values.get('defaults.workspace.mode') ?? 'cwd') as 'cwd' | 'worktree' | 'copy';
  const workspacePath = values.get('defaults.workspace.path');
  const model = values.get('defaults.model');
  const projectCheck = values.get('project.check');
  const projectTools = values.get('project.tools');
  const projectEditPaths = values.get('project.edit_paths');
  const projectNestedRepos = canonicalizeNestedRepos(values.get('project.nested_repos'));
  const projectSpecDir = values.get('project.spec.dir');
  const projectSpecRules = values.get('project.spec.rules');
  const projectSpecTool = values.get('project.spec.tool');
  const projectSpecCheck = values.get('project.spec.check');
  const knowledgeProvider = values.get('project.knowledge.provider');
  const knowledgeCommand = values.get('project.knowledge.command');
  const knowledgeDir = values.get('project.knowledge.dir');
  const knowledgeRules = values.get('project.knowledge.rules');
  const runsRoot = expandHome(requireString(values, 'runs.root'), home);
  const runners = buildRunners(values, merged.provenance);
  const runnersByExtension = buildRunnersByExtension(runners, merged.provenance, layers);

  // Согласованность объявления проверяется здесь, а не схемой: схема видит
  // один файл, а `provider` и `command` могут прийти из разных слоёв —
  // источник, объявленный пайплайном, и команда, объявленная конфигурацией,
  // законны вместе. Отказ на несогласованном объявлении, а не молчаливое
  // «источника нет»: репозиторий, назвавший провайдера, память включить
  // намеревался, и тихий отказ выглядел бы как пустая память.
  if (knowledgeProvider === 'cmd' && typeof knowledgeCommand !== 'string') {
    throw new StepcastError('Источник знания cmd объявлен без команды', {
      at: 'project.knowledge.command',
      hint: 'Назовите команду источника или объявите provider: fs',
    });
  }
  if (knowledgeProvider === 'fs' && typeof knowledgeDir !== 'string') {
    throw new StepcastError('Встроенный источник знания объявлен без каталога', {
      at: 'project.knowledge.dir',
      hint: 'Назовите каталог знания — например, dir: knowledge',
    });
  }

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
      costMicroUsd: requireNumber(values, 'limits.cost'),
      wallclockMs: requireNumber(values, 'limits.wallclock'),
      concurrency: requireNumber(values, 'limits.concurrency'),
      attempts: requireNumber(values, 'limits.attempts'),
      iterations: requireNumber(values, 'limits.iterations'),
    },
    envDeny: (values.get('env_deny') as string[] | undefined) ?? [],
    // Заведомо неприменимая строка (`TreeRow.failure`) из проекции выпадает
    // наравне с отключённой: её `use` — каталог, который загрузчик и не
    // попытается открыть, и выдавать его за объявленный модуль значило бы
    // соврать потребителю поля.
    plugins: pluginTree
      .filter((row) => row.enabled && row.failure === undefined && !isBuiltinUse(row.use))
      .map((row) => row.use),
    context: {
      inlineThreshold: requireNumber(values, 'context.inline_threshold'),
      maxTokens: requireNumber(values, 'context.max_tokens'),
      noteMaxTokens: requireNumber(values, 'context.note_max_tokens'),
      deny: (values.get('context.deny') as string[] | undefined) ?? [],
    },
    backends: buildBackends(values, home),
    runners,
    runnersByExtension,
    ui: { port: requireNumber(values, 'ui.port') },
    project: {
      check: typeof projectCheck === 'string' ? projectCheck : undefined,
      tools:
        Array.isArray(projectTools) && projectTools.every((item) => typeof item === 'string')
          ? (projectTools as readonly string[])
          : undefined,
      editPaths:
        Array.isArray(projectEditPaths) && projectEditPaths.every((item) => typeof item === 'string')
          ? (projectEditPaths as readonly string[])
          : undefined,
      nestedRepos: projectNestedRepos?.dirs,
      nestedRepoDeclarations: projectNestedRepos?.declarations,
      proposals: (values.get('project.proposals') ?? 'queue') as 'queue' | 'direct',
      spec: {
        dir: typeof projectSpecDir === 'string' ? projectSpecDir : undefined,
        rules: typeof projectSpecRules === 'string' ? projectSpecRules : undefined,
        tool: typeof projectSpecTool === 'string' ? projectSpecTool : undefined,
        check: typeof projectSpecCheck === 'string' ? projectSpecCheck : undefined,
      },
      knowledge: {
        provider:
          knowledgeProvider === 'fs' || knowledgeProvider === 'cmd' ? knowledgeProvider : undefined,
        command: typeof knowledgeCommand === 'string' ? knowledgeCommand : undefined,
        dir: typeof knowledgeDir === 'string' ? knowledgeDir : undefined,
        rules: typeof knowledgeRules === 'string' ? knowledgeRules : undefined,
        indexMaxTokens: requireNumber(values, 'project.knowledge.index_max_tokens'),
        specIndexMaxTokens: requireNumber(values, 'project.knowledge.spec_index_max_tokens'),
        unitMaxTokens: requireNumber(values, 'project.knowledge.unit_max_tokens'),
        staleAfterMs: requireNumber(values, 'project.knowledge.stale_after'),
        timeoutMs: requireNumber(values, 'project.knowledge.timeout'),
      },
    },
  };

  return {
    config,
    values,
    provenance: merged.provenance,
    denyContributions: merged.denyContributions,
    pluginTree,
  };
}
