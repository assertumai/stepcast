import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';

import codexPlugin from '../backends/codex/index.js';
import { describeSource } from '../pipeline/config/merge.js';
import type { ModelTiers } from '../pipeline/config/modelTiers.js';
import type { ResolvedConfig } from '../pipeline/config/resolve.js';
import { ModelNameSchema, ModelTierSchema, RawConfigSchema } from '../pipeline/config/schema.js';
import { StepcastError } from '../../kernel/errors.js';
import { currentDaemonKernel } from './daemon/kernel.js';
import type { KernelCache } from './pipelines.js';

export interface SettingsValue {
  readonly value: string | undefined;
  readonly source: string;
}

export interface BackendView {
  readonly name: string;
  readonly command: string;
  readonly enabled: boolean;
  /** Есть адаптер; настройки неподключённого Codex можно заполнить заранее. */
  readonly available: boolean;
  readonly defaultModel: string | undefined;
  readonly defaultModelSource: string;
  readonly modelTiers: ModelTiers;
  readonly modelTierSources: Readonly<Record<string, string>>;
}

export interface Settings {
  readonly agent: SettingsValue;
  /** Старое общее переопределение модели сохраняется для совместимости. */
  readonly model: SettingsValue;
  readonly backends: readonly BackendView[];
  readonly file: string;
}

const BackendPatchSchema = z.object({
  defaultModel: ModelNameSchema.nullable().optional(),
  modelTiers: z.partialRecord(ModelTierSchema, ModelNameSchema.nullable()).optional(),
}).strict();

const SettingsPatchSchema = z.object({
  agent: ModelNameSchema.optional(),
  model: z.string().trim().nullable().optional(),
  backends: z.record(z.string(), BackendPatchSchema).optional(),
  /** Явное подключение адаптера из поставки, без установки внешнего пакета. */
  connectCodex: z.literal(true).optional(),
}).strict();

export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export function globalConfigPath(home: string = homedir()): string {
  return join(home, '.stepcast', 'config.yml');
}

function valueOf(resolved: ResolvedConfig, path: string, value: string | undefined): SettingsValue {
  const source = resolved.provenance.get(path);
  return { value, source: source === undefined ? 'встроенное умолчание' : describeSource(source) };
}

/**
 * Витрина правит глобальный файл; проектный слой отключён независимо от cwd.
 *
 * `kernelCache` — кеш ядра демона (`src/parts/ui/daemon/server.ts`, `createUiServer`):
 * ядро переживает отдельный запрос тем же правилом, каким кеш проверяет ключ
 * проекта (design.md, Решение 6) — свежая правка настроек, добавившая плагин
 * (`connectCodex`), меняет объявления, и следующий вызов поднимает ядро
 * заново, а не читает устаревшее. Без кеша, как и при прямом вызове вне
 * сервера (тесты), плагины загружаются заново на каждый вызов.
 */
export async function readSettings(home: string = homedir(), kernelCache?: KernelCache): Promise<Settings> {
  // Единая точка получения действующего ядра демона (`src/parts/ui/daemon/kernel.ts`,
  // design.md Решение 6): ключ кеша `home:<home>`, строки поставки витрины —
  // тот же вызов, что использует диспетчер маршрутов.
  const { resolved, registry, fallback, buildError } = await currentDaemonKernel(kernelCache, home);
  // Запасной встроенный состав держит витрину открытой, чтобы та назвала
  // причину отказа (`ui-screens`, «Отказ сборки состава не гасит витрину»), но
  // конфигурации пользователя в нём нет: ни домашнего слоя, ни проектного.
  // Отдать его значения за настройки значило бы показать правдоподобные и
  // неверные — и на них же проверить правку, которая пишется в настоящий файл.
  if (fallback) {
    throw new StepcastError(`Настройки не читаются: ${buildError ?? 'конфигурация не собирается'}`, {
      file: globalConfigPath(home),
      hint: 'Почините файлы, из которых собирается состав плагинов, — витрина покажет ту же причину полосой над экраном',
    });
  }
  const { config } = resolved;
  const backends: BackendView[] = Object.entries(config.backends).map(([name, backend]) => ({
    name,
    command: backend.command,
    enabled: backend.enabled,
    available: registry.backends.has(name),
    defaultModel: backend.defaultModel,
    defaultModelSource: valueOf(resolved, `backends.${name}.default_model`, backend.defaultModel).source,
    modelTiers: backend.modelTiers ?? {},
    modelTierSources: Object.fromEntries(Object.entries(backend.modelTiers ?? {}).map(([tier, model]) => [
      tier, valueOf(resolved, `backends.${name}.model_tiers.${tier}`, model).source,
    ])),
  }));

  // Codex поставляется как opt-in плагин: карточка видна и до подключения,
  // но агентом по умолчанию он может стать только вместе с адаптером.
  if (!backends.some((backend) => backend.name === 'codex')) {
    backends.push({
      name: 'codex', command: 'codex', enabled: true, available: false,
      defaultModel: codexPlugin.backends!.codex!.defaults!.default_model,
      defaultModelSource: 'plugin:codex', modelTiers: {}, modelTierSources: {},
    });
  } else {
    const codex = backends.find((backend) => backend.name === 'codex')!;
    if (!codex.available && codex.defaultModel === undefined) {
      backends[backends.indexOf(codex)] = {
        ...codex, defaultModel: codexPlugin.backends!.codex!.defaults!.default_model,
        defaultModelSource: 'plugin:codex',
      };
    }
  }

  return {
    agent: valueOf(resolved, 'defaults.agent', config.defaults.agent),
    model: valueOf(resolved, 'defaults.model', config.defaults.model),
    backends, file: globalConfigPath(home),
  };
}

