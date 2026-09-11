import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isApiPath,
  isPluginPath,
  isWidgetPath,
  hrefFor,
  parseRoute,
  pluginModuleHref,
  widgetModuleHref,
  type RouteScreen,
} from '../src/ui/routes.js';
import { declaration as agents } from '../src/ui/screens/agents/declaration.js';
import { declaration as backlog } from '../src/ui/screens/backlog/declaration.js';
import { declaration as cleanup } from '../src/ui/screens/cleanup/declaration.js';
import { declaration as pipelines } from '../src/ui/screens/pipelines/declaration.js';
import { declaration as run } from '../src/ui/screens/run/declaration.js';
import { declaration as runs } from '../src/ui/screens/runs/declaration.js';
import { declaration as settings } from '../src/ui/screens/settings/declaration.js';
import { declaration as steps } from '../src/ui/screens/steps/declaration.js';
import { declaration as usage } from '../src/ui/screens/usage/declaration.js';
import { declaration as widgets } from '../src/ui/screens/widgets/declaration.js';

/** Таблица всех десяти встроенных экранов — то, что демон и витрина держат в действующем составе. */
const ALL_SCREENS: ReadonlyMap<string, RouteScreen> = new Map(
  [runs, run, pipelines, steps, widgets, backlog, usage, cleanup, agents, settings].map((screen) => [
    screen.id,
    screen,
  ]),
);

