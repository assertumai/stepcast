import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import {
  moveBetween,
  moveWithin,
  parseBacklogFile,
  readBacklogFile,
  withFields,
  withStatus,
  withoutFields,
  writeBacklogFile,
} from '../../../core/backlog/index.js';
import { isStepcastError } from '../../../core/errors.js';
import { listProjects } from '../../../core/journal/reader.js';
import { readBody, sendJson } from '../../http.js';
import { screenRow, type ApiHandler } from '../registry.js';
import { declaration } from './declaration.js';

/**
 * Экран «Доска» и единственный маршрут, который правит очередь с витрины:
 * `POST /api/backlog/move`.
 *
 * Демон пишет очередь сам, а не порождает команду бинаря, как `POST /api/run`.
 * Правило «единственный писатель — бинарь» касается журнала прогона: он
 * пишется из-под идущего прогона, и второй писатель состязался бы с ним за
 * последнее слово. У очереди второго писателя во время перетаскивания нет, а
 * плата за отсоединённый процесс была бы прямой: ответ `202` без результата,
 * то есть карточка, вернувшаяся на место без объяснения.
 *
 * Колонки доски и состояния формата — одни и те же слова (`todo`,
 * `in_progress`, `done`), четвёртая колонка `archive` — не состояние, а файл:
 * `archived.md` рядом с `backlog.md` (`docs/backlog.md`). Поэтому перенос в
 * архив статус пункта не трогает: архив хранит исход таким, каким он был.
 */

const COLUMNS = ['todo', 'in_progress', 'done', 'archive'] as const;

const PostBodySchema = z
  .object({
    project: z.string().min(1),
    slug: z.string().min(1),
    column: z.enum(COLUMNS),
    /**
     * Слаг пункта, перед которым встать в колонке-получателе. Отсутствие
     * значит «в конец»: доска шлёт положение, посчитанное по своей колонке, и
     * последняя карточка соседа снизу не имеет.
     */
    before: z.string().min(1).optional(),
  })
  .strict();

const TASKS_FILE = 'backlog.md';
const ARCHIVE_FILE = 'archived.md';

/** Отсутствующий архив — пустой текст, а не отказ: он заводится первым же переносом. */
function readOrEmpty(file: string): string {
  return existsSync(file) ? readBacklogFile(file) : '';
}

function holdsSlug(file: string, text: string, slug: string): boolean {
  if (text === '') return false;
  return parseBacklogFile(file, text).some((entry) => entry.slug === slug);
}

const handleMove: ApiHandler = async (req, res, env) => {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 413, { error: 'Тело запроса слишком велико' });
    return;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(body === '' ? '{}' : body) as unknown;
  } catch {
    sendJson(res, 400, { error: 'Тело запроса не разбирается как JSON' });
    return;
  }

  const parsed = PostBodySchema.safeParse(raw);
  if (!parsed.success) {
    sendJson(res, 400, {
      error: `Тело запроса не соответствует формату: ${parsed.error.issues[0]?.message ?? 'project, slug, column и необязательный before'}`,
    });
    return;
  }

  const { project: projectKey, slug, column, before } = parsed.data;

  // Взятие в работу — дело запуска, а не доски: `backlog pick` проставляет и
  // `in_progress`, и `started_at` одним вызовом, и проставленный доской
  // статус сделал бы пункт несвободным для того самого прогона, ради которого
  // его и двигали.
  if (column === 'in_progress') {
    sendJson(res, 400, {
      error: 'В работу пункт переводит запуск пайплайна (backlog pick), а не перенос на доске',
    });
    return;
  }

  const project = listProjects(env.runsRoot).find((entry) => entry.key === projectKey);
  if (project?.path === undefined) {
    sendJson(res, 400, { error: `Проект ${projectKey} неизвестен указателю projects.json` });
    return;
  }

  const tasksFile = join(project.path, TASKS_FILE);
  const archiveFile = join(project.path, ARCHIVE_FILE);

  try {
    const tasksText = readOrEmpty(tasksFile);
    const archiveText = readOrEmpty(archiveFile);

    const inTasks = holdsSlug(tasksFile, tasksText, slug);
    const inArchive = holdsSlug(archiveFile, archiveText, slug);
    if (!inTasks && !inArchive) {
      sendJson(res, 404, { error: `Пункт ${slug} не найден ни в ${TASKS_FILE}, ни в ${ARCHIVE_FILE}` });
      return;
    }

    const fromFile = inTasks ? tasksFile : archiveFile;
    const toFile = column === 'archive' ? archiveFile : tasksFile;

    if (fromFile === toFile) {
      const text = fromFile === tasksFile ? tasksText : archiveText;
      const moved = moveWithin(text, slug, before, fromFile);
      // Статус проставляется после перестановки: `withFields` ищет пункт
      // разбором, и порядок строк к этому моменту уже окончательный.
      writeBacklogFile(fromFile, column === 'archive' ? moved : withStatus(moved, slug, column));
    } else {
      const fromText = fromFile === tasksFile ? tasksText : archiveText;
      const toText = toFile === tasksFile ? tasksText : archiveText;
      const result = moveBetween(fromText, toText, slug, before, fromFile, toFile);
      // Оба файла пишутся по очереди, и атомарности на пару у записи нет:
      // отказ второй записи оставил бы пункт в обоих файлах. Источник поэтому
      // пишется вторым — пункт, задвоенный на мгновение, виден на доске
      // дважды, а пункт, пропавший из обоих, не виден нигде.
      writeBacklogFile(toFile, column === 'archive' ? result.to : withStatus(result.to, slug, column));
      writeBacklogFile(fromFile, result.from);
    }
  } catch (error) {
    if (isStepcastError(error)) {
      sendJson(res, 400, { error: error.message, ...(error.at === undefined ? {} : { at: error.at }) });
      return;
    }
    sendJson(res, 500, { error: `Не удалось перенести пункт: ${(error as Error).message}` });
    return;
  }

  // Новый вид очереди придёт обычным тактом наблюдателя событием `backlog`:
  // доска не получает его ответом, чтобы на экране не оказалось двух истин.
  sendJson(res, 200, { ok: true });
};

