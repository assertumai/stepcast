import assert from 'node:assert/strict';
import { get, request, type IncomingMessage } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { createUiServer, LOOPBACK, type UiServer } from '../src/parts/ui/daemon/server.js';
import { createKernelCache, type KernelCache } from '../src/parts/ui/pipelines.js';
import { makeJournalBed } from './helpers.js';

/**
 * Реестр экранов и маршрутов API (`ui-screens`): регистрация и снятие
 * маршрута строкой, состав `GET /api/screens`, отключение и замена экрана
 * патчем, повтор пары «метод и путь», отказ сборки не гасит витрину, один
 * контекст демона на все маршруты. Дополняет `test/ui-server.test.ts`
 * (маршруты переведённых экранов, проверяемые без правки ожиданий) там, где
 * тому тесту нечего проверять, — саму механику реестра.
 */

async function startServer(
  t: TestContext,
  options: { runsRoot: string; home?: string; kernelCache?: KernelCache },
): Promise<UiServer> {
  const server = await createUiServer({ ...options, port: 0 });
  t.after(() => server.close());
  return server;
}

interface Fetched {
  readonly code: number;
  readonly body: string;
}

function fetchPath(server: UiServer, path: string, method = 'GET'): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const callback = (res: IncomingMessage): void => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ code: res.statusCode ?? 0, body }));
    };
    if (method === 'GET') {
      get({ host: LOOPBACK, port: server.port, path }, callback).on('error', reject);
    } else {
      const req = request({ host: LOOPBACK, port: server.port, path, method }, callback);
      req.on('error', reject);
      req.end();
    }
  });
}

type Json = Record<string, unknown>;

async function fetchJson(server: UiServer, path: string, method = 'GET'): Promise<{ code: number; json: Json }> {
  const { code, body } = await fetchPath(server, path, method);
  return { code, json: JSON.parse(body) as Json };
}

function writeModule(path: string, body: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
}

function writePatch(home: string, body: string): void {
  mkdirSync(join(home, '.stepcast'), { recursive: true });
  writeFileSync(join(home, '.stepcast', 'plugins.patch.yml'), body);
}

describe('ui-screens: регистрация и снятие маршрута', () => {
  it('маршрут действующего экрана отвечает, отключение строки делает тот же запрос 404', async (t) => {
    const { runsRoot, home } = makeJournalBed();
    const server = await startServer(t, { runsRoot, home });

    const before = await fetchJson(server, '/api/backlog');
    assert.equal(before.code, 200);

    writePatch(home, 'version: 1\nkind: plugins-patch\nplugins:\n  - id: screen-backlog\n    use: stepcast:screen-backlog\n    enabled: false\n');

    const after = await fetchJson(server, '/api/backlog');
    assert.equal(after.code, 404);
    assert.match(String(after.json.error), /маршрут/i);

    // Демон не перезапускался — сосед отвечает по-прежнему.
    const sibling = await fetchJson(server, '/api/overview');
    assert.equal(sibling.code, 200);
  });
});

