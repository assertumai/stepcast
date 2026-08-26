import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseDocument } from 'yaml';

import { describeSource } from '../core/config/merge.js';
import { resolveConfig } from '../core/config/resolve.js';
import { RawConfigSchema } from '../core/config/schema.js';
import { StepcastError } from '../core/errors.js';

/**
 * Дефолтные агент и модель, какими их видит витрина.
 *
 * Читается вся разрешённая конфигурация, пишется только глобальный файл:
 * витрина охватывает все проекты сразу, и её настройка — это настройка «по
 * умолчанию везде». Проектный слой в чтении сознательно отключён — демон не
 * привязан к проекту, и подхватить чужой `.stepcast/config.yml` по случайному
 * рабочему каталогу значило бы показать настройку, которой у пользователя нет.
 *
 * Правка идёт по документу, а не по разобранному дереву: конфигурация пишется
 * человеком и полна комментариев, а перезапись файла из объекта стёрла бы их
 * молча.
 */

export interface SettingsValue {
  readonly value: string | undefined;
  /** Откуда взято значение: встроенное умолчание или путь файла. */
  readonly source: string;
}

export interface BackendView {
  readonly name: string;
  readonly command: string;
  readonly enabled: boolean;
  readonly defaultModel: string | undefined;
}

export interface Settings {
  readonly agent: SettingsValue;
  readonly model: SettingsValue;
  readonly backends: readonly BackendView[];
  /** Файл, в который витрина пишет. Пользователь должен знать, что правит. */
  readonly file: string;
}

export interface SettingsPatch {
  readonly agent?: string;
  /** `null` — снять значение и вернуться к модели бэкенда. */
  readonly model?: string | null;
}

export function globalConfigPath(home: string = homedir()): string {
  return join(home, '.stepcast', 'config.yml');
}

function valueOf(
  resolved: ReturnType<typeof resolveConfig>,
  path: string,
  value: string | undefined,
): SettingsValue {
  const source = resolved.provenance.get(path);
  return {
    ...(value === undefined ? { value: undefined } : { value }),
    source: source === undefined ? 'встроенное умолчание' : describeSource(source),
  };
}

export function readSettings(home: string = homedir()): Settings {
  const file = globalConfigPath(home);
  const resolved = resolveConfig({ cwd: home, home, projectPath: null });
  const { config } = resolved;

  return {
    agent: valueOf(resolved, 'defaults.agent', config.defaults.agent),
    model: valueOf(resolved, 'defaults.model', config.defaults.model),
    backends: Object.entries(config.backends).map(([name, backend]) => ({
      name,
      command: backend.command,
      enabled: backend.enabled,
      defaultModel: backend.defaultModel,
    })),
    file,
  };
}

/**
 * Записать дефолты в глобальную конфигурацию.
 *
 * Проверка агента по списку бэкендов — не придирка: `defaults.agent`, не
 * названный ни одним бэкендом, валит не эту запись, а следующий прогон, уже
 * после раскрытия пайплайна.
 */
export function writeSettings(patch: SettingsPatch, home: string = homedir()): Settings {
  const current = readSettings(home);

  if (patch.agent !== undefined) {
    const known = current.backends.map((backend) => backend.name);
    if (!known.includes(patch.agent)) {
      throw new StepcastError(
        `Неизвестный агент ${patch.agent}: бэкенды с таким именем не объявлены`,
        { hint: `Объявленные бэкенды: ${known.join(', ')}` },
      );
    }
  }

  const file = globalConfigPath(home);
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    // Файла ещё нет: витрина заводит его первой правкой.
  }

  const document = parseDocument(text);
  if (patch.agent !== undefined) document.setIn(['defaults', 'agent'], patch.agent);
  if (patch.model !== undefined) {
    if (patch.model === null || patch.model === '') document.deleteIn(['defaults', 'model']);
    else document.setIn(['defaults', 'model'], patch.model);
  }

  const next = document.toString();
  const parsed = RawConfigSchema.safeParse(parseDocument(next).toJS() ?? {});
  if (!parsed.success) {
    throw new StepcastError(
      `Правка не проходит схему конфигурации: ${parsed.error.issues[0]?.message ?? 'неизвестная ошибка'}`,
      { file },
    );
  }

  mkdirSync(dirname(file), { recursive: true });
  // Через временный файл: оборванная запись не должна оставить пользователя с
  // испорченной конфигурацией.
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, next);
  renameSync(temporary, file);

  return readSettings(home);
}
