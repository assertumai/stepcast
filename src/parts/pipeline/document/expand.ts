import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, posix, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ModelTierSchema } from '../config/schema.js';
import type { ModelTier } from '../config/modelTiers.js';
import type { Config, RunnerConfig } from '../config/resolve.js';
import { Ajv2020 } from 'ajv/dist/2020.js';

import { StepcastError } from '../../../kernel/errors.js';
import { assertDataKey } from '../run/journal/data.js';
import { findProjectRoot } from '../run/journal/paths.js';
import { findPackageRoot, packagedSchemaPath, packagedWrapperPath } from '../domain/package-schema.js';
import { builtinRegistry } from '../../builtin.js';
import {
  hasPredicateEvaluator,
  hasStepExecutor,
  isNativePredicate,
  isNativeStepKind,
  type NativePredicate,
  type NativeStepKind,
  type StepKind,
  type StepKindContribution,
  type StepKindDocumentForm,
} from '../contract.js';
import {
  contributionOwner,
  formerStepKindOwner,
  nativePredicateNames,
  nativeStepKindNames,
  predicateNames,
  pluginPredicateNames,
  pluginStepKindDescriptors,
  stepKindNames,
  type Registry,
} from '../../../kernel/registry.js';
import { parseCount, parseDuration, parseExitCode, parseMoney, parsePercent, parseTokens } from '../../../kernel/units.js';
import { interpolateTree, interpolateTypedTree, placeholderNamespaces, type Scope } from './interpolate.js';
import { readYamlDocument, rejectProposalsKeyInPipeline, rejectWiringKeys, validateDocument } from './load.js';
import { resolveParams, type ParamValue } from './params.js';
import { resolveUsesStep } from './steps.js';
import {
  buildDocumentSchemas,
  isDefaultNativePredicates,
  isDefaultNativeStepKinds,
  JobDocumentSchema,
  PipelineDocumentSchema,
  STEP_COMMON_KEYS,
  type JobEntry,
  type PipelineDocument,
  type RawBudget,
  type RawContextEntry,
  type RawAgentStep,
  type RawBuiltinPredicate,
  type RawMcp,
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
  KnowledgeDeclaration,
  McpServers,
  ModelOrigin,
  Pipeline,
  Predicate,
  ResolvedScript,
  ScriptLayer,
  ScriptUnresolved,
  Step,
  StepCommon,
  Permissions,
  Substitution,
  SubstitutionMap,
  Triggers,
  UsesOrigin,
  Workspace,
  PipelinePublication,
} from './model.js';

/**
 * Пространства, чьи значения известны только в прогоне. Экспортировано для
 * `steps.ts`: та же проверка «значение ещё содержит отложенную подстановку»
 * нужна параметрам шага `uses` — единый набор пространств, а не копия.
 */
export const DEFERRED_NAMESPACES = new Set(['jobs', 'run', 'env']);

/**
 * Состав пространства `project`: имя команды проверки, инструменты
 * репозитория, границы правок и группа практики спецификации.
 */
const PROJECT_NAMES = [
  'check',
  'tools',
  'edit_paths',
  'spec.dir',
  'spec.rules',
  'spec.tool',
  'spec.check',
  // Практика памяти публикуется тремя именами из девяти объявляемых: `dir` и
  // `rules` вставляются документами (границей правок работы записи, записью
  // контекста с правилами письма), `provider` — тем, что о нём иногда надо
  // сказать промпту. Величины (`index_max_tokens`, `spec_index_max_tokens`,
  // `unit_max_tokens`, `stale_after`, `timeout`) не публикуются: их читает
  // движок и источник, и вставлять их некуда.
  'knowledge.dir',
  'knowledge.rules',
  'knowledge.provider',
];

/**
 * Разное объяснение для двух разных ошибок пространства `project`:
 * обращение к имени вне состава — про сам состав, обращение к необъявленному
 * имени из состава (`check`, `tools`, `edit_paths`, `spec.dir`, `spec.rules`,
 * `spec.tool`, `spec.check`) — про оба места, где его можно объявить.
 */
function explainProject(pipelinePath: string) {
  return (_expression: string, namespace: string, path: string): string | undefined => {
    if (namespace !== 'project') return undefined;
    if (!PROJECT_NAMES.includes(path)) {
      return `Пространство project содержит только ${PROJECT_NAMES.join(', ')}`;
    }
    return `Объявите project.${path} верхним ключом пайплайна (${pipelinePath}) либо в .stepcast/config.yml`;
  };
}

/**
 * Область `job`: единственное имя `lane` — значение ключа обвязки `lane`,
 * объявленного на месте подключения работы. Пусто у работы без объявленной
 * метки — тогда `${job.lane}` не находит `lane` в значениях и падает в общую
 * ветку `explain`, а не раскрывается в пустую строку: пустая строка собрала
 * бы имя соседней сущности (`plan-`) молча.
 */
function jobValues(lane: string | undefined): Readonly<Record<string, unknown>> {
  return lane === undefined ? {} : { lane };
}

/**
 * Объяснение для тела работы: то же, что `explainProject`, плюс причина
 * отсутствия `job.lane` — работа, которую называет `jobId`, не объявила метку
 * обвязкой подключения.
 */
function explainBody(pipelinePath: string, jobId: string) {
  const explainProjectFor = explainProject(pipelinePath);
  return (expression: string, namespace: string, path: string): string | undefined => {
    if (namespace === 'job') {
      return `Работа ${jobId} не объявляет lane на месте подключения — ${'${'}${expression}${'}'} не может раскрыться в пустую строку`;
    }
    return explainProjectFor(expression, namespace, path);
  };
}

/**
 * Действующие значения пространства `project`: пайплайн поверх конфигурации,
 * по каждому ключу отдельно — ни один слой не обязателен, и объявление части
 * группы в одном слое не должно затенять часть, объявленную в другом.
 * Разрешается один раз в `expandPipeline`; оба потребителя (`pipelineScope` и
 * `bodyScope`) получают уже посчитанный объект.
 */
function resolveProjectValues(
  document: Pick<PipelineDocument, 'project'>,
  config: Config,
): Readonly<Record<string, unknown>> {
  return {
    check: document.project?.check ?? config.project.check,
    tools: document.project?.tools ?? config.project.tools,
    edit_paths: document.project?.edit_paths ?? config.project.editPaths,
    spec: {
      dir: document.project?.spec?.dir ?? config.project.spec.dir,
      rules: document.project?.spec?.rules ?? config.project.spec.rules,
      tool: document.project?.spec?.tool ?? config.project.spec.tool,
      check: document.project?.spec?.check ?? config.project.spec.check,
    },
    knowledge: {
      dir: document.project?.knowledge?.dir ?? config.project.knowledge.dir,
      rules: document.project?.knowledge?.rules ?? config.project.knowledge.rules,
      provider: document.project?.knowledge?.provider ?? config.project.knowledge.provider,
    },
  };
}

/**
 * Действующая практика памяти: пайплайн поверх конфигурации, полистово — тем
 * же правилом, что `resolveProjectValues`. Величины разбираются здесь, а не
 * слоем конфигурации, потому что пайплайновый слой приходит строкой (`2k`,
 * `14d`) и до этого места числом не становился.
 *
 * Согласованность объявления (`cmd` без команды, `fs` без каталога)
 * проверяется на слитом значении, а не в каждом слое: провайдер, объявленный
 * пайплайном, и команда, объявленная конфигурацией, законны вместе.
 */
function resolveKnowledge(
  document: Pick<PipelineDocument, 'project'>,
  config: Config,
  pipelinePath: string,
): KnowledgeDeclaration {
  const declared = document.project?.knowledge;
  const base = config.project.knowledge;

  const provider = declared?.provider ?? base.provider;
  const command = declared?.command ?? base.command;
  const dir = declared?.dir ?? base.dir;

  if (provider === 'cmd' && command === undefined) {
    throw new StepcastError('Источник знания cmd объявлен без команды', {
      file: pipelinePath,
      at: 'project.knowledge.command',
      hint: 'Назовите команду источника или объявите provider: fs',
    });
  }
  if (provider === 'fs' && dir === undefined) {
    throw new StepcastError('Встроенный источник знания объявлен без каталога', {
      file: pipelinePath,
      at: 'project.knowledge.dir',
      hint: 'Назовите каталог знания — например, dir: knowledge',
    });
  }

  return {
    provider,
    command,
    dir,
    rules: declared?.rules ?? base.rules,
    indexMaxTokens:
      declared?.index_max_tokens === undefined
        ? base.indexMaxTokens
        : parseTokens(declared.index_max_tokens, 'project.knowledge.index_max_tokens'),
    specIndexMaxTokens:
      declared?.spec_index_max_tokens === undefined
        ? base.specIndexMaxTokens
        : parseTokens(declared.spec_index_max_tokens, 'project.knowledge.spec_index_max_tokens'),
    unitMaxTokens:
      declared?.unit_max_tokens === undefined
        ? base.unitMaxTokens
        : parseTokens(declared.unit_max_tokens, 'project.knowledge.unit_max_tokens'),
    staleAfterMs:
      declared?.stale_after === undefined
        ? base.staleAfterMs
        : parseDuration(declared.stale_after, 'project.knowledge.stale_after'),
    timeoutMs:
      declared?.timeout === undefined
        ? base.timeoutMs
        : parseDuration(declared.timeout, 'project.knowledge.timeout'),
  };
}

/** Корни трёх слоёв разрешения шага `script` (design.md, решение 3). */
export interface ScriptRoots {
  /** `<project>/.stepcast/scripts/` ищется от этого каталога. */
  readonly project: string;
  /** `<home>/.stepcast/scripts/` ищется от этого каталога. */
  readonly home: string;
  /** Встроенный каталог пакета целиком — без `.stepcast/scripts/` внутри него. */
  readonly builtin: string;
}

export interface ExpandOptions {
  readonly pipelinePath: string;
  readonly config: Config;
  /**
   * Реестр вкладов: от него зависит перечень допустимых ключей предикатов и
   * проверка их значений. Без значения — только встроенные предикаты.
   */
  readonly registry?: Registry;
  /** Значения `--input`, как их передал пользователь. */
  readonly inputs?: Readonly<Record<string, ParamValue>>;
  /**
   * Каталог запуска — семя умолчания `scriptRoots.project`/`stepRoots.project`
   * вместо `dirname(pipelinePath)` (`pipeline-definition`, «Ссылка на поставку
   * называет и пайплайн, а не только схему»). Нужен пайплайну поставки: его
   * файл лежит внутри пакета, и `findProjectRoot` от каталога поставки нашёл
   * бы (или не нашёл) `.git` не там, где стоит искать раннер/степ-слои
   * проекта, — искать их нужно от каталога, откуда команда вызвана.
   * Игнорируется, если `scriptRoots`/`stepRoots` заданы явно.
   */
  readonly projectRoot?: string;
  /**
   * Корни слоёв разрешения `script`. Тесты подставляют свои — умолчание
   * (`findProjectRoot(dirname(pipelinePath))`, `homedir()`,
   * `findPackageRoot` от расположения этого модуля) годится для настоящего
   * прогона, но держит их на каталогах машины и повторяемости тестов не даёт.
   */
  readonly scriptRoots?: ScriptRoots;
  /**
   * Корни слоёв разрешения имени `uses` — тот же приём, что у `scriptRoots`:
   * тесты подставляют свои, умолчание (`scriptRoots.project`/`.home`,
   * `src/builtin/steps` от расположения движка) годится для настоящего
   * прогона. Форма та же, что у `ScriptRoots`, но `builtin` указывает на
   * каталог переиспользуемых шагов пакета, а не на каталог скриптов.
   */
  readonly stepRoots?: ScriptRoots;
}

/**
 * Привести числовое поле после раскрытия подстановок. `inputs` и `params`
 * раскрываются раньше и приходят сюда уже числом или числовой строкой; от
 * `jobs`, `run` и `env` в значении остаётся нетронутый `${...}` — эти
 * пространства известны только в прогоне, а числовое поле нужно раньше.
 *
 * Отложенное пространство ищется в самом значении: выражение могло доехать до
 * поля через `params`, и тогда на поле записана вполне раскрытая подстановка
 * `params.*`, а `${jobs...}` виден только в тексте. Остаток `${`, не
 * принадлежащий отложенному пространству, — это литерал, полученный
 * экранированием; он идёт в разбор и отклоняется как неразбираемое число.
 */
