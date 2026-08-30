import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { resolveConfig } from '../src/core/config/resolve.js';
import { resolveItemRepo } from '../src/core/project/repos.js';
import { StepcastError } from '../src/core/errors.js';

/**
 * `resolveItemRepo` — единственное место склейки путей и единственное место
 * отказов вокруг имени репозитория (design.md, решения 2, 4, 5). Конфигурация
 * собирается настоящим `resolveConfig` по временным файлам — так же, как в
 * `test/config.test.ts`, — а не собранным вручную объектом `Config`: иначе
 * тест доказывал бы только то, что вручную собранный объект похож на
 * настоящий, а не то, что модуль работает с тем, что даёт движок.
 */

function config(projectYaml: string) {
  const root = mkdtempSync(join(tmpdir(), 'stepcast-project-repos-'));
  const home = join(root, 'home');
  const cwd = join(root, 'project');
  mkdirSync(join(home, '.stepcast'), { recursive: true });
  mkdirSync(join(cwd, '.stepcast'), { recursive: true });
  writeFileSync(join(cwd, '.stepcast', 'config.yml'), projectYaml);

  return resolveConfig({ cwd, home, globalPath: join(home, '.stepcast', 'config.yml') }).config;
}

const ROOT_ONLY = 'project:\n  check: npm run check\n  spec:\n    dir: openspec/changes\n    rules: openspec/rules.md\n    tool: openspec\n';

const WITH_BACKEND =
  'project:\n  check: npm run check\n  spec:\n    dir: openspec/changes\n    rules: openspec/rules.md\n    tool: openspec\n' +
  '  nested_repos:\n    - dir: backend\n      check: "./gradlew check"\n      spec:\n        dir: docs/changes\n        rules: docs/spec-rules.md\n        tool: openspec\n';

describe('project/repos: resolveItemRepo', () => {
  it('пункт без поля repos разрешается в объявление корня без приставки к путям', () => {
    const resolved = resolveItemRepo(config(ROOT_ONLY), { slug: 'an-item', repos: [] });
    assert.deepEqual(resolved, {
      dir: '.',
      check: 'npm run check',
      spec: { dir: 'openspec/changes', rules: 'openspec/rules.md', tool: 'openspec' },
    });
  });

  it('пункт называет "." явно — тот же ответ, что и без поля', () => {
    const withoutField = resolveItemRepo(config(ROOT_ONLY), { slug: 'a', repos: [] });
    const explicitRoot = resolveItemRepo(config(ROOT_ONLY), { slug: 'a', repos: ['.'] });
    assert.deepEqual(explicitRoot, withoutField);
  });

  it('пункт называет объявленный вложенный репозиторий: каталог и пути склеены от корня', () => {
    const resolved = resolveItemRepo(config(WITH_BACKEND), { slug: 'an-item', repos: ['backend'] });
    assert.deepEqual(resolved, {
      dir: 'backend',
      check: './gradlew check',
      spec: { dir: 'backend/docs/changes', rules: 'backend/docs/spec-rules.md', tool: 'openspec' },
    });
  });

  it('неизвестное имя отказывает, называя пункт, имя и перечень объявленных каталогов', () => {
    assert.throws(
      () => resolveItemRepo(config(WITH_BACKEND), { slug: 'an-item', repos: ['no-such'] }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /an-item/);
        assert.match(error.message, /no-such/);
        assert.match(error.message, /backend/);
        return true;
      },
    );
  });

  it('неизвестное имя без объявленного состава называет пустой перечень, а не молчит', () => {
    assert.throws(
      () => resolveItemRepo(config(ROOT_ONLY), { slug: 'an-item', repos: ['backend'] }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /an-item/);
        assert.match(error.message, /backend/);
        return true;
      },
    );
  });

  it('два репозитория у пункта отказывают, называя пункт и то, что дорожка ведёт один репозиторий', () => {
    assert.throws(
      () => resolveItemRepo(config(WITH_BACKEND), { slug: 'an-item', repos: ['.', 'backend'] }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /an-item/);
        assert.match(error.message, /один репозиторий/);
        return true;
      },
    );
  });

  it('корень без объявленного check отказывает, называя пункт, недостающий ключ и файл конфигурации', () => {
    const noCheck = 'project:\n  spec:\n    dir: openspec/changes\n    rules: openspec/rules.md\n    tool: openspec\n';
    assert.throws(
      () => resolveItemRepo(config(noCheck), { slug: 'an-item', repos: [] }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /an-item/);
        assert.match(error.message, /корень/);
        assert.match(error.message, /check/);
        assert.match(error.hint ?? '', /\.stepcast\/config\.yml/);
        return true;
      },
    );
  });

  it('вложенный репозиторий, объявленный только строкой (без check/spec), отказывает недостающим ключом', () => {
    const stringForm = ROOT_ONLY + '  nested_repos: [backend]\n';
    assert.throws(
      () => resolveItemRepo(config(stringForm), { slug: 'an-item', repos: ['backend'] }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /an-item/);
        assert.match(error.message, /backend/);
        assert.match(error.message, /check/);
        assert.match(error.hint ?? '', /\.stepcast\/config\.yml/);
        return true;
      },
    );
  });

  it('вложенный репозиторий с check, но без spec.tool отказывает этим ключом', () => {
    const incomplete =
      ROOT_ONLY +
      '  nested_repos:\n    - dir: backend\n      check: "./gradlew check"\n      spec:\n        dir: docs/changes\n        rules: docs/spec-rules.md\n';
    assert.throws(
      () => resolveItemRepo(config(incomplete), { slug: 'an-item', repos: ['backend'] }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /an-item/);
        assert.match(error.message, /backend/);
        assert.match(error.message, /spec\.tool/);
        return true;
      },
    );
  });

  /**
   * Заполнены обе дорожки, репозитории у них разные, и неполно объявлен тот,
   * что достался второй, — по отказу обязано быть видно, чей пункт остановил
   * заход, а не только какой репозиторий недообъявлен (иначе человеку не
   * найти дорожку, которую правит).
   */
  it('отказ несёт слаг именно того пункта, чей репозиторий недообъявлен', () => {
    const twoRepos =
      ROOT_ONLY +
      '  nested_repos:\n    - dir: backend\n      check: "./gradlew check"\n      spec:\n        dir: docs/changes\n        rules: docs/spec-rules.md\n        tool: openspec\n    - dir: mobile\n';
    const resolved = config(twoRepos);

    assert.doesNotThrow(() => resolveItemRepo(resolved, { slug: 'lane-a-item', repos: ['backend'] }));
    assert.throws(
      () => resolveItemRepo(resolved, { slug: 'lane-b-item', repos: ['mobile'] }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /lane-b-item/);
        assert.doesNotMatch(error.message, /lane-a-item/);
        assert.equal(error.at, 'lane-b-item');
        return true;
      },
    );
  });

  it('check остаётся строкой и не разбирается на части', () => {
    const resolved = resolveItemRepo(config(WITH_BACKEND), { slug: 'an-item', repos: ['backend'] });
    assert.equal(typeof resolved.check, 'string');
    assert.equal(resolved.check, './gradlew check');
  });
});
