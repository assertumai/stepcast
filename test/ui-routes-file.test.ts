import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { StepcastError } from '../src/core/errors.js';
import { buildRouteTable, homeRoutesPath, projectRoutesPath, writeRouteRow } from '../src/ui/routesFile.js';
import { tempDir } from './tmp.js';

/** Домашний и проектный каталоги для трёх слоёв — без .stepcast/routes.yml, если тест его не пишет. */
function layerDirs(): { home: string; projectRoot: string } {
  const home = tempDir('routes-home-');
  const projectRoot = tempDir('routes-project-');
  return { home, projectRoot };
}

function writeHomeRoutes(home: string, content: string): void {
  const path = homeRoutesPath(home);
  mkdirSync(join(home, '.stepcast'), { recursive: true });
  writeFileSync(path, content);
}

function writeProjectRoutes(projectRoot: string, content: string): void {
  const path = projectRoutesPath(projectRoot);
  mkdirSync(join(projectRoot, '.stepcast'), { recursive: true });
  writeFileSync(path, content);
}

describe('ui-routes-file: сборка таблицы трёх слоёв', () => {
  it('без пользовательских файлов действует встроенная таблица без отказа', () => {
    const { home } = layerDirs();
    const result = buildRouteTable({ home });
    const runs = result.entries.find((entry) => entry.id === 'screen-runs');
    assert.ok(runs !== undefined);
    assert.equal(runs?.definition.path, '/');
    assert.equal(runs?.sources.path.layer, 'builtin');
  });

  it('проектный слой переносит встроенный маршрут на другой путь, не трогая цель и навигацию', () => {
    const { home, projectRoot } = layerDirs();
    writeProjectRoutes(projectRoot, 'routes:\n  - id: screen-pipelines\n    path: /release\n');

    const result = buildRouteTable({ home, projectRoot });
    const entry = result.entries.find((candidate) => candidate.id === 'screen-pipelines');
    assert.equal(entry?.definition.path, '/release');
    assert.equal(entry?.sources.path.layer, 'project');
    assert.deepEqual(entry?.definition.target, { kind: 'screen', id: 'screen-pipelines' });
    assert.equal(entry?.definition.nav?.order, 1);
    assert.equal(entry?.sources.navOrder?.layer, 'builtin');
  });

  it('домашний слой переименовывает пункт меню, не трогая путь и цель', () => {
    const { home } = layerDirs();
    writeHomeRoutes(home, 'routes:\n  - id: screen-cleanup\n    nav:\n      title: Чистка\n');

    const result = buildRouteTable({ home });
    const entry = result.entries.find((candidate) => candidate.id === 'screen-cleanup');
    assert.equal(entry?.definition.nav?.title, 'Чистка');
    assert.equal(entry?.definition.path, '/cleanup');
    assert.equal(entry?.sources.navTitle?.layer, 'home');
    assert.equal(entry?.sources.path.layer, 'builtin');
  });

  it('enabled: false убирает маршрут из действующей таблицы целиком', () => {
    const { home } = layerDirs();
    writeHomeRoutes(home, 'routes:\n  - id: screen-agents\n    enabled: false\n');

    const result = buildRouteTable({ home });
    assert.equal(result.entries.some((entry) => entry.id === 'screen-agents'), false);
  });

  it('отключённый маршрут остаётся в перечне отключённых с файлом, который его выключил', () => {
    const { home } = layerDirs();
    writeHomeRoutes(home, 'routes:\n  - id: screen-agents\n    enabled: false\n');

    const result = buildRouteTable({ home });
    // Без этого перечня отключённый маршрут исчезал бы из витрины совсем, и
    // включить его обратно можно было бы только правкой файла руками.
    const off = result.disabled.find((entry) => entry.id === 'screen-agents');
    assert.equal(off?.path, '/agents', 'поля отключённой строки слиты слоями так же, как у действующей');
    assert.deepEqual(off?.target, { kind: 'screen', id: 'screen-agents' });
    assert.equal(off?.disabledBy.layer, 'home');
    assert.equal(off?.disabledBy.file, homeRoutesPath(home));
  });

  it('отключённая строка не отказывает сборке ни конфликтом пути, ни отсутствием цели', () => {
    const { home, projectRoot } = layerDirs();
    writeProjectRoutes(
      projectRoot,
      'routes:\n' +
        '  - id: my-runs\n    path: /\n    target: { screen: screen-runs }\n    enabled: false\n' +
        '  - id: my-half\n    nav: { title: Пусто }\n    enabled: false\n',
    );

    const result = buildRouteTable({ home, projectRoot });
    assert.equal(result.entries.find((entry) => entry.id === 'screen-runs')?.definition.path, '/');
    assert.deepEqual(
      result.disabled.map((entry) => entry.id).sort(),
      ['my-half', 'my-runs'],
    );
  });

  it('отсутствующий встроенный файл — названный отказ с именем файла, без подстановки зашитых адресов', () => {
    const { home } = layerDirs();
    const missing = join(tempDir('routes-builtin-'), 'routes.yml');

    assert.throws(
      () => buildRouteTable({ home, builtinPath: missing }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.file, missing);
        assert.match(error.message, /не читается/);
        return true;
      },
    );
  });

  it('неразбираемый встроенный файл — названный отказ с именем файла', () => {
    const { home } = layerDirs();
    const dir = tempDir('routes-builtin-');
    const broken = join(dir, 'routes.yml');
    writeFileSync(broken, 'routes: [{ id: bad, path: 7 }]\n');

    assert.throws(
      () => buildRouteTable({ home, builtinPath: broken }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.file, broken);
        return true;
      },
    );
  });

  it('новый id в проектном слое дополняет таблицу, не задевая остальных', () => {
    const { home, projectRoot } = layerDirs();
    writeProjectRoutes(
      projectRoot,
      'routes:\n  - id: my-dashboard\n    path: /team\n    target: { widget: proj/team }\n',
    );

    const result = buildRouteTable({ home, projectRoot });
    // 13 встроенных маршрутов (включая screen-decisions и screen-proposals) плюс этот новый.
    assert.equal(result.entries.length, 14);
    const entry = result.entries.find((candidate) => candidate.id === 'my-dashboard');
    assert.deepEqual(entry?.definition.target, { kind: 'widget', id: 'proj/team' });
    const runs = result.entries.find((candidate) => candidate.id === 'screen-runs');
    assert.equal(runs?.definition.path, '/');
  });

  it('проектный слой — только файл каталога, в котором поднят демон', () => {
    const { home, projectRoot } = layerDirs();
    const otherProject = tempDir('routes-other-project-');
    writeProjectRoutes(otherProject, 'routes:\n  - id: screen-runs\n    path: /elsewhere\n');

    const result = buildRouteTable({ home, projectRoot });
    const runs = result.entries.find((candidate) => candidate.id === 'screen-runs');
    assert.equal(runs?.definition.path, '/');
  });

  it('два маршрута с одинаковым нормализованным шаблоном — названный отказ с обоими id и файлами', () => {
    const { home, projectRoot } = layerDirs();
    writeProjectRoutes(
      projectRoot,
      'routes:\n  - id: my-runs\n    path: /runs/:a/:b\n    target: { screen: screen-runs }\n',
    );

    assert.throws(
      () => buildRouteTable({ home, projectRoot }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /screen-run\b/);
        assert.match(error.message, /my-runs/);
        assert.match(error.message, /routes\.yml/);
        return true;
      },
    );
  });

  it('путь под зарезервированным префиксом — названный отказ', () => {
    const { home, projectRoot } = layerDirs();
    writeProjectRoutes(
      projectRoot,
      'routes:\n  - id: my-api\n    path: /api/whatever\n    target: { screen: screen-runs }\n',
    );

    assert.throws(
      () => buildRouteTable({ home, projectRoot }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /зарезервированный путь/);
        return true;
      },
    );
  });

  it('подстановка параметра цели на несуществующее имя — названный отказ со ссылкой на маршрут, файл и имя', () => {
    const { home, projectRoot } = layerDirs();
    writeProjectRoutes(
      projectRoot,
      'routes:\n  - id: my-widget\n    path: /w/:id\n    target: { widget: proj/clock }\n    params: { note: "${params.nope}" }\n',
    );

    assert.throws(
      () => buildRouteTable({ home, projectRoot }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /my-widget/);
        assert.match(error.message, /nope/);
        assert.equal(error.file, projectRoutesPath(projectRoot));
        return true;
      },
    );
  });

  it('неразбираемый файл слоя — названный отказ с именем файла и местом разбора', () => {
    const { home, projectRoot } = layerDirs();
    writeProjectRoutes(projectRoot, 'routes: [{ id: bad, path: 7 }]\n');

    assert.throws(
      () => buildRouteTable({ home, projectRoot }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.file, projectRoutesPath(projectRoot));
        return true;
      },
    );
  });

  it('новый id без path/target ни в одном слое — названный отказ', () => {
    const { home, projectRoot } = layerDirs();
    writeProjectRoutes(projectRoot, 'routes:\n  - id: my-half\n    nav:\n      title: Пусто\n');

    assert.throws(
      () => buildRouteTable({ home, projectRoot }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /my-half/);
        return true;
      },
    );
  });

  it('маршрут с целью-дашбордом собирается тем же вкладом, что и цель-экран/цель-виджет', () => {
    const { home, projectRoot } = layerDirs();
    writeProjectRoutes(
      projectRoot,
      'routes:\n  - id: my-dashboard\n    path: /release/:period\n    target: { dashboard: release }\n    params: { window: "${params.period}" }\n',
    );

    const result = buildRouteTable({ home, projectRoot });
    const entry = result.entries.find((candidate) => candidate.id === 'my-dashboard');
    assert.deepEqual(entry?.definition.target, { kind: 'dashboard', id: 'release' });
    assert.deepEqual(entry?.definition.params, { window: '${params.period}' });
  });

  it('поле цели-дашборда сливается по слоям тем же правилом, что и прочие поля строки', () => {
    const { home, projectRoot } = layerDirs();
    writeHomeRoutes(home, 'routes:\n  - id: my-dashboard\n    path: /release\n    target: { dashboard: release }\n');
    writeProjectRoutes(projectRoot, 'routes:\n  - id: my-dashboard\n    nav:\n      title: Релиз\n');

    const result = buildRouteTable({ home, projectRoot });
    const entry = result.entries.find((candidate) => candidate.id === 'my-dashboard');
    assert.deepEqual(entry?.definition.target, { kind: 'dashboard', id: 'release' });
    assert.equal(entry?.sources.target.layer, 'home');
    assert.equal(entry?.definition.nav?.title, 'Релиз');
    assert.equal(entry?.sources.navTitle?.layer, 'project');
  });

  it('подстановка параметра цели-дашборда на имя вне шаблона пути — названный отказ', () => {
    const { home, projectRoot } = layerDirs();
    writeProjectRoutes(
      projectRoot,
      'routes:\n  - id: my-dashboard\n    path: /release\n    target: { dashboard: release }\n    params: { window: "${params.nope}" }\n',
    );

    assert.throws(
      () => buildRouteTable({ home, projectRoot }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /my-dashboard/);
        assert.match(error.message, /nope/);
        return true;
      },
    );
  });

  it('неизвестный ключ строки маршрута — отказ с указанием файла', () => {
    const { home, projectRoot } = layerDirs();
    writeProjectRoutes(
      projectRoot,
      'routes:\n  - id: my-route\n    path: /x\n    target: { screen: screen-runs }\n    bogus: 1\n',
    );

    assert.throws(
      () => buildRouteTable({ home, projectRoot }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.file, projectRoutesPath(projectRoot));
        assert.match(error.message, /bogus/);
        return true;
      },
    );
  });
});

