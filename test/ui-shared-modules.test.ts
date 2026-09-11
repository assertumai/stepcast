import assert from 'node:assert/strict';
import { get } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it, type TestContext } from 'node:test';

import {
  SHARED_MODULES,
  SHARED_MODULE_IMPORT_MAP,
  SHARED_MODULE_LIST,
  WIDGET_RUNTIME_GLOBAL,
  checkedRouteSegment,
  sharedModuleText,
  type SharedModuleSpecifier,
} from '../src/ui/sharedModules.js';
import { isSafeSegment, sharedModuleHref, widgetModuleHref } from '../src/ui/routes.js';
import { createUiServer, LOOPBACK, type UiServer } from '../src/ui/server.js';
import { createWidgetCompiler } from '../src/ui/widgets.js';
import { makeJournalBed } from './helpers.js';
import { tempDir } from './tmp.js';

/**
 * Таблица общих модулей (`src/ui/sharedModules.ts`, design.md изменения
 * `shared-module-table`, Решения 1—4): один перечень, из которого выведены
 * карта имён страницы, публикация экземпляров, адреса переходников, прокси
 * дев-сервера и `external` сборки — проверка ловит разъезд любой пары, а не
 * «неизвестный спецификатор» в чужом браузере.
 *
 * Имена `react`, `react-dom`, `react/jsx-runtime` и `cordis` — реальные
 * установленные пакеты, и перечень их реэкспортов сверяется здесь, узловым
 * тестом, с тем, что они действительно экспортируют (design.md, Решение 4).
 * `@stepcast/slots` и `@stepcast/ui` живут в `ui/` и узлу не видны — их
 * перечень сверяет браузерный тест (`ui/test/sharedSlots.test.tsx`,
 * `ui/test/components.test.tsx`).
 */

const NODE_VISIBLE_SPECIFIERS: readonly SharedModuleSpecifier[] = ['react', 'react-dom', 'react/jsx-runtime', 'cordis'];

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function missingNames(names: readonly string[], mod: Record<string, unknown>): string[] {
  return names.filter((name) => !Object.prototype.hasOwnProperty.call(mod, name));
}

describe('ui-shared-modules: перечень реэкспортируемых имён не расходится с модулем', () => {
  it('каждое объявленное имя действительно экспортируется установленной версией пакета', async () => {
    for (const specifier of NODE_VISIBLE_SPECIFIERS) {
      const mod = (await import(specifier)) as Record<string, unknown>;
      assert.deepEqual(
        missingNames(SHARED_MODULES[specifier].names, mod),
        [],
        `${specifier}: перечень разошёлся с реальным экспортом`,
      );
    }
  });

  it('отсутствующее в реальном экспорте имя проверка называет', async () => {
    const mod = (await import('react')) as Record<string, unknown>;
    const withBogusName = [...SHARED_MODULES.react.names, 'совсемНеСуществующееИмя'];
    assert.deepEqual(missingNames(withBogusName, mod), ['совсемНеСуществующееИмя']);
  });
});

describe('ui-shared-modules: сегмент адреса записи', () => {
  it('сегмент каждой записи таблицы — безопасный сегмент пути', () => {
    for (const entry of SHARED_MODULE_LIST) {
      assert.ok(isSafeSegment(entry.routeSegment), `${entry.specifier}: сегмент "${entry.routeSegment}" небезопасен`);
      assert.equal(checkedRouteSegment(entry), entry.routeSegment);
    }
  });

  it('небезопасный сегмент новой записи отклонён на выводе применений, а не уезжает в путь', () => {
    for (const bad of ['', 'react/dom', '..', '../react', 'react\\dom']) {
      assert.throws(
        () => checkedRouteSegment({ specifier: 'cordis', routeSegment: bad, hasDefault: false, names: [] }),
        /не годится сегментом пути/,
        `сегмент "${bad}" обязан быть отклонён`,
      );
    }
  });
});

