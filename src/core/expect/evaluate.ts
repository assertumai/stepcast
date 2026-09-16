import { execaSync } from 'execa';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
// Сборка для draft 2020-12: схемы пишутся по актуальному стандарту, а
// обычный экспорт ajv знает только draft-07 и отклоняет ссылку на мета-схему.
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';

import { StepcastError } from '../errors.js';
import { runProcess } from '../exec/process.js';
import type { RunJournal } from '../journal/writer.js';
import { describeScriptUnresolved } from '../pipeline/expand.js';
import type { Predicate, ScriptUnresolved } from '../pipeline/model.js';
import type { PredicateResult } from '../journal/schema.js';
import type { KnowledgeSource } from '../knowledge/types.js';
import { hasPredicateEvaluator } from '../plugins/pipeline-contract.js';
import type { Registry } from '../plugins/registry.js';

/**
 * Вычисление предикатов.
 *
 * Все объявленные предикаты вычисляются, даже если один уже не прошёл: отчёт
 * с одной первой ошибкой заставляет чинить их по очереди, а стоимость
 * вычисления остальных пренебрежима по сравнению с шагом.
 */

export interface EvaluationInput {
  readonly exitCode: number | null;
  /** Текстовый результат: для агента — итоговый ответ, для команды — stdout. */
  readonly text: string;
  readonly structured: unknown;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /**
   * Пути, изменившиеся за время шага, — база для предиката границ.
   * `undefined` означает, что якорь снять не удалось: предикат тогда не
   * вычисляется, а помечается невычисленным. Считать его непройденным нельзя —
   * это превратило бы неудачу внутреннего учёта в отказ пользователю.
   */
  readonly changedPaths?: readonly string[] | undefined;
  /**
   * Источник знания для предиката `knowledge_valid`. Как и `changedPaths`,
   * необязателен: шаг без предиката о нём не знает, а линт отклоняет предикат
   * при необъявленной практике памяти раньше, чем дело доходит сюда.
   */
  readonly knowledge?: KnowledgeSource | undefined;
  /**
   * Контракт вызова предиката `script`: где вести каталог `script-<n>` и
   * какими путями к логам попытки заполнять его `input.json`. Не объявлен —
   * предикат `script` в списке невозможен: линт и `expand.ts` не пропускают
   * его до вызывающего без этого контракта (`run/runner.ts`).
   */
  readonly script?: ScriptPredicateContext | undefined;
}

