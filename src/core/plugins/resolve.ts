import { resolveConfig, type ResolveOptions, type ResolvedConfig } from '../config/resolve.js';
import { loadPlugins, type LoadOptions } from './load.js';
import type { Context } from './context.js';
import { pluginContext } from './kernel.js';
import { contributionOwner, kernelFromRegistry, type Registry } from './registry.js';

/**
 * Разрешение конфигурации вместе с плагинами.
 *
 * Двухфазность неизбежна: список `plugins` называет сама конфигурация, а
 * умолчания бэкендов приносят загруженные плагины — то есть прочитать её надо
 * раньше, чем известно, чем её дополнят. Первый проход читает слои и даёт
 * список модулей, второй — те же слои плюс слой умолчаний плагинов.
 *
 * Файлы читаются дважды; это два небольших YAML, и цена измеряется
 * миллисекундами. Взамен происхождение каждого значения остаётся честным:
 * умолчание плагина видно в `stepcast config` источником `plugin:<имя>`, а не
 * притворяется встроенным и не подмешивается в уже слитую карту задним числом.
 */
export interface ResolvedWithPlugins {
  readonly resolved: ResolvedConfig;
  readonly registry: Registry;
  /** Контекст ядра, породившего `registry` — то, чем пользуется `CommandEnv.ctx`. */
  readonly ctx: Context;
}

/**
 * Что делать с реестром: собрать его загрузкой либо взять уже собранный.
 *
 * Варианты разведены типом, а не необязательным полем рядом с прочими:
 * готовый реестр отменяет `loadPlugins` целиком, то есть вместе с ним
 * отменяет и `builtinCommands`, и `importModule`. Пара
 * `{ builtinCommands, registry }` в одном объекте выглядела бы осмысленно и
 * молча вернула бы реестр без единой команды — здесь она не компилируется.
 */
export type ResolveWithPluginsOptions =
  | (Omit<LoadOptions, 'projectRoot'> & {
      readonly projectRoot?: string;
      readonly registry?: undefined;
    })
  | {
      readonly projectRoot?: string;
      /**
       * Реестр, собранный ранее тем же корнем проекта: пропускает
       * `loadPlugins` (а с ним и повторный импорт модулей), но не второй
       * проход разрешения — умолчания плагинных бэкендов обязаны лечь слоем и
       * на кешированном реестре так же, как на свежесобранном. Развилка живёт
       * здесь, а не рядом с кешом: единственное место, которое обязано знать
       * оба пути сборки реестра, — то, что решает, нужен ли второй проход.
       */
      readonly registry: Registry;
    };

export async function resolveWithPlugins(
  options: ResolveOptions,
  loadOptions: ResolveWithPluginsOptions,
): Promise<ResolvedWithPlugins> {
  const first = resolveConfig(options);
  const projectRoot = loadOptions.projectRoot ?? options.cwd;
  const registry =
    loadOptions.registry ?? (await loadPlugins(first, { ...loadOptions, projectRoot }));
  const ctx = pluginContext(kernelFromRegistry(registry).ctx);

  const pluginDefaults = registry.plugins.flatMap((plugin) => {
    const backends: Record<string, unknown> = {};
    for (const [name, contribution] of registry.backends) {
      if (contribution.defaults === undefined) continue;
      // Умолчания принадлежат тому плагину, который внёс бэкенд: имя слоя
      // обязано называть его, иначе отчёт покажет чужое авторство.
      if (contributionOwner(registry, 'backends', name) !== plugin.name) continue;
      backends[name] = contribution.defaults;
    }
    return Object.keys(backends).length === 0 ? [] : [{ plugin: plugin.name, values: { backends } }];
  });

  if (pluginDefaults.length === 0) return { resolved: first, registry, ctx };

  return { resolved: resolveConfig({ ...options, pluginDefaults }), registry, ctx };
}