function toCount(
  raw: string | number,
  path: string,
  substitutions: SubstitutionMap,
  parse: (input: string | number, at?: string, source?: string) => number,
  at: string,
): number {
  const expression = substitutions.get(path)?.[0]?.expression;
  const source = expression === undefined ? undefined : `\${${expression}}`;

  if (typeof raw === 'string') {
    const deferred = placeholderNamespaces(raw).filter((namespace) =>
      DEFERRED_NAMESPACES.has(namespace),
    );
    if (deferred.length > 0) {
      throw new StepcastError(
        `Числовое поле ссылается на отложенное пространство ${deferred.join(', ')}`,
        {
          at,
          hint:
            'Пространства jobs, run и env известны только в прогоне — числовое поле раскрывается при разборе пайплайна' +
            (source === undefined ? '' : `. Значение получено из ${source}`),
        },
      );
    }
  }

  return parse(raw, at, source);
}

/**
 * Разобрать объявление `data`: каждое имя проверяется тем же предикатом, что и
 * ключ данных при записи (`assertDataKey`), — недопустимое имя отклоняется
 * здесь, при разборе, а не отказом на середине прогона.
 */
function toDataDeclaration(
  raw: readonly string[] | undefined,
  declaringFile: string,
  at: string,
): readonly string[] {
  const names = raw ?? [];
  for (const name of names) {
    try {
      assertDataKey(name);
    } catch (error) {
      throw new StepcastError(`Работа объявляет данные с недопустимым именем «${name}»`, {
        file: declaringFile,
        at: `${at}.data`,
        ...(error instanceof StepcastError && error.hint !== undefined ? { hint: error.hint } : {}),
        cause: error,
      });
    }
  }
  return names;
}

function toBudget(raw: RawBudget, substitutions: SubstitutionMap, at: string): Budget {
  const onExceed = raw.on_exceed ?? 'stop';

  return {
    ...(raw.tokens === undefined ? {} : { tokens: parseTokens(raw.tokens, `${at}.tokens`) }),
    ...(raw.cost === undefined ? {} : { costMicroUsd: parseMoney(raw.cost, `${at}.cost`) }),
    ...(raw.wallclock === undefined
      ? {}
      : { wallclockMs: parseDuration(raw.wallclock, `${at}.wallclock`) }),
    ...(raw.rate_limit_pct === undefined
      ? {}
      : {
          rateLimitPct: toCount(
            raw.rate_limit_pct,
            `${at}.rate_limit_pct`,
            substitutions,
            parsePercent,
            `${at}.rate_limit_pct`,
          ),
        }),
    onExceed,
    ...(raw.on_exceed === undefined ? {} : { declaredOnExceed: raw.on_exceed }),
  };
}

/**
 * Расписание не подстановочное поле по смыслу — cron-выражению негде взять
 * значение из `${inputs.*}` — но проходит через `interpolateTree` наравне с
 * остальными скалярными полями пайплайна: `pipelineRest` не исключает его, и
 * заводить отдельный путь только ради одного поля незачем.
 */
function toTriggers(
  raw:
    | { schedule?: readonly { cron?: string | undefined; timezone?: string | undefined }[] | undefined }
    | undefined,
): Triggers | undefined {
  if (raw === undefined) return undefined;
  return {
    schedule: (raw.schedule ?? []).map((entry) => ({
      ...(entry.cron === undefined ? {} : { cron: entry.cron }),
      ...(entry.timezone === undefined ? {} : { timezone: entry.timezone }),
    })),
  };
}

/**
 * Селектор записи знания из объявленной формы. Ровно одно из `scope` и `id`:
 * запись без селектора почти наверняка забытая правка, а запись с обоими
 * несёт два разных вопроса под одним ответом.
 */
function toKnowledgeSelector(raw: RawContextEntry & object, at: string): ContextEntry {
  const declared = (raw as { knowledge: unknown }).knowledge;

  if (declared === 'index') {
    return { kind: 'knowledge', selector: { kind: 'index' } };
  }

  const body = declared as { scope?: string | string[]; id?: string | string[]; budget?: unknown };
  const hasScope = body.scope !== undefined;
  const hasId = body.id !== undefined;

  if (hasScope === hasId) {
    throw new StepcastError(
      hasScope
        ? 'Запись контекста knowledge объявляет и scope, и id'
        : 'Запись контекста knowledge не объявляет ни scope, ни id',
      {
        at,
        hint: 'Допустимы три формы: knowledge: index, { scope: … }, { id: … }',
      },
    );
  }

  const budget =
    body.budget === undefined
      ? undefined
      : parseTokens(body.budget as string | number, `${at}.budget`);

  const list = (value: string | string[]): readonly string[] =>
    typeof value === 'string' ? [value] : value;

  return {
    kind: 'knowledge',
    selector: hasScope
      ? { kind: 'scope', scope: list(body.scope as string | string[]) }
      : { kind: 'id', id: list(body.id as string | string[]) },
    ...(budget === undefined ? {} : { budget }),
  };
}

function toContext(raw: readonly RawContextEntry[] | undefined, at = 'context'): ContextEntry[] {
  return (raw ?? []).map((entry, index) => {
    if (typeof entry === 'string') return { kind: 'path', path: entry, mode: 'auto' };
    if ('text' in entry) return { kind: 'text', text: entry.text };
    if ('knowledge' in entry) return toKnowledgeSelector(entry, `${at}[${index}]`);
    return {
      kind: 'path',
      path: entry.path,
      mode: entry.mode ?? 'auto',
      // Только объявленное: необъявленное требование не должно отличать
      // запись от прежней ни в снимке пайплайна, ни в отчёте.
      ...(entry.required === undefined ? {} : { required: entry.required }),
    };
  });
}

/**
 * Путь схемы разрешается от файла объявления — тем же правилом, что
 * `output_schema` шага и `output.schema` работы. Путь `file_exists` остаётся
 * сырым: он указывает на файл, созданный шагом, а тот появляется в рабочей
 * директории.
 */
/**
 * Проверка значений плагинных предикатов. Тот же движок схем, что и у
 * встроенного предиката `schema`, — второй потребовал бы от автора плагина
 * знать, какой диалект понимает движок.
 */
const ajv = new Ajv2020({ allErrors: true, strict: false });

/**
 * Всё, чем располагает типизированный разбор встроенного предиката
 * (design.md, Решение 3) — те же параметры, что раньше принимал `toPredicate`
 * целиком. Один и тот же набор для всех десяти встроенных предикатов, даже
 * когда конкретному не нужна часть полей.
 */
interface BuiltinPredicateParseContext {
  readonly declaringFile: string;
  readonly substitutions: SubstitutionMap;
  readonly at: string;
  readonly registry: Registry;
  readonly config: Config;
  readonly scriptRoots: ScriptRoots;
}

/**
 * Собрать внутреннюю форму встроенного предиката единственным приведением
 * `raw`/`ctx` (design.md, Решение 3): `test` — предикат типа над
 * `RawBuiltinPredicate`, сужающий её оператором `in`, как сегодня в цепочке
 * `toPredicate`; `parse` получает уже сужённую ветвь и типизированный
 * контекст, и в его теле приведений типа больше нет.
 */
function nativePredicateForm<R extends RawBuiltinPredicate & Record<string, unknown>>(
  name: string,
  test: (raw: Record<string, unknown>) => raw is R,
  parse: (raw: R, ctx: BuiltinPredicateParseContext) => Predicate,
): NativePredicate {
  return {
    name,
    native: {
      test,
      parse: (raw, ctx) => parse(raw as R, ctx as BuiltinPredicateParseContext),
    },
  };
}

function isExitCodePredicateRaw(raw: Record<string, unknown>): raw is Extract<RawBuiltinPredicate, { exit_code: unknown }> {
  return 'exit_code' in raw;
}
function parseExitCodePredicate(
  raw: Extract<RawBuiltinPredicate, { exit_code: unknown }>,
  ctx: BuiltinPredicateParseContext,
): Predicate {
  return {
    kind: 'exit_code',
    value: toCount(raw.exit_code, `${ctx.at}.exit_code`, ctx.substitutions, parseExitCode, `${ctx.at}.exit_code`),
  };
}

function isFileExistsPredicateRaw(raw: Record<string, unknown>): raw is Extract<RawBuiltinPredicate, { file_exists: unknown }> {
  return 'file_exists' in raw;
}
function parseFileExistsPredicate(raw: Extract<RawBuiltinPredicate, { file_exists: unknown }>): Predicate {
  return { kind: 'file_exists', path: raw.file_exists };
}

function isSchemaPredicateRaw(raw: Record<string, unknown>): raw is Extract<RawBuiltinPredicate, { schema: unknown }> {
  return 'schema' in raw;
}
function parseSchemaPredicate(
  raw: Extract<RawBuiltinPredicate, { schema: unknown }>,
  ctx: BuiltinPredicateParseContext,
): Predicate {
  return { kind: 'schema', path: resolveSchemaPath(raw.schema, ctx.declaringFile, `${ctx.at}.schema`) };
}

function isMatchesPredicateRaw(raw: Record<string, unknown>): raw is Extract<RawBuiltinPredicate, { matches: unknown }> {
  return 'matches' in raw;
}
function parseMatchesPredicate(raw: Extract<RawBuiltinPredicate, { matches: unknown }>): Predicate {
  return { kind: 'matches', pattern: raw.matches };
}

function isNotMatchesPredicateRaw(raw: Record<string, unknown>): raw is Extract<RawBuiltinPredicate, { not_matches: unknown }> {
  return 'not_matches' in raw;
}
function parseNotMatchesPredicate(raw: Extract<RawBuiltinPredicate, { not_matches: unknown }>): Predicate {
  return { kind: 'not_matches', pattern: raw.not_matches };
}

function isChangedOnlyPredicateRaw(raw: Record<string, unknown>): raw is Extract<RawBuiltinPredicate, { changed_only: unknown }> {
  return 'changed_only' in raw;
}
function parseChangedOnlyPredicate(raw: Extract<RawBuiltinPredicate, { changed_only: unknown }>): Predicate {
  return { kind: 'changed_only', globs: raw.changed_only };
}

function isKnowledgeValidPredicateRaw(raw: Record<string, unknown>): raw is Extract<RawBuiltinPredicate, { knowledge_valid: unknown }> {
  return 'knowledge_valid' in raw;
}
function parseKnowledgeValidPredicate(
  raw: Extract<RawBuiltinPredicate, { knowledge_valid: unknown }>,
  ctx: BuiltinPredicateParseContext,
): Predicate {
  // `knowledge_valid: false` не значит «проверять на несоответствие»: у
  // предиката нет отрицания, и молча читать его как «не проверять» значило
  // бы отличать выключенную проверку от отсутствующей ничем.
  if (raw.knowledge_valid !== true) {
    throw new StepcastError('Предикат knowledge_valid принимает только true', {
      at: `${ctx.at}.knowledge_valid`,
      hint: 'Уберите предикат, если проверять память не нужно',
    });
  }
  return { kind: 'knowledge_valid' };
}

function isCmdPredicateRaw(raw: Record<string, unknown>): raw is Extract<RawBuiltinPredicate, { cmd: unknown }> {
  return 'cmd' in raw;
}
function parseCmdPredicate(raw: Extract<RawBuiltinPredicate, { cmd: unknown }>): Predicate {
  return { kind: 'cmd', command: raw.cmd };
}

function isScriptPredicateRaw(raw: Record<string, unknown>): raw is Extract<RawBuiltinPredicate, { script: unknown }> {
  return 'script' in raw;
}
function parseScriptPredicate(
  raw: Extract<RawBuiltinPredicate, { script: unknown }>,
  ctx: BuiltinPredicateParseContext,
): Predicate {
  // Путь и раннер разрешаются тем же правилом, что и у шага `script`, без
  // `args` и без явного `runner`: у предиката этих ключей нет вовсе
  // (`docs/pipeline-format.md`, раздел «Предикат script»).
  const outcome = resolveScript(raw.script, [], undefined, ctx.declaringFile, ctx.config, ctx.scriptRoots, `${ctx.at}.script`);
  return {
    kind: 'script',
    path: raw.script,
    ...('resolved' in outcome ? { resolved: outcome.resolved } : { unresolved: outcome.unresolved }),
  };
}

function isJudgePredicateRaw(raw: Record<string, unknown>): raw is Extract<RawBuiltinPredicate, { judge: unknown }> {
  return 'judge' in raw;
}
function parseJudgePredicate(raw: Extract<RawBuiltinPredicate, { judge: unknown }>): Predicate {
  return {
    kind: 'judge',
    claim: raw.judge,
    hard: raw.hard ?? false,
    ...(raw.agent === undefined ? {} : { agent: raw.agent }),
    ...(raw.model === undefined ? {} : { model: raw.model }),
  };
}

