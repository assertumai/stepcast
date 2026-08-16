/**
 * Сопоставление путей с глобами. Нужно там, где сопоставляется строка, а не
 * содержимое каталога: запреты `context.deny` и исключения `context_exclude`.
 */

export function globToRegExp(pattern: string): RegExp {
  let source = '';

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] as string;

    if (char === '*') {
      const isDouble = pattern[index + 1] === '*';
      if (isDouble) {
        const followedBySlash = pattern[index + 2] === '/';
        // `**/` покрывает и ноль сегментов: шаблон `**/*.pem` должен ловить
        // `key.pem` в корне так же, как `certs/key.pem`.
        source += followedBySlash ? '(?:.*/)?' : '.*';
        index += followedBySlash ? 2 : 1;
        continue;
      }
      source += '[^/]*';
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      continue;
    }

    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }

  return new RegExp(`^${source}$`);
}

export function matchesGlob(path: string, pattern: string): boolean {
  return globToRegExp(pattern).test(normalize(path));
}

export function matchesAnyGlob(path: string, patterns: readonly string[]): string | undefined {
  const normalized = normalize(path);
  return patterns.find((pattern) => globToRegExp(pattern).test(normalized));
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}
