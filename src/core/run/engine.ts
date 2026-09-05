import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StepcastError } from '../errors.js';
import { findPackageRoot } from '../package-schema.js';
import { realOrLiteral } from './preflight.js';

/**
 * Движок прогона, тот же код, который петля саморазвития правит сама у себя
 * (merge-check-rebuilds-engine): распознавание установки внутри правимого
 * дерева и снятие снимка, чтобы пересборка `dist/` посреди прогона не
 * подменяла код, которым прогон уже исполняется.
 */

export interface EngineLocation {
  readonly root: string;
  readonly entry: string;
}

/** Каталоги, которых нет в установленной форме пакета и не место в снимке. */
const EXCLUDED_FROM_WHOLE_COPY = new Set(['node_modules', '.git']);

/** Расположение этого модуля: и в исходниках, и в `dist/` — внутри пакета движка. */
const HERE = fileURLToPath(new URL('.', import.meta.url));

/** То, что пакет движка объявляет о себе сам; всё прочее нас не касается. */
interface EnginePackage {
  readonly name?: string;
  readonly bin?: string | Readonly<Record<string, string>>;
  readonly files?: readonly string[];
  readonly dependencies?: Readonly<Record<string, string>>;
}

function readEnginePackage(engineRoot: string): EnginePackage {
  const path = join(engineRoot, 'package.json');
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as EnginePackage;
  } catch (error) {
    throw new StepcastError(`Не удалось прочитать package.json движка: ${(error as Error).message}`, {
      file: path,
      cause: error,
    });
  }
}

/**
 * Точка входа пакета — то, что он объявляет в `bin`: именно её зовут шаги
 * через `$STEPCAST_BIN`. `process.argv[1]` называет запущенный файл процесса,
 * а это не одно и то же: движок, поднятый библиотекой или обёрткой, идёт с
 * `argv[1]` вызывающего. Он остаётся запасным ответом на случай пакета без
 * `bin` или с несобранной точкой входа — прежнее приближение лучше пустоты.
 */
function entryOf(engineRoot: string, declared: EnginePackage): string {
  const bin = declared.bin;
  const named =
    typeof bin === 'string'
      ? bin
      : bin === undefined
        ? undefined
        : ((declared.name === undefined ? undefined : bin[declared.name]) ?? Object.values(bin)[0]);

  if (named !== undefined) {
    const path = resolve(engineRoot, named);
    if (existsSync(path)) return realpathSync(path);
  }

  return process.argv[1] === undefined ? '' : realOrLiteral(process.argv[1]);
}

/**
 * Корень пакета исполняющего движка и его точка входа, оба через `realpath`.
 *
 * Корень ищется подъёмом от расположения этого модуля до ближайшего
 * `package.json` — тем же приёмом, что `findPackageRoot(HERE)` в
 * `package-schema.ts`. Не от `process.argv[1]`: тот называет запущенный файл
 * процесса, и у движка, поднятого библиотекой или обёрткой, привёл бы к
 * пакету вызывающего — снимок сняли бы с чужого пакета и объявили движком.
 * Разрешение ссылок обязательно: путь установки может вести в рабочее дерево
 * цепочкой ссылок (`/opt/homebrew/bin/stepcast` → `lib/node_modules/stepcast`
 * → дерево), и без `realpath` эта цепочка выглядела бы установкой в `/opt`.
 */
export function locateEngine(): EngineLocation {
  const root = realpathSync(findPackageRoot(HERE));
  return { root, entry: entryOf(root, readEnginePackage(root)) };
}

/**
 * Движок правим, когда его корень лежит внутри рабочего дерева проекта и ни
 * один сегмент пути от корня дерева до него не равен `node_modules` — иначе
 * это чужой установленный пакет (`<project>/node_modules/stepcast`), а не
 * исходники, которые прогон вправе переписать.
 */
export function isEditableEngine(options: {
  readonly engineRoot: string;
  readonly projectRoot: string;
}): boolean {
  const root = realOrLiteral(options.engineRoot);
  const tree = realOrLiteral(options.projectRoot);
  if (root === tree) return true;
  if (!root.startsWith(`${tree}${sep}`)) return false;

  const relativeToTree = root.slice(tree.length + 1);
  return !relativeToTree.split(sep).includes('node_modules');
}

/** Запись `files`, которую можно скопировать как путь: не шаблон и не отрицание. */
function isPlainPath(name: string): boolean {
  return !name.startsWith('!') && !/[*?[\]{}]/.test(name);
}

/**
 * Скопировать пакет движка в каталог снимка по его собственному объявлению:
 * `package.json` плюс всё, что он называет в `files`; без `files` — весь
 * корень пакета, минус `node_modules` и `.git`. Другого источника знания о
 * составе установленной формы пакета нет: то, чего нет в `files`, не доезжает
 * и до `npm install`.
 *
 * Формат `files` шире копирования путей: npm допускает шаблоны (`dist/*.js`),
 * отрицания (`!dist/test`) и записи, которых на диске нет, — последние он
 * молча пропускает. Пропускаем и мы; на шаблоне или отрицании копируется весь
 * корень пакета. Это заведомо больше объявленного, но снимку важно ничего не
 * потерять, а лишний вес в каталоге прогона беды не делает — тогда как отказ
 * на законном `package.json` не дал бы такому движку запустить ни одного
 * прогона в собственном дереве.
 */