/**
 * Десять внутренних форм встроенных предикатов — вкладом того же вида, каким
 * сервис `predicates` ядра принимает плагинный (`native`, design.md, Решение
 * 2). Экспортированы поимённо, а не собраны в одну функцию регистрации:
 * регистрирует их строка встроенного слоя (`src/parts/pipeline/expect/row.ts`).
 * Порядок регистрации фиксирует перечень строк (`src/parts/rows.ts`), а не
 * порядок этих объявлений.
 */
export const EXIT_CODE_PREDICATE = nativePredicateForm('exit_code', isExitCodePredicateRaw, parseExitCodePredicate);
export const FILE_EXISTS_PREDICATE = nativePredicateForm('file_exists', isFileExistsPredicateRaw, parseFileExistsPredicate);
export const SCHEMA_PREDICATE = nativePredicateForm('schema', isSchemaPredicateRaw, parseSchemaPredicate);
export const MATCHES_PREDICATE = nativePredicateForm('matches', isMatchesPredicateRaw, parseMatchesPredicate);
export const NOT_MATCHES_PREDICATE = nativePredicateForm('not_matches', isNotMatchesPredicateRaw, parseNotMatchesPredicate);
export const CHANGED_ONLY_PREDICATE = nativePredicateForm('changed_only', isChangedOnlyPredicateRaw, parseChangedOnlyPredicate);
export const KNOWLEDGE_VALID_PREDICATE = nativePredicateForm('knowledge_valid', isKnowledgeValidPredicateRaw, parseKnowledgeValidPredicate);
export const CMD_PREDICATE = nativePredicateForm('cmd', isCmdPredicateRaw, parseCmdPredicate);
export const SCRIPT_PREDICATE = nativePredicateForm('script', isScriptPredicateRaw, parseScriptPredicate);
export const JUDGE_PREDICATE = nativePredicateForm('judge', isJudgePredicateRaw, parseJudgePredicate);

/**
 * Те же десять форм в каноническом порядке строки предикатов
 * (`src/parts/pipeline/expect/row.ts`) — для единственного вопроса, который задаётся о
 * предикате **вне** действующего состава: узнал бы он этот ключ, будь его
 * строка включена (`rejectUnknownPredicates` ниже). Обход реестра
 * (`matchNativePredicate`) на него ответить не может — снятого предиката в
 * реестре нет, — а перечень не задаёт ни порядка регистрации, ни порядка
 * разбора: и то и другое по-прежнему записано только в перечне строк.
 */
const BUILTIN_PREDICATES_IN_ROW_ORDER: readonly NativePredicate[] = [
  EXIT_CODE_PREDICATE,
  FILE_EXISTS_PREDICATE,
  SCHEMA_PREDICATE,
  MATCHES_PREDICATE,
  NOT_MATCHES_PREDICATE,
  CHANGED_ONLY_PREDICATE,
  KNOWLEDGE_VALID_PREDICATE,
  CMD_PREDICATE,
  SCRIPT_PREDICATE,
  JUDGE_PREDICATE,
];

/**
 * Встроенный предикат, узнавший себя в сырой записи, — обход реестра
 * (design.md, Решение 3), тем же приёмом, что `matchStepKind`: спрашивается
 * действующий состав (`isNativePredicate` + `native.test`), а не
 * фиксированная цепочка `in`.
 */
function matchNativePredicate(rawRecord: Record<string, unknown>, registry: Registry): NativePredicate | undefined {
  for (const [, kind] of registry.predicates) {
    if (isNativePredicate(kind) && kind.native.test(rawRecord)) return kind;
  }
  return undefined;
}

function toPredicate(
  raw: RawPredicate,
  declaringFile: string,
  substitutions: SubstitutionMap,
  at: string,
  registry: Registry,
  config: Config,
  scriptRoots: ScriptRoots,
): Predicate {
  const rawRecord = raw as unknown as Record<string, unknown>;
  const matched = matchNativePredicate(rawRecord, registry);
  if (matched !== undefined) {
    const ctx: BuiltinPredicateParseContext = { declaringFile, substitutions, at, registry, config, scriptRoots };
    return matched.native.parse(raw, ctx) as Predicate;
  }

  return toPluginPredicate(raw, at, registry);
}

/**
 * Предикат плагина: ключ уже принят схемой документа, форму значения
 * проверяет JSON Schema вклада. Проверка здесь, а не в схеме документа,
 * потому что zod-модель чужой версии в объединение не положить, — но она
 * всё равно происходит при разборе, до первого токена.
 */
function toPluginPredicate(raw: RawPredicate, at: string, registry: Registry): Predicate {
  const keys = Object.keys(raw as Record<string, unknown>);
  const name = keys[0];
  const contribution = name === undefined ? undefined : registry.predicates.get(name);

  if (name === undefined || contribution === undefined || !hasPredicateEvaluator(contribution)) {
    throw new StepcastError(`Неизвестный предикат ${name ?? '(без ключа)'}`, {
      at,
      hint: `Доступны: ${predicateNames(registry).join(', ')}`,
    });
  }

  const value = (raw as Record<string, unknown>)[name];
  const validate = ajv.compile(contribution.schema as object);
  if (!validate(value)) {
    const detail = (validate.errors ?? [])
      .map((error) => `${error.instancePath === '' ? 'значение' : error.instancePath} ${error.message ?? ''}`.trim())
      .join('; ');
    throw new StepcastError(`Значение предиката ${name} не соответствует его схеме: ${detail}`, {
      at: `${at}.${name}`,
      hint: `Схему объявляет плагин, внёсший предикат ${name}`,
    });
  }

  return { kind: 'plugin', name, value };
}

function toPermissions(raw: NonNullable<RawAgentStep['permissions']>): Permissions {
  return {
    ...(raw.mode === undefined ? {} : { mode: raw.mode }),
    ...(raw.allow === undefined ? {} : { allow: raw.allow }),
    ...(raw.deny === undefined ? {} : { deny: raw.deny }),
    ...(raw.enforce === undefined ? {} : { enforce: raw.enforce }),
  };
}

/**
 * Приводит сырое объявление серверов к модели. Новый объект строится всегда
 * заново, даже когда содержимое не меняется (`mcp: {}`): на тождестве этого
 * объекта держится различение уровня, где объявление сделано на самом деле
 * (`expand.ts`, StepDefaults, и диагностика линта, design.md решение 2).
 */
function toMcp(raw: RawMcp): McpServers {
  return Object.fromEntries(
    Object.entries(raw).map(([name, server]) => [
      name,
      'command' in server
        ? { command: server.command, ...(server.env === undefined ? {} : { env: server.env }) }
        : { url: server.url, ...(server.headers === undefined ? {} : { headers: server.headers }) },
    ]),
  );
}

