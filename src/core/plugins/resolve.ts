import { resolveConfig, type ResolveOptions, type ResolvedConfig } from '../config/resolve.js';
import { loadPlugins, type LoadOptions } from './load.js';
import { contributionOwner, type Registry } from './registry.js';

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
}

export async function resolveWithPlugins(
  options: ResolveOptions,
  loadOptions: Omit<LoadOptions, 'projectRoot'> & { readonly projectRoot?: string },
): Promise<ResolvedWithPlugins> {
  const first = resolveConfig(options);
  const projectRoot = loadOptions.projectRoot ?? options.cwd;
  const registry = await loadPlugins(first, { ...loadOptions, projectRoot });

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

  if (pluginDefaults.length === 0) return { resolved: first, registry };

  return { resolved: resolveConfig({ ...options, pluginDefaults }), registry };
}
