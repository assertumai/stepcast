import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { Anchor } from './types.js';

/**
 * Отпечаток входов шага — то, что отвечает на вопрос «остался ли прошлый
 * успех шага действительным».
 *
 * Правило трёхуровневое, с явным приоритетом:
 *
 * 1. Объявленные входы работы, если автор их указал. Самый узкий вариант, под
 *    его ответственность: пропущенный файл означает пропущенную инвалидацию.
 * 2. Наблюдённые входы — файлы, которые шаг фактически читал в прошлом
 *    успешном исполнении. От пользователя не требуется ничего.
 * 3. Всё рабочее дерево. Умолчание.
 *
 * Асимметрия наблюдённых входов существенна: они сужают инвалидацию на
 * *следующем* прогоне, а не на текущем. На текущем перечень ещё неизвестен —
 * он получается из потока вызовов инструментов по ходу шага, а ключ нужен до
 * запуска.
 *
 * Режим отказа выбран грубым сознательно: при любом сомнении отпечаток
 * расширяется до всего дерева. Лишнее переисполнение стоит денег, тихо
 * устаревший результат стоит доверия ко всему инструменту.
 */
export type InputsOrigin = 'declared' | 'observed' | 'tree';

export interface InputsFingerprint {
  readonly value: string;
  readonly origin: InputsOrigin;
}

/** Устойчивый хеш по перечню путей: отсутствующий файл участвует явно. */
function hashPaths(dir: string, paths: readonly string[]): string {
  const hash = createHash('sha256');

  for (const relative of [...paths].sort()) {
    const full = join(dir, relative);
    hash.update(relative);
    hash.update('\0');

    if (!existsSync(full)) {
      // Отсутствие — тоже состояние: удаление файла обязано менять отпечаток.
      hash.update('отсутствует');
    } else if (statSync(full).isDirectory()) {
      hash.update('каталог');
    } else {
      hash.update(createHash('sha256').update(readFileSync(full)).digest('hex'));
    }
    hash.update('\n');
  }

  return hash.digest('hex').slice(0, 40);
}

export interface FingerprintOptions {
  readonly dir: string;
  /** Якорь дерева на начало шага: умолчание и запасной вариант. */
  readonly treeAnchor: Anchor | undefined;
  /** Объявленные входы работы, если они есть. */
  readonly declared?: readonly string[] | undefined;
  /** Наблюдённые входы прошлого успешного исполнения этого шага. */
  readonly observed?: readonly string[] | undefined;
}

export function fingerprintInputs(options: FingerprintOptions): InputsFingerprint | undefined {
  const { dir, declared, observed, treeAnchor } = options;

  if (declared !== undefined && declared.length > 0) {
    return { value: hashPaths(dir, declared), origin: 'declared' };
  }

  if (observed !== undefined && observed.length > 0) {
    return { value: hashPaths(dir, observed), origin: 'observed' };
  }

  // Якоря нет — значит, отпечаток неизвестен. Пустое значение здесь было бы
  // хуже отсутствия: оно означало бы «ничего не изменилось».
  if (treeAnchor === undefined) return undefined;

  return { value: treeAnchor.id, origin: 'tree' };
}

/** Человекочитаемое происхождение отпечатка для объяснения инвалидации. */
export function describeOrigin(origin: InputsOrigin): string {
  switch (origin) {
    case 'declared':
      return 'по объявленным входам работы';
    case 'observed':
      return 'по файлам, прочитанным шагом в прошлом прогоне';
    case 'tree':
      return 'по всему рабочему дереву';
  }
}