function toAttempts(
  raw: RawStep['attempts'],
  limits: Config['limits'],
  substitutions: SubstitutionMap,
  at: string,
): Attempts {
  const max =
    raw?.max === undefined
      ? 1
      : toCount(raw.max, `${at}.attempts.max`, substitutions, parseCount, `${at}.attempts.max`);
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

const STEPCAST_SCHEMA_PREFIX = 'stepcast:';

/**
 * Путь к схеме, объявленной в документе: `stepcast:<имя>` — ссылка на схему,
 * поставляемую пакетом stepcast, разрешается от расположения движка
 * (`packagedSchemaPath`), а не от файла объявления. Прочее значение — путь,
 * разрешаемый как обычно. Ветка применяется только к местам объявления
 * схемы — `uses` и `prompt: file:` остаются на `resolveDeclaredPath`, движок
 * не публикует ни работ, ни промптов.
 */
function resolveSchemaPath(value: string, declaringFile: string, declaredAt: string): string {
  if (value.startsWith(STEPCAST_SCHEMA_PREFIX)) {
    return packagedSchemaPath(value.slice(STEPCAST_SCHEMA_PREFIX.length), {
      file: declaringFile,
      declaredAt,
    });
  }
  return resolveDeclaredPath(value, declaringFile);
}

function readPrompt(
  value: string,
  declaringFile: string,
  scope: Scope,
  at: string,
): {
  text: string;
  source?: string;
  substitutions: readonly Substitution[];
} {
  // Промпт, объявленный прямо в документе, сюда приходит уже раскрытым: тело
  // работы целиком проходит через `interpolateTree`, и его подстановки уже
  // записаны в карту под этим же ключом. Второй проход дал бы их дубли с
  // позициями по раскрытому тексту и вдобавок снял бы экранирование ещё раз,
  // превратив литерал `$${inputs.x}` в значение.
  if (!value.startsWith('file:')) return { text: value, substitutions: [] };

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
  // Происхождение объявляется только для этого текста: остальная область
  // видимости раскрывает поля документа, у которых место — точечный путь, а
  // не файл.
  const fileScope: Scope = { ...scope, origin: path };
  const result = interpolateTree(raw, fileScope, at);
  return { text: result.value, source: path, substitutions: result.substitutions.get(at) ?? [] };
}

/**
 * Дописать подстановки, найденные при раскрытии файла промпта, в карту под
 * тем же ключом, что и у промпта, объявленного в документе, — вместо
 * перезаписи: у поля документа уже могла быть записана подстановка из самого
 * пути `file:...`, и её нельзя терять.
 */
function recordPromptSubstitutions(
  substitutions: Map<string, readonly Substitution[]>,
  key: string,
  extra: readonly Substitution[],
): void {
  if (extra.length === 0) return;
  substitutions.set(key, [...(substitutions.get(key) ?? []), ...extra]);
}

/**
 * Ключи шага, снимаемые с него перед общим `interpolateTree` тела работы:
 * `input`, `with` и ключ каждого плагинного вида шага. Подстановка внутри них
 * разрешается типизированным проходом в `toStep`, а не общим, который вернул
 * бы всё строкой (design.md, решение 4). `with` шага `uses` — тот же случай,
 * что и `input` шага `script`: главный смысл контракта — объект из выхода
 * работы выше по графу, а не строка; поля плагинного вида — он же
 * (`toPluginStep` раскрывает их `interpolateTypedTree`), и без изъятия число,
 * объект и список доезжали бы до схемы вклада строками. Тот же приём, каким из
 * общего обхода уже вынесен `display` работы.
 */
function typedStepKeys(registry: Registry): readonly string[] {
  return ['input', 'with', ...pluginStepKindDescriptors(registry).flatMap((descriptor) => descriptor.keys)];
}

function omitStepInputs(rawSteps: unknown, registry: Registry): unknown {
  if (!Array.isArray(rawSteps)) return rawSteps;
  const typed = typedStepKeys(registry);
  return rawSteps.map((step) => {
    if (step === null || typeof step !== 'object') return step;
    const rest = { ...(step as Record<string, unknown>) };
    for (const key of typed) delete rest[key];
    return rest;
  });
}

/** Вернуть на место ключи, снятые `omitStepInputs`, — нераскрытыми, для `toStep`. */
function restoreStepInputs(interpolatedSteps: unknown, rawSteps: unknown, registry: Registry): unknown {
  if (!Array.isArray(interpolatedSteps) || !Array.isArray(rawSteps)) return interpolatedSteps;
  const typed = typedStepKeys(registry);
  return interpolatedSteps.map((step, index) => {
    const original = rawSteps[index];
    if (original === null || typeof original !== 'object') return step;
    const originalRecord = original as Record<string, unknown>;
    const restored = { ...(step as Record<string, unknown>) };
    for (const key of typed) {
      if (key in originalRecord) restored[key] = originalRecord[key];
    }
    return restored;
  });
}

function parseModelTier(value: unknown, file: string, at: string): ModelTier | undefined {
  if (value === undefined) return undefined;
  const parsed = ModelTierSchema.safeParse(value);
  if (!parsed.success) {
    throw new StepcastError(`Недопустимый model_tier: ${String(value)}`, {
      file, at, hint: 'Допустимы max, deep, balance, fast, mini',
    });
  }
  return parsed.data;
}

/**
 * Найти файл скрипта: явный путь (`./`, `../`, абсолютный) разрешается от
 * файла объявления и слоёв не касается; голое имя ищется слоями — проектный,
 * домашний, встроенный (design.md, решение 3). Возвращает найденный файл
 * либо перечень каталогов, в которых его не было — не бросает исключение:
 * ненайденный файл не прерывает раскрытие (design.md, решение 1).
 */
function resolveScriptFile(
  value: string,
  declaringFile: string,
  roots: ScriptRoots,
): { readonly absolutePath: string; readonly layer: ScriptLayer } | { readonly searched: readonly string[] } {
  if (isAbsolute(value) || value.startsWith('./') || value.startsWith('../')) {
    const absolutePath = resolveDeclaredPath(value, declaringFile);
    if (isFile(absolutePath)) return { absolutePath, layer: 'explicit' };
    return { searched: [dirname(absolutePath)] };
  }

  const layers: ReadonlyArray<readonly [ScriptLayer, string]> = [
    ['project', join(roots.project, '.stepcast', 'scripts')],
    ['home', join(roots.home, '.stepcast', 'scripts')],
    ['builtin', roots.builtin],
  ];
  const searched: string[] = [];
  for (const [layer, dir] of layers) {
    searched.push(dir);
    const candidate = join(dir, value);
    if (isFile(candidate)) return { absolutePath: candidate, layer };
  }
  return { searched };
}

/**
 * Находкой считается обычный файл, а не всякий существующий путь: значение,
 * указавшее на каталог (`script: tools`, где `tools` — подкаталог слоя),
 * иначе дошло бы до чтения содержимого и упало бы системной ошибкой вместо
 * названного отказа. Символьная ссылка на файл — находка: `statSync` идёт по
 * ссылке, и раннер получит ровно то, что получил бы вручную.
 */
export function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

/**
 * Имя интерпретатора из строки shebang: последний сегмент пути, а для формы
 * `#!/usr/bin/env <имя>` — первое слово за `env`, не начинающееся с дефиса
 * (`-S` и подобные флаги `env` пропускаются). Сама строка в argv не попадает
 * никогда — только имя, которым ищут запись таблицы раннеров (design.md,
 * решение 5).
 */
function extractShebangName(content: string): string | undefined {
  if (!content.startsWith('#!')) return undefined;
  const newline = content.indexOf('\n');
  const firstLine = (newline === -1 ? content : content.slice(0, newline)).slice(2).trim();
  const parts = firstLine.split(/\s+/).filter((part) => part.length > 0);
  const interpreter = parts[0];
  if (interpreter === undefined) return undefined;

  const interpreterName = interpreter.split('/').pop();
  if (interpreterName !== 'env') return interpreterName === '' ? undefined : interpreterName;

  return parts.slice(1).find((part) => !part.startsWith('-'));
}

/** Короткий отпечаток содержимого файла: тем же образцом, что и другие хеши движка. */
export function fingerprintContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Выбрать раннер шага `script` тремя правилами: явный `runner` → расширение
 * файла → имя из shebang (design.md, решение 5). Возвращает либо имя и
 * запись таблицы, либо причину, по которой выбор не состоялся, — тоже не
 * исключение: диагностику даёт линт, а прогон отказывает названно.
 */
export function selectRunner(
  declaredRunner: string | undefined,
  absolutePath: string,
  content: string,
  config: Config,
): { readonly name: string; readonly command: readonly string[] } | ScriptUnresolved {
  if (declaredRunner !== undefined) {
    const runner = config.runners[declaredRunner];
    if (runner === undefined) {
      return {
        reason: 'unknown_runner',
        runner: declaredRunner,
        known: Object.keys(config.runners).sort(),
      };
    }
    return { name: declaredRunner, command: runner.command };
  }

  const extension = extname(absolutePath);
  const byExtension = extension === '' ? undefined : config.runnersByExtension.get(extension);
  if (byExtension !== undefined) {
    return { name: byExtension, command: config.runners[byExtension]!.command };
  }

  const shebangName = extractShebangName(content);
  const byShebang = shebangName === undefined ? undefined : config.runners[shebangName];
  if (byShebang !== undefined) {
    return { name: shebangName as string, command: byShebang.command };
  }

  return {
    reason: 'runner_undetermined',
    extensions: [...config.runnersByExtension.keys()].sort(),
  };
}

const STEPCAST_WRAPPER_PREFIX = 'stepcast:';

/**
 * Разрешить обёртку раннера в абсолютный путь (design.md, решение 7):
 * `stepcast:<имя>` — от расположения движка, путь — по тем же правилам, что
 * значение `script` (слоями для голого имени, от места объявления —
 * `runner.wrapperFile` — для `./` и `../`). Не объявлена — `undefined`.
 */
export function resolveWrapper(runner: RunnerConfig, roots: ScriptRoots): string | undefined {
  const value = runner.wrapper;
  if (value === undefined) return undefined;
  if (value.startsWith(STEPCAST_WRAPPER_PREFIX)) {
    return packagedWrapperPath(value.slice(STEPCAST_WRAPPER_PREFIX.length));
  }

  const declaringFile = runner.wrapperFile ?? roots.builtin;
  if (isAbsolute(value) || value.startsWith('./') || value.startsWith('../')) {
    return resolveDeclaredPath(value, declaringFile);
  }

  const located = resolveScriptFile(value, declaringFile, roots);
  if ('searched' in located) {
    throw new StepcastError(`Обёртка ${value} не найдена`, {
      hint: `Искали: ${located.searched.join(', ')}`,
    });
  }
  return located.absolutePath;
}

/**
 * Разрешить шаг `script` целиком: путь, раннер, argv, отпечаток. Отложенная
 * подстановка (`jobs`, `run`, `env`) в значении `script` отклоняется здесь же
 * — отпечаток и argv обязаны попасть в замок и ключ шага, а не остаться
 * текстом до прогона (design.md, решение 1б).
 */
function resolveScript(
  path: string,
  args: readonly string[],
  declaredRunner: string | undefined,
  declaringFile: string,
  config: Config,
  roots: ScriptRoots,
  at: string,
): { readonly resolved: ResolvedScript } | { readonly unresolved: ScriptUnresolved } {
  const deferred = placeholderNamespaces(path).filter((namespace) => DEFERRED_NAMESPACES.has(namespace));
  if (deferred.length > 0) {
    throw new StepcastError(`Значение script ссылается на отложенное пространство ${deferred.join(', ')}`, {
      file: declaringFile,
      at,
      hint: 'Пространства jobs, run и env известны только в прогоне — путь скрипта разрешается при раскрытии пайплайна',
    });
  }

  const located = resolveScriptFile(path, declaringFile, roots);
  if ('searched' in located) {
    return { unresolved: { reason: 'file_not_found', searched: located.searched } };
  }

  const content = readFileSync(located.absolutePath, 'utf8');
  const runner = selectRunner(declaredRunner, located.absolutePath, content, config);
  if ('reason' in runner) return { unresolved: runner };

  // Обёртка встаёт между командой раннера и путём скрипта (design.md, решение
  // 7): argv шага — команда, обёртка, скрипт, `args`.
  const wrapperPath = resolveWrapper(config.runners[runner.name]!, roots);

  return {
    resolved: {
      absolutePath: located.absolutePath,
      layer: located.layer,
      runner: runner.name,
      argv: [
        ...runner.command,
        ...(wrapperPath === undefined ? [] : [wrapperPath]),
        located.absolutePath,
        ...args,
      ],
      fingerprint: fingerprintContent(content),
    },
  };
}

/**
 * Текст причины отказа неразрешённого скрипта — общий для шага `script` и
 * предиката `script`: оба несут один и тот же перечень причин
 * (`ScriptUnresolved`), и текст должен звучать одинаково что в журнале
 * прогона, что в вердикте предиката (`run/runner.ts`, `expect/evaluate.ts`).
 *
 * Происхождение `uses` передаётся там, где шаг собран из манифеста: две
 * причины выбора раннера общие с шагом `script`, а объявлены они в манифесте,
 * и без него текст отправил бы автора искать `runner:` в документе пайплайна,
 * где его у шага `uses` нет вовсе.
 */
export function describeScriptUnresolved(
  unresolved: ScriptUnresolved,
  uses?: UsesOrigin,
): string {
  switch (unresolved.reason) {
    case 'file_not_found':
      return `Файл скрипта не найден ни в одном слое. Искали: ${unresolved.searched.join(', ')}`;
    case 'unknown_runner':
      return uses === undefined
        ? `Неизвестный раннер ${unresolved.runner}. Известны: ${unresolved.known.join(', ')}`
        : `Манифест шага ${uses.name} (${uses.manifestPath}) называет неизвестный раннер ${unresolved.runner}. Известны: ${unresolved.known.join(', ')}`;
    case 'runner_undetermined':
      return uses === undefined
        ? `Раннер не определяется ни расширением, ни shebang. Известные расширения: ${unresolved.extensions.join(', ')}`
        : `Шаг ${uses.name}: раннер файла, объявленного манифестом ${uses.manifestPath}, не определяется ни расширением, ни shebang. Известные расширения: ${unresolved.extensions.join(', ')}`;
    case 'step_not_found':
      return `Переиспользуемый шаг ${unresolved.name} не найден ни в одном слое. Искали: ${unresolved.searched.join(', ')}`;
    case 'manifest_invalid':
      return `Манифест шага ${unresolved.name} (${unresolved.manifestPath}) некорректен: ${unresolved.detail}`;
    case 'name_mismatch':
      return `Манифест ${unresolved.manifestPath} объявляет name: ${unresolved.manifestName}, а каталог шага называется ${unresolved.name}`;
    case 'step_file_missing':
      return `Шаг ${unresolved.name}: файл ${unresolved.expectedPath} не найден (манифест ${unresolved.manifestPath})`;
    case 'params_invalid':
      return `Шаг ${unresolved.name}: параметры не проходят манифест ${unresolved.manifestPath} — ${unresolved.detail}`;
  }
}

interface StepDefaults {
  readonly agent: string;
  readonly model: string | undefined;
  /**
   * Слой, давший `model`, — `job`, `pipeline` либо `config`; не определён, когда
   * `model` тоже не определена. Разрешается один раз в `expandPipeline`, рядом
   * со значением: сравнивать строки задним числом нельзя, одинаковое значение
   * законно прийти с разных слоёв.
   */
  readonly modelLayer: 'job' | 'pipeline' | 'config' | undefined;
  readonly modelTier: ModelTier | undefined;
  readonly tierLayer: 'pipeline' | 'job';
  readonly timeoutMs: number;
  readonly sessionMode: 'shared' | 'per_step';
  /** Политика доступа, объявленная работой — применяется к шагу без своей. */
  readonly permissions: Permissions | undefined;
  /**
   * Объявление MCP-серверов, действующее для шагов работы: своё, либо —
   * тем же объектом — унаследованное от пайплайна. Тождество объекта здесь
   * и отличает уровень объявления друг от друга (design.md, решение 2).
   */
  readonly mcp: McpServers | undefined;
}

/**
 * Всё, чем располагает типизированный разбор встроенного вида шага
 * (design.md, решение 2) — те же параметры, что раньше принимал `toStep`
 * целиком, плюс уже посчитанная общая часть. Один и тот же набор для всех
 * четырёх встроенных видов, даже когда конкретному не нужна часть полей:
 * бесплатнее общего типа, чем четыре разных сигнатуры.
 */
interface BuiltinStepParseContext {
  readonly common: StepCommon;
  readonly declaringFile: string;
  readonly scope: Scope;
  readonly defaults: StepDefaults;
  readonly config: Config;
  readonly substitutions: Map<string, readonly Substitution[]>;
  readonly at: string;
  readonly registry: Registry;
  readonly scriptRoots: ScriptRoots;
  readonly stepRoots: ScriptRoots;
}

type StepParseResult = { readonly step: Step; readonly modelOrigin?: ModelOrigin };

function buildStepCommon(
  raw: RawStep,
  index: number,
  declaringFile: string,
  defaults: StepDefaults,
  config: Config,
  substitutions: Map<string, readonly Substitution[]>,
  at: string,
  registry: Registry,
  scriptRoots: ScriptRoots,
): StepCommon {
  return {
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
    ...(raw.budget === undefined
      ? {}
      : { budget: toBudget(raw.budget, substitutions, `${at}.budget`) }),
    expect: (raw.expect ?? []).map((entry, i) =>
      toPredicate(entry, declaringFile, substitutions, `${at}.expect.${i}`, registry, config, scriptRoots),
    ),
    attempts: toAttempts(raw.attempts, config.limits, substitutions, at),
  };
}

/** Узнать шаг `run` среди уже провалидированных документом — замена дискриминанта (`toStep`). */
function isRunStepRaw(raw: Record<string, unknown>): boolean {
  return 'run' in raw;
}

function parseRunStep(raw: RawStep, ctx: BuiltinStepParseContext): StepParseResult {
  if (!('run' in raw)) throw new Error('parseRunStep: раскрытие вызвано на шаге без ключа run');
  const { common, declaringFile, scope, substitutions, at } = ctx;
  let onFail: { readonly analyze: string; readonly prompt: string } | undefined;
  if (raw.on_fail !== undefined) {
    const onFailKey = `${at}.on_fail.prompt`;
    const onFailPrompt = readPrompt(raw.on_fail.prompt, declaringFile, scope, onFailKey);
    recordPromptSubstitutions(substitutions, onFailKey, onFailPrompt.substitutions);
    onFail = { analyze: raw.on_fail.analyze, prompt: onFailPrompt.text };
  }
  return {
    step: {
      ...common,
      kind: 'run',
      command: raw.run,
      ...(onFail === undefined ? {} : { onFail }),
      ...(raw.output_schema === undefined
        ? {}
        : { outputSchemaPath: resolveSchemaPath(raw.output_schema, declaringFile, `${at}.output_schema`) }),
    },
  };
}

/** Узнать шаг `uses` среди уже провалидированных документом (`toStep`). */
function isUsesStepRaw(raw: Record<string, unknown>): boolean {
  return 'uses' in raw;
}

// Шаг `uses` разбирается до шага `script`: ключи, объявляемые манифестом,
// названы в его схеме (`declaredByManifest`) необязательными — и по
// присутствию ключа `script` два вида шага уже не различаются. Различает их
// сам `uses`, которого у шага `script` нет вовсе. Порядок обхода видов в
// `toStep` — порядок регистрации строк встроенного слоя в перечне дефолта
// (`src/parts/rows.ts`, `BUILTIN_ROWS`): `step-uses` стоит в нём раньше
// `step-script` ровно поэтому, и это единственное место, где порядок узнан.
function parseUsesStep(raw: RawStep, ctx: BuiltinStepParseContext): StepParseResult {
  if (!('uses' in raw)) throw new Error('parseUsesStep: раскрытие вызвано на шаге без ключа uses');
  const { common, scope, substitutions, at, stepRoots, scriptRoots, config } = ctx;
  let onFail: { readonly analyze: string; readonly prompt: string } | undefined;
  if (raw.on_fail !== undefined) {
    const onFailKey = `${at}.on_fail.prompt`;
    const onFailPrompt = readPrompt(raw.on_fail.prompt, ctx.declaringFile, scope, onFailKey);
    recordPromptSubstitutions(substitutions, onFailKey, onFailPrompt.substitutions);
    onFail = { analyze: raw.on_fail.analyze, prompt: onFailPrompt.text };
  }
  // `raw.with` дошёл сюда нераскрытым, тем же приёмом, что и `raw.input`
  // шага `script` (`omitStepInputs`/`restoreStepInputs`): типизированный
  // проход разрешает `${params.*}`/`${inputs.*}` здесь, а `${jobs.*}`,
  // `${run.*}` и `${env.*}` остаются текстом до `late.ts`.
  const withResult = interpolateTypedTree(raw.with ?? {}, scope, `${at}.with`);
  for (const [path, list] of withResult.substitutions) substitutions.set(path, list);

  const build = resolveUsesStep(raw.uses, withResult.value, stepRoots, scriptRoots, config);
  const usesResolved = 'resolved' in build ? build.resolved : undefined;

  return {
    step: {
      ...common,
      kind: 'script',
      // Абсолютный путь, если файл разрешился; иначе — имя, которым шаг
      // назван на месте вызова: `path` шага `script` тоже несёт то, чем
      // читатель мог бы опознать шаг до разрешения.
      path: usesResolved?.absolutePath ?? raw.uses,
      args: [],
      ...(onFail === undefined ? {} : { onFail }),
      // Сведённые параметры — с применёнными умолчаниями, если состав
      // прошёл проверку, иначе то, что передало место вызова: шаг всё
      // равно не исполнится (design.md, решение 6).
      input: build.uses.params ?? withResult.value,
      ...(build.outputSchemaPath === undefined ? {} : { outputSchemaPath: build.outputSchemaPath }),
      ...('resolved' in build ? { resolved: build.resolved } : { unresolved: build.unresolved }),
      uses: {
        ...build.uses,
        ...(build.paramsSchema === undefined ? {} : { paramsSchema: build.paramsSchema }),
      },
    },
  };
}

/** Узнать шаг `script` среди уже провалидированных документом (`toStep`). */
function isScriptStepRaw(raw: Record<string, unknown>): boolean {
  return 'script' in raw;
}

function parseScriptStep(raw: RawStep, ctx: BuiltinStepParseContext): StepParseResult {
  // Второе условие — не защитная копия: `UsesStepSchema` тоже несёт ключ
  // `script` в своём типе (`declaredByManifest`, всегда `undefined`), и без
  // него `raw.script` остался бы `string | undefined` для компилятора, хотя
  // на этом пути (после `uses`, см. порядок обхода `toStep`) шаг `uses`
  // сюда никогда не доходит.
  if (!('script' in raw) || 'uses' in raw) throw new Error('parseScriptStep: раскрытие вызвано на шаге без ключа script');
  const { common, scope, substitutions, at, declaringFile, config, scriptRoots } = ctx;
  let onFail: { readonly analyze: string; readonly prompt: string } | undefined;
  if (raw.on_fail !== undefined) {
    const onFailKey = `${at}.on_fail.prompt`;
    const onFailPrompt = readPrompt(raw.on_fail.prompt, declaringFile, scope, onFailKey);
    recordPromptSubstitutions(substitutions, onFailKey, onFailPrompt.substitutions);
    onFail = { analyze: raw.on_fail.analyze, prompt: onFailPrompt.text };
  }
  const args = raw.args ?? [];
  const outcome = resolveScript(raw.script, args, raw.runner, declaringFile, config, scriptRoots, `${at}.script`);
  // `raw.input` дошёл сюда нераскрытым (`omitStepInputs`/`restoreStepInputs`):
  // общий обход тела работы его не тронул, чтобы `${params.retries}` не
  // превратился в строку "3" раньше типизированного прохода.
  const inputResult = raw.input === undefined ? undefined : interpolateTypedTree(raw.input, scope, `${at}.input`);
  if (inputResult !== undefined) {
    for (const [path, list] of inputResult.substitutions) substitutions.set(path, list);
  }
  return {
    step: {
      ...common,
      kind: 'script',
      path: raw.script,
      args,
      ...(raw.runner === undefined ? {} : { runner: raw.runner }),
      ...(onFail === undefined ? {} : { onFail }),
      ...(inputResult === undefined ? {} : { input: inputResult.value }),
      ...(raw.output_schema === undefined
        ? {}
        : { outputSchemaPath: resolveSchemaPath(raw.output_schema, declaringFile, `${at}.output_schema`) }),
      ...('resolved' in outcome ? { resolved: outcome.resolved } : { unresolved: outcome.unresolved }),
    },
  };
}

/**
 * Узнать шаг `agent` среди уже провалидированных документом (`toStep`).
 * `prompt` — единственный обязательный ключ агентского шага, которого нет ни
 * у одного другого вида (встроенного или плагинного: имя плагинного вида не
 * вправе совпасть с ключом встроенного, design.md решение 3) — дискриминант
 * настоящий, а не позиция «последнего» в списке видов.
 */
function isAgentStepRaw(raw: Record<string, unknown>): boolean {
  return 'prompt' in raw;
}

function parseAgentStep(raw: RawStep, ctx: BuiltinStepParseContext): StepParseResult {
  if (!('prompt' in raw)) throw new Error('parseAgentStep: раскрытие вызвано на шаге без ключа prompt');
  const { common, scope, substitutions, at, declaringFile, config, defaults } = ctx;
  const promptKey = `${at}.prompt`;
  const prompt = readPrompt(raw.prompt, declaringFile, scope, promptKey);
  recordPromptSubstitutions(substitutions, promptKey, prompt.substitutions);
  const agent = raw.agent ?? defaults.agent;
  const backend = config.backends[agent];
  const tier = parseModelTier(raw.model_tier, declaringFile, `${at}.model_tier`) ?? defaults.modelTier;
  const tierModel = tier === undefined ? undefined : backend?.modelTiers?.[tier]?.model;
  const model = raw.model ?? defaults.model ?? tierModel ?? backend?.defaultModel;

  const modelOrigin: ModelOrigin =
    raw.model !== undefined
      ? { layer: 'step' }
      : defaults.modelLayer !== undefined
        ? { layer: defaults.modelLayer }
        : tier !== undefined
          ? {
              layer: 'tier', backend: agent, tier,
              tierLayer: raw.model_tier !== undefined ? 'step' : defaults.tierLayer,
              ...(tierModel === undefined ? { fallback: true as const } : {}),
            }
          : backend?.defaultModel !== undefined
            ? { layer: 'backend', backend: agent }
            : { layer: 'none' };

  return {
    step: {
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
        : { outputSchemaPath: resolveSchemaPath(raw.output_schema, declaringFile, `${at}.output_schema`) }),
      // Ближайшее объявление побеждает целиком: политика не складывается между
      // уровнями, поэтому job-level политика применяется, только если шаг не
      // назвал своей вовсе.
      ...(raw.permissions !== undefined
        ? { permissions: toPermissions(raw.permissions) }
        : defaults.permissions === undefined
          ? {}
          : { permissions: defaults.permissions }),
      // Тот же приём, что и с правами: шаг, назвавший свой блок (пустой в том
      // числе — `mcp: {}` снимает унаследованное), получает новый объект;
      // иначе — объект уровня работы/пайплайна тем же тождеством ссылки.
      ...(raw.mcp !== undefined
        ? { mcp: toMcp(raw.mcp) }
        : defaults.mcp === undefined
          ? {}
          : { mcp: defaults.mcp }),
    },
    modelOrigin,
  };
}

