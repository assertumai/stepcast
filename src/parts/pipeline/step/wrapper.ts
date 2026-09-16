import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { input, output } from './index.js';

/**
 * Обёртка раннера `stepcast:step` (design.md, решение 8; `runners.<имя>.wrapper`
 * `node`/`node-ts`). Встаёт в argv между командой раннера и путём скрипта:
 * `node <обёртка> <скрипт> <args...>`.
 *
 * Делает ровно четыре вещи: чинит `process.argv`, чтобы скрипт увидел себя на
 * своём обычном месте; импортирует модуль, чем исполняет его тело; найдя
 * default export-функцию, зовёт её входом шага и пишет возвращённое значение;
 * упавшее — модуль или функцию — превращает в ненулевой код и сообщение в
 * `stderr`.
 *
 * В Node нет способа импортировать модуль, не исполнив его тело: значит
 * модуль без default export уже отработал как обычный скрипт к тому моменту,
 * когда обёртка проверяет `mod.default`, — и обёртке дальше делать нечего.
 *
 * Что считать точкой входа, зависит от формата модуля (`moduleFormat`): у ESM
 * это объявленный default export, у CommonJS — `module.exports`, оказавшийся
 * функцией.
 */

function describeError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

/**
 * Формат модуля — тем же правилом, каким его выбирает сам Node: расширение,
 * а для `.js` и `.ts` — поле `type` ближайшего вверх по дереву `package.json`.
 *
 * Различать формат обязательно: у модуля CommonJS Node кладёт в `default`
 * значение `module.exports`, и у скрипта, ничего не экспортирующего, это
 * пустой объект `{}`, а не `undefined`. Принять его за «объявлена точка входа,
 * но не функцией» значило бы отказать обычному скрипту на `.js` или `.cjs` —
 * тому самому, который до обёртки работал.
 */
function moduleFormat(scriptPath: string): 'module' | 'commonjs' {
  const extension = extname(scriptPath).toLowerCase();
  if (extension === '.mjs' || extension === '.mts') return 'module';
  if (extension === '.cjs' || extension === '.cts') return 'commonjs';

  let dir = dirname(resolve(scriptPath));
  for (;;) {
    const manifest = resolve(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { readonly type?: unknown };
        return parsed.type === 'module' ? 'module' : 'commonjs';
      } catch {
        // Нечитаемый манифест — не повод падать обёртке: Node на таком
        // остановится сам, своим сообщением, при импорте.
        return 'commonjs';
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return 'commonjs';
    dir = parent;
  }
}

async function main(): Promise<void> {
  const [, , scriptPath, ...args] = process.argv;
  if (scriptPath === undefined) {
    console.error('Обёртка stepcast:step запущена без пути скрипта');
    process.exitCode = 1;
    return;
  }

  // Починка до импорта: тело модуля читает `process.argv` уже на обычном
  // месте — так же, как увидело бы его без обёртки (design.md, решение 8).
  process.argv = [process.argv[0] as string, scriptPath, ...args];

  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(scriptPath).href)) as Record<string, unknown>;
  } catch (error) {
    console.error(describeError(error));
    process.exitCode = 1;
    return;
  }

  const entry = mod.default;
  if (moduleFormat(scriptPath) === 'commonjs') {
    // У CommonJS точка входа выражается ровно одним способом —
    // `module.exports = функция`. Всё прочее содержимое `module.exports`,
    // пустой объект в том числе, — обычный скрипт, уже отработавший при
    // импорте: отличить «ничего не экспортировал» от «объявил точку входа
    // объектом» в этом формате нечем, и молчать здесь вернее, чем отказывать.
    if (typeof entry !== 'function') return;
  } else if (!('default' in mod)) {
    // Default export отсутствует — модуль уже исполнился как обычный скрипт:
    // большего с ним не происходит.
    return;
  } else if (typeof entry !== 'function') {
    console.error(
      'Default export модуля не функция: обёртка stepcast:step умеет звать только функцию входа',
    );
    process.exitCode = 1;
    return;
  }

  try {
    const result: unknown = await (entry as (stepInput: unknown) => unknown)(input());
    if (result !== undefined) output(result);
  } catch (error) {
    console.error(describeError(error));
    process.exitCode = 1;
  }
}

await main();