describe('ui-screens: состав экранов у демона', () => {
  it('GET /api/screens отдаёт объявления действующих экранов, их набор совпадает с отвечающими маршрутами', async (t) => {
    const { runsRoot, home } = makeJournalBed();
    const server = await startServer(t, { runsRoot, home });

    const { code, json } = await fetchJson(server, '/api/screens');
    assert.equal(code, 200);
    const screens = json.screens as Array<{ id: string; title: string; params: readonly string[] }>;
    const ids = screens.map((screen) => screen.id).sort();
    assert.deepEqual(ids, [
      'screen-agents',
      'screen-backlog',
      'screen-cleanup',
      'screen-decisions',
      'screen-pipelines',
      'screen-proposals',
      'screen-routes',
      'screen-run',
      'screen-runs',
      'screen-scrum',
      'screen-settings',
      'screen-steps',
      'screen-usage',
      'screen-widgets',
    ]);

    // Каждый названный экран, кроме безмаршрутного `screen-widgets`, отвечает.
    const routed: Record<string, string> = {
      'screen-runs': '/api/runs',
      'screen-pipelines': '/api/pipelines',
      'screen-steps': '/api/steps',
      'screen-backlog': '/api/backlog',
      'screen-usage': '/api/usage',
      'screen-cleanup': '/api/usage-records',
      'screen-agents': '/api/models',
      'screen-settings': '/api/settings',
    };
    for (const [id, path] of Object.entries(routed)) {
      const response = await fetchJson(server, path);
      assert.notEqual(response.code, 404, `${id} → ${path}`);
    }
  });

  it('домашний патч отключает экран: его нет в составе, маршрут отвечает 404, соседние экраны и их маршруты работают', async (t) => {
    const { runsRoot, home } = makeJournalBed();
    writePatch(home, 'version: 1\nkind: plugins-patch\nplugins:\n  - id: screen-steps\n    use: stepcast:screen-steps\n    enabled: false\n');
    const server = await startServer(t, { runsRoot, home });

    const screens = await fetchJson(server, '/api/screens');
    const ids = (screens.json.screens as Array<{ id: string }>).map((screen) => screen.id);
    assert.ok(!ids.includes('screen-steps'), ids.join(', '));
    assert.ok(ids.includes('screen-runs'), ids.join(', '));

    const disabled = await fetchJson(server, '/api/steps');
    assert.equal(disabled.code, 404);

    const sibling = await fetchJson(server, '/api/backlog');
    assert.equal(sibling.code, 200);
  });

  it('патч ставит на место строки встроенного экрана модуль пользователя: действуют его объявление и маршрут, встроенная половина не применяется, отказа по занятому маршруту нет', async (t) => {
    const { runsRoot, home } = makeJournalBed();
    writeModule(
      join(home, '.stepcast', 'my-usage.mjs'),
      `export default {
        name: 'user-usage',
        inject: ['screens', 'api'],
        apply(ctx) {
          ctx.screens.register({ id: 'screen-usage', title: 'Расход (свой)', params: [] });
          ctx.api.register('GET', '/api/usage', (req, res) => {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ custom: true }));
          });
        },
      };
      `,
    );
    writePatch(home, 'version: 1\nkind: plugins-patch\nplugins:\n  - id: screen-usage\n    use: ./my-usage.mjs\n');
    const server = await startServer(t, { runsRoot, home });

    const screens = await fetchJson(server, '/api/screens');
    const listed = screens.json.screens as Array<{ id: string; title: string; builtin: boolean }>;
    const usage = listed.find((screen) => screen.id === 'screen-usage');
    assert.equal(usage?.title, 'Расход (свой)');
    // Признак происхождения: страница по нему решает, вправе ли она взять
    // встроенную половину из своего бандла. У замены `id` тот же самый, и без
    // признака она показала бы встроенный экран вместо пользовательского.
    assert.equal(usage?.builtin, false);
    assert.equal(listed.find((screen) => screen.id === 'screen-runs')?.builtin, true);

    const response = await fetchJson(server, '/api/usage');
    assert.equal(response.code, 200);
    assert.equal(response.json.custom, true);
  });

  it('экран, объявленный дважды, — отказ сборки, называющий обе строки', async (t) => {
    const { runsRoot, home } = makeJournalBed();
    const twin = (name: string): string => `export default {
        name: '${name}',
        inject: ['screens'],
        apply(ctx) {
          ctx.screens.register({ id: 'screen-twin', title: 'Двойник', params: [] });
        },
      };
      `;
    writeModule(join(home, '.stepcast', 'twin-a.mjs'), twin('twin-a'));
    writeModule(join(home, '.stepcast', 'twin-b.mjs'), twin('twin-b'));
    writePatch(
      home,
      'version: 1\nkind: plugins-patch\nplugins:\n  - id: twin-a\n    use: ./twin-a.mjs\n  - id: twin-b\n    use: ./twin-b.mjs\n',
    );
    const server = await startServer(t, { runsRoot, home });

    const screens = await fetchJson(server, '/api/screens');
    const buildError = String(screens.json.buildError ?? '');
    assert.match(buildError, /screen-twin/);
    assert.match(buildError, /twin-a/);
    assert.match(buildError, /twin-b/);

    // Вторая строка не подменила первую молча: состав остался встроенным.
    const ids = (screens.json.screens as Array<{ id: string }>).map((screen) => screen.id);
    assert.ok(!ids.includes('screen-twin'), ids.join(', '));
  });
});

