import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { resolveConfig, type ResolvedConfig } from '../src/core/config/resolve.js';
import { StepcastError } from '../src/core/errors.js';
import { availableNames, contributionOwner } from '../src/core/plugins/registry.js';
import { loadPlugins } from '../src/core/plugins/load.js';
import { tempDir } from './tmp.js';

interface Bed {
  readonly root: string;
  readonly home: string;
  readonly globalPath: string;
  readonly projectPath: string;
  readonly homePatchPath: string;
  readonly projectPatchPath: string;
}

function bed(): Bed {
  const base = tempDir('plugin-tree-');
  const root = join(base, 'work');
  const home = join(base, 'home');
  mkdirSync(join(root, '.stepcast'), { recursive: true });
  mkdirSync(join(home, '.stepcast'), { recursive: true });
  return {
    root,
    home,
    globalPath: join(home, '.stepcast', 'config.yml'),
    projectPath: join(root, '.stepcast', 'config.yml'),
    homePatchPath: join(home, '.stepcast', 'plugins.patch.yml'),
    projectPatchPath: join(root, '.stepcast', 'plugins.patch.yml'),
  };
}

interface Files {
  readonly global?: string;
  readonly project?: string;
  readonly homePatch?: string;
  readonly projectPatch?: string;
}

function resolved(place: Bed, files: Files = {}, builtinRows?: readonly string[]): ResolvedConfig {
  if (files.global !== undefined) writeFileSync(place.globalPath, files.global);
  if (files.project !== undefined) writeFileSync(place.projectPath, files.project);
  if (files.homePatch !== undefined) writeFileSync(place.homePatchPath, files.homePatch);
  if (files.projectPatch !== undefined) writeFileSync(place.projectPatchPath, files.projectPatch);
  return resolveConfig({
    cwd: place.root,
    home: place.home,
    globalPath: place.globalPath,
    projectPath: place.projectPath,
    ...(builtinRows === undefined ? {} : { builtinRows }),
  });
}

/** Модуль плагина на диске: загружается настоящим `import()`. */
function writeModule(path: string, body: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
}

const REPLACEMENT_CLAUDE = `
export default {
  name: 'user-claude',
  backends: { claude: { create: () => ({ name: 'claude', from: 'user' }) } },
};
`;

describe('plugin-tree: свёртка трёх слоёв', () => {
  it('встроенная строка, домашний патч и проектный патч дают дерево ожидаемого состава и порядка', () => {
    const place = bed();
    const config = resolved(place, {
      homePatch: 'version: 1\nkind: plugins-patch\nplugins:\n  - id: home-extra\n    use: ./home-extra.mjs\n',
      projectPatch:
        'version: 1\nkind: plugins-patch\nplugins:\n  - id: project-extra\n    use: ./project-extra.mjs\n    after: home-extra\n',
    });

    assert.deepEqual(
      config.pluginTree.map((row) => [row.id, row.use, row.enabled]),
      [
        ['backend-claude', 'stepcast:backend-claude', true],
        ['home-extra', './home-extra.mjs', true],
        ['project-extra', './project-extra.mjs', true],
      ],
    );
    assert.deepEqual(config.pluginTree[0]?.source, { kind: 'builtin' });
    assert.deepEqual(config.pluginTree[1]?.source, { kind: 'file', path: place.homePatchPath });
    assert.deepEqual(config.pluginTree[2]?.source, { kind: 'file', path: place.projectPatchPath });
  });

  it('конфигурация без единого plugins.patch.yml сворачивается в прежний состав и порядок', () => {
    const place = bed();
    writeModule(join(place.home, '.stepcast', 'g.mjs'), 'export default { name: "g", predicates: [] };\n');
    writeModule(join(place.root, '.stepcast', 'p.mjs'), 'export default { name: "p", predicates: [] };\n');
    const config = resolved(place, {
      global: 'plugins: ["./g.mjs"]\n',
      project: 'plugins: ["./p.mjs"]\n',
    });

    assert.deepEqual(config.pluginTree.map((row) => row.id), ['backend-claude', './g.mjs', './p.mjs']);
    // `Config.plugins` — модули, и только они: `stepcast:backend-claude`
    // модулем не является и `resolveModulePath` не разрешается, поэтому в
    // публичную форму поля не попадает (`config/resolve.ts`).
    assert.deepEqual(config.config.plugins, ['./g.mjs', './p.mjs']);
  });

  it('projectPath: null собирает дерево из встроенного и домашнего патча, без проектного слоя', () => {
    const place = bed();
    writeFileSync(place.homePatchPath, 'version: 1\nkind: plugins-patch\nplugins:\n  - id: home-only\n    use: ./home-only.mjs\n');
    // Проектный слой не читается вовсе: даже patch рядом с ним не подхватится.
    writeFileSync(place.projectPatchPath, 'version: 1\nkind: plugins-patch\nplugins:\n  - id: project-only\n    use: ./project-only.mjs\n');

    const config = resolveConfig({ cwd: place.root, home: place.home, projectPath: null });

    assert.deepEqual(config.pluginTree.map((row) => row.id), ['backend-claude', 'home-only']);
  });
});