describe('ui-routes-file: запись строки в слой через Document', () => {
  it('добавляет новую строку, сохраняя комментарии и прочие строки файла', () => {
    const { home } = layerDirs();
    const path = homeRoutesPath(home);
    mkdirSync(join(home, '.stepcast'), { recursive: true });
    writeFileSync(path, '# мои маршруты\nroutes:\n  - id: screen-cleanup # правил вручную\n    enabled: false\n');

    writeRouteRow('home', { id: 'my-route', path: '/mine', target: { screen: 'screen-runs' } }, { home });

    const text = readFileSync(path, 'utf8');
    assert.match(text, /# мои маршруты/);
    assert.match(text, /# правил вручную/);
    assert.match(text, /my-route/);

    const result = buildRouteTable({ home });
    const entry = result.entries.find((candidate) => candidate.id === 'my-route');
    assert.equal(entry?.definition.path, '/mine');
  });

  it('файл с повтором ключа не переписывается — отказ называет место разбора', () => {
    const { home } = layerDirs();
    const path = homeRoutesPath(home);
    mkdirSync(join(home, '.stepcast'), { recursive: true });
    // Повтор ключа `routes:` YAML не разбирает, но разбор «как получится» даёт
    // схемно верный объект: без проверки `doc.errors` запись прошла бы поверх
    // файла, который чтение слоя считает сломанным, и унесла бы первый блок.
    const broken =
      'routes:\n  - id: mine\n    path: /mine\n    target: { screen: screen-runs }\nroutes:\n  - id: other\n    path: /other\n    target: { screen: screen-runs }\n';
    writeFileSync(path, broken);

    assert.throws(
      () => writeRouteRow('home', { id: 'my-route', path: '/new', target: { screen: 'screen-runs' } }, { home }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.file, path);
        assert.match(error.message, /не разбирается как YAML/);
        assert.match(String(error.at), /строка 5/);
        return true;
      },
    );
    assert.equal(readFileSync(path, 'utf8'), broken);
  });

  it('правка существующей строки заменяет её на месте, не дублируя', () => {
    const { home } = layerDirs();
    writeHomeRoutes(home, 'routes:\n  - id: my-route\n    path: /old\n    target: { screen: screen-runs }\n');

    writeRouteRow('home', { id: 'my-route', path: '/new', target: { screen: 'screen-runs' } }, { home });

    const result = buildRouteTable({ home });
    const rows = result.entries.filter((candidate) => candidate.id === 'my-route');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.definition.path, '/new');
  });
});
