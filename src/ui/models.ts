import { homedir } from 'node:os';

import { discoverModels, type ModelDiscoveryResult } from '../core/backend/models.js';
import { resolveWithCachedKernel, type KernelCache } from './pipelines.js';
import { readSettings } from './settings.js';

/**
 * Перечисление моделей по каждому агенту страницы «Агенты».
 *
 * Список агентов — тот же, что уже собирает `readSettings` (включая
 * синтетическую карточку codex до подключения плагина): страница не должна
 * видеть два разных состава агентов из двух соседних запросов. Пробы при
 * этом идут отдельным проходом `resolveWithPlugins`, а не общим с
 * `readSettings`, — маршрут читающий, и `discoverModels` вправе поднять
 * процесс, но это не повод протаскивать пробу внутрь чтения настроек
 * (design.md, решение 5).
 */
export interface ModelsView {
  readonly backends: Readonly<Record<string, ModelDiscoveryResult>>;
}

export async function readModels(
  home: string = homedir(),
  options: { readonly refresh?: boolean } = {},
  kernelCache?: KernelCache,
): Promise<ModelsView> {
  const settings = await readSettings(home, kernelCache);
  const { resolved, registry } = await resolveWithCachedKernel(
    `home:${home}`,
    { cwd: home, home, projectPath: null },
    home,
    kernelCache,
  );

  const entries = await Promise.all(
    settings.backends.map(async (backend) => {
      const result = await discoverModels(backend.name, resolved.config, registry, options);
      return [backend.name, result] as const;
    }),
  );

  return { backends: Object.fromEntries(entries) };
}