describe('plugin-tree: строки поставки вызывающего', () => {
  it('id строк поставки встают во встроенный слой рядом со строками движка, и патчи правят их наравне', () => {
    const place = bed();
    const config = resolved(
      place,
      {
        homePatch: 'version: 1\nkind: plugins-patch\nplugins:\n  - id: screen-usage\n    use: ./my-usage.mjs\n',
        projectPatch: 'version: 1\nkind: plugins-patch\nplugins:\n  - id: screen-steps\n    use: irrelevant\n    enabled: false\n',
      },
      ['ui-shell', 'screen-usage', 'screen-steps'],
    );

    assert.deepEqual(config.pluginTree.map((row) => [row.id, row.use, row.enabled]), [
      ['backend-claude', 'stepcast:backend-claude', true],
      ['ui-shell', 'stepcast:ui-shell', true],
      ['screen-usage', './my-usage.mjs', true],
      ['screen-steps', 'irrelevant', false],
    ]);
  });

  it('вызывающий, не назвавший своих строк, получает прежнее дерево — тот же состав и порядок', () => {
    const place = bed();
    const withoutRows = resolved(place);
    const config = resolved(place);

    assert.deepEqual(config.pluginTree, withoutRows.pluginTree);
    assert.deepEqual(config.pluginTree.map((row) => row.id), ['backend-claude']);
  });
});

describe('plugin-tree: замена строки патчем', () => {
  it('замена по известному id сохраняет место и не наследует поля заменяемой строки', () => {
    const place = bed();
    // a, b (отключена), c заводятся домашним слоем — строка, которую заменяет
    // проектный патч, обязана быть известна до него, иначе сработает вставка,
    // а не замена.
    const config = resolved(place, {
      homePatch:
        'version: 1\nkind: plugins-patch\nplugins:\n' +
        '  - id: a\n    use: ./a.mjs\n' +
        '  - id: b\n    use: ./b.mjs\n    enabled: false\n' +
        '  - id: c\n    use: ./c.mjs\n',
      projectPatch:
        'version: 1\nkind: plugins-patch\nplugins:\n' +
        '  - id: b\n    use: ./b2.mjs\n', // не называет enabled: умолчание true, а не false заменяемой
    });

    // Порядок остался прежним — b стоит на своём месте, между a и c.
    assert.deepEqual(config.pluginTree.map((row) => row.id), ['backend-claude', 'a', 'b', 'c']);
    const b = config.pluginTree.find((row) => row.id === 'b');
    assert.equal(b?.use, './b2.mjs');
    assert.equal(b?.enabled, true);
    assert.deepEqual(b?.source, { kind: 'file', path: place.projectPatchPath });
  });

  it('before/after вместе с известным id отклоняется отказом, называющим файл и id', () => {
    const place = bed();
    // id 'a' обязан быть известен до того, как проектный патч попробует его
    // заменить с позицией, — иначе строка окажется новой, и сработает вставка,
    // а не замена: заводим её домашним патчем, слоем ниже проектного.
    assert.throws(
      () =>
        resolved(place, {
          homePatch: 'version: 1\nkind: plugins-patch\nplugins:\n  - id: a\n    use: ./a.mjs\n',
          projectPatch:
            'version: 1\nkind: plugins-patch\nplugins:\n  - id: a\n    use: ./a2.mjs\n    after: backend-claude\n',
        }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.file, place.projectPatchPath);
        assert.equal(error.at, 'a');
        assert.match(error.message, /уже в дереве/);
        return true;
      },
    );
  });
});

