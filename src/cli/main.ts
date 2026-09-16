import { resolveConfig } from '../core/config/resolve.js';
import { ExitCode, isStepcastError, StepcastError, type ExitCodeValue } from '../core/errors.js';
import { parseArgs, type CliIo, type CommandSpec } from './args.js';
import type { RowOutcome } from '../core/plugins/load.js';
import type { PipelineCommandEnv } from '../core/plugins/pipeline-contract.js';
import { BUILTIN_USE_PREFIX } from '../core/plugins/tree.js';
import { resolveWithPlugins } from '../parts/resolve.js';
import { reportError } from './output.js';
import { row as pluginsRow, runPluginsCommandAfterLoadFailure } from './commands/plugins.js';
import type { CommandRow } from './commandRow.js';
import { COMMAND_ROW_IDS, COMMAND_ROWS } from './rows.js';

export type { CliIo } from './args.js';

/**
 * Строки независимых команд (design.md изменения `cli-commands-as-rows`,
 * Решение 5): `data`, `down`, `init` исполняются раньше, чем состав
 * существует, — точка входа берёт их вклад прямо из объявления строки, минуя
 * дерево целиком. Единственный источник состава: второго перечня имён рядом
 * с `COMMAND_ROWS` не заводится — расхождение между ними было бы видно
 * позже всего.
 */
const INDEPENDENT_COMMAND_ROWS: readonly CommandRow[] = COMMAND_ROWS.filter((row) => row.independent);

/** Id строк независимых команд — то, чем `resolveConfig` защищает их от подмены составом (design.md, Решение 6). */
const INDEPENDENT_COMMAND_ROW_IDS: readonly string[] = INDEPENDENT_COMMAND_ROWS.map((row) => row.id);

/** Строка команды по имени вклада — среди объявлений перечня, без обращения к реестру плагинов. */
function findCommandRow(name: string): CommandRow | undefined {
  return COMMAND_ROWS.find((row) => row.command.name === name);
}

/**
 * `PipelineCommandEnv` ранней ветки: настоящих `config` и `registry` в ней
 * нет, потому что она их не разрешает. Чтение любого из двух свойств —
 * признак того, что перечень независимых команд назвал команду неверно, и это
 * StepcastError с объяснением, а не встроенные умолчания: подставленное
 * умолчание превратило бы ошибку разметки в тихое неверное поведение.
 */
export function buildIndependentCommandEnv(name: string, cwd: string): PipelineCommandEnv {
  function readForbidden(): never {
    throw new StepcastError(
      `Команда ${name} объявлена независимой от конфигурации и не вправе читать её`,
    );
  }
  return {
    cwd,
    get config() {
      return readForbidden();
    },
    get registry() {
      return readForbidden();
    },
    get ctx() {
      return readForbidden();
    },
    get pluginTree() {
      return readForbidden();
    },
    get pluginOutcomes() {
      return readForbidden();
    },
  };
}

/**
 * Состояние строки команды текстом — для отказа об отсутствующей команде
 * (design.md, Решение 10). Строка, снятая каскадом вместе со своим
 * поставщиком (`pipeline`) или отказавшая при незакрытом внедрении, сюда не
 * доходит вовсе: такой отказ рождается раньше, внутри самой загрузки
 * (`resolveWithPlugins`), и называет причину не менее внятно — своим текстом.
 * Здесь остаются два случая, при которых загрузка завершилась успехом, а
 * команды всё равно нет в реестре: строка отключена патчем либо заменена
 * чужим модулем, не принёсшим одноимённой команды.
 */
function describeCommandRowState(id: string, outcomes: readonly RowOutcome[]): string {
  const outcome = outcomes.find((entry) => entry.row.id === id);
  if (outcome === undefined) return 'не значится в действующем составе';
  if (outcome.status === 'disabled') return 'отключена патчем состава';
  if (outcome.status === 'failed') return `отказала: ${outcome.error?.message ?? 'неизвестная причина'}`;
  if (outcome.status === 'not-attempted') return 'не загружалась';
  if (outcome.row.use !== `${BUILTIN_USE_PREFIX}${id}`) return 'заменена патчем состава, не принёсшим этой команды';
  return 'действует, но не приносит эту команду';
}

/** Отказ на имени команды, объявленной строкой, которой в действующем составе нет (design.md, Решение 10). */
function namedAbsenceError(row: CommandRow, outcomes: readonly RowOutcome[]): StepcastError {
  return new StepcastError(
    `Команда ${row.command.name} объявлена строкой ${row.id}, которой в действующем составе нет — ${describeCommandRowState(row.id, outcomes)}`,
    { at: 'plugins', hint: 'Действующий состав покажет stepcast plugins' },
  );
}

