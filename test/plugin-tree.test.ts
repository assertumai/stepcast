import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { resolveConfig, type ResolvedConfig } from '../src/core/config/resolve.js';
import { StepcastError } from '../src/core/errors.js';
import { createKernel } from '../src/core/plugins/kernel.js';
import { walkPluginTree } from '../src/core/plugins/load.js';
import { availableNames, contributionOwner } from '../src/core/plugins/registry.js';
import { loadPlugins } from '../src/parts/load.js';
import { BUILTIN_ROWS, BUILTIN_ROW_IDS } from '../src/parts/rows.js';
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

/** Каталог плагина пользователя (`user-plugins`): манифест плюс перечисленные файлы половин. */
function writePluginDir(
  baseDir: string,
  id: string,
  manifest: Record<string, unknown>,
  files: Readonly<Record<string, string>> = {},
): string {
  const dir = join(baseDir, '.stepcast', 'plugins', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
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
        ['step-run', 'stepcast:step-run', true],
        ['step-uses', 'stepcast:step-uses', true],
        ['step-script', 'stepcast:step-script', true],
        ['step-agent', 'stepcast:step-agent', true],
        ['step-decision', 'stepcast:step-decision', true],
        ['home-extra', './home-extra.mjs', true],
        ['project-extra', './project-extra.mjs', true],
      ],
    );
    assert.deepEqual(config.pluginTree[0]?.source, { kind: 'builtin' });
    assert.deepEqual(config.pluginTree[6]?.source, { kind: 'file', path: place.homePatchPath });
    assert.deepEqual(config.pluginTree[7]?.source, { kind: 'file', path: place.projectPatchPath });
  });

  it('конфигурация без единого plugins.patch.yml сворачивается в прежний состав и порядок', () => {
    const place = bed();
    writeModule(join(place.home, '.stepcast', 'g.mjs'), 'export default { name: "g", predicates: [] };\n');
    writeModule(join(place.root, '.stepcast', 'p.mjs'), 'export default { name: "p", predicates: [] };\n');
    const config = resolved(place, {
      global: 'plugins: ["./g.mjs"]\n',
      project: 'plugins: ["./p.mjs"]\n',
    });

    assert.deepEqual(
      config.pluginTree.map((row) => row.id),
      ['backend-claude', 'step-run', 'step-uses', 'step-script', 'step-agent', 'step-decision', './g.mjs', './p.mjs'],
    );
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

    assert.deepEqual(
      config.pluginTree.map((row) => row.id),
      ['backend-claude', 'step-run', 'step-uses', 'step-script', 'step-agent', 'step-decision', 'home-only'],
    );
  });
});