describe('plugin-tree: вставка строки по позиции', () => {
  it('after ставит строку сразу после названной', () => {
    const place = bed();
    const config = resolved(place, {
      projectPatch:
        'version: 1\nkind: plugins-patch\nplugins:\n  - id: a\n    use: ./a.mjs\n    after: backend-claude\n',
    });
    assert.deepEqual(config.pluginTree.map((row) => row.id), ['backend-claude', 'a']);
  });

  it('before ставит строку сразу перед названной, в том числе перед встроенной', () => {
    const place = bed();
    const config = resolved(place, {
      projectPatch:
        'version: 1\nkind: plugins-patch\nplugins:\n  - id: my-backends\n    use: ./my-backends.mjs\n    before: backend-claude\n',
    });
    assert.deepEqual(config.pluginTree.map((row) => row.id), ['my-backends', 'backend-claude']);
  });

  it('без before и after строка становится последней', () => {
    const place = bed();
    const config = resolved(place, {
      projectPatch: 'version: 1\nkind: plugins-patch\nplugins:\n  - id: a\n    use: ./a.mjs\n',
    });
    assert.equal(config.pluginTree.at(-1)?.id, 'a');
  });

  it('несуществующий id позиции отклоняется отказом, называющим файл, вставляемую строку и ненайденный id', () => {
    const place = bed();
    assert.throws(
      () =>
        resolved(place, {
          projectPatch:
            'version: 1\nkind: plugins-patch\nplugins:\n  - id: a\n    use: ./a.mjs\n    after: no-such-row\n',
        }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.file, place.projectPatchPath);
        assert.equal(error.at, 'a');
        assert.match(error.message, /no-such-row/);
        assert.match(error.hint ?? '', /no-such-row/);
        return true;
      },
    );
  });

  it('before и after вместе отклоняется отказом', () => {
    const place = bed();
    assert.throws(
      () =>
        resolved(place, {
          projectPatch:
            'version: 1\nkind: plugins-patch\nplugins:\n  - id: a\n    use: ./a.mjs\n    before: backend-claude\n    after: backend-claude\n',
        }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.file, place.projectPatchPath);
        assert.equal(error.at, 'a');
        assert.match(error.message, /before, и after/);
        return true;
      },
    );
  });

  it('повтор id внутри одного файла патча отклоняется отказом, называющим файл и id', () => {
    const place = bed();
    assert.throws(
      () =>
        resolved(place, {
          projectPatch: 'version: 1\nkind: plugins-patch\nplugins:\n  - id: a\n    use: ./a.mjs\n  - id: a\n    use: ./a2.mjs\n',
        }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.file, place.projectPatchPath);
        assert.equal(error.at, 'a');
        assert.match(error.message, /дважды/);
        return true;
      },
    );
  });
});

