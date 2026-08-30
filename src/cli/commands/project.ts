import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { resolveConfig } from '../../core/config/resolve.js';
import { ExitCode, StepcastError, type ExitCodeValue } from '../../core/errors.js';
import { findProjectRoot } from '../../core/journal/paths.js';
import { describeSchemaFailure } from '../../core/pipeline/load.js';
import { BacklogSlotsResponseSchema, type BacklogSlotsResponse } from '../../core/backlog/schema.js';
import { resolveItemRepo } from '../../core/project/repos.js';
import type { ParsedArgs } from '../args.js';

/**
 * `stepcast project repos` — дополняет документ дорожек (`backlog pick
 * --lanes`) объявлениями репозитория, который назвал пункт каждой
 * заполненной дорожки. Команда сама читает конфигурацию (design.md, решение
 * 1): `backlog` остаётся переносимой командой, которой устройство проекта не
 * нужно вовсе, а разрешение репозитория требует ровно конфигурации —
 * заводить для этого флаг у `pick` значило бы сделать её зависимой от него.
 *
 * Команда только отвечает: ни очередь, ни рабочее дерево, ни конфигурация ею
 * не правятся.
 */

const ACTIONS = ['repos'] as const;

function stringFlag(flags: ParsedArgs['flags'], name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

async function readDocument(
  cwd: string,
  fileFlag: string | undefined,
  readStdin: (() => Promise<string>) | undefined,
): Promise<string> {
  if (fileFlag !== undefined) {
    const path = resolvePath(cwd, fileFlag);
    try {
      return readFileSync(path, 'utf8');
    } catch (error) {
      throw new StepcastError(`Не удалось прочитать файл ${path}: ${(error as Error).message}`, {
        file: path,
        cause: error,
      });
    }
  }

  // Стандартный ввод не читается вовсе при заданном --file: конвейер второго
  // звена не обязан существовать, и его отсутствие не отказ.
  return (await readStdin?.()) ?? '';
}

/**
 * Пустой и неразбираемый ввод — отказ разбора, а не молчаливая выдача
 * пустого документа: так отказ первого звена конвейера (`backlog pick`)
 * доезжает ненулевым кодом второго (design.md, решение 1 и риск в конце).
 */
function parseDocument(text: string): BacklogSlotsResponse {
  if (text.trim() === '') {
    throw new StepcastError('Пуст стандартный ввод: ожидался документ дорожек backlog pick --lanes');
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new StepcastError(`Документ дорожек не разбирается как JSON: ${(error as Error).message}`, {
      cause: error,
    });
  }

  const parsed = BacklogSlotsResponseSchema.safeParse(json);
  if (!parsed.success) {
    const failure = describeSchemaFailure(parsed.error);
    throw new StepcastError(
      `Документ дорожек не соответствует схеме stepcast:backlog-slots: ${failure.message}`,
      failure.at === undefined ? {} : { at: failure.at },
    );
  }
  return parsed.data;
}

export async function runProjectCommand(
  args: ParsedArgs,
  write: (line: string) => void,
  cwd: string,
  readStdin?: () => Promise<string>,
): Promise<ExitCodeValue> {
  const [action] = args.positional;
  if (action !== 'repos') {
    throw new StepcastError(
      `неизвестное действие «${action ?? ''}» у команды project, ожидалось одно из ${ACTIONS.join(', ')}`,
    );
  }

  // Конфигурация читается до чтения стандартного ввода: `resolveConfig`
  // синхронна и не должна оказаться по другую сторону единственного `await`
  // команды — вызывающий, подменивший HOME на время вызова, обязан застать
  // его действующим. Конфигурация ищется от корня рабочего дерева git, как у
  // `assert-clean`: пути состава и объявления вложенных репозиториев
  // объявлены от корня, и вызов из подкаталога обязан отвечать то же, что
  // вызов из корня.
  const root = findProjectRoot(cwd);
  const { config } = resolveConfig({ cwd: root });

  const text = await readDocument(cwd, stringFlag(args.flags, 'file'), readStdin);
  const document = parseDocument(text);

  const lanes: Record<string, unknown> = {};
  for (const [lane, value] of Object.entries(document.lanes)) {
    if (!value.filled || value.item === null) {
      lanes[lane] = value;
      continue;
    }
    const repo = resolveItemRepo(config, { slug: value.item.slug, repos: value.item.repos });
    lanes[lane] = { ...value, repo };
  }

  write(JSON.stringify({ lanes }, null, 2));
  return ExitCode.ok;
}