describe('ui-shared-modules: текст переходника', () => {
  it('отказывает названной ошибкой без опубликованного экземпляра', async () => {
    const dir = tempDir('shared-module-');
    const file = join(dir, 'react.mjs');
    writeFileSync(file, sharedModuleText(SHARED_MODULES.react));

    await assert.rejects(import(pathToFileURL(file).href), /не опубликован витриной/);
  });

  it('реэкспортирует объявленные имена из опубликованного объекта', async () => {
    const dir = tempDir('shared-module-');
    const file = join(dir, 'react.mjs');
    writeFileSync(file, sharedModuleText(SHARED_MODULES.react));

    (globalThis as Record<string, unknown>)[WIDGET_RUNTIME_GLOBAL] = { react: { useState: 'маркер' } };
    try {
      const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
      assert.equal(mod.useState, 'маркер');
    } finally {
      delete (globalThis as Record<string, unknown>)[WIDGET_RUNTIME_GLOBAL];
    }
  });

  it('переходники react и react-dom дают экспорт по умолчанию, jsx-runtime и cordis — нет', () => {
    assert.match(sharedModuleText(SHARED_MODULES.react), /export default /);
    assert.match(sharedModuleText(SHARED_MODULES['react-dom']), /export default /);
    assert.doesNotMatch(sharedModuleText(SHARED_MODULES['react/jsx-runtime']), /export default /);
    assert.doesNotMatch(sharedModuleText(SHARED_MODULES.cordis), /export default /);
  });

  it('идиома `import React, { useState } from "react"` связывается с переходником', async () => {
    const dir = tempDir('shared-module-default-');
    const shim = join(dir, 'react.mjs');
    writeFileSync(shim, sharedModuleText(SHARED_MODULES.react));
    const widget = join(dir, 'widget.mjs');
    writeFileSync(
      widget,
      "import React, { useState } from './react.mjs';\nexport const pair = [React.useState, useState];\n",
    );

    const instance = { useState: 'маркер' };
    (globalThis as Record<string, unknown>)[WIDGET_RUNTIME_GLOBAL] = { react: instance };
    try {
      const mod = (await import(pathToFileURL(widget).href)) as { readonly pair: readonly unknown[] };
      assert.deepEqual(mod.pair, ['маркер', 'маркер']);
    } finally {
      delete (globalThis as Record<string, unknown>)[WIDGET_RUNTIME_GLOBAL];
    }
  });

  it('экспортом по умолчанию идёт сам объект, а не пространство имён вокруг него', async () => {
    const dir = tempDir('shared-module-namespace-');
    const file = join(dir, 'react.mjs');
    writeFileSync(file, sharedModuleText(SHARED_MODULES.react));

    const instance = { useState: 'маркер' };
    (globalThis as Record<string, unknown>)[WIDGET_RUNTIME_GLOBAL] = {
      react: { ...instance, default: instance },
    };
    try {
      const mod = (await import(pathToFileURL(file).href)) as { readonly default: unknown };
      assert.equal(mod.default, instance);
    } finally {
      delete (globalThis as Record<string, unknown>)[WIDGET_RUNTIME_GLOBAL];
    }
  });
});

describe('ui-shared-modules: карта имён страницы', () => {
  /** Карта имён разметки — объект `imports` единственного `<script type="importmap">`. */
  function pageImportMap(html: string): Record<string, string> {
    const block = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(block !== null, 'разметка витрины обязана нести карту имён');
    const parsed = JSON.parse((block as RegExpExecArray)[1] as string) as {
      readonly imports?: Record<string, string>;
    };
    assert.ok(parsed.imports !== undefined, 'карта имён обязана нести раздел imports');
    return parsed.imports as Record<string, string>;
  }

  it('карта имён разметки совпадает с таблицей', () => {
    const html = readFileSync(join(ROOT, 'ui', 'index.html'), 'utf8');
    assert.deepEqual(pageImportMap(html), SHARED_MODULE_IMPORT_MAP);
  });

  it('карта имён объявлена до первого модульного скрипта страницы', () => {
    const html = readFileSync(join(ROOT, 'ui', 'index.html'), 'utf8');
    const map = html.indexOf('<script type="importmap">');
    const firstModule = html.indexOf('<script type="module"');
    assert.ok(map >= 0 && firstModule >= 0);
    assert.ok(map < firstModule, 'карта имён после модульного скрипта браузером не применяется');
  });

  it('дев-сервер проксирует на демон каждую форму адреса — виджет и каждое имя таблицы', () => {
    const config = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
    // Записи прокси — ровно те, чья цель демон; ключ записи и есть префикс пути.
    const prefixes = [...config.matchAll(/'([^']+)':\s*\{\s*target:\s*DAEMON/g)].map((match) => match[1] as string);
    assert.ok(prefixes.length > 0, 'перечень прокси дев-сервера не разобран');

    // `/plugins` — не форма адреса общих модулей, и её прокси-запись — своя
    // задача (у дев-сервера этого репозитория её сегодня нет вовсе); эта
    // проверка про то, что меняет `shared-module-table`.
    const addresses = [widgetModuleHref('ключ', 'clock', '1:2'), ...Object.values(SHARED_MODULE_IMPORT_MAP)];
    for (const address of addresses) {
      assert.ok(
        prefixes.some((prefix) => address.startsWith(prefix)),
        `адрес ${address} не покрыт ни одной записью прокси (${prefixes.join(', ')})`,
      );
    }
  });
});