/**
 * Проверить значение под ключом плагинного вида шага схемой вклада — тем же
 * `ajv` и той же формой отказа, что и у плагинного предиката
 * (`toPluginPredicate` выше): путь поля, причина и имя плагина, объявившего
 * схему. Отдельная функция: её же зовёт `runner.ts` перед исполнением, по
 * окончательным значениям (design.md, решение 5).
 */
export function validateStepKindFields(kind: StepKindContribution, value: unknown, at: string, registry: Registry): void {
  const validate = ajv.compile(kind.fields as object);
  if (!validate(value)) {
    const detail = (validate.errors ?? [])
      .map((error) => `${error.instancePath === '' ? 'значение' : error.instancePath} ${error.message ?? ''}`.trim())
      .join('; ');
    const owner = contributionOwner(registry, 'steps', kind.name) ?? 'неизвестный';
    throw new StepcastError(`Поля вида шага ${kind.name} не соответствуют его схеме: ${detail}`, {
      at,
      hint: `Схему объявляет плагин ${owner}, внёсший вид шага ${kind.name}`,
    });
  }
}

/**
 * Форма документа вклада — объявленная либо синтезированная из имени и
 * `fields` (design.md, Решение 1): `test` = «ключ с именем вида присутствует»,
 * `keys` = `[имя]`, `schema` = `{ properties: { имя: fields }, required:
 * [имя] }`, `parse` = «значение под ключом». Одна функция, которой пользуются
 * и узнавание (`matchStepKind`), и разбор (`toPluginStep`), и сборка ветви
 * схемы (`registry.pluginStepKindDescriptors`, `published-schema.ts`) — ни
 * один из них не ветвится по тому, объявил вклад `document` сам или нет.
 */
function documentFormOf(kind: StepKindContribution): StepKindDocumentForm {
  if (kind.document !== undefined) return kind.document;
  const { name, fields } = kind;
  return {
    test: (raw) => name in raw,
    keys: [name],
    schema: { properties: { [name]: fields }, required: [name] },
    parse: (raw) => (raw as Record<string, unknown>)[name],
  };
}

/**
 * Узнавание шага любого вида — тест, независимо от происхождения (design.md,
 * Решение 4): вклад со своим исполнителем узнаётся объявленным либо
 * синтезированным `documentFormOf(kind).test`, внутренняя форма встроенных —
 * `native.test`. Вопрос — `hasStepExecutor`, а не `isNativeStepKind`: о
 * происхождении вклада узнавание не спрашивает вовсе, и вклад, случайно
 * несущий поле `native` (декларативному это имя запрещено схемой загрузки, а
 * плагину контекста — ничем), узнаётся своей формой, а не падает на чтении
 * документа голым TypeError. `matchStepKind` и `rejectUnknownStepKinds`
 * спрашивают только эту функцию, без своей ветви «встроенный / плагинный».
 */