describe('ui-screens: владелец маршрута отключён', () => {
  it('экран уборки зовёт маршрут отключённого экрана прогонов и получает 404 с названием снятого маршрута', async (t) => {
    const { runsRoot, home } = makeJournalBed();
    const server = await startServer(t, { runsRoot, home });

    // До отключения отбор прогонов — маршрут `screen-runs` — обслуживает
    // вызовы уборки, не объявляя его второй раз (`ui-screens`, «Экран зовёт
    // чужой маршрут»).
    const before = await fetchJson(server, '/api/runs?trait=failed');
    assert.equal(before.code, 200);

    writePatch(home, 'version: 1\nkind: plugins-patch\nplugins:\n  - id: screen-runs\n    use: stepcast:screen-runs\n    enabled: false\n');

    const select = await fetchJson(server, '/api/runs?trait=failed');
    assert.equal(select.code, 404);
    // Витрина показывает отказ, а не пустой список: текст ответа несёт метод и
    // путь снятого маршрута, и `ui/src/api.ts` бросает его как ошибку запроса.
    assert.match(String(select.json.error), /GET \/api\/runs/);

    const remove = await fetchJson(server, '/api/runs', 'DELETE');
    assert.equal(remove.code, 404);
    assert.match(String(remove.json.error), /DELETE \/api\/runs/);

    // Свои маршруты уборки при этом целы — отключён владелец чужого, а не она.
    const own = await fetchJson(server, '/api/usage-records');
    assert.equal(own.code, 200);
  });
});

describe('ui-screens: маршрут принадлежит одной строке', () => {
  it('повтор пары «метод и путь» — отказ сборки, называющий обе строки; действующий состав остаётся встроенным', async (t) => {
    const { runsRoot, home } = makeJournalBed();
    writeModule(
      join(home, '.stepcast', 'dup-a.mjs'),
      `export default {
        name: 'dup-a',
        inject: ['api'],
        apply(ctx) { ctx.api.register('GET', '/api/custom-dup', () => {}); },
      };
      `,
    );
    writeModule(
      join(home, '.stepcast', 'dup-b.mjs'),
      `export default {
        name: 'dup-b',
        inject: ['api'],
        apply(ctx) { ctx.api.register('GET', '/api/custom-dup', () => {}); },
      };
      `,
    );
    writePatch(
      home,
      'version: 1\nkind: plugins-patch\nplugins:\n  - id: dup-a\n    use: ./dup-a.mjs\n  - id: dup-b\n    use: ./dup-b.mjs\n',
    );
    const server = await startServer(t, { runsRoot, home });

    const screens = await fetchJson(server, '/api/screens');
    assert.equal(screens.code, 200);
    const buildError = String(screens.json.buildError ?? '');
    assert.match(buildError, /GET/);
    assert.match(buildError, /\/api\/custom-dup/);
    assert.match(buildError, /dup-a/);
    assert.match(buildError, /dup-b/);

    // Отказ сборки при самом первом обходе — действующий состав встроенный:
    // обычные маршруты продолжают отвечать.
    const overview = await fetchJson(server, '/api/overview');
    assert.equal(overview.code, 200);
  });
});

describe('ui-screens: необъявленный адрес', () => {
  it('запрос под /api/, которого не объявила ни одна строка, отвечает 404 с объяснением', async (t) => {
    const { runsRoot, home } = makeJournalBed();
    const server = await startServer(t, { runsRoot, home });

    const missing = await fetchJson(server, `/api/${encodeURIComponent('нет-такого')}`);
    assert.equal(missing.code, 404);
    assert.match(String(missing.json.error), /маршрут/i);
  });
});

describe('ui-screens: отказ сборки не гасит витрину', () => {
  it('патч, сломанный при работающем демоне, не меняет действующий состав; причина приходит в /api/screens', async (t) => {
    const { runsRoot, home } = makeJournalBed();
    const server = await startServer(t, { runsRoot, home });

    const before = await fetchJson(server, '/api/backlog');
    assert.equal(before.code, 200);
    const screensBefore = await fetchJson(server, '/api/screens');
    assert.equal(screensBefore.json.buildError, undefined);

    writePatch(home, 'version: 1\nkind: plugins-patch\nplugins: [\n');

    const after = await fetchJson(server, '/api/backlog');
    assert.equal(after.code, 200, 'прежний состав продолжает отвечать');
    const screensAfter = await fetchJson(server, '/api/screens');
    assert.equal(screensAfter.code, 200);
    assert.ok(typeof screensAfter.json.buildError === 'string' && screensAfter.json.buildError.length > 0);
  });

  it('патч, сломанный при старте демона, даёт встроенный состав и называет причину', async (t) => {
    const { runsRoot, home } = makeJournalBed();
    writePatch(home, 'version: 1\nkind: plugins-patch\nplugins: [\n');
    const server = await startServer(t, { runsRoot, home });

    const screens = await fetchJson(server, '/api/screens');
    assert.equal(screens.code, 200);
    assert.ok(typeof screens.json.buildError === 'string' && screens.json.buildError.length > 0);
    const ids = (screens.json.screens as Array<{ id: string }>).map((screen) => screen.id);
    assert.ok(ids.includes('screen-runs'), ids.join(', '));

    const overview = await fetchJson(server, '/api/overview');
    assert.equal(overview.code, 200);
  });
});