/** Сервер с закрытием, зарегистрированным сразу — тем же приёмом, что в `test/ui-server.test.ts`. */
async function startServer(t: TestContext, runsRoot: string): Promise<UiServer> {
  const server = await createUiServer({ runsRoot, port: 0 });
  t.after(() => server.close());
  return server;
}

interface FetchedWithHeaders {
  readonly code: number;
  readonly body: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

function fetchPath(server: UiServer, path: string): Promise<FetchedWithHeaders> {
  return new Promise((resolve, reject) => {
    get({ host: LOOPBACK, port: server.port, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ code: res.statusCode ?? 0, body, headers: res.headers }));
    }).on('error', reject);
  });
}

describe('ui-shared-modules: демон отдаёт переходник по /shared/<имя>.js', () => {
  it('каждое имя таблицы отдаётся исполняемым JS и отказывает без опубликованного экземпляра', async (t) => {
    const { runsRoot } = makeJournalBed();
    const server = await startServer(t, runsRoot);

    for (const entry of SHARED_MODULE_LIST) {
      const res = await fetchPath(server, sharedModuleHref(entry.routeSegment));
      assert.equal(res.code, 200, entry.specifier);
      assert.match(String(res.headers['content-type']), /text\/javascript/, entry.specifier);
      assert.match(res.body, /не опубликован витриной/, entry.specifier);
    }
  });

  it('сегмент вне таблицы и прежний адрес /widgets/runtime/ дают 404', async (t) => {
    const { runsRoot } = makeJournalBed();
    const server = await startServer(t, runsRoot);

    const unknown = await fetchPath(server, '/shared/lodash.js');
    const bareDir = await fetchPath(server, '/shared/');
    const oldAddress = await fetchPath(server, '/widgets/runtime/react.js');

    assert.equal(unknown.code, 404);
    assert.equal(bareDir.code, 404);
    assert.equal(oldAddress.code, 404);
  });
});

describe('ui-shared-modules: перечень внешних имён сборки равен таблице', () => {
  it('каждое имя таблицы остаётся голым внешним импортом в собранном бандле', async () => {
    const home = tempDir('shared-module-bundle-');
    const dir = join(home, 'plugin');
    mkdirSync(dir, { recursive: true });
    const importLines = SHARED_MODULE_LIST.map(
      (entry, index) => `import * as m${index} from ${JSON.stringify(entry.specifier)};`,
    ).join('\n');
    const useLines = SHARED_MODULE_LIST.map((_, index) => `m${index}`).join(', ');
    writeFileSync(
      join(dir, 'index.tsx'),
      `${importLines}\nexport default function plugin() { return [${useLines}]; }\n`,
    );

    const compiler = createWidgetCompiler();
    const outcome = await compiler.compileBundle(join(dir, 'index.tsx'), 'v1');
    await compiler.dispose();

    assert.equal(outcome?.kind, 'ok', JSON.stringify(outcome));
    const code = (outcome as { readonly kind: 'ok'; readonly code: string }).code;
    for (const entry of SHARED_MODULE_LIST) {
      assert.match(code, new RegExp(`from "${entry.specifier.replace('/', '\\/')}"`), entry.specifier);
    }
  });
});
