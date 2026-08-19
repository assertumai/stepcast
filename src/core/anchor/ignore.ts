import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Правила игнорирования для дерева вне git.
 *
 * В репозитории исключения берёт на себя сам git — `add -A` уважает
 * `.gitignore` целиком, включая вложенные файлы и отрицания. Здесь нужен
 * разбор только для деревьев вне репозитория, где git недоступен, и потому
 * поддерживается сознательно узкое подмножество: комментарии, пустые строки,
 * привязка к корню, каталоги, `*` и `?`.
 *
 * Отрицания (`!`) и вложенные `.gitignore` не поддерживаются: вне git они
 * встречаются редко, а неверно понятое отрицание молча меняло бы состав
 * отпечатка. Неподдержанное правило пропускается, а не толкуется наугад.
 */
export interface IgnoreRules {
  ignores(relativePath: string, isDirectory: boolean): boolean;
}

interface Rule {
  readonly regex: RegExp;
  readonly directoryOnly: boolean;
  readonly anchored: boolean;
}

const ALWAYS_IGNORED = new Set(['.git']);

function toRegex(pattern: string): RegExp {
  let source = '';
  for (const char of pattern) {
    if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

function parse(content: string): Rule[] {
  const rules: Rule[] = [];

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    // Отрицания не поддерживаются: см. комментарий к модулю.
    if (line.startsWith('!')) continue;

    const directoryOnly = line.endsWith('/');
    const body = directoryOnly ? line.slice(0, -1) : line;
    const anchored = body.includes('/');
    const normalized = body.startsWith('/') ? body.slice(1) : body;

    rules.push({ regex: toRegex(normalized), directoryOnly, anchored });
  }

  return rules;
}

/** Прочитать правила из корневого `.gitignore`, если он есть. */
export function loadIgnoreRules(root: string): IgnoreRules {
  const path = join(root, '.gitignore');
  const rules = existsSync(path) ? parse(readFileSync(path, 'utf8')) : [];

  return {
    ignores(relativePath: string, isDirectory: boolean): boolean {
      const segments = relativePath.split('/');
      if (segments.some((segment) => ALWAYS_IGNORED.has(segment))) return true;

      for (const rule of rules) {
        if (rule.directoryOnly && !isDirectory) continue;

        if (rule.anchored) {
          if (rule.regex.test(relativePath)) return true;
          continue;
        }
        // Непривязанное правило совпадает с любым сегментом пути — так же, как
        // это делает git.
        if (segments.some((segment) => rule.regex.test(segment))) return true;
      }

      return false;
    },
  };
}