/**
 * Поля пункта, которые правит панель деталей. Всё, что вне перечня, правкой
 * с витрины не считается:
 *
 * - `status` задаёт колонка — правка поля рядом с перетаскиванием дала бы два
 *   способа сказать одно и то же, расходящихся на первом же несогласии;
 * - `started_at` и `reason` проставляет движок (`backlog pick`, `finish`) —
 *   это бухгалтерия прогона, а не описание работы;
 * - `slug` — имя пункта в заголовке, а не поле; его смена — переименование, и
 *   вместе с ним пришлось бы двигать файлы дорожек прогона, которые на него
 *   ссылаются.
 */
const REQUIRED_FIELDS = ['title', 'why', 'done_when'] as const;
const OPTIONAL_FIELDS = ['group', 'track', 'repos'] as const;

const EditBodySchema = z
  .object({
    project: z.string().min(1),
    slug: z.string().min(1),
    fields: z
      .object({
        title: z.string().optional(),
        why: z.string().optional(),
        done_when: z.string().optional(),
        group: z.string().optional(),
        track: z.string().optional(),
        repos: z.string().optional(),
      })
      .strict(),
  })
  .strict();

/**
 * Правка полей пункта, где бы он ни лежал, — в очереди либо в архиве.
 *
 * Записывается только текст, прошедший разбор целиком: негодное значение
 * (`track` не слагом, перевод строки в поле) отвергается до записи, а не
 * оставляет файл, который следующее же чтение очереди не разберёт.
 *
 * Пустое значение необязательного поля убирает само поле; пустое значение
 * обязательного — отказ: пункт без `title` не разбирается.
 */
const handleEdit: ApiHandler = async (req, res, env) => {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 413, { error: 'Тело запроса слишком велико' });
    return;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(body === '' ? '{}' : body) as unknown;
  } catch {
    sendJson(res, 400, { error: 'Тело запроса не разбирается как JSON' });
    return;
  }

  const parsed = EditBodySchema.safeParse(raw);
  if (!parsed.success) {
    sendJson(res, 400, {
      error: `Тело запроса не соответствует формату: ${parsed.error.issues[0]?.message ?? 'project, slug и fields'}`,
    });
    return;
  }

  const { project: projectKey, slug, fields } = parsed.data;

  const project = listProjects(env.runsRoot).find((entry) => entry.key === projectKey);
  if (project?.path === undefined) {
    sendJson(res, 400, { error: `Проект ${projectKey} неизвестен указателю projects.json` });
    return;
  }

  const set: Record<string, string> = {};
  const remove: string[] = [];
  for (const name of [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]) {
    const value = fields[name];
    if (value === undefined) continue;
    const trimmed = value.trim();
    if (trimmed !== '') {
      set[name] = trimmed;
      continue;
    }
    if ((REQUIRED_FIELDS as readonly string[]).includes(name)) {
      sendJson(res, 400, { error: `Поле «${name}» обязательно и не может быть пустым` });
      return;
    }
    remove.push(name);
  }

  if (Object.keys(set).length === 0 && remove.length === 0) {
    sendJson(res, 400, { error: 'Не названо ни одного поля к правке' });
    return;
  }

  const tasksFile = join(project.path, TASKS_FILE);
  const archiveFile = join(project.path, ARCHIVE_FILE);

  try {
    const tasksText = readOrEmpty(tasksFile);
    const file = holdsSlug(tasksFile, tasksText, slug) ? tasksFile : archiveFile;
    const text = file === tasksFile ? tasksText : readOrEmpty(archiveFile);
    if (!holdsSlug(file, text, slug)) {
      sendJson(res, 404, { error: `Пункт ${slug} не найден ни в ${TASKS_FILE}, ни в ${ARCHIVE_FILE}` });
      return;
    }

    const edited = withoutFields(withFields(text, slug, set), slug, remove);
    // Разбор всего файла заново — проверка перед записью: схема ловит и
    // негодный `track`, и `repos`, который она разбирает в перечень.
    parseBacklogFile(file, edited);
    writeBacklogFile(file, edited);
  } catch (error) {
    if (isStepcastError(error)) {
      sendJson(res, 400, { error: error.message, ...(error.at === undefined ? {} : { at: error.at }) });
      return;
    }
    sendJson(res, 500, { error: `Не удалось записать пункт: ${(error as Error).message}` });
    return;
  }

  sendJson(res, 200, { ok: true });
};

export const row = screenRow(declaration.id, ['screens', 'api'], (ctx) => {
  ctx.screens.register(declaration);
  ctx.api.register('POST', '/api/backlog/move', handleMove);
  ctx.api.register('POST', '/api/backlog/item', handleEdit);
});
