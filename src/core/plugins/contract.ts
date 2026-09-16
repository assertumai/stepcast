import { z } from 'zod';

import type { ExitCodeValue } from '../errors.js';
// Ссылки на реестр и контекст — только типом: в рантайме импорт стирается, и
// круга между контрактом, реестром и контекстом не возникает. Контекст берётся
// из `context.js`, а не из ядра: публикуемая поверхность плагина не должна
// тянуть за собой ни `cordis`, ни его типы (см. `context.ts`).
import type { RowOutcome } from './load.js';
import type { Context, Inject } from './context.js';
import type { TreeRow } from './tree.js';
import type { CliIo, CommandSpec, ParsedArgs } from './cli-types.js';

/**
 * Контракт плагина — ядерная половина (`plugin-surface-split`, design.md,
 * Решение 1): здесь только то, что не называет пайплайн — ни шаг, ни работу,
 * ни прогон, ни попытку, ни предикат, ни бэкенд, ни журнал, ни конфигурацию
 * движка. Доменная половина — вклад бэкенда, предиката, вида шага и их родня —
 * живёт в соседнем модуле `pipeline-contract.ts`: временно, до переезда
 * каталогов шагом 10 (`docs/microkernel-target.md`), но уже отдельным файлом,
 * потому что подпуть `stepcast/plugin` обязан не тянуть домен ни в рантайме,
 * ни в объявлениях.
 *
 * Плагин ничего не вызывает у движка при загрузке — он экспортирует описание
 * своих вкладов, а движок его читает. Так конфликт имён и валидность формы
 * проверяются целиком до того, как исполнится хоть одна строка плагина сверх
 * импорта, и результат не зависит от порядка загрузки.
 *
 * Плагин — код с правами процесса движка. Песочницы нет и не обещано: список
 * `plugins` лежит в конфигурации репозитория и попадает в ревью там же, где
 * `project.check`.
 */

/** Слаг в kebab-case или snake_case — форма имени вклада, общая для ядра и домена. */
export const SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

/** Диагностика, которую вправе вернуть статическая проверка плагина. */
export interface PluginDiagnostic {
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly hint?: string;
}

/** Окружение команды: ядерная часть — то, что движок разрешает независимо от домена пайплайна. */
export interface CommandEnv {
  readonly cwd: string;
  /**
   * Контекст ядра. Команда плагина достаёт через него сервис, заведённый этим
   * же плагином, — реестр отдаёт только служебные сервисы вклада, а свой
   * сервис плагина в нём не виден (design.md, Решение 12).
   */
  readonly ctx: Context;
  /**
   * Итоговое дерево плагинов того же разрешения конфигурации, которым собран
   * действующий состав (`plugin-tree`). Команде осмотра (`stepcast plugins`)
   * оно нужно целиком — со слоями, порядком и отключёнными строками, которых
   * в реестре нет вовсе, — и брать его вторым чтением слоёв нельзя: правка
   * патча между двумя чтениями развела бы напечатанное дерево с загруженным
   * составом.
   */
  readonly pluginTree: readonly TreeRow[];
  /**
   * Итог применения каждой строки дерева (`RowOutcome`, `user-plugins`,
   * design.md Решение 10) — тот же состав, что уже собрала загрузка.
   * `undefined`, если реестр пришёл готовым, а не собран `loadPlugins` на этом
   * вызове (`resolveWithPlugins`, вариант с кешированным реестром) — на пути
   * CLI такого не бывает, но поле остаётся честным для прочих вызывающих.
   */
  readonly pluginOutcomes: readonly RowOutcome[] | undefined;
}

/**
 * Вклад команды: новая подкоманда `stepcast <имя>`. Обобщена по окружению с
 * ядерным умолчанием (`plugin-surface-split`, design.md, Решение 6): команда,
 * которой хватает `CommandEnv` ядра, компилируется, не зная о пайплайне,
 * а команда пайплайна объявляется `CommandContribution<PipelineCommandEnv>`
 * (`stepcast/pipeline`) без единого приведения типа. `run` объявлен методом, а
 * не свойством-функцией, — и это не случайность: только метод проверяется
 * бивариантно, и хранение разных `CommandContribution<E>` одним общим типом в
 * реестре и диспетчере опирается именно на эту бивариантность (design.md,
 * «Risks»), а не на приведение.
 */
export interface CommandContribution<E extends CommandEnv = CommandEnv> {
  readonly name: string;
  /** Описание позиционных аргументов и флагов — то же, что у встроенных. */
  readonly spec: CommandSpec;
  /**
   * Сервисы, без которых команду не исполнить (design.md изменения
   * `pipeline-owns-services`, Решение 9). Диспетчер (`src/cli/main.ts`)
   * проверяет каждое имя по действующему контексту до вызова `run` и
   * отказывает названно, не доходя до тела команды, если состав его не
   * несёт, — вместо того чтобы команда упала на первом обращении к
   * отсутствующему вкладу или напечатала пустой перечень, будто пайплайнов не
   * существует вовсе. Не объявляют команды, которые реестра не читают, и
   * команды, обязанные работать именно тогда, когда состав сломан (`plugins`,
   * `config` и подобные): для них молчаливое поле — не пропуск, а осознанный
   * выбор.
   */
  readonly inject?: readonly string[];
  run(args: ParsedArgs, io: CliIo, env: E): Promise<ExitCodeValue> | ExitCodeValue;
}

export const CommandContributionSchema = z
  .object({
    name: z.string().regex(SLUG, 'имя команды — слаг в kebab-case'),
    spec: z.object({ description: z.string() }).loose(),
    run: z.custom<CommandContribution['run']>((value) => typeof value === 'function', {
      message: 'должна быть функцией',
    }),
  })
  .loose();

/** Ядерная форма плагина: имя, версия и вклад команд — то, чем автор пишет плагин, не зная о пайплайне. */
export interface StepcastPlugin {
  /** Имя плагина: слаг в kebab-case, уникальный среди загруженных. */
  readonly name: string;
  readonly version?: string;
  readonly commands?: readonly CommandContribution[];
}

/** Загруженный плагин: то, что движок пишет в манифест прогона и в отчёт. */
export interface LoadedPlugin {
  readonly name: string;
  readonly version?: string;
  /** Разрешённый путь модуля — по нему прогон воспроизводят. */
  readonly source: string;
}

/**
 * Вторая форма плагина: функция над контекстом либо объект с `apply` — то,
 * что не умеет декларативная форма: завести сервис с именем, которого ядро не
 * знает, и объявить зависимость от чужого через `inject` (design.md,
 * Решение 7). Имя обязано быть известно до применения: им подписан
 * `LoadedPlugin` и им же называет себя отказ о занятом имени ядра —
 * `Plugin.Base.name` объекта либо `Function.name` функции. Безымянная функция
 * именем не располагает: у `export default function (ctx) {…}` `Function.name`
 * равен `default`, и загрузчик отказывает такому плагину (`load.ts`).
 */
export interface ContextPluginObject {
  readonly name?: string;
  readonly version?: string;
  readonly inject?: Inject;
  apply(ctx: Context, config?: unknown): unknown;
}

export type ContextPluginFunction = ((ctx: Context, config?: unknown) => unknown) & {
  readonly name?: string;
  readonly version?: string;
  readonly inject?: Inject;
};

export type ContextPlugin = ContextPluginFunction | ContextPluginObject;

/** Плагин контекста опознаётся по форме экспорта: функция либо объект с `apply`. */
export function isContextPlugin(value: unknown): value is ContextPlugin {
  if (typeof value === 'function') return true;
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { apply?: unknown }).apply === 'function'
  );
}
