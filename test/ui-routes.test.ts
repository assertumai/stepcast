import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  hrefFor,
  hrefForRoute,
  isApiPath,
  isPluginPath,
  isReservedPath,
  isSharedPath,
  isWidgetPath,
  normalizedTemplate,
  parseRoute,
  paramPlaceholderNames,
  pluginModuleHref,
  substituteParams,
  templateParamNames,
  widgetModuleHref,
  type RouteDefinition,
  type RouteTable,
} from '../src/parts/ui/routes.js';

/** Небольшая таблица маршрутов, покрывающая специфичность, необязательный сегмент и перечень значений. */
const TABLE: RouteTable = [
  { id: 'runs', path: '/', target: { kind: 'screen', id: 'screen-runs' } },
  { id: 'run', path: '/runs/:projectKey/:runId', target: { kind: 'screen', id: 'screen-run' } },
  { id: 'runs-new', path: '/runs/new', target: { kind: 'screen', id: 'screen-runs-new' } },
  {
    id: 'usage',
    path: '/usage/:period?',
    target: { kind: 'screen', id: 'screen-usage' },
    values: { period: ['7d', '30d', '90d', 'all'] },
  },
  { id: 'widget-page', path: '/w/:id', target: { kind: 'widget', id: 'proj/clock' }, params: { note: '${params.id}' } },
];

describe('ui-routes: разбор адреса по таблице маршрутов', () => {
  it('строит и разбирает адрес прогона кругом', () => {
    const projectKey = 'проект a b';
    const runId = 'ид с пробелом & знак%';
    const href = hrefFor({ kind: 'screen', id: 'screen-run' }, { projectKey, runId }, TABLE);
    assert.ok(href !== undefined);
    const matched = parseRoute(href!, TABLE);
    assert.deepEqual(matched?.pathParams, { projectKey, runId });
    assert.equal(matched?.route.id, 'run');
  });

  it('статический сегмент побеждает параметр независимо от порядка строк', () => {
    const dynamic: RouteDefinition = { id: 'run-by-id', path: '/runs/:id', target: { kind: 'screen', id: 'screen-run-by-id' } };
    const staticRoute: RouteDefinition = { id: 'runs-new', path: '/runs/new', target: { kind: 'screen', id: 'screen-runs-new' } };
    assert.equal(parseRoute('/runs/new', [dynamic, staticRoute])?.route.id, 'runs-new');
    assert.equal(parseRoute('/runs/new', [staticRoute, dynamic])?.route.id, 'runs-new');
  });

  it('необязательный последний сегмент разбирается и без значения, и со значением', () => {
    assert.deepEqual(parseRoute('/usage', TABLE)?.pathParams, {});
    assert.deepEqual(parseRoute('/usage/7d', TABLE)?.pathParams, { period: '7d' });
  });

  it('значение вне закрытого перечня — неразобранный адрес', () => {
    assert.equal(parseRoute('/usage/вчера', TABLE), undefined);
  });

  it('неразобранный адрес отдаёт undefined, а не подмену другой целью', () => {
    assert.equal(parseRoute('/что-то-ещё', TABLE), undefined);
    assert.equal(parseRoute('/runs/a/b/c', TABLE), undefined);
    assert.equal(parseRoute('/runs/../b', TABLE), undefined);
  });

  it('hrefFor берёт первый по таблице маршрут, ведущий к цели', () => {
    assert.equal(hrefFor({ kind: 'screen', id: 'screen-runs' }, {}, TABLE), '/');
  });

  it('hrefFor цели без маршрута отдаёт undefined, а не корень', () => {
    assert.equal(hrefFor({ kind: 'screen', id: 'screen-нет-такого' }, {}, TABLE), undefined);
  });

  it('hrefForRoute отдаёт адрес своего маршрута, а не первый по таблице адрес той же цели', () => {
    // Ровно случай пользовательского маршрута: своя строка на ту же цель, что
    // и встроенная. Поиск по цели вернул бы `/` — адрес встроенной строки.
    const mine: RouteDefinition = { id: 'release', path: '/release', target: { kind: 'screen', id: 'screen-runs' } };
    assert.equal(hrefFor(mine.target, {}, [...TABLE, mine]), '/');
    assert.equal(hrefForRoute(mine), '/release');
  });

  it('hrefForRoute отдаёт undefined, когда обязательный параметр шаблона не назван', () => {
    const run = TABLE[1] as RouteDefinition;
    assert.equal(hrefForRoute(run), undefined);
    assert.equal(hrefForRoute(run, { projectKey: 'p', runId: 'r' }), '/runs/p/r');
  });

  it('параметры цели подставляются значениями параметров пути', () => {
    const matched = parseRoute('/w/clock-1', TABLE);
    assert.deepEqual(matched?.targetParams, { note: 'clock-1' });
  });

  it('normalizedTemplate считает разные имена параметров одним и тем же адресом', () => {
    assert.equal(normalizedTemplate('/runs/:projectKey/:runId'), normalizedTemplate('/runs/:a/:b'));
    assert.notEqual(normalizedTemplate('/runs/:id'), normalizedTemplate('/runs/new'));
  });

  it('templateParamNames и paramPlaceholderNames', () => {
    assert.deepEqual(templateParamNames('/runs/:projectKey/:runId'), ['projectKey', 'runId']);
    assert.deepEqual(paramPlaceholderNames('${params.a}-${params.b}'), ['a', 'b']);
  });

  it('substituteParams заменяет плейсхолдеры значениями и допускает литералы', () => {
    assert.equal(substituteParams('prefix-${params.id}', { id: '42' }), 'prefix-42');
    assert.equal(substituteParams('literal', {}), 'literal');
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
    assert.equal(isPluginPath('/plugins'), false);
    assert.equal(isPluginPath('/widgets/proj/clock.js'), false);
    assert.equal(isPluginPath('/'), false);
  });

  it('isReservedPath покрывает все четыре зарезервированных префикса', () => {
    assert.equal(isReservedPath('/api/x'), true);
    assert.equal(isReservedPath('/widgets/x'), true);
    assert.equal(isReservedPath('/plugins/x'), true);
    assert.equal(isReservedPath('/shared/x'), true);
    assert.equal(isReservedPath('/runs'), false);
  });

  it('isSharedPath ложен для голого /shared', () => {
    assert.equal(isSharedPath('/shared/cordis.js'), true);
    assert.equal(isSharedPath('/shared'), false);
  });
});