describe('plugin-tree: отключение строки', () => {
  it('enabled: false убирает вклады строки из реестра, не убирая её из дерева, и освобождает имя другой строке', async () => {
    const place = bed();
    writeModule(
      join(place.root, '.stepcast', 'a.mjs'),
      'export default { name: "a", predicates: [{ name: "shared_name", schema: { type: "boolean" }, evaluate: () => ({ predicate: "shared_name", passed: true, hard: true }) }] };\n',
    );
    writeModule(
      join(place.root, '.stepcast', 'b.mjs'),
      'export default { name: "b", predicates: [{ name: "shared_name", schema: { type: "boolean" }, evaluate: () => ({ predicate: "shared_name", passed: false, hard: true }) }] };\n',
    );
    const config = resolved(place, {
      projectPatch:
        'version: 1\nkind: plugins-patch\nplugins:\n' +
        '  - id: a\n    use: ./a.mjs\n    enabled: false\n' +
        '  - id: b\n    use: ./b.mjs\n',
    });

    const row = config.pluginTree.find((item) => item.id === 'a');
    assert.equal(row?.enabled, false);
    assert.ok(config.pluginTree.some((item) => item.id === 'a'), 'отключённая строка осталась в дереве');

    const registry = await loadPlugins(config, { projectRoot: place.root });
    assert.deepEqual(registry.plugins.map((plugin) => plugin.name), ['b']);
    assert.equal(registry.predicates.get('shared_name')?.name, 'shared_name');
    assert.equal(contributionOwner(registry, 'predicates', 'shared_name'), 'b');
  });
});

describe('plugin-tree: замена встроенной строки', () => {
  it('проектный патч заменяет backend-claude модулем пользователя: реестр несёт вклад пользователя без конфликта имён', async () => {
    const place = bed();
    writeModule(join(place.root, '.stepcast', 'claude.mjs'), REPLACEMENT_CLAUDE);
    const config = resolved(place, {
      projectPatch: 'version: 1\nkind: plugins-patch\nplugins:\n  - id: backend-claude\n    use: ./claude.mjs\n',
    });

    const registry = await loadPlugins(config, { projectRoot: place.root });

    assert.deepEqual(availableNames(registry, 'backends'), ['claude']);
    assert.equal(contributionOwner(registry, 'backends', 'claude'), 'user-claude');
    assert.deepEqual(
      registry.plugins.map((plugin) => plugin.name),
      ['user-claude'],
    );
  });

  it('незаменённая встроенная строка оставляет владельцем «встроенный», и текст отказа о конфликте сохраняется дословно', async () => {
    const place = bed();
    writeModule(join(place.root, '.stepcast', 'impostor.mjs'), REPLACEMENT_CLAUDE.replace('user-claude', 'impostor'));
    const config = resolved(place, { project: 'plugins: ["./impostor.mjs"]\n' });

    assert.equal(config.pluginTree[0]?.id, 'backend-claude');

    await assert.rejects(
      () => loadPlugins(config, { projectRoot: place.root }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /Имя бэкенда claude занято/);
        assert.match(error.message, /встроенный вклад/);
        assert.match(error.message, /плагин impostor/);
        return true;
      },
    );
  });

  it('две строки, назвавшие одну встроенную фабрику, отказывают составом полей обычного отказа загрузки', async () => {
    const place = bed();
    // Отказ рождается внутри встроенной фабрики, а не в `applyPlugin`, — и
    // всё же обязан назвать строку и файл, в котором она объявлена
    // (`plugin-contributions`).
    const config = resolved(place, {
      projectPatch:
        'version: 1\nkind: plugins-patch\nplugins:\n  - id: mine\n    use: stepcast:backend-claude\n',
    });

    await assert.rejects(
      () => loadPlugins(config, { projectRoot: place.root }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.file, place.projectPatchPath);
        assert.equal(error.at, 'plugins');
        assert.match(error.message, /claude/);
        return true;
      },
    );
  });

  it('строка патча с id встроенного предиката — обычная новая строка, имя предиката остаётся зарезервированным', async () => {
    const place = bed();
    writeModule(
      join(place.root, '.stepcast', 'exit-code.mjs'),
      'export default { name: "exit-code-row", predicates: [{ name: "exit_code", schema: { type: "number" }, evaluate: () => ({ predicate: "exit_code", passed: true, hard: true }) }] };\n',
    );
    const config = resolved(place, {
      projectPatch: 'version: 1\nkind: plugins-patch\nplugins:\n  - id: exit_code\n    use: ./exit-code.mjs\n',
    });

    // Строка дерева — обычная, с id exit_code; проверяется, что имя предиката
    // exit_code всё равно зарезервировано движком и попытка занять его отказывает.
    await assert.rejects(
      () => loadPlugins(config, { projectRoot: place.root }),
      (error: unknown) =>
        error instanceof StepcastError &&
        /Имя предиката exit_code занято/.test(error.message) &&
        /встроенный вклад/.test(error.message),
    );
  });
});

