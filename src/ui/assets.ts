import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Страница витрины.
 *
 * Собирается Vite в один самодостаточный файл со встроенными скриптами и
 * стилями. Отсюда и единственный артефакт: демон отдаёт одну страницу и не
 * становится файловым сервером с разбором MIME и защитой от обхода путей —
 * то самое свойство, ради которого прежняя витрина держалась строковой
 * константой в этом файле.
 *
 * Читается с диска при первом запросе и остаётся в памяти: страница неизменна
 * в пределах запуска демона, а перечитывать её на каждое обращение — платить
 * за неизменное.
 */

/** Собранная витрина рядом с скомпилированным кодом: `dist/ui-web/index.html`. */
export function dashboardPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui-web', 'index.html');
}

let cached: string | undefined;

/**
 * Разметка витрины. `undefined` — витрина не собрана: единственный внятный
 * ответ на это — сказать, какой командой её собрать, а не отдать пустую
 * страницу и оставить пользователя гадать.
 */
export function dashboardHtml(): string | undefined {
  if (cached !== undefined) return cached;
  try {
    cached = readFileSync(dashboardPath(), 'utf8');
  } catch {
    return undefined;
  }
  return cached;
}