describe('ui-screens: строка каркаса снята патчем', () => {
  it('патч, отключивший `ui-shell` вместе с экранами, не валит демон: маршруты отвечают встроенным составом, причина названа', async (t) => {
    const { runsRoot, home } = makeJournalBed();
    // Отключены и каркас, и все экраны: дерево собирается успешно — ждать
    // сервисов некому, — но ни реестра экранов, ни реестра маршрутов в нём
    // нет. Без разбора этого случая первое же обращение к составу дало бы
    // `TypeError` мимо всякого разбора отказа и уронило бы демон.
    const rows = ['ui-shell', 'screen-runs', 'screen-run', 'screen-pipelines', 'screen-steps', 'screen-widgets',
      'screen-backlog', 'screen-scrum', 'screen-usage', 'screen-cleanup', 'screen-agents', 'screen-settings', 'screen-routes',
      'screen-decisions', 'screen-proposals', 'ui-dashboards', 'ui-run-launch'];
    writePatch(
      home,
      `version: 1\nkind: plugins-patch\nplugins:\n${rows
        .map((id) => `  - id: ${id}\n    use: stepcast:${id}\n    enabled: false\n`)
        .join('')}`,
    );
    const server = await startServer(t, { runsRoot, home });

    const screens = await fetchJson(server, '/api/screens');
    assert.equal(screens.code, 200);
    assert.match(String(screens.json.buildError ?? ''), /ui-shell/);
    const ids = (screens.json.screens as Array<{ id: string }>).map((screen) => screen.id);
    assert.ok(ids.includes('screen-runs'), ids.join(', '));

    const overview = await fetchJson(server, '/api/overview');
    assert.equal(overview.code, 200);

    // Демон жив и на следующем запросе: отказ не оставил висящего отклонения.
    const again = await fetchJson(server, '/api/screens');
    assert.equal(again.code, 200);
  });

  it('пока ни одна сборка не удалась, настройки отказывают с причиной, а не выдают встроенные умолчания за конфигурацию пользователя', async (t) => {
    const { runsRoot, home } = makeJournalBed();
    mkdirSync(join(home, '.stepcast'), { recursive: true });
    writeFileSync(join(home, '.stepcast', 'config.yml'), 'defaults:\n  agent: claude\n  model: моя-модель\n');
    writePatch(home, 'version: 1\nkind: plugins-patch\nplugins: [\n');
    const server = await startServer(t, { runsRoot, home });

    const settings = await fetchJson(server, '/api/settings');
    assert.equal(settings.code, 500);
    assert.match(String(settings.json.error), /Настройки не читаются/);

    // Состав экранов при этом отдаётся: витрина открывается и называет причину.
    const screens = await fetchJson(server, '/api/screens');
    assert.equal(screens.code, 200);
    assert.ok(typeof screens.json.buildError === 'string');

    // Отказ не одноразовый: второй запрос отвечает тем же, а не выдаёт
    // запасное ядро за успешную сборку.
    const again = await fetchJson(server, '/api/settings');
    assert.equal(again.code, 500);
  });
});

describe('ui-screens: одна точка ядра демона', () => {
  it('запрос маршрута экрана и запрос настроек обслужены одним и тем же собственным контекстом демона', async (t) => {
    const { runsRoot, home } = makeJournalBed();
    const kernelCache = createKernelCache();
    const server = await startServer(t, { runsRoot, home, kernelCache });

    const backlog = await fetchJson(server, '/api/backlog');
    assert.equal(backlog.code, 200);
    assert.equal(kernelCache.entries.size, 1);
    const [entry] = [...kernelCache.entries.values()];

    const settings = await fetchJson(server, '/api/settings');
    assert.equal(settings.code, 200);
    // Тот же ключ, то же ядро — второй запрос не поднял его заново.
    assert.equal(kernelCache.entries.size, 1);
    assert.equal([...kernelCache.entries.values()][0], entry);
  });
});
