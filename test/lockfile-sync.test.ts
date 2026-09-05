import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * `npm install` чинит расхождение между `package.json` и `package-lock.json`
 * молча, а `npm ci` — которым дорожки петли поднимаются в чистом рабочем
 * дереве — на этом расхождении отказывает ещё до первого шага. Тест
 * воспроизводит ту же сверку, что `npm ci` делает перед установкой, чтобы
 * дрейф был виден в `npm run check`, а не только в случайном `npm ci`.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as Record<string, unknown>;
}

describe('package-lock.json синхронен с package.json', () => {
  it('диапазоны версий совпадают для dependencies, devDependencies и optionalDependencies', () => {
    const manifest = readJson('package.json');
    const lock = readJson('package-lock.json');

    const packages = lock.packages as Record<string, Record<string, unknown>> | undefined;
    assert.ok(packages, 'package-lock.json не содержит поля "packages"');
    const root = packages[''];
    assert.ok(root, 'package-lock.json не содержит корневую запись packages[""]');

    const mismatches: string[] = [];
    for (const field of DEPENDENCY_FIELDS) {
      const manifestRanges = (manifest[field] ?? {}) as Record<string, string>;
      const lockRanges = (root[field] ?? {}) as Record<string, string>;
      for (const [name, manifestRange] of Object.entries(manifestRanges)) {
        const lockRange = lockRanges[name];
        if (lockRange !== manifestRange) {
          mismatches.push(
            `${field}.${name}: package.json просит "${manifestRange}", package-lock.json — "${lockRange ?? '<отсутствует>'}"`,
          );
        }
      }
    }

    assert.deepEqual(mismatches, [], `package-lock.json разошёлся с package.json:\n${mismatches.join('\n')}`);
  });
});
