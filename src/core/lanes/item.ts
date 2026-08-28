import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { StepcastError } from '../errors.js';

/**
 * Чтение `item-<дорожка>.json` каталога прогона — файла, который пишет
 * `stepcast backlog pick --lanes --run-dir`. Модуль общий для сведения
 * дорожек и `backlog settle`: второго разбора того же формата в коде нет.
 */

export interface LaneItem {
  readonly lane: string;
  readonly slug: string;
  readonly title?: string;
}

const ITEM_FILE = /^item-(.+)\.json$/;

function itemPath(runDir: string, lane: string): string {
  return join(runDir, `item-${lane}.json`);
}

/** Дорожке в этом прогоне достался пункт очереди. */
export function hasLaneItem(runDir: string, lane: string): boolean {
  return existsSync(itemPath(runDir, lane));
}

/** Дорожки, которым в этом прогоне достался пункт очереди. */
export function takenLanes(runDir: string): readonly string[] {
  if (!existsSync(runDir)) return [];
  return readdirSync(runDir)
    .map((name) => ITEM_FILE.exec(name)?.[1])
    .filter((lane): lane is string => lane !== undefined);
}

/** Слаг и заголовок пункта, взятого дорожкой. Файл без слага — отказ конфигурации, называющий файл. */
export function readLaneItem(runDir: string, lane: string): LaneItem {
  const path = itemPath(runDir, lane);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new StepcastError(`Не удалось прочитать файл пункта дорожки ${lane}: ${(error as Error).message}`, {
      file: path,
      cause: error,
    });
  }

  const slug = (raw as { slug?: unknown } | null)?.slug;
  if (typeof slug !== 'string' || slug === '') {
    throw new StepcastError(`Файл пункта дорожки ${lane} не содержит слага`, { file: path });
  }

  const title = (raw as { title?: unknown }).title;
  return { lane, slug, ...(typeof title === 'string' ? { title } : {}) };
}