describe('ui-routes: разбор адресов по таблице экранов', () => {
  it('строит и разбирает адрес прогона кругом', () => {
    // Ключ проекта и id прогона — сегменты раскладки журнала: слэш, как и в
    // адресе API (`isSafeSegment`), в них недопустим, а вот пробел, `&` и `%`
    // — как раз то, ради чего экранирование нужно.
    const projectKey = 'проект a b';
    const runId = 'ид с пробелом & знак%';
    const href = hrefFor(run.id, { projectKey, runId }, ALL_SCREENS);

    assert.deepEqual(parseRoute(href, ALL_SCREENS), { screenId: run.id, params: { projectKey, runId } });
  });

  it('неизвестный путь ведёт на экран с наименьшим местом в навигации', () => {
    assert.deepEqual(parseRoute('/что-то-ещё', ALL_SCREENS), { screenId: runs.id, params: {} });
    assert.deepEqual(parseRoute('/', ALL_SCREENS), { screenId: runs.id, params: {} });
  });

  it('/runs/<проект> без идентификатора прогона не признаётся адресом прогона', () => {
    assert.deepEqual(parseRoute('/runs/a', ALL_SCREENS), { screenId: runs.id, params: {} });
  });

  it('/runs/<проект>/<прогон>/<хвост> не признаётся адресом прогона', () => {
    assert.deepEqual(parseRoute('/runs/a/b/c', ALL_SCREENS), { screenId: runs.id, params: {} });
  });

  it('небезопасный сегмент параметра не признаётся адресом экрана', () => {
    assert.deepEqual(parseRoute('/runs/../b', ALL_SCREENS), { screenId: runs.id, params: {} });
  });

  it('каждый объявленный путь разбирается в свой id', () => {
    for (const screen of [pipelines, steps, widgets, backlog, cleanup, agents, settings]) {
      assert.deepEqual(parseRoute(screen.path, ALL_SCREENS), { screenId: screen.id, params: {} }, screen.id);
    }
  });

  it('хвост за адресом экрана без параметров ведёт на экран по умолчанию', () => {
    assert.deepEqual(parseRoute('/backlog/что-то', ALL_SCREENS), { screenId: runs.id, params: {} });
    assert.deepEqual(parseRoute('/settings/что-то', ALL_SCREENS), { screenId: runs.id, params: {} });
  });

  it('hrefFor даёт адрес, который parseRoute разбирает обратно в тот же id', () => {
    for (const screen of ALL_SCREENS.values()) {
      if (screen.nav === undefined) continue; // у экрана без параметров и без пункта меню (run) свой круговой тест выше
      const href = hrefFor(screen.id, {}, ALL_SCREENS);
      assert.deepEqual(parseRoute(href, ALL_SCREENS), { screenId: screen.id, params: {} }, screen.id);
    }
  });

  it('hrefFor неизвестного id даёт корень, а не бросает исключение', () => {
    assert.equal(hrefFor('screen-нет-такого', {}, ALL_SCREENS), '/');
  });

  // Требование ui-dashboard: «Период — в адресе, пресетами» (design.md изменения ui-dashboard, Решение 5).
  // `:period?` — необязательный параметр: голый /usage разбирается тем же
  // экраном, что и /usage/<значение>. Перечень значений объявляет сам экран
  // (`paramValues` объявления), а разбор адреса остаётся общим и имён
  // пресетов не знает (design.md, Решение 10) — он лишь сверяется с
  // объявленным перечнем.
  it('/usage/<период> разбирается в screen-usage c параметром period', () => {
    assert.deepEqual(parseRoute('/usage', ALL_SCREENS), { screenId: usage.id, params: {} });
    assert.deepEqual(parseRoute('/usage/7d', ALL_SCREENS), { screenId: usage.id, params: { period: '7d' } });
    assert.deepEqual(parseRoute('/usage/30d', ALL_SCREENS), { screenId: usage.id, params: { period: '30d' } });
    assert.deepEqual(parseRoute('/usage/90d', ALL_SCREENS), { screenId: usage.id, params: { period: '90d' } });
    assert.deepEqual(parseRoute('/usage/all', ALL_SCREENS), { screenId: usage.id, params: { period: 'all' } });
  });

  it('значение периода вне объявленного перечня — неизвестный адрес: ведёт на экран по умолчанию, как вёл до перевода', () => {
    // Перечень закрыт объявлением экрана (`paramValues`), поэтому
    // `/usage/вчера` этому экрану не принадлежит вовсе и разбирается как
    // любой другой неизвестный адрес — экраном по умолчанию (`ui-screens`,
    // «Переведённые экраны не меняют поведения»: прежний `parseRoute` уводил
    // такой адрес на экран прогонов, а не открывал расход за подставленный
    // период).
    assert.deepEqual(parseRoute('/usage/вчера', ALL_SCREENS), { screenId: runs.id, params: {} });
    assert.deepEqual(parseRoute('/usage/7', ALL_SCREENS), { screenId: runs.id, params: {} });
  });

  it('параметр без объявленного перечня принимает любой безопасный сегмент', () => {
    assert.deepEqual(parseRoute('/runs/проект/прогон-17', ALL_SCREENS), {
      screenId: run.id,
      params: { projectKey: 'проект', runId: 'прогон-17' },
    });
  });

  it('/api/... не признаётся адресом страницы', () => {
    assert.equal(isApiPath('/api/overview'), true);
    assert.equal(isApiPath('/api'), true);
    assert.equal(isApiPath('/runs/a/b'), false);
    assert.equal(isApiPath('/'), false);
  });

  it('isWidgetPath истинен для обеих объявленных форм и для любого пути под /widgets/', () => {
    assert.equal(isWidgetPath('/widgets/proj/clock.js'), true);
    assert.equal(isWidgetPath('/widgets/runtime/react.js'), true);
    // Любой путь под /widgets/, не совпадающий ни с одной формой, — тоже
    // предмет демона: он обязан ответить 404, а не отдать страницу витрины.
    assert.equal(isWidgetPath('/widgets/proj/clock.ts'), true);
    assert.equal(isWidgetPath('/widgets/'), true);
  });

  it('isWidgetPath ложен для голого /widgets — это адрес экрана меню', () => {
    assert.equal(isWidgetPath('/widgets'), false);
    assert.equal(isWidgetPath('/runs'), false);
    assert.equal(isWidgetPath('/'), false);
  });

  it('widgetModuleHref экранирует сегменты и несёт версию параметром', () => {
    const href = widgetModuleHref('проект a', 'clock b', '123:45');
    assert.equal(href, `/widgets/${encodeURIComponent('проект a')}/${encodeURIComponent('clock b')}.js?v=123%3A45`);
    assert.equal(isWidgetPath(href), true);
  });

  it('pluginModuleHref экранирует сегмент и несёт версию параметром', () => {
    const href = pluginModuleHref('плагин a', 'abc:123');
    assert.equal(href, `/plugins/${encodeURIComponent('плагин a')}.js?v=abc%3A123`);
    assert.equal(isPluginPath(href), true);
  });

  it('isPluginPath истинен для любого пути под /plugins/, ложен для голого /plugins и адресов экранов', () => {
    assert.equal(isPluginPath('/plugins/example.js'), true);
    assert.equal(isPluginPath('/plugins/'), true);
    // Голый `/plugins` без хвостового разделителя — не адрес этого демонского
    // механизма: у него нет экрана меню, но предикат остаётся симметричным
    // `isWidgetPath` ровно в этой части.
    assert.equal(isPluginPath('/plugins'), false);
    assert.equal(isPluginPath('/widgets/proj/clock.js'), false);
    assert.equal(isPluginPath('/'), false);
  });
});