// Задача 1.2 (row-module-convention): у строк встроенного слоя две формы — id
// в семени дерева (`ResolveOptions.builtinRows`) и фабрика при обходе
// (`LoadOptions.builtinRows`). У строк движка развести их нечем: обе идут из
// одного перечня `src/parts/rows.ts` (`BUILTIN_ROW_IDS` выведен из
// `BUILTIN_ROWS`), и проверять тут можно лишь то, что перечень действительно
// сеет дерево — весь и в своём порядке. Развести формы способен только
// вызывающий, подающий их двумя параметрами (`src/ui/kernel.ts:126` и `:128`),
// — эта ветвь и проверяется отдельно.
describe('plugin-tree: две формы набора строк — id в семени и фабрика при обходе', () => {
  it('перечень движка сеет встроенный слой дефолтной сборки целиком и в своём порядке', () => {
    const place = bed();
    const config = resolved(place);

    assert.deepEqual(config.pluginTree.map((row) => row.id), [...BUILTIN_ROW_IDS]);
    assert.deepEqual([...BUILTIN_ROW_IDS], BUILTIN_ROWS.map((row) => row.id));
  });

  it('вызывающий, назвавший id семени и не подавший фабрику, получает отказ, называющий эту строку', async () => {
    const place = bed();
    // Перекос ровно тот, которого не бывает у строк движка: id строки витрины
    // назван разрешению, а обходу тот же перечень не подан.
    const config = resolved(place, {}, ['ui-shell']);

    await assert.rejects(
      () => loadPlugins(config, { projectRoot: place.root }),
      (error: unknown) =>
        error instanceof StepcastError && /несуществующую встроенную строку stepcast:ui-shell/.test(error.message),
    );
  });

  // Сошедшиеся формы — «applyTreeRow ищет фабрику строки поставки среди
  // builtinRows» ниже: тот же `ui-shell` обеими формами применяется и дерево
  // собирается.
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
      ['step-run', 'stepcast:step-run', true],
      ['step-uses', 'stepcast:step-uses', true],
      ['step-script', 'stepcast:step-script', true],
      ['step-agent', 'stepcast:step-agent', true],
      ['step-decision', 'stepcast:step-decision', true],
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
    assert.deepEqual(
      config.pluginTree.map((row) => row.id),
      ['backend-claude', 'step-run', 'step-uses', 'step-script', 'step-agent', 'step-decision'],
    );
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
    assert.deepEqual(
      config.pluginTree.map((row) => row.id),
      ['backend-claude', 'step-run', 'step-uses', 'step-script', 'step-agent', 'step-decision', 'a', 'b', 'c'],
    );
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
    assert.deepEqual(
      config.pluginTree.map((row) => row.id),
      ['backend-claude', 'a', 'step-run', 'step-uses', 'step-script', 'step-agent', 'step-decision'],
    );
  });

  it('before ставит строку сразу перед названной, в том числе перед встроенной', () => {
    const place = bed();
    const config = resolved(place, {
      projectPatch:
        'version: 1\nkind: plugins-patch\nplugins:\n  - id: my-backends\n    use: ./my-backends.mjs\n    before: backend-claude\n',
    });
    assert.deepEqual(
      config.pluginTree.map((row) => row.id),
      ['my-backends', 'backend-claude', 'step-run', 'step-uses', 'step-script', 'step-agent', 'step-decision'],
    );
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

    const { registry } = await loadPlugins(config, { projectRoot: place.root });
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

    const { registry } = await loadPlugins(config, { projectRoot: place.root });

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
  it('applyTreeRow ищет фабрику строки поставки среди builtinRows', async () => {
    const place = bed();
    const config = resolved(place, {}, ['ui-shell']);
    const applied: string[] = [];

    const { registry } = await loadPlugins(config, {
      projectRoot: place.root,
      builtinRows: [{ id: 'ui-shell', apply: () => { applied.push('ui-shell'); } }],
    });

    assert.deepEqual(applied, ['ui-shell']);
    assert.deepEqual(availableNames(registry, 'backends'), ['claude']);
  });

  it('неизвестное stepcast:<id> отказывает прежним текстом, перечисляя строки движка, а за ними строки вызывающего', async () => {
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
        const hint = error.hint ?? '';
        assert.match(hint, /stepcast:backend-claude/);
        assert.match(hint, /stepcast:ui-shell/);
        // Порядок обязателен (design.md, Решение 3): строки движка
        // (`BUILTIN_ROWS`), затем строки вызывающего, в порядке подстановки
        // `src/parts/load.ts`.
        assert.equal(
          hint,
          'Пакет поставляет: stepcast:backend-claude, stepcast:step-run, stepcast:step-uses, stepcast:step-script, stepcast:step-agent, stepcast:step-decision, stepcast:ui-shell',
        );
        return true;
      },
    );
  });

  // Задача 3.7: ядро не несёт собственной таблицы строк поставки — обходу,
  // которому не подано ни одной, строка `stepcast:<имя>` отказывает как
  // несуществующая, даже когда речь о встроенной строке движка.
  it('walkPluginTree без единой поданной строки поставки отказывает на stepcast:backend-claude как на несуществующей', async () => {
    const place = bed();
    const config = resolved(place);

    const { outcomes } = await walkPluginTree(createKernel(), config, { projectRoot: place.root });

    const backendClaude = outcomes.find((outcome) => outcome.row.id === 'backend-claude');
    assert.equal(backendClaude?.status, 'failed');
    assert.match(backendClaude?.error?.message ?? '', /несуществующую встроенную строку stepcast:backend-claude/);
    // Подсказка на этом пути называет причину, а не вырождается в перечень
    // «Пакет поставляет: » с пустым хвостом: поставки не «нет вовсе» —
    // обходу её не подали.
    assert.equal(
      backendClaude?.error?.hint,
      'Обходу не подано ни одной строки поставки: форму stepcast:<имя> разрешают только строки параметра builtinRows',
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

// Задача 5 (row-module-convention): пересечение перечня движка и перечня
// вызывающего по `id` — сегодня это не бывает успешным (`builtinSeedRows` не
// снимает дублей, семя получает две одноимённые строки, обход применяет
// первую найденную и упирается в отказ о занятом имени, где обе стороны
// зовутся «встроенный вклад» — причина не названа), и отказ состава заменяет
// этот молчаливый исход именованным.
describe('plugin-tree: пересечение перечней строк — именованный отказ', () => {
  it('вызывающий подаёт строку с id встроенной строки движка — отказ называет id, строки не применены', async () => {
    const place = bed();
    const config = resolved(place);
    const applied: string[] = [];

    await assert.rejects(
      () =>
        loadPlugins(config, {
          projectRoot: place.root,
          builtinRows: [{ id: 'backend-claude', apply: () => { applied.push('backend-claude'); } }],
        }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /backend-claude/);
        return true;
      },
    );

    // Отказ рождается до сборки ядра и обхода дерева: даже фабрика
    // вызывающего, которая должна была бы конфликтовать со встроенной, ни
    // разу не вызвана.
    assert.deepEqual(applied, []);
  });

  it('замена backend-claude патчем состава по-прежнему проходит, отказ о пересечении её не задевает', async () => {
    const place = bed();
    writeModule(join(place.root, '.stepcast', 'claude.mjs'), REPLACEMENT_CLAUDE);
    const config = resolved(place, {
      projectPatch: 'version: 1\nkind: plugins-patch\nplugins:\n  - id: backend-claude\n    use: ./claude.mjs\n',
    });

    const { registry } = await loadPlugins(config, { projectRoot: place.root });

    assert.equal(contributionOwner(registry, 'backends', 'claude'), 'user-claude');
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

    assert.deepEqual(
      config.pluginTree.map((row) => row.id),
      ['backend-claude', 'step-run', 'step-uses', 'step-script', 'step-agent', 'step-decision', './shared.mjs'],
    );
    assert.deepEqual(config.pluginTree[6]?.source, { kind: 'file', path: place.globalPath });

    const { registry } = await loadPlugins(config, { projectRoot: place.root });
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

describe('plugin-tree: каталожные строки (user-plugins)', () => {
  it('плагин, найденный обходом домашнего слоя, стоит в дереве и применяется', async () => {
    const place = bed();
    const dir = writePluginDir(place.home, 'clock', { version: '1.0.0', server: 'server.mjs' }, {
      'server.mjs': 'export default { name: "clock", predicates: [] };\n',
    });

    const config = resolved(place);
    const row = config.pluginTree.find((item) => item.id === 'clock');
    assert.equal(row?.use, dir);
    assert.equal(row?.enabled, true);
    assert.deepEqual(row?.source, { kind: 'directory', dir, layer: 'home' });

    const { registry } = await loadPlugins(config, { projectRoot: place.root });
    assert.deepEqual(registry.plugins.map((plugin) => plugin.name), ['clock']);
  });

  it('патч своего слоя отключает найденную обходом строку', async () => {
    const place = bed();
    writePluginDir(place.home, 'clock', { server: 'server.mjs' }, {
      'server.mjs': 'export default { name: "clock", predicates: [] };\n',
    });

    const config = resolved(place, {
      // `use` повторяет каталог, найденный обходом: тот же приём, что в
      // design.md, Решение 2 — патч того же слоя правит найденную строку.
      // Замена целиком, поэтому `use` патча — то, что теперь несёт строка, а
      // не прежний абсолютный путь, поставленный обходом.
      homePatch: `version: 1\nkind: plugins-patch\nplugins:\n  - id: clock\n    use: ./plugins/clock\n    enabled: false\n`,
    });

    const row = config.pluginTree.find((item) => item.id === 'clock');
    assert.equal(row?.use, './plugins/clock');
    assert.equal(row?.enabled, false);
    assert.deepEqual(row?.source, { kind: 'file', path: place.homePatchPath });

    const { registry } = await loadPlugins(config, { projectRoot: place.root });
    assert.deepEqual(registry.plugins, []);
  });

  it('проектный слой заменяет найденную строку домашнего слоя целиком', async () => {
    const place = bed();
    writePluginDir(place.home, 'clock', { server: 'server.mjs' }, {
      'server.mjs':
        'export default { name: "clock", predicates: [{ name: "home_only", schema: { type: "boolean" }, evaluate: () => ({ predicate: "home_only", passed: true, hard: true }) }] };\n',
    });
    const projectDir = writePluginDir(place.root, 'clock', { server: 'server.mjs' }, {
      'server.mjs':
        'export default { name: "clock", predicates: [{ name: "project_only", schema: { type: "boolean" }, evaluate: () => ({ predicate: "project_only", passed: true, hard: true }) }] };\n',
    });

    const config = resolved(place);
    const rows = config.pluginTree.filter((item) => item.id === 'clock');
    assert.equal(rows.length, 1, 'домашняя строка не должна остаться в дереве наравне с проектной');
    assert.equal(rows[0]?.use, projectDir);
    assert.deepEqual(rows[0]?.source, { kind: 'directory', dir: projectDir, layer: 'project' });

    const { registry } = await loadPlugins(config, { projectRoot: place.root });
    assert.deepEqual(availableNames(registry, 'predicates').sort(), ['project_only']);
  });

  it('строка патча, назвавшая в use каталог с манифестом, даёт тот же плагин, что и обход', async () => {
    const place = bed();
    // Каталог вне `.stepcast/plugins/` обходом не находится — на него ссылается только патч.
    // Патч разрешает относительный `use` от своего собственного каталога
    // (`.stepcast`), поэтому каталог плагина заводится рядом, внутри него.
    const dir = join(place.root, '.stepcast', 'vendored', 'clock');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ server: 'server.mjs' }));
    writeFileSync(join(dir, 'server.mjs'), 'export default { name: "clock", predicates: [] };\n');

    const config = resolved(place, {
      projectPatch: 'version: 1\nkind: plugins-patch\nplugins:\n  - id: clock\n    use: ./vendored/clock\n',
    });

    const row = config.pluginTree.find((item) => item.id === 'clock');
    assert.deepEqual(row?.source, { kind: 'file', path: place.projectPatchPath });

    const { registry } = await loadPlugins(config, { projectRoot: place.root });
    assert.deepEqual(registry.plugins.map((plugin) => plugin.name), ['clock']);
  });

  it('имя, объявленное серверной половиной, обязано совпасть с именем каталога', async () => {
    const place = bed();
    writePluginDir(place.home, 'clock', { server: 'server.mjs' }, {
      'server.mjs': 'export default { name: "not-clock", predicates: [] };\n',
    });
    const config = resolved(place);

    // Строка найдена обходом — расхождение имён её отказ, но не отказ
    // загрузки целиком (design.md, Решение 10): вклады не регистрируются,
    // а причина видна в итогах строк, не в отклонении промиса.
    const { registry, outcomes } = await loadPlugins(config, { projectRoot: place.root });
    assert.deepEqual(registry.plugins, []);
    const outcome = outcomes.find((item) => item.row.id === 'clock');
    assert.equal(outcome?.status, 'failed');
    assert.match(outcome?.error?.message ?? '', /clock/);
    assert.match(outcome?.error?.message ?? '', /not-clock/);
  });

  it('каталог, названный именем встроенной строки, отказывает сам и не заменяет её', async () => {
    const place = bed();
    const dir = writePluginDir(place.home, 'backend-claude', { server: 'server.mjs' }, {
      'server.mjs': 'export default { name: "backend-claude", predicates: [] };\n',
    });
    // Сосед по каталогу плагинов обязан работать: отказ одной строки не имеет
    // права остановить обход и сборку дерева целиком.
    writePluginDir(place.home, 'clock', { server: 'server.mjs' }, {
      'server.mjs': 'export default { name: "clock", predicates: [] };\n',
    });

    const config = resolved(place);

    const builtin = config.pluginTree.find((row) => row.source.kind === 'builtin' && row.id === 'backend-claude');
    assert.equal(builtin?.use, 'stepcast:backend-claude', 'встроенная строка своей подмены не получила');
    assert.equal(builtin?.failure, undefined);
    const fromDir = config.pluginTree.find((row) => row.source.kind === 'directory' && row.id === 'backend-claude');
    assert.deepEqual(fromDir?.source, { kind: 'directory', dir, layer: 'home' });
    assert.match(fromDir?.failure?.message ?? '', /backend-claude/);
    assert.ok(
      !config.config.plugins.includes(dir),
      'заведомо отказавшая строка не попадает в перечень модулей конфигурации',
    );

    const { registry, outcomes } = await loadPlugins(config, { projectRoot: place.root });
    const failed = outcomes.find((outcome) => outcome.row === fromDir);
    assert.equal(failed?.status, 'failed');
    assert.match(failed?.error?.hint ?? '', /патч/);
    assert.equal(
      outcomes.find((outcome) => outcome.row === builtin)?.status,
      'active',
      'встроенная строка применена как обычно',
    );
    assert.deepEqual(registry.plugins.map((plugin) => plugin.name), ['clock'], 'сосед по каталогу загружен');
  });

  it('плагин без серверной половины действует и ничего не импортирует', async () => {
    const place = bed();
    const dir = writePluginDir(place.home, 'clock', { browser: 'browser.tsx' }, {
      'browser.tsx': 'export default () => {};\n',
    });

    const config = resolved(place);
    const row = config.pluginTree.find((item) => item.id === 'clock');
    assert.equal(row?.use, dir);

    const imported: string[] = [];
    const { registry, outcomes } = await loadPlugins(config, {
      projectRoot: place.root,
      importModule: async (url) => {
        imported.push(url);
        return {};
      },
    });

    assert.deepEqual(imported, [], 'без объявленной серверной половины импортировать нечего');
    assert.equal(outcomes.find((item) => item.row.id === 'clock')?.status, 'active');
    assert.deepEqual(registry.plugins, [], 'вкладов у такой строки нет — вся её половина браузерная');
  });

  it('ключ plugins, назвавший тот же id, что и каталог, оставляет строку за обходом', async () => {
    const place = bed();
    const dir = writePluginDir(place.home, 'clock', { server: 'server.mjs' }, {
      'server.mjs': 'export default { name: "clock", predicates: [] };\n',
    });

    // Спецификатор ключа `plugins` совпал с именем каталога: строка уже в
    // дереве, и повтор ключа её не трогает (`applyOperation`, ветка `key`).
    const config = resolved(place, { global: 'plugins: ["clock"]\n' });

    const rows = config.pluginTree.filter((item) => item.id === 'clock');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.use, dir, 'модуль остался каталогом, найденным обходом');
    assert.deepEqual(rows[0]?.source, { kind: 'directory', dir, layer: 'home' });

    const { registry } = await loadPlugins(config, { projectRoot: place.root });
    assert.deepEqual(registry.plugins.map((plugin) => plugin.name), ['clock']);
  });
});