/** Проверить всю правку до записи; менять YAML-документ, сохраняя комментарии. */
export async function writeSettings(
  input: unknown,
  home: string = homedir(),
  kernelCache?: KernelCache,
): Promise<Settings> {
  const parsedPatch = SettingsPatchSchema.safeParse(input);
  if (!parsedPatch.success) {
    const issue = parsedPatch.error.issues[0]!;
    throw new StepcastError(`Некорректная правка настроек ${issue.path.join('.')}: ${issue.message}`);
  }
  const patch = parsedPatch.data;
  const current = await readSettings(home, kernelCache);
  const known = new Map(current.backends.map((backend) => [backend.name, backend]));
  for (const name of Object.keys(patch.backends ?? {})) {
    if (!known.has(name)) throw new StepcastError(`Неизвестный агент ${name}`);
  }
  if (patch.agent !== undefined) {
    const backend = known.get(patch.agent);
    if (backend === undefined) throw new StepcastError(`Неизвестный агент ${patch.agent}`);
    if (!backend.enabled) throw new StepcastError(`Агент ${patch.agent} выключен`);
    if (!backend.available && !(patch.agent === 'codex' && patch.connectCodex === true)) {
      throw new StepcastError(`Агент ${patch.agent} не подключён: сначала подключите его плагин`);
    }
  }

  const file = globalConfigPath(home);
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const document = parseDocument(text);
  if (patch.connectCodex === true) {
    const plugins = (document.toJS() as { plugins?: string[] } | null)?.plugins ?? [];
    if (!plugins.includes('stepcast/backends/codex')) {
      if (!document.has('plugins')) document.set('plugins', document.createNode([]));
      document.addIn(['plugins'], 'stepcast/backends/codex');
    }
  }
  if (patch.agent !== undefined) document.setIn(['defaults', 'agent'], patch.agent);
  if (patch.model !== undefined) {
    if (patch.model === null || patch.model === '') document.deleteIn(['defaults', 'model']);
    else document.setIn(['defaults', 'model'], patch.model);
  }
  for (const [name, backend] of Object.entries(patch.backends ?? {})) {
    const path = ['backends', name];
    if (backend.defaultModel !== undefined) {
      if (backend.defaultModel === null) document.deleteIn([...path, 'default_model']);
      else document.setIn([...path, 'default_model'], backend.defaultModel);
    }
    for (const [tier, model] of Object.entries(backend.modelTiers ?? {})) {
      if (model === null) document.deleteIn([...path, 'model_tiers', tier]);
      else document.setIn([...path, 'model_tiers', tier], model);
    }
  }

  const next = document.toString();
  const parsed = RawConfigSchema.safeParse(parseDocument(next).toJS() ?? {});
  if (!parsed.success) {
    throw new StepcastError(`Правка не проходит схему конфигурации: ${parsed.error.issues[0]?.message ?? 'неизвестная ошибка'}`, { file });
  }

  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, next);
  renameSync(temporary, file);
  // Кеш перечитывает объявления плагинов заново при каждом обращении: правка,
  // добавившая plugins (`connectCodex`), обязана быть видна тут же, без
  // перезапуска демона.
  return readSettings(home, kernelCache);
}
