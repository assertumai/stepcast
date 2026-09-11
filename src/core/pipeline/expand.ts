import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ModelTierSchema } from '../config/schema.js';
import type { ModelTier } from '../config/modelTiers.js';
import type { Config, RunnerConfig } from '../config/resolve.js';
import { Ajv2020 } from 'ajv/dist/2020.js';

import { StepcastError } from '../errors.js';
import { assertDataKey } from '../journal/data.js';
import { findProjectRoot } from '../journal/paths.js';
import { findPackageRoot, packagedSchemaPath, packagedWrapperPath } from '../package-schema.js';
import { builtinRegistry } from '../plugins/builtin.js';
import { predicateNames, type Registry } from '../plugins/registry.js';
import { parseCount, parseDuration, parseExitCode, parseMoney, parsePercent, parseTokens } from '../units.js';
import { interpolateTree, interpolateTypedTree, placeholderNamespaces, type Scope } from './interpolate.js';
import { readYamlDocument, rejectWiringKeys, validateDocument } from './load.js';
import { resolveParams, type ParamValue } from './params.js';
import {
  buildDocumentSchemas,
  JobDocumentSchema,
  PipelineDocumentSchema,
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
  Permissions,
  Substitution,
  SubstitutionMap,
  Triggers,
  Workspace,
} from './model.js';

/** Пространства, чьи значения известны только в прогоне. */
const DEFERRED_NAMESPACES = new Set(['jobs', 'run', 'env']);

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
   * Корни слоёв разрешения `script`. Тесты подставляют свои — умолчание
   * (`findProjectRoot(dirname(pipelinePath))`, `homedir()`,
   * `findPackageRoot` от расположения этого модуля) годится для настоящего
   * прогона, но держит их на каталогах машины и повторяемости тестов не даёт.
   */
  readonly scriptRoots?: ScriptRoots;
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