describe('plugin-tree: фабрики строк поставки при загрузке', () => {
  it('applyTreeRow ищет фабрику среди builtinRows наравне с findBuiltinRow', async () => {
    const place = bed();
    const config = resolved(place, {}, ['ui-shell']);
    const applied: string[] = [];

    const registry = await loadPlugins(config, {
      projectRoot: place.root,
      builtinRows: [{ id: 'ui-shell', apply: () => { applied.push('ui-shell'); } }],
    });

    assert.deepEqual(applied, ['ui-shell']);
    assert.deepEqual(availableNames(registry, 'backends'), ['claude']);
  });

  it('неизвестное stepcast:<id> отказывает прежним текстом, перечисляя и строки движка, и строки вызывающего', async () => {
    const place = bed();
    const config = resolved(place, {
      projectPatch: 'version: 1\nkind: plugins-patch\nplugins:\n  - id: mine\n    use: stepcast:screen-usage\n',
    });

    await assert.rejects(
      () =>
        loadPlugins(config, {
          projectRoot: place.root,
          builtinRows: [{ id: 'ui-shell', apply: () => undefined }],
        }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /несуществующую встроенную строку stepcast:screen-usage/);
        assert.match(error.hint ?? '', /stepcast:backend-claude/);
        assert.match(error.hint ?? '', /stepcast:ui-shell/);
        return true;
      },
    );
  });

  it('строка витрины, отключённая патчем, фабрику не зовёт', async () => {
    const place = bed();
    const config = resolved(
      place,
      {
        projectPatch:
          'version: 1\nkind: plugins-patch\nplugins:\n  - id: ui-shell\n    use: stepcast:ui-shell\n    enabled: false\n',
      },
      ['ui-shell'],
    );
    let called = false;

    await loadPlugins(config, {
      projectRoot: place.root,
      builtinRows: [{ id: 'ui-shell', apply: () => { called = true; } }],
    });

    assert.equal(called, false);
  });
});