export interface ScriptPredicateContext {
  /** Каталог шага: в нём заводится подкаталог `script-<n>` вызова. */
  readonly stepDir: string;
  /** Номер попытки — им собирается имя `stdout.log`/`stderr.log` попытки. */
  readonly attempt: number;
  readonly journal: RunJournal;
  /** Сквозной номер вызова в пределах шага: растёт через попытки и предикаты. */
  readonly nextCallIndex: () => number;
  readonly timeoutMs: number;
  readonly stallTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

const ajv = new Ajv2020({ allErrors: true, strict: false });

export async function evaluatePredicates(
  predicates: readonly Predicate[],
  input: EvaluationInput,
  registry?: Registry,
): Promise<PredicateResult[]> {
  if (predicates.length === 0) {
    const passed = input.exitCode === 0;
    return [
      {
        predicate: 'exit_code',
        passed,
        hard: true,
        expected: 0,
        actual: input.exitCode,
        ...(passed ? {} : { detail: `код возврата ${input.exitCode ?? 'нет'} вместо 0` }),
      },
    ];
  }

  // Последовательно, в объявленном порядке: параллельность предикатов не
  // обещана и обещана не будет — предикат вправе трогать рабочее дерево, и
  // одновременность превратила бы отчёт в лотерею.
  const results: PredicateResult[] = [];
  for (const predicate of predicates) {
    results.push(await evaluateOne(predicate, input, registry));
  }
  return results;
}

async function evaluateOne(
  predicate: Predicate,
  input: EvaluationInput,
  registry?: Registry,
): Promise<PredicateResult> {
  switch (predicate.kind) {
    case 'exit_code': {
      const passed = input.exitCode === predicate.value;
      return {
        predicate: 'exit_code',
        passed,
        hard: true,
        expected: predicate.value,
        actual: input.exitCode,
        ...(passed
          ? {}
          : { detail: `код возврата ${input.exitCode ?? 'нет'} вместо ${predicate.value}` }),
      };
    }

    case 'file_exists': {
      const path = absolute(predicate.path, input.cwd);
      const passed = existsSync(path);
      return {
        predicate: 'file_exists',
        passed,
        hard: true,
        expected: predicate.path,
        ...(passed ? {} : { detail: `файл не найден: ${predicate.path}` }),
      };
    }

    case 'schema':
      return evaluateSchema(predicate.path, input);

    case 'matches':
    case 'not_matches': {
      const regexp = compile(predicate.pattern);
      const found = regexp.test(input.text);
      const passed = predicate.kind === 'matches' ? found : !found;
      return {
        predicate: predicate.kind,
        passed,
        hard: true,
        expected: predicate.pattern,
        ...(passed
          ? {}
          : {
              detail:
                predicate.kind === 'matches'
                  ? `в выводе нет совпадения с ${predicate.pattern}`
                  : `в выводе найдено запрещённое совпадение с ${predicate.pattern}`,
            }),
      };
    }

    case 'cmd': {
      const result = execaSync(predicate.command, {
        cwd: input.cwd,
        env: input.env,
        extendEnv: false,
        reject: false,
        shell: true,
        all: true,
      });
      const passed = result.exitCode === 0;
      return {
        predicate: 'cmd',
        passed,
        hard: true,
        expected: predicate.command,
        actual: result.exitCode,
        // Вывод сохраняется целиком: он и есть то, что подмешивается
        // следующей попытке при include_failure.
        ...(passed ? {} : { detail: `${predicate.command}:\n${String(result.all ?? '').trim()}` }),
      };
    }

    case 'script':
      return evaluateScript(predicate, input);

    case 'changed_only':
      return evaluateChangedOnly(predicate.globs, input);

    case 'knowledge_valid':
      return evaluateKnowledgeValid(input);
    case 'plugin':
      return evaluatePlugin(predicate.name, predicate.value, input, registry);
    case 'judge':
      // Вычисление судьи — второй, асинхронный проход попытки (см.
      // exec/judgePass.ts): он требует агентского вызова, сессий и журнала, а
      // этот синхронный проход о них не знает нарочно. Место в списке
      // сохраняется, чтобы порядок предикатов не зависел от того, что судья
      // вычисляется позже остальных.
      return {
        predicate: 'judge',
        passed: true,
        hard: false,
        expected: predicate.claim,
        detail: 'не вычислен: судья вызывается вторым проходом',
      };
  }
}

/**
 * Предикат `script`: файл-проверка, исполняемая раннером, разрешённым на
 * раскрытии (`expand.ts`, `resolveScript`). Вход и выход — тот же контракт
 * файлов, что у шага `script` (`docs/pipeline-format.md`), но с полями самой
 * попытки: код возврата, пути к её `stdout.log`/`stderr.log` и структурированный
 * выход, если он есть.
 *
 * Неразрешённый предикат (файл не найден, раннер не определяется) не бросает
 * исключение — линт называет причину заранее (`lint.ts`), а вычисление здесь
 * отдаёт её же непройденным предикатом, тем же текстом, что и у шага `script`
 * (`describeScriptUnresolved`).
 */
async function evaluateScript(
  predicate: Extract<Predicate, { kind: 'script' }>,
  input: EvaluationInput,
): Promise<PredicateResult> {
  if (predicate.resolved === undefined) {
    return {
      predicate: 'script',
      passed: false,
      hard: true,
      expected: predicate.path,
      detail: describeScriptUnresolved(predicate.unresolved as ScriptUnresolved),
    };
  }

  const call = input.script;
  if (call === undefined) {
    // Вызывающий обязан передать контракт вызова вместе с разрешённым
    // предикатом — иначе некуда писать `input.json` и нечем ограничить
    // исполнение временем. Внутренняя ошибка движка, а не отказ пользователя.
    throw new StepcastError('Предикат script вычислен без контракта вызова', {
      hint: 'evaluatePredicates позвана без поля script в EvaluationInput',
    });
  }

  const dir = call.journal.prepareScriptCall(call.stepDir, call.nextCallIndex());
  const suffix = call.attempt === 1 ? '' : `.${call.attempt}`;

  call.journal.writeStepJson(dir, 'input.json', {
    exit_code: input.exitCode,
    stdout: join(call.stepDir, `stdout${suffix}.log`),
    stderr: join(call.stepDir, `stderr${suffix}.log`),
    ...(input.structured === undefined ? {} : { structured: input.structured }),
  });

  const outputPath = join(dir, 'output.json');
  const result = await runProcess({
    command: predicate.resolved.argv,
    cwd: input.cwd,
    env: {
      ...input.env,
      // Свой вход и выход, отдельные от контракта самого шага (если это шаг
      // `script`): предикат — второй, независимый вызов, а не продолжение
      // того же контракта.
      STEPCAST_INPUT: join(dir, 'input.json'),
      STEPCAST_OUTPUT: outputPath,
    },
    timeoutMs: call.timeoutMs,
    ...(call.stallTimeoutMs === undefined ? {} : { stallTimeoutMs: call.stallTimeoutMs }),
    ...(call.signal === undefined ? {} : { signal: call.signal }),
    stdoutPath: join(dir, 'stdout.log'),
    stderrPath: join(dir, 'stderr.log'),
  });

  const passed = result.outcome === 'exited' && result.exitCode === 0;
  if (passed) {
    return { predicate: 'script', passed: true, hard: true, expected: predicate.path };
  }

  const reason = readScriptPredicateReason(outputPath) ?? `код возврата ${result.exitCode ?? 'нет'}`;
  return { predicate: 'script', passed: false, hard: true, expected: predicate.path, detail: reason };
}

/**
 * Причина отказа из `output.json` предиката `script`: единственное поле
 * `reason`, без проверки схемой — это причина отказа, а не структурированный
 * выход шага (`docs/pipeline-format.md`). Отсутствие файла или поля — не
 * ошибка: вызывающий берёт родовую причину по коду возврата.
 */
function readScriptPredicateReason(outputPath: string): string | undefined {
  if (!existsSync(outputPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(outputPath, 'utf8')) as { reason?: unknown };
    return typeof parsed.reason === 'string' ? parsed.reason : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Целостность памяти репозитория. Проваливает шаг только красное нарушение;
 * жёлтое попадает в отчёт и проверку проходит.
 *
 * Разделение уровней здесь не мягкотелость, а условие выживания гейта.
 * Проверка, краснеющая от любой правки задетого файла, красна всегда, и
 * первое, что с ней сделают, — обойдут; красным становится просроченное, то
 * есть то, на что никто не взглянул за объявленный срок.
 */
function evaluateKnowledgeValid(input: EvaluationInput): PredicateResult {
  if (input.knowledge === undefined) {
    // Тем же порядком, что `changed_only` без якоря: невычисленным, а не
    // непройденным. Отсутствие источника — не провал шага, а недостача
    // сведений, и объявлять её отказом автору значит наказывать не за то.
    return {
      predicate: 'knowledge_valid',
      passed: true,
      hard: false,
      detail: 'не вычислен: практика памяти не объявлена',
    };
  }

  const verdict = input.knowledge.check();
  const red = verdict.problems.filter((problem) => problem.level === 'red');
  const yellow = verdict.problems.filter((problem) => problem.level === 'yellow');

  const describe = (problem: (typeof verdict.problems)[number]): string =>
    `${problem.id === undefined ? problem.kind : `${problem.id} (${problem.kind})`}: ${problem.detail}`;

  return {
    predicate: 'knowledge_valid',
    passed: red.length === 0,
    hard: true,
    expected: 'память без красных нарушений',
    ...(red.length === 0
      ? // Жёлтое видно и на пройденном предикате: иначе устаревание копилось
        // бы молча до того дня, когда станет красным разом.
        yellow.length === 0
        ? {}
        : { detail: `устаревает: ${yellow.map(describe).join('; ')}` }
      : {
          actual: red.length,
          detail: red.map(describe).join('; '),
        }),
  };
}

/**
 * Предикат плагина: вычисляет сам вклад. Движок здесь только зовёт его,
 * приводит результат к общему виду и не даёт умолчаниям вклада разойтись с
 * записью в журнале — имя предиката в результате всегда из реестра, а не из
 * того, что вернул вклад.
 *
 * Отказ вычислителя — непройденный предикат с названной причиной, а не
 * крушение шага: исключение из чужого кода не должно выглядеть дефектом
 * движка.
 */
async function evaluatePlugin(
  name: string,
  value: unknown,
  input: EvaluationInput,
  registry?: Registry,
): Promise<PredicateResult> {
  const contribution = registry?.predicates.get(name);
  if (contribution === undefined || !hasPredicateEvaluator(contribution)) {
    return {
      predicate: name,
      passed: false,
      hard: true,
      detail: `предикат ${name} не предоставлен ни одним загруженным плагином`,
      expected: value,
    };
  }

  const hard = contribution.hard ?? true;
  try {
    const result = await contribution.evaluate(value, input);
    return { ...result, predicate: name, hard: result.hard ?? hard };
  } catch (error) {
    return {
      predicate: name,
      passed: false,
      hard,
      detail: `предикат ${name} отказал: ${error instanceof Error ? error.message : String(error)}`,
      expected: value,
    };
  }
}

/**
 * Границы изменений: все изменившиеся пути обязаны попадать хотя бы под один
 * из объявленных шаблонов.
 *
 * Предикат проверяет границы, но не факт работы: шаг, не изменивший ничего,
 * его проходит. Держать его единственным не стоит, о чём предупреждает линт.
 */
function evaluateChangedOnly(
  globs: readonly string[],
  input: EvaluationInput,
): PredicateResult {
  if (input.changedPaths === undefined) {
    return {
      predicate: 'changed_only',
      passed: true,
      hard: false,
      detail: 'не вычислен: состояние рабочего дерева снять не удалось',
      expected: globs,
    };
  }

  const outside = input.changedPaths.filter((path) => !globs.some((glob) => matches(glob, path)));

  return {
    predicate: 'changed_only',
    passed: outside.length === 0,
    hard: true,
    expected: globs,
    ...(outside.length === 0
      ? {}
      : {
          actual: outside,
          detail: `за объявленные границы вышли: ${outside.join(', ')}`,
        }),
  };
}

/** Сопоставление пути с шаблоном: `**` пересекает разделители, `*` — нет. */
function matches(glob: string, path: string): boolean {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] as string;
    if (char === '*' && glob[index + 1] === '*') {
      source += '.*';
      index += 1;
      if (glob[index + 1] === '/') index += 1;
      continue;
    }
    if (char === '*') {
      source += '[^/]*';
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`).test(path);
}

/**
 * Проверить значение JSON Schema, данной значением, — тем же Ajv и тем же
 * форматом замечаний, каким проверяются схема выхода `script` и манифест
 * переиспользуемого шага (`src/core/pipeline/steps.ts`). Дефект схемы —
 * ошибка конфигурации с текстом причины, а не исключение с чужим стеком.
 */
export function validateAgainstSchema(
  schema: unknown,
  value: unknown,
): { readonly passed: boolean; readonly detail?: string } {
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(schema as object);
  } catch (error) {
    throw new StepcastError(`Схема некорректна: ${(error as Error).message}`, { cause: error });
  }

  const passed = validate(value) === true;
  return {
    passed,
    ...(passed
      ? {}
      : {
          detail: (validate.errors ?? [])
            .map(
              (error: ErrorObject) =>
                `${error.instancePath === '' ? '/' : error.instancePath}: ${error.message ?? ''}`,
            )
            .join('\n'),
        }),
  };
}

/**
 * Проверить значение схемой из файла — общая механика для предиката `schema`
 * и для проверки объявленного `output_schema` шага `script` движком
 * (`runner.ts`, design.md решение 6): один компилятор, одно сообщение о
 * дефектной схеме, а не по реализации на потребителя. Тонкая обёртка над
 * `validateAgainstSchema`: читает файл и привязывает ошибки к нему.
 */
export function validateAgainstSchemaFile(
  path: string,
  value: unknown,
): { readonly passed: boolean; readonly detail?: string } {
  let schema: unknown;
  try {
    schema = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new StepcastError(`Не удалось прочитать схему ${path}: ${(error as Error).message}`, {
      file: path,
      cause: error,
    });
  }

  try {
    return validateAgainstSchema(schema, value);
  } catch (error) {
    if (error instanceof StepcastError) {
      throw new StepcastError(`Схема ${path} некорректна: ${(error.cause as Error).message}`, {
        file: path,
        cause: error.cause,
      });
    }
    throw error;
  }
}

function evaluateSchema(path: string, input: EvaluationInput): PredicateResult {
  if (input.structured === undefined) {
    return {
      predicate: 'schema',
      passed: false,
      hard: true,
      expected: path,
      detail: 'шаг не произвёл структурированного вывода',
    };
  }

  const { passed, detail } = validateAgainstSchemaFile(absolute(path, input.cwd), input.structured);

  return {
    predicate: 'schema',
    passed,
    hard: true,
    expected: path,
    ...(detail === undefined ? {} : { detail }),
  };
}

function compile(pattern: string): RegExp {
  const match = /^\/(.*)\/([a-z]*)$/.exec(pattern);
  return match === null
    ? new RegExp(pattern)
    : new RegExp(match[1] as string, match[2] as string);
}

function absolute(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolvePath(cwd, path);
}