function stepKindTest(kind: StepKind): (raw: Readonly<Record<string, unknown>>) => boolean {
  return hasStepExecutor(kind) ? documentFormOf(kind).test : kind.native.test;
}

/**
 * Проверить сырую запись шага, узнанного видом с собственной формой
 * документа, его `document.schema` — тем же `ajv` и той же формой отказа, что
 * и у `validateStepKindFields` ниже, только на записи документа, а не на
 * разобранных полях (design.md, Решение 6). Не зовётся для вклада без
 * `document`: его синтезированная форма всегда проходит собственную же схему,
 * и вторая проверка была бы дублированием `validateStepKindFields` под другим
 * текстом отказа.
 */
function validateStepKindDocument(
  kind: StepKindContribution & { readonly document: StepKindDocumentForm },
  value: unknown,
  at: string,
  registry: Registry,
): void {
  const validate = ajv.compile(kind.document.schema as object);
  if (!validate(value)) {
    const detail = (validate.errors ?? [])
      .map((error) => `${error.instancePath === '' ? 'значение' : error.instancePath} ${error.message ?? ''}`.trim())
      .join('; ');
    const owner = contributionOwner(registry, 'steps', kind.name) ?? 'неизвестный';
    throw new StepcastError(`Шаг вида ${kind.name} не соответствует его форме: ${detail}`, {
      at,
      hint: `Форму объявляет плагин ${owner}, внёсший вид шага ${kind.name}`,
    });
  }
}

/**
 * Шаг плагинного вида: занятые ключи вклада — объявленные `document.keys`
 * либо единственное имя (design.md, Решение 1). Каждый раскрывается
 * типизированным проходом, тем же, каким раскрывается `input` шага `script`
 * (design.md, решение 5): подстановка на объект или список не должна
 * превращаться в строку. Дальше — `document.schema` (только если форма
 * объявлена вкладом — иначе это была бы вторая проверка той же `fields`
 * схемой под новым текстом отказа), `parse` в обёртке отказа разбора
 * (design.md, Решение 6) и `fields` — как и раньше.
 */
function toPluginStep(
  rawRecord: Record<string, unknown>,
  kind: StepKindContribution,
  ctx: BuiltinStepParseContext,
): Step {
  const form = documentFormOf(kind);
  const hasOwnDocument = kind.document !== undefined;
  // Адрес отказа для формы документа — адрес самого шага: разобранные поля
  // пути в документе не имеют. Для формы `fields` — прежний адрес ключа.
  const at = hasOwnDocument ? ctx.at : `${ctx.at}.${kind.name}`;

  const values: Record<string, unknown> = {};
  let hasDeferred = false;
  for (const key of form.keys) {
    const keyAt = `${ctx.at}.${key}`;
    const result = interpolateTypedTree(rawRecord[key], ctx.scope, keyAt);
    for (const [path, list] of result.substitutions) ctx.substitutions.set(path, list);
    if ([...result.substitutions.values()].some((list) => list.some((sub) => sub.deferred))) {
      hasDeferred = true;
    }
    values[key] = result.value;
  }

  // Схема проверяется по тому, что известно статически: поле, несущее
  // отложенную подстановку (`${jobs.*}`), ещё не раскрыто и почти наверняка не
  // пройдёт схему как строка-плейсхолдер. Вторая проверка — перед исполнением,
  // по окончательным значениям (`runner.ts`, тот же образец, что у
  // `uses.paramsSchema`).
  if (hasOwnDocument && !hasDeferred) {
    validateStepKindDocument(kind as StepKindContribution & { document: StepKindDocumentForm }, values, at, ctx.registry);
  }

  let fields: unknown;
  try {
    fields = form.parse(values);
  } catch (error) {
    const owner = contributionOwner(ctx.registry, 'steps', kind.name) ?? 'неизвестный';
    throw new StepcastError(
      `Разбор шага вида ${kind.name} отказал: ${error instanceof Error ? error.message : String(error)}`,
      { at, hint: `Разбор объявляет плагин ${owner}, внёсший вид шага ${kind.name}`, cause: error },
    );
  }

  if (!hasDeferred) {
    validateStepKindFields(kind, fields, at, ctx.registry);
  }

  return {
    ...ctx.common,
    kind: 'plugin',
    name: kind.name,
    fields,
  };
}

/**
 * Вид шага, узнавший себя в сыром шаге, — обход реестра вместо перечисления
 * (design.md, решение 1, решение 2): каждый вид узнаётся своей формой
 * (`stepKindTest`), без ветви «встроенный / плагинный» в самом обходе. Порядок
 * обхода — порядок регистрации строк встроенного слоя в перечне дефолта
 * (`src/parts/rows.ts`, `BUILTIN_ROWS`): `step-run`, `step-uses`, `step-script`,
 * `step-agent`, затем плагинные в порядке их загрузки. Побеждает первый по
 * порядку регистрации (design.md, Решение 8) — два вида, узнавшие один и тот
 * же сырой шаг, не различаются иначе; перечень строк — единственное место,
 * где этот порядок записан (`builtin-step-kinds-as-rows`, design.md, Решение 2).
 *
 * Отдельной функцией, потому что вопрос «какого вида этот шаг» задаётся
 * дважды: при разборе (`toStep`) и раньше него — проверкой документа
 * (`rejectUnknownStepKinds`), которой нужен тот же ответ, чтобы отказ называл
 * вид шага, а не разваливался дампом объединения схем.
 */
function matchStepKind(rawRecord: Record<string, unknown>, registry: Registry): StepKind | undefined {
  for (const [, kind] of registry.steps) {
    if (stepKindTest(kind)(rawRecord)) return kind;
  }
  return undefined;
}

/**
 * Отказать шагу, вид которого не знает ни один вклад действующего реестра, —
 * до проверки схемой документа и её же словами (`rejectWiringKeys` рядом в
 * `load.ts` — тот же приём): объединение ветвей шага отклонило бы такой
 * документ дампом всех своих веток, где не звучит ни имя вида, ни перечень
 * доступных, ни плагин, вместе с которым вид снят.
 *
 * Шаг, вид которого распознан, сюда не попадает: лишний ключ рядом с ключом
 * вида — забота строгого объекта ветви, и он называет его точнее.
 */