function copyPackageFiles(engineRoot: string, snapshotDir: string, declared: EnginePackage): void {
  const listed = declared.files;
  const byPath = listed !== undefined && listed.every(isPlainPath);

  try {
    cpSync(join(engineRoot, 'package.json'), join(snapshotDir, 'package.json'));
    if (!byPath) {
      cpSync(engineRoot, snapshotDir, {
        recursive: true,
        filter: (source) => !EXCLUDED_FROM_WHOLE_COPY.has(basename(source)),
      });
      return;
    }
    for (const name of listed as readonly string[]) {
      const source = join(engineRoot, name);
      if (!existsSync(source)) continue;
      cpSync(source, join(snapshotDir, name), { recursive: true });
    }
  } catch (error) {
    throw new StepcastError(`Не удалось скопировать пакет движка в снимок: ${(error as Error).message}`, {
      file: snapshotDir,
      cause: error,
    });
  }
}

/**
 * Символическая ссылка снимка на `node_modules` исходного пакета: копировать
 * сотни мегабайт зависимостей ради защиты от пересборки `dist/` было бы
 * несоразмерно, а разрешение модулей в Node идёт вверх от расположения файла —
 * ссылка отдаёт снимку те же зависимости, что были у исходного пакета.
 *
 * Разрешимость проверяется здесь, а не оставляется первому вызову
 * `$STEPCAST_BIN`: висячая ссылка создаётся на POSIX без единого отказа, а в
 * монорепозитории с движком внутри зависимости подняты в корень репозитория —
 * подъём от снимка, лежащего в каталоге прогона, до этого корня не доходит
 * никогда. Половинчатый снимок и `ERR_MODULE_NOT_FOUND` посреди прогона хуже
 * внятного отказа на старте.
 */
function linkNodeModules(engineRoot: string, snapshotDir: string, declared: EnginePackage): void {
  const target = join(engineRoot, 'node_modules');
  const dependencies = Object.keys(declared.dependencies ?? {});
  const present = existsSync(target) && statSync(target).isDirectory();

  if (!present) {
    // Пакету без зависимостей разрешать нечего — ссылка была бы висячей.
    if (dependencies.length === 0) return;
    throw new StepcastError(
      `Зависимости движка не разрешаются из снимка: каталог ${target} отсутствует, а package.json объявляет ${dependencies.join(', ')}`,
      {
        file: target,
        hint: 'Так выглядит движок в монорепозитории с поднятыми в корень зависимостями: снимок в каталоге прогона до них не дотянется',
      },
    );
  }

  const missing = dependencies.filter((name) => !existsSync(join(target, ...name.split('/'))));
  if (missing.length > 0) {
    throw new StepcastError(
      `Зависимости движка не разрешаются из снимка: ${missing.join(', ')} нет в ${target}`,
      {
        file: target,
        hint: 'Зависимости подняты выше корня пакета движка; снимок делит node_modules только с самим пакетом',
      },
    );
  }

  const link = join(snapshotDir, 'node_modules');
  try {
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    throw new StepcastError(`Не удалось создать ссылку node_modules в снимке движка: ${(error as Error).message}`, {
      file: link,
      cause: error,
    });
  }
}

/** Место точки входа внутри снимка; точка входа вне пакета снимку не по адресу. */
function snapshotEntry(engine: EngineLocation, snapshotDir: string): string {
  const inside = relative(engine.root, engine.entry);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new StepcastError(`Точка входа движка ${engine.entry} лежит вне его пакета ${engine.root}`, {
      file: engine.entry,
      hint: 'Снимок копирует пакет целиком: точка входа обязана лежать внутри его корня',
    });
  }
  return join(snapshotDir, inside);
}

/**
 * Снять снимок правимого движка в каталог прогона и вернуть точку входа
 * снимка. Отказ копирования или создания ссылки поднимается `StepcastError`
 * и не проглатывается: молчаливое исполнение незафиксированным движком — то
 * самое поведение, против которого снимок и заводится.
 */
export function pinEngine(options: {
  readonly engine: EngineLocation;
  readonly snapshotDir: string;
}): string {
  const declared = readEnginePackage(options.engine.root);
  const pinnedEntry = snapshotEntry(options.engine, options.snapshotDir);

  try {
    mkdirSync(options.snapshotDir, { recursive: true });
  } catch (error) {
    throw new StepcastError(`Не удалось создать каталог снимка движка: ${(error as Error).message}`, {
      file: options.snapshotDir,
      cause: error,
    });
  }

  copyPackageFiles(options.engine.root, options.snapshotDir, declared);
  linkNodeModules(options.engine.root, options.snapshotDir, declared);

  // Точка входа могла не попасть под объявленный `files`: npm кладёт файлы из
  // `bin` в пакет независимо от `files`, так что `files: ["lib"]` при
  // `bin: "./cli.js"` — законное объявление. Без этой проверки снимок снялся
  // бы «успешно», а `STEPCAST_BIN` всех шагов вёл бы в никуда.
  if (!existsSync(pinnedEntry)) {
    throw new StepcastError(`Точка входа движка не попала в снимок: ${pinnedEntry} не создан`, {
      file: pinnedEntry,
      hint: 'Поле files в package.json движка не покрывает точку входа — добавьте её в files',
    });
  }

  return pinnedEntry;
}

/** Движок, которым прогон исполняется: пишется в манифест у всякого прогона. */
export interface EngineInfo {
  readonly root: string;
  readonly entry: string;
  readonly pinned: boolean;
}