export async function run(argv: readonly string[], io: CliIo): Promise<ExitCodeValue> {
  try {
    const commandName = argv[0];
    const independentRow =
      commandName === undefined ? undefined : INDEPENDENT_COMMAND_ROWS.find((row) => row.command.name === commandName);
    if (independentRow !== undefined) {
      const args = parseArgs(argv, { [commandName as string]: independentRow.command.spec });
      return await independentRow.command.run(args, io, buildIndependentCommandEnv(commandName as string, io.cwd));
    }

    // Плагины загружаются до разбора аргументов: команда плагина обязана
    // попасть в перечень раньше, чем разбор объявит её неизвестной. Точка
    // входа подаёт `COMMAND_ROW_IDS` разрешению конфигурации и `COMMAND_ROWS`
    // загрузчику — тем же механизмом, каким `stepcast up` подаёт `UI_ROWS`
    // (`src/ui/kernel.ts`): дерево команд CLI = перечень движка
    // (`src/parts/rows.ts`) плюс перечень команд, и ни строки витрины, ни её
    // команд в нём нет.
    let resolution: Awaited<ReturnType<typeof resolveWithPlugins>>;
    try {
      resolution = await resolveWithPlugins(
        { cwd: io.cwd, builtinRows: COMMAND_ROW_IDS, independentRowIds: INDEPENDENT_COMMAND_ROW_IDS },
        { builtinRows: COMMAND_ROWS },
      );
    } catch (error) {
      // Отказ загрузки одной из строк не заслоняет команду осмотра дерева
      // (design.md, Решение 8): для неё дерево печатается всё равно, а
      // строка-виновница несёт причину. Для прочих команд поведение прежнее —
      // отказ прекращает команду до диспетчеризации.
      if (commandName !== 'plugins' || !isStepcastError(error)) throw error;
      // Повторный разбор конфигурации без загрузки: если он тоже кинет, это
      // отказ разбора (а не загрузки), и команда обязана прекратиться как
      // прежде — исключение не перехватывается здесь второй раз.
      const resolved = resolveConfig({
        cwd: io.cwd,
        builtinRows: COMMAND_ROW_IDS,
        independentRowIds: INDEPENDENT_COMMAND_ROW_IDS,
      });
      const failureArgs = parseArgs(argv, { plugins: pluginsRow.command.spec }); // тот же разбор флагов, что и на обычном пути — неизвестный флаг отказывает так же.
      return await runPluginsCommandAfterLoadFailure(failureArgs, io, resolved, {
        projectRoot: io.cwd,
        builtinRows: COMMAND_ROWS,
      });
    }
    const { resolved, registry, ctx, outcomes } = resolution;

    // Имя, объявленное строкой перечня, которой в действующем составе нет
    // (design.md, Решение 10): отказ называет команду, её строку и её
    // состояние — до разбора аргументов и без печати общей справки. Имя, не
    // объявленное ни одной строкой и не внесённое плагином, идёт дальше,
    // прежним путём «Неизвестная команда: …».
    if (commandName !== undefined) {
      const declaredRow = findCommandRow(commandName);
      if (declaredRow !== undefined && registry.commands.get(commandName) === undefined) {
        // `outcomes` пуст только на пути с готовым реестром (`resolveWithPlugins`,
        // вариант `registry`), которым CLI не пользуется: здесь он всегда
        // собран этим же вызовом.
        throw namedAbsenceError(declaredRow, outcomes ?? []);
      }
    }

    const specs: Record<string, CommandSpec> = {};
    for (const [name, contribution] of registry.commands) specs[name] = contribution.spec;

    const args = parseArgs(argv, specs);
    const contribution = registry.commands.get(args.command);
    if (contribution === undefined) return ExitCode.configError;

    // Отказ до вызова тела команды (design.md изменения `pipeline-owns-services`,
    // Решение 9): состав без строки-поставщика — законное состояние ядра, и
    // команда, объявившая `inject`, обязана сказать об этом внятно, а не
    // упасть на первом обращении к отсутствующему сервису реестра или
    // напечатать пустой перечень, будто пайплайнов не существует вовсе.
    // Встроенные команды это поле больше не объявляют (`cli-commands-as-rows`,
    // Решение 9) — их `inject` несёт строка, и проверка ниже касается только
    // команды плагина.
    //
    // Имена проверяются по действующему контексту (`ctx.get`), а не по
    // перечню недостающих сервисов реестра (`Registry.missingServices`):
    // реестр знает лишь свои четыре доменных имени, и команда плагина,
    // объявившая зависимость от сервиса другого плагина, осталась бы без
    // проверки вовсе — падая в собственном теле там, где обещан названный
    // отказ (находка ревью).
    const missingInject = (contribution.inject ?? []).filter((name) => ctx.get(name) === undefined);
    if (missingInject.length > 0) {
      throw new StepcastError(
        `Команда ${args.command} ждёт сервис ${missingInject.join(', ')}: в действующем составе его не заводит ни одна строка`,
        { at: 'plugins', hint: 'Действующий состав покажет stepcast plugins — строку-поставщика отключил патч либо она снята из перечня' },
      );
    }

    // Типизирован явно `PipelineCommandEnv`, а не отдан литералом: `contribution`
    // хранится ядерным `CommandContribution` (реестр общий на оба вида
    // команд — design.md, «Risks»), и его `run` ждёт параметром ядерный
    // `CommandEnv`. Именованная переменная того же значения, что подходит и
    // под доменное, и под ядерное окружение структурно, проходит проверку
    // избыточных полей литерала один раз здесь, а не отдельно на каждой из
    // двадцати пяти команд.
    const env: PipelineCommandEnv = {
      cwd: io.cwd,
      config: resolved.config,
      registry,
      ctx,
      pluginTree: resolved.pluginTree,
      pluginOutcomes: outcomes,
    };
    return await contribution.run(args, io, env);
  } catch (error) {
    return reportError(error, io.err);
  }
}