describe('plugin-tree: ключ plugins как сокращённая форма', () => {
  it('патч заменяет строку, объявленную ключом plugins по id, равному спецификатору', async () => {
    const place = bed();
    writeModule(join(place.root, '.stepcast', 'http-real.mjs'), 'export default { name: "http-real", backends: {} };\n');
    const config = resolved(place, {
      global: 'plugins: ["stepcast-plugin-http"]\n',
      projectPatch:
        'version: 1\nkind: plugins-patch\nplugins:\n  - id: stepcast-plugin-http\n    use: ./http-real.mjs\n',
    });

    const row = config.pluginTree.find((item) => item.id === 'stepcast-plugin-http');
    assert.equal(row?.use, './http-real.mjs');
    assert.deepEqual(row?.source, { kind: 'file', path: place.projectPatchPath });
  });

  it('строка ключа plugins отключается патчем по id, равному спецификатору', () => {
    const place = bed();
    const config = resolved(place, {
      global: 'plugins: ["a"]\n',
      projectPatch: 'version: 1\nkind: plugins-patch\nplugins:\n  - id: a\n    use: a\n    enabled: false\n',
    });

    const row = config.pluginTree.find((item) => item.id === 'a');
    assert.equal(row?.enabled, false);
    assert.ok(!config.config.plugins.includes('a'), 'отключённый модуль не входит в действующий список');
  });

  it('повтор одного спецификатора между слоями даёт одну строку дерева, одну загрузку и прежнюю базу разрешения пути', async () => {
    const place = bed();
    // id — сам спецификатор (текст, не разрешённый путь), поэтому оба слоя,
    // назвавшие один и тот же текст, метят одну и ту же строку дерева
    // (design.md, Решение 4). Повтор ничего не меняет: строка остаётся за
    // слоем, объявившим её первым, вместе со своим файлом, — иначе
    // относительный путь сменил бы базу разрешения и грузился бы другой файл,
    // чего прежний список ключа `plugins` не делал.
    writeModule(join(place.home, '.stepcast', 'shared.mjs'), 'export default { name: "home-shared", predicates: [] };\n');
    writeModule(join(place.root, '.stepcast', 'shared.mjs'), 'export default { name: "project-shared", predicates: [] };\n');
    const config = resolved(place, {
      global: 'plugins: ["./shared.mjs"]\n',
      project: 'plugins: ["./shared.mjs"]\n',
    });

    assert.deepEqual(config.pluginTree.map((row) => row.id), ['backend-claude', './shared.mjs']);
    assert.deepEqual(config.pluginTree[1]?.source, { kind: 'file', path: place.globalPath });

    const registry = await loadPlugins(config, { projectRoot: place.root });
    assert.equal(registry.plugins.length, 1);
    assert.equal(registry.plugins[0]?.name, 'home-shared', 'модуль разрешён от домашнего файла, объявившего строку');
  });

  it('патч нижнего слоя, заменивший строку, переживает повтор спецификатора ключом верхнего слоя', () => {
    const place = bed();
    // Повтор спецификатора — не правка: он находит строку в дереве и оставляет
    // её как есть, включая `use`, поставленный патчем.
    const config = resolved(place, {
      global: 'plugins: ["./shared.mjs"]\n',
      homePatch: 'version: 1\nkind: plugins-patch\nplugins:\n  - id: ./shared.mjs\n    use: ./replacement.mjs\n',
      project: 'plugins: ["./shared.mjs"]\n',
    });

    const row = config.pluginTree.find((item) => item.id === './shared.mjs');
    assert.equal(row?.use, './replacement.mjs');
    assert.deepEqual(row?.source, { kind: 'file', path: place.homePatchPath });
  });
});

describe('plugin-tree: отказы чтения патча', () => {
  it('неразбираемый YAML патча отказывает, называя файл', () => {
    const place = bed();
    assert.throws(
      () => resolved(place, { projectPatch: 'version: 1\nkind: plugins-patch\nplugins:\n  - id: [a\n' }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.file, place.projectPatchPath);
        assert.match(error.message, /не разбирается как YAML/);
        return true;
      },
    );
  });

  it('документ без kind отказывает, называя файл и место', () => {
    const place = bed();
    assert.throws(
      () => resolved(place, { homePatch: 'version: 1\nplugins:\n  - id: a\n    use: ./a.mjs\n' }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.file, place.homePatchPath);
        assert.equal(error.at, 'kind');
        assert.match(error.hint ?? '', /plugins-patch/);
        return true;
      },
    );
  });

  it('неизвестный ключ строки отказывает, называя файл, ключ и подсказку', () => {
    const place = bed();
    assert.throws(
      () =>
        resolved(place, {
          projectPatch: 'version: 1\nkind: plugins-patch\nplugins:\n  - id: a\n    use: ./a.mjs\n    enable: false\n',
        }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.file, place.projectPatchPath);
        assert.match(`${error.at ?? ''} ${error.message}`, /enable/);
        assert.match(error.hint ?? '', /docs\/plugins\.md/);
        return true;
      },
    );
  });

  it('пустой список plugins в патче отказывает, называя файл и место', () => {
    const place = bed();
    assert.throws(
      () => resolved(place, { projectPatch: 'version: 1\nkind: plugins-patch\nplugins: []\n' }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.file, place.projectPatchPath);
        assert.equal(error.at, 'plugins');
        return true;
      },
    );
  });
});