function toPredicate(
  raw: RawPredicate,
  declaringFile: string,
  substitutions: SubstitutionMap,
  at: string,
  registry: Registry,
  config: Config,
  scriptRoots: ScriptRoots,
): Predicate {
  // Объединение включает и ветви плагинов, поэтому разбор встроенных ведётся
  // по их собственному типу: проверка ключа идёт по настоящему объекту, а
  // сужение — по размеченному объединению встроенных ветвей.
  const builtin = raw as RawBuiltinPredicate;

  if ('exit_code' in builtin) {
    return {
      kind: 'exit_code',
      value: toCount(builtin.exit_code, `${at}.exit_code`, substitutions, parseExitCode, `${at}.exit_code`),
    };
  }
  if ('file_exists' in builtin) return { kind: 'file_exists', path: builtin.file_exists };
  if ('schema' in builtin) {
    return { kind: 'schema', path: resolveSchemaPath(builtin.schema, declaringFile, `${at}.schema`) };
  }
  if ('matches' in builtin) return { kind: 'matches', pattern: builtin.matches };
  if ('not_matches' in builtin) return { kind: 'not_matches', pattern: builtin.not_matches };
  if ('changed_only' in builtin) return { kind: 'changed_only', globs: builtin.changed_only };
  if ('knowledge_valid' in builtin) {
    // `knowledge_valid: false` не значит «проверять на несоответствие»: у
    // предиката нет отрицания, и молча читать его как «не проверять» значило
    // бы отличать выключенную проверку от отсутствующей ничем.
    if (builtin.knowledge_valid !== true) {
      throw new StepcastError('Предикат knowledge_valid принимает только true', {
        at: `${at}.knowledge_valid`,
        hint: 'Уберите предикат, если проверять память не нужно',
      });
    }
    return { kind: 'knowledge_valid' };
  }
  if ('cmd' in builtin) return { kind: 'cmd', command: builtin.cmd };
  if ('script' in builtin) {
    // Путь и раннер разрешаются тем же правилом, что и у шага `script`, без
    // `args` и без явного `runner`: у предиката этих ключей нет вовсе
    // (`docs/pipeline-format.md`, раздел «Предикат script»).
    const outcome = resolveScript(builtin.script, [], undefined, declaringFile, config, scriptRoots, `${at}.script`);
    return {
      kind: 'script',
      path: builtin.script,
      ...('resolved' in outcome ? { resolved: outcome.resolved } : { unresolved: outcome.unresolved }),
    };
  }
  if ('judge' in builtin) {
    return {
      kind: 'judge',
      claim: builtin.judge,
      hard: builtin.hard ?? false,
      ...(builtin.agent === undefined ? {} : { agent: builtin.agent }),
      ...(builtin.model === undefined ? {} : { model: builtin.model }),
    };
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

  if (name === undefined || contribution === undefined) {
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
 * Снять `input` с каждого шага перед общим `interpolateTree` тела работы:
 * подстановка внутри `input` разрешается типизированным проходом в `toStep`,
 * а не общим, который вернул бы всё строкой (design.md, решение 4). Тот же
 * приём, каким из общего обхода уже вынесен `display` работы.
 */
function omitStepInputs(rawSteps: unknown): unknown {
  if (!Array.isArray(rawSteps)) return rawSteps;
  return rawSteps.map((step) => {
    if (step === null || typeof step !== 'object' || !('input' in step)) return step;
    const { input: _input, ...rest } = step as Record<string, unknown>;
    return rest;
  });
}

/** Вернуть на место `input`, снятый `omitStepInputs`, — нераскрытым, для `toStep`. */
function restoreStepInputs(interpolatedSteps: unknown, rawSteps: unknown): unknown {
  if (!Array.isArray(interpolatedSteps) || !Array.isArray(rawSteps)) return interpolatedSteps;
  return interpolatedSteps.map((step, index) => {
    const original = rawSteps[index];
    if (original === null || typeof original !== 'object' || !('input' in original)) return step;
    return { ...(step as Record<string, unknown>), input: (original as Record<string, unknown>).input };
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
function isFile(path: string): boolean {
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
function fingerprintContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Выбрать раннер шага `script` тремя правилами: явный `runner` → расширение
 * файла → имя из shebang (design.md, решение 5). Возвращает либо имя и
 * запись таблицы, либо причину, по которой выбор не состоялся, — тоже не
 * исключение: диагностику даёт линт, а прогон отказывает названно.
 */
function selectRunner(
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
function resolveWrapper(runner: RunnerConfig, roots: ScriptRoots): string | undefined {
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
 */
export function describeScriptUnresolved(unresolved: ScriptUnresolved): string {
  switch (unresolved.reason) {
    case 'file_not_found':
      return `Файл скрипта не найден ни в одном слое. Искали: ${unresolved.searched.join(', ')}`;
    case 'unknown_runner':
      return `Неизвестный раннер ${unresolved.runner}. Известны: ${unresolved.known.join(', ')}`;
    case 'runner_undetermined':
      return `Раннер не определяется ни расширением, ни shebang. Известные расширения: ${unresolved.extensions.join(', ')}`;
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
): { readonly step: Step; readonly modelOrigin?: ModelOrigin } {
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
    ...(raw.budget === undefined
      ? {}
      : { budget: toBudget(raw.budget, substitutions, `${at}.budget`) }),
    expect: (raw.expect ?? []).map((entry, i) =>
      toPredicate(entry, declaringFile, substitutions, `${at}.expect.${i}`, registry, config, scriptRoots),
    ),
    attempts: toAttempts(raw.attempts, config.limits, substitutions, at),
  };

  if ('run' in raw) {
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

  if ('script' in raw) {
    let onFail: { readonly analyze: string; readonly prompt: string } | undefined;
    if (raw.on_fail !== undefined) {
      const onFailKey = `${at}.on_fail.prompt`;
      const onFailPrompt = readPrompt(raw.on_fail.prompt, declaringFile, scope, onFailKey);
      recordPromptSubstitutions(substitutions, onFailKey, onFailPrompt.substitutions);
      onFail = { analyze: raw.on_fail.analyze, prompt: onFailPrompt.text };
    }
    const args = raw.args ?? [];
    const outcome = resolveScript(
      raw.script,
      args,
      raw.runner,
      declaringFile,
      config,
      scriptRoots,
      `${at}.script`,
    );
    // `raw.input` дошёл сюда нераскрытым (`omitStepInputs`/`restoreStepInputs`):
    // общий обход тела работы его не тронул, чтобы `${params.retries}` не
    // превратился в строку "3" раньше типизированного прохода.
    const inputResult =
      raw.input === undefined
        ? undefined
        : interpolateTypedTree(raw.input, scope, `${at}.input`);
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

  const promptKey = `${at}.prompt`;
  const prompt = readPrompt(raw.prompt, declaringFile, scope, promptKey);
  recordPromptSubstitutions(substitutions, promptKey, prompt.substitutions);
  const agent = raw.agent ?? defaults.agent;
  const backend = config.backends[agent];
  const tier = parseModelTier(raw.model_tier, declaringFile, `${at}.model_tier`) ?? defaults.modelTier;
  const tierModel = tier === undefined ? undefined : backend?.modelTiers?.[tier];
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
 * Раскрыть пайплайн: подставить значения, втянуть подключённые работы,
 * применить умолчания. Результат самодостаточен — исходные документы больше
 * не нужны.
 */
export function expandPipeline(options: ExpandOptions): ExpandedPipeline {
  const { config } = options;
  const pipelinePath = resolvePath(options.pipelinePath);
  const registry = options.registry ?? builtinRegistry();
  const scriptRoots: ScriptRoots = options.scriptRoots ?? {
    project: findProjectRoot(dirname(pipelinePath)),
    home: homedir(),
    builtin: join(findPackageRoot(fileURLToPath(new URL('.', import.meta.url))), 'src', 'builtin', 'scripts'),
  };
  // Схемы документа зависят от загруженных плагинов: ключ предиката —
  // закрытое объединение, и без плагинных ветвей их предикат отклонялся бы
  // как опечатка.
  const schemas =
    registry.predicates.size === 0
      ? { PipelineDocumentSchema, JobDocumentSchema }
      : buildDocumentSchemas([...registry.predicates.keys()]);

  const document = validateDocument(
    schemas.PipelineDocumentSchema,
    readYamlDocument(pipelinePath),
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

  const pipelineWorkspace: Workspace = {
    mode: doc.workspace?.mode ?? config.defaults.workspace.mode,
    ...(doc.workspace?.path === undefined ? {} : { path: doc.workspace.path }),
  };

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
        { ...(rest as Record<string, unknown>), steps: omitStepInputs(restSteps) },
        bodyScope,
        at,
      );
      collect(interpolated.substitutions);
      body = {
        ...interpolated.value,
        steps: restoreStepInputs((interpolated.value as Record<string, unknown>).steps, restSteps),
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
        { ...(rest as Record<string, unknown>), steps: omitStepInputs(restSteps) },
        bodyScope,
        at,
      );
      collect(interpolated.substitutions);
      body = {
        ...interpolated.value,
        steps: restoreStepInputs((interpolated.value as Record<string, unknown>).steps, restSteps),
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
        );
        if (expanded.modelOrigin !== undefined) {
          modelOrigins.set(`${id}/${expanded.step.id}`, expanded.modelOrigin);
        }
        return expanded.step;
      }),
    });
  }

  const triggers = toTriggers(doc.triggers);

  const pipeline: Pipeline = {
    name: doc.name ?? 'pipeline',
    file: pipelinePath,
    knowledge: resolveKnowledge(document, config, pipelinePath),
    inputs,
    workspace: pipelineWorkspace,
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