function rejectUnknownStepKinds(document: unknown, file: string, registry: Registry): void {
  if (typeof document !== 'object' || document === null) return;
  const record = document as Record<string, unknown>;

  // Файл работы несёт шаги прямо в документе, пайплайн — в теле каждой работы,
  // объявленной на месте. Работа, подключённая ключом `uses`, проверяется
  // своим файлом, когда до него дойдёт чтение.
  checkRawSteps(record.steps, file, 'steps', registry);
  const jobs = record.jobs;
  if (typeof jobs !== 'object' || jobs === null) return;
  for (const [id, entry] of Object.entries(jobs as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue;
    checkRawSteps((entry as Record<string, unknown>).steps, file, `jobs.${id}.steps`, registry);
  }
}

function checkRawSteps(rawSteps: unknown, file: string, at: string, registry: Registry): void {
  if (!Array.isArray(rawSteps)) return;
  for (const [index, raw] of rawSteps.entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    if (matchStepKind(record, registry) !== undefined) continue;

    const site = { file, at: `${at}.${index}`, hint: `Доступны: ${stepKindNames(registry).join(', ')}` };
    const candidates = Object.keys(record).filter((key) => !STEP_COMMON_KEYS.includes(key));

    // Вид, снятый вместе с плагином, называется по имени — пока живо ядро,
    // помнящее прежнего владельца (design.md, решение 8). Тот же ответ, что
    // даёт исполнение шага, чей вид снят посреди прогона (`runner.ts`).
    for (const key of candidates) {
      const former = formerStepKindOwner(registry, key);
      if (former === undefined) continue;
      throw new StepcastError(`Вид шага ${key} снят вместе с плагином ${former}`, site);
    }

    // Третья причина, между «снят вместе с плагином» и «неизвестен вовсе»
    // (`builtin-step-kinds-as-rows`, design.md, Решение 5): вид шага известен
    // формату, но патч состава отключил строку, вносящую его, и в реестре
    // вида нет. Опечатки в ключе нет: искать нужно не в документе, а в
    // составе строк.
    //
    // Спрашивается об этом та же форма, которой вид узнаёт свой шаг
    // (`native.test`), а не таблица «ключ → владельцы»: таблица резерва
    // отвечает на другой вопрос (какие ключи заняты форматом) и вид по ключу
    // называет не всегда — ключи `script`, `args`, `runner`, `input`
    // принадлежат сразу `script` и `uses`, а `run` и `prompt` — по одному
    // виду. Обход формами даёт точный ответ и ровно то различие, которого
    // требует спека: текст отличается тогда и только тогда, когда шаг был бы
    // узнан, будь вид в составе. Порядок обхода — канонический порядок строк
    // (`src/parts/rows.ts`, `BUILTIN_ROWS`), тот же, что и у `matchStepKind`.
    for (const kind of BUILTIN_STEP_KINDS_IN_ROW_ORDER) {
      if (registry.steps.has(kind.name)) continue;
      if (!kind.native.test(record)) continue;
      throw new StepcastError(`Вид шага ${kind.name} отключён составом: строки, вносящей его, в дереве нет`, {
        ...site,
        hint: 'Вид шага приносит строка дерева; действующий состав показывает stepcast plugins',
      });
    }

    throw new StepcastError(
      candidates.length === 0
        ? 'Шаг не называет ни один известный вид шага'
        : `Вид шага ${candidates.join(', ')} неизвестен: такого вклада в реестре нет`,
      site,
    );
  }
}

/**
 * Отказать записи `expect`/`until.check`, чей предикат известен формату, но
 * состав его снял, — до проверки схемой документа, тем же приёмом, что
 * `rejectUnknownStepKinds` (design.md, Решение 5). Обходит `steps[].expect`
 * рядом с `checkRawSteps` и `jobs.*.until.check` — на обоих вызовах
 * (файл пайплайна и подключённый файл работы), до `validateDocument`.
 */
function rejectUnknownPredicates(document: unknown, file: string, registry: Registry): void {
  if (typeof document !== 'object' || document === null) return;
  const record = document as Record<string, unknown>;

  // Файл работы несёт шаги и `until` прямо в документе, пайплайн — в теле
  // каждой работы, объявленной на месте: тот же приём, каким `rejectUnknownStepKinds`
  // обходит оба документа одной функцией.
  checkStepExpectPredicates(record.steps, file, 'steps', registry);
  checkUntilCheckPredicates(record.until, file, 'until', registry);
  const jobs = record.jobs;
  if (typeof jobs !== 'object' || jobs === null) return;
  for (const [id, entry] of Object.entries(jobs as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const jobRecord = entry as Record<string, unknown>;
    checkStepExpectPredicates(jobRecord.steps, file, `jobs.${id}.steps`, registry);
    checkUntilCheckPredicates(jobRecord.until, file, `jobs.${id}.until`, registry);
  }
}

function checkStepExpectPredicates(rawSteps: unknown, file: string, at: string, registry: Registry): void {
  if (!Array.isArray(rawSteps)) return;
  for (const [index, raw] of rawSteps.entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    checkPredicateList((raw as Record<string, unknown>).expect, file, `${at}.${index}.expect`, registry);
  }
}

function checkUntilCheckPredicates(rawUntil: unknown, file: string, at: string, registry: Registry): void {
  if (typeof rawUntil !== 'object' || rawUntil === null) return;
  checkPredicateList((rawUntil as Record<string, unknown>).check, file, `${at}.check`, registry);
}

/**
 * Проверить список сырых записей предиката — спрашивается форма узнавания из
 * `BUILTIN_PREDICATES_IN_ROW_ORDER` (design.md, Решение 5): реестр без
 * снятой строки на этот вопрос ответить не может, а форма отвечает всегда.
 * Запись, узнанная активным вкладом или не узнанная вовсе (настоящая
 * опечатка), сюда не попадает — прежний отказ о неизвестном предикате её
 * называет своими словами, дампом ветвей.
 */
function checkPredicateList(rawList: unknown, file: string, at: string, registry: Registry): void {
  if (!Array.isArray(rawList)) return;
  for (const [index, raw] of rawList.entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    for (const form of BUILTIN_PREDICATES_IN_ROW_ORDER) {
      if (registry.predicates.has(form.name)) continue;
      if (!form.native.test(record)) continue;
      throw new StepcastError(`Предикат ${form.name} отключён составом: строки, вносящей его, в дереве нет`, {
        file,
        at: `${at}.${index}`,
        hint: 'Предикат приносит строка дерева; действующий состав показывает stepcast plugins',
      });
    }
  }
}

/**
 * Разобрать шаг раскрытием ветви вида — обход реестра (`matchStepKind`):
 * каждый вид шага сам знает, узнаёт ли он себя в `raw`, и как себя разобрать.
 */
function toStep(
  raw: RawStep,
  index: number,
  declaringFile: string,
  scope: Scope,
  defaults: StepDefaults,
  config: Config,
  substitutions: Map<string, readonly Substitution[]>,
  at: string,
  registry: Registry,
  scriptRoots: ScriptRoots,
  stepRoots: ScriptRoots,
): StepParseResult {
  const common = buildStepCommon(raw, index, declaringFile, defaults, config, substitutions, at, registry, scriptRoots);
  const ctx: BuiltinStepParseContext = {
    common,
    declaringFile,
    scope,
    defaults,
    config,
    substitutions,
    at,
    registry,
    scriptRoots,
    stepRoots,
  };
  const rawRecord = raw as unknown as Record<string, unknown>;

  const matched = matchStepKind(rawRecord, registry);
  if (matched !== undefined) {
    // Единственная оставшаяся ветвь по происхождению (design.md, Решение 4):
    // встроенный разбор отдаёт типизированный вариант модели `Step` движка,
    // плагинный — поля, которые движок сам кладёт в `PluginStep`.
    return isNativeStepKind(matched)
      ? (matched.native.parse(raw, ctx) as StepParseResult)
      : { step: toPluginStep(rawRecord, matched, ctx) };
  }

  // Недостижимо на пути от `validateDocument`: схема документа уже отклонила
  // бы ключ, которого не знает ни один вид (та же гарантия, что и у
  // плагинного предиката, `toPluginPredicate`). Оставлено как страховка на
  // случай, если схема и реестр разошлись между двумя вызовами.
  throw new StepcastError('Шаг не называет ни один известный вид', {
    at,
    hint: `Доступны: ${stepKindNames(registry).join(', ')}`,
  });
}

/**
 * Внутренние формы четырёх встроенных видов шага — вкладом того же вида,
 * которым сервис `steps` ядра принимает плагинный (`native`, design.md,
 * решение 2, решение 4). Экспортированы поимённо, а не собраны в одну
 * функцию регистрации: регистрирует их теперь не сборка ядра, а строки
 * встроенного слоя (`src/parts/pipeline/steps/{run,uses,script,agent}/row.ts`), по
 * одной строке на вид — `registerBuiltinStepKinds` этот пункт снимает вовсе
 * (`builtin-step-kinds-as-rows`, design.md, Решение 1). Порядок регистрации
 * (а с ним и порядок обхода `toStep`) фиксирует перечень строк
 * (`src/parts/rows.ts`, `BUILTIN_ROWS`), а не порядок этих объявлений —
 * они всего лишь называют форму разбора, которую строка внесёт.
 */
export const RUN_STEP_KIND: NativeStepKind = {
  name: 'run',
  title: 'Команда',
  native: { test: isRunStepRaw, parse: parseRunStep },
};
export const USES_STEP_KIND: NativeStepKind = {
  name: 'uses',
  title: 'Переиспользуемый шаг',
  native: { test: isUsesStepRaw, parse: parseUsesStep },
};
export const SCRIPT_STEP_KIND: NativeStepKind = {
  name: 'script',
  title: 'Скрипт',
  native: { test: isScriptStepRaw, parse: parseScriptStep },
};
export const AGENT_STEP_KIND: NativeStepKind = {
  name: 'agent',
  title: 'Агент',
  native: { test: isAgentStepRaw, parse: parseAgentStep },
};

/**
 * Те же четыре формы в каноническом порядке строк дефолта (`src/parts/rows.ts`,
 * `BUILTIN_ROWS`) — для единственного вопроса, который задаётся о виде шага
 * **вне** действующего состава: узнал бы он этот шаг, будь его строка включена
 * (`checkRawSteps`). Обход реестра (`matchStepKind`) на него ответить не может
 * — снятого вида в реестре нет, — а таблица резерва ключей отвечает на другой
 * вопрос (Решение 5, Решение 6). Перечень не задаёт ни порядка регистрации, ни
 * порядка узнавания: и то и другое по-прежнему записано только в перечне строк.
 */
const BUILTIN_STEP_KINDS_IN_ROW_ORDER: readonly NativeStepKind[] = [
  RUN_STEP_KIND,
  USES_STEP_KIND,
  SCRIPT_STEP_KIND,
  AGENT_STEP_KIND,
];

/**
 * Раскрыть пайплайн: подставить значения, втянуть подключённые работы,
 * применить умолчания. Результат самодостаточен — исходные документы больше
 * не нужны.
 */
export function expandPipeline(options: ExpandOptions): ExpandedPipeline {
  const { config } = options;
  const pipelinePath = resolvePath(options.pipelinePath);
  const registry = options.registry ?? builtinRegistry();
  const scriptRoots: ScriptRoots = options.scriptRoots ?? {
    project: findProjectRoot(options.projectRoot ?? dirname(pipelinePath)),
    home: homedir(),
    builtin: join(findPackageRoot(fileURLToPath(new URL('.', import.meta.url))), 'src', 'builtin', 'scripts'),
  };
  // `project` и `home` — те же корни, что и у слоёв `script`: оба каталога
  // ищутся от одного и того же проекта и домашнего каталога, различается
  // только имя подкаталога (`steps` вместо `scripts`) и встроенный слой.
  const stepRoots: ScriptRoots = options.stepRoots ?? {
    project: scriptRoots.project,
    home: scriptRoots.home,
    builtin: join(findPackageRoot(fileURLToPath(new URL('.', import.meta.url))), 'src', 'builtin', 'steps'),
  };
  // Схемы документа зависят от действующего состава: ключ предиката и ключ
  // плагинного вида шага — закрытые объединения, и без их ветвей предикат или
  // шаг отклонялись бы как опечатка; ветвь встроенного вида шага, снятого
  // составом (`builtin-step-kinds-as-rows`, design.md, Решение 4), схема
  // обязана не показывать вовсе — иначе редактор подсказал бы ключ, ведущий
  // в отказ `checkRawSteps`.
  const pluginKinds = pluginStepKindDescriptors(registry);
  const activeNativeKinds = nativeStepKindNames(registry);
  const pluginPredicates = pluginPredicateNames(registry);
  const activeNativePredicates = nativePredicateNames(registry);
  const schemas =
    pluginPredicates.length === 0 &&
    pluginKinds.length === 0 &&
    isDefaultNativeStepKinds(activeNativeKinds) &&
    isDefaultNativePredicates(activeNativePredicates)
      ? { PipelineDocumentSchema, JobDocumentSchema }
      : buildDocumentSchemas(pluginPredicates, pluginKinds, activeNativeKinds, activeNativePredicates);

  const rawPipeline = readYamlDocument(pipelinePath);
  rejectUnknownStepKinds(rawPipeline, pipelinePath, registry);
  rejectUnknownPredicates(rawPipeline, pipelinePath, registry);
  rejectProposalsKeyInPipeline(rawPipeline, pipelinePath);
  const document = validateDocument(
    schemas.PipelineDocumentSchema,
    rawPipeline,
    pipelinePath,
  ) as PipelineDocument;

  const inputs = resolveParams(document.inputs ?? {}, options.inputs ?? {}, {
    file: pipelinePath,
    what: 'inputs',
  });

  // Пайплайн поверх конфигурации, ни один слой не обязателен. Разрешается
  // ровно один раз: оба потребителя (область пайплайна и область тела работы)
  // берут уже посчитанное значение.
  const projectValues = resolveProjectValues(document, config);

  const pipelineScope: Scope = {
    values: { inputs, project: projectValues },
    deferred: DEFERRED_NAMESPACES,
    file: pipelinePath,
    explain: explainProject(pipelinePath),
  };

  const substitutions = new Map<string, readonly Substitution[]>();
  const collect = (map: ReadonlyMap<string, readonly Substitution[]>): void => {
    for (const [path, list] of map) substitutions.set(path, list);
  };

  // Скалярные поля документа раскрываются здесь, на уровне пайплайна: `jobs`
  // раскрывается отдельно, каждая работа — в собственной области видимости.
  // `project` исключён наравне с ними: значение уже посчитано выше, а
  // подстановка секции как обычного поля дала бы `doc.project`, которым
  // никто дальше не пользуется.
  const {
    version: _version,
    kind: _kind,
    inputs: _inputsDecl,
    jobs: _jobsField,
    project: _projectField,
    ...pipelineRest
  } = document;
  const interpolatedPipeline = interpolateTree(pipelineRest as Record<string, unknown>, pipelineScope, '');
  collect(interpolatedPipeline.substitutions);
  const doc = interpolatedPipeline.value as typeof pipelineRest;

  const liveFiles = (doc.workspace?.live_files ?? []).map((entry) => {
    const normalized = posix.normalize(entry.path.replaceAll('\\', '/'));
    if (isAbsolute(entry.path) || normalized === '..' || normalized.startsWith('../')) {
      throw new StepcastError(`Путь живого файла выходит за корень проекта: ${entry.path}`, {
        file: pipelinePath,
        at: 'workspace.live_files',
      });
    }
    return {
      path: normalized.replace(/^\.\//, ''),
      writeback: entry.writeback,
      commitOnSuccess: entry.commit_on_success,
    } as const;
  });
  const duplicateLivePath = liveFiles.find(
    (entry, index) => liveFiles.findIndex((candidate) => candidate.path === entry.path) !== index,
  );
  if (duplicateLivePath !== undefined) {
    throw new StepcastError(`Живой файл объявлен дважды: ${duplicateLivePath.path}`, {
      file: pipelinePath,
      at: 'workspace.live_files',
    });
  }

  const pipelineWorkspace: Workspace = {
    mode: doc.workspace?.mode ?? config.defaults.workspace.mode,
    ...(doc.workspace?.path === undefined ? {} : { path: doc.workspace.path }),
  };
  const publicationDeclared =
    doc.workspace?.source !== undefined ||
    doc.workspace?.preserve_local_changes !== undefined ||
    doc.workspace?.live_files !== undefined;
  const publication: PipelinePublication | undefined = publicationDeclared
    ? {
        source: doc.workspace?.source ?? 'commit',
        preserveLocalChanges: doc.workspace?.preserve_local_changes ?? false,
        liveFiles,
      }
    : undefined;

  const defaultSession = doc.defaults?.session ?? config.defaults.session;
  const defaultAgent = doc.agent ?? doc.defaults?.agent ?? config.defaults.agent;
  const defaultModel = doc.model ?? doc.defaults?.model ?? config.defaults.model;
  const defaultModelTier = parseModelTier(
    doc.model_tier ?? doc.defaults?.model_tier, pipelinePath,
    doc.model_tier !== undefined ? 'model_tier' : 'defaults.model_tier',
  );
  // Слой умолчания разрешается здесь же, рядом со значением: сравнивать
  // строки задним числом в toStep нельзя — документ пайплайна и конфигурация
  // законно объявляют одну и ту же модель, и слои должны остаться различимы.
  const defaultModelLayer: 'pipeline' | 'config' | undefined =
    doc.model !== undefined || doc.defaults?.model !== undefined ? 'pipeline' : config.defaults.model !== undefined ? 'config' : undefined;

  // Объявление пайплайна — верхний из трёх уровней (design.md, решение 2):
  // разбирается один раз здесь, а не в цикле работ, чтобы работы, его не
  // переопределившие, унаследовали ровно этот объект — тождеством ссылки, а
  // не побитовым равенством, на нём и держится диагностика линта.
  const pipelineMcp: McpServers | undefined = doc.mcp === undefined ? undefined : toMcp(doc.mcp);

  const jobs: Job[] = [];
  const modelOrigins = new Map<string, ModelOrigin>();

  for (const [id, entryRaw] of Object.entries(document.jobs)) {
    const at = `jobs.${id}`;
    const entry = entryRaw as JobEntry;

    // Обвязка живёт на месте подключения и подставляется в области пайплайна.
    const wiring = interpolateTree(
      {
        needs: 'needs' in entry ? entry.needs : undefined,
        on: 'on' in entry ? entry.on : undefined,
        if: 'if' in entry ? entry.if : undefined,
        lane: 'lane' in entry ? entry.lane : undefined,
        display: 'display' in entry ? entry.display : undefined,
        session_group: 'session_group' in entry ? entry.session_group : undefined,
        budget_exempt: 'budget_exempt' in entry ? entry.budget_exempt : undefined,
      },
      pipelineScope,
      at,
    );
    collect(wiring.substitutions);

    // Метка известна сразу после раскрытия обвязки: кладётся в область тела
    // ниже, а не в pipelineScope — обвязка (needs, if, сам lane, …) метку
    // работы не читает, только объявляет.
    const job = jobValues(wiring.value.lane as string | undefined);

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
      rejectUnknownStepKinds(rawDocument, usesPath, registry);
      rejectUnknownPredicates(rawDocument, usesPath, registry);
      const jobDocument = validateDocument(schemas.JobDocumentSchema, rawDocument, usesPath);

      const withValues = interpolateTree(entry.with ?? {}, pipelineScope, `${at}.with`);
      collect(withValues.substitutions);

      const params = resolveParams(jobDocument.params ?? {}, withValues.value, {
        file: pipelinePath,
        what: 'with',
        owner: at,
      });

      declaringFile = usesPath;
      bodyScope = {
        values: { params, project: projectValues, job },
        deferred: DEFERRED_NAMESPACES,
        // Поля тела объявлены в файле работы: диагностика должна называть его,
        // а не пайплайн, где работа только подключена.
        file: usesPath,
        hints: {
          // Работа не видит inputs намеренно: иначе она привязана к одному
          // пайплайну и перестаёт быть переиспользуемой.
          inputs: 'Работе недоступны inputs пайплайна — передайте значение через with и объявите его в params',
        },
        explain: explainBody(pipelinePath, id),
      };

      const { params: _params, kind: _kind, version: _version, ...rest } = jobDocument;
      const restSteps = (rest as Record<string, unknown>).steps;
      const interpolated = interpolateTree(
        { ...(rest as Record<string, unknown>), steps: omitStepInputs(restSteps, registry) },
        bodyScope,
        at,
      );
      collect(interpolated.substitutions);
      body = {
        ...interpolated.value,
        steps: restoreStepInputs((interpolated.value as Record<string, unknown>).steps, restSteps, registry),
      };

      // Переопределения с места подключения накладываются поверх файла работы
      // и делят с ним область job: буква дорожки известна уже здесь, на месте
      // подключения, — ровно там, где стоит и сам ключ lane, — и решение
      // сделать её доступной принято явно, а не по умолчанию.
      const overrideScope: Scope = {
        ...pipelineScope,
        values: { ...pipelineScope.values, job },
        explain: explainBody(pipelinePath, id),
      };
      const overrides = interpolateTree(
        {
          ...(entry.agent === undefined ? {} : { agent: entry.agent }),
          ...(entry.model === undefined ? {} : { model: entry.model }),
          ...(entry.model_tier === undefined ? {} : { model_tier: entry.model_tier }),
          ...(entry.description === undefined ? {} : { description: entry.description }),
          ...(entry.session === undefined ? {} : { session: entry.session }),
          ...(entry.workspace === undefined ? {} : { workspace: entry.workspace }),
          ...(entry.env === undefined ? {} : { env: { ...(body.env as object), ...entry.env } }),
          ...(entry.context === undefined ? {} : { context: entry.context }),
          ...(entry.context_upstream === undefined ? {} : { context_upstream: entry.context_upstream }),
          ...(entry.budget === undefined ? {} : { budget: entry.budget }),
        },
        overrideScope,
        at,
      );
      collect(overrides.substitutions);
      body = { ...body, ...overrides.value };
    } else {
      declaringFile = pipelinePath;
      bodyScope = {
        ...pipelineScope,
        values: { ...pipelineScope.values, job },
        explain: explainBody(pipelinePath, id),
      };
      const {
        needs: _needs,
        on: _on,
        if: _if,
        lane: _lane,
        display: _display,
        session_group: _sessionGroup,
        budget_exempt: _budgetExempt,
        ...rest
      } = entry;
      const restSteps = (rest as Record<string, unknown>).steps;
      const interpolated = interpolateTree(
        { ...(rest as Record<string, unknown>), steps: omitStepInputs(restSteps, registry) },
        bodyScope,
        at,
      );
      collect(interpolated.substitutions);
      body = {
        ...interpolated.value,
        steps: restoreStepInputs((interpolated.value as Record<string, unknown>).steps, restSteps, registry),
      };
    }

    const jobModelTier = parseModelTier(
      body.model_tier,
      'uses' in entry && entry.model_tier !== undefined ? pipelinePath : declaringFile,
      `${at}.model_tier`,
    );
    const sessionMode = (body.session as 'shared' | 'per_step' | undefined) ?? defaultSession;
    // Слияние, а не замена: работа обычно переопределяет только `inherit`
    // (или только `path`), а режим объявлен один раз на пайплайне. Полная
    // замена стёрла бы его и оставила `mode` неопределённым.
    const rawWorkspace = body.workspace as Workspace | undefined;
    const workspace: Workspace = ((): Workspace => {
      if (rawWorkspace === undefined) return pipelineWorkspace;
      const mode = rawWorkspace.mode ?? pipelineWorkspace.mode;
      // Пайплайновый путь размещения принадлежит пайплайновому режиму: работа,
      // сменившая режим, наследовать его не может — при режиме, отличном от
      // `copy`, путь и вовсе запрещён. Свой путь работа объявляет сама.
      const inheritedPath = mode === pipelineWorkspace.mode ? pipelineWorkspace.path : undefined;
      const path = rawWorkspace.path ?? inheritedPath;
      return {
        mode,
        ...(path === undefined ? {} : { path }),
        ...(rawWorkspace.inherit === undefined ? {} : { inherit: rawWorkspace.inherit }),
      };
    })();
    const rawSteps = body.steps as RawStep[];

    const until = body.until as
      | { max_iterations?: string | number; check: RawPredicate[] }
      | undefined;
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

    const jobPermissions =
      body.permissions === undefined
        ? undefined
        : toPermissions(body.permissions as NonNullable<RawAgentStep['permissions']>);

    // Своё объявление работы — то, что попадёт в её запись замка (задача 4);
    // действующее для шагов значение (`stepMcp` ниже) отличается тем, что
    // подставляет пайплайновое там, где работа своего не назвала.
    const jobMcp: McpServers | undefined =
      body.mcp === undefined ? undefined : toMcp(body.mcp as RawMcp);
    const stepMcp = jobMcp ?? pipelineMcp;

    const output = body.output as { from?: string; schema?: string } | undefined;
    if (output !== undefined && output.from === undefined) {
      // Способен дать выход: агентский шаг всегда, `script` всегда (канал —
      // файл, объявлен `output_schema` или нет), `run` — только с объявленным
      // `output_schema` (design.md, решение 11).
      const capable = (step: RawStep): boolean => {
        if ('script' in step) return true;
        if ('run' in step) return step.output_schema !== undefined;
        return true;
      };
      const lastCapable = [...rawSteps].reverse().find(capable);
      if (lastCapable === undefined) {
        throw new StepcastError('Работа объявляет output без from и не содержит шагов, способных дать выход', {
          file: declaringFile,
          at: `${at}.output`,
          hint: 'Укажите output.from или добавьте агентский шаг, script либо run с output_schema',
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
      ...(wiring.value.lane === undefined ? {} : { lane: wiring.value.lane as string }),
      ...(wiring.value.session_group === undefined
        ? {}
        : { sessionGroup: wiring.value.session_group as string }),
      ...(wiring.value.budget_exempt === undefined
        ? {}
        : { budgetExempt: wiring.value.budget_exempt as boolean }),
      ...(wiring.value.display === undefined
        ? {}
        : { display: wiring.value.display as Readonly<Record<string, string>> }),
      session: sessionMode,
      workspace,
      env: (body.env as Record<string, string> | undefined) ?? {},
      context: toContext(body.context as RawContextEntry[] | undefined),
      contextUpstream:
        (body.context_upstream as ContextUpstream | undefined) ?? doc.context_upstream ?? 'all',
      inputs: (body.inputs as readonly string[] | undefined) ?? [],
      data: toDataDeclaration(body.data as readonly string[] | undefined, declaringFile, at),
      ...(until === undefined
        ? {}
        : {
            until: {
              maxIterations: toCount(
                until.max_iterations as string | number,
                `${at}.until.max_iterations`,
                substitutions,
                parseCount,
                `${at}.until.max_iterations`,
              ),
              check: until.check.map((entry, i) =>
                toPredicate(entry, declaringFile, substitutions, `${at}.until.check.${i}`, registry, config, scriptRoots),
              ),
            },
          }),
      ...(output === undefined
        ? {}
        : {
            output: {
              ...(output.from === undefined ? {} : { from: output.from }),
              ...(output.schema === undefined
                ? {}
                : { schemaPath: resolveSchemaPath(output.schema, declaringFile, `${at}.output.schema`) }),
            },
          }),
      ...(body.budget === undefined
        ? {}
        : { budget: toBudget(body.budget as RawBudget, substitutions, `${at}.budget`) }),
      ...(jobPermissions === undefined ? {} : { permissions: jobPermissions }),
      ...(jobMcp === undefined ? {} : { mcp: jobMcp }),
      steps: rawSteps.map((step, index) => {
        const expanded = toStep(
          step,
          index,
          declaringFile,
          bodyScope,
          {
            agent: (body.agent as string | undefined) ?? defaultAgent,
            model: (body.model as string | undefined) ?? defaultModel,
            modelLayer: body.model !== undefined ? 'job' : defaultModelLayer,
            modelTier: jobModelTier ?? defaultModelTier,
            tierLayer: jobModelTier !== undefined ? 'job' : 'pipeline',
            timeoutMs: config.defaults.stepTimeoutMs,
            sessionMode,
            permissions: jobPermissions,
            mcp: stepMcp,
          },
          config,
          substitutions,
          `${at}.steps.${index}`,
          registry,
          scriptRoots,
          stepRoots,
        );
        if (expanded.modelOrigin !== undefined) {
          modelOrigins.set(`${id}/${expanded.step.id}`, expanded.modelOrigin);
        }
        return expanded.step;
      }),
    });
  }

  if (publication !== undefined) {
    if (pipelineWorkspace.mode !== 'worktree') {
      throw new StepcastError('Политика source: commit требует workspace.mode: worktree', {
        file: pipelinePath,
        at: 'workspace.mode',
      });
    }
    const nonIsolated = jobs.find((job) => job.workspace.mode !== 'worktree');
    if (nonIsolated !== undefined) {
      throw new StepcastError(
        `Работа ${nonIsolated.id} меняет commit-backed workspace на ${nonIsolated.workspace.mode}`,
        {
          file: nonIsolated.source,
          at: `jobs.${nonIsolated.id}.workspace.mode`,
          hint: 'При source: commit все работы исполняются в worktree; используйте workspace.inherit для выбора дерева',
        },
      );
    }
    if (publication.liveFiles.length > 0 && !publication.preserveLocalChanges) {
      throw new StepcastError('Живые файлы требуют preserve_local_changes: true', {
        file: pipelinePath,
        at: 'workspace.preserve_local_changes',
      });
    }
  }

  const triggers = toTriggers(doc.triggers);

  const pipeline: Pipeline = {
    name: doc.name ?? 'pipeline',
    file: pipelinePath,
    knowledge: resolveKnowledge(document, config, pipelinePath),
    inputs,
    workspace: pipelineWorkspace,
    ...(publication === undefined ? {} : { publication }),
    env: doc.env ?? {},
    envFiles: doc.env_files ?? [],
    envDeny: [...config.envDeny, ...(doc.env_deny ?? [])],
    context: toContext(doc.context),
    contextUpstream: doc.context_upstream ?? 'all',
    ...(doc.budget === undefined ? {} : { budget: toBudget(doc.budget, substitutions, 'budget') }),
    ...(pipelineMcp === undefined ? {} : { mcp: pipelineMcp }),
    concurrency:
      doc.concurrency === undefined
        ? config.defaults.concurrency
        : toCount(doc.concurrency, 'concurrency', substitutions, parseCount, 'concurrency'),
    failFast: doc.fail_fast ?? config.defaults.failFast,
    ...(triggers === undefined ? {} : { triggers }),
    jobs,
  };

  return { pipeline, substitutions, modelOrigins };
}
