import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MENU, USAGE_PERIODS, isApiPath, isWidgetPath, parseRoute, runHref, widgetModuleHref } from '../src/ui/routes.js';

describe('ui-routes: разбор адресов', () => {
  it('строит и разбирает адрес прогона кругом', () => {
    // Ключ проекта и id прогона — сегменты раскладки журнала: слэш, как и в
    // адресе API (`isSafeSegment`), в них недопустим, а вот пробел, `&` и `%`
    // — как раз то, ради чего экранирование нужно.
    const projectKey = 'проект a b';
    const runId = 'ид с пробелом & знак%';
    const href = runHref(projectKey, runId);

    const route = parseRoute(href);
    assert.deepEqual(route, { page: 'run', projectKey, runId });
  });

  it('неизвестный путь даёт маршрут первого экрана', () => {
    assert.deepEqual(parseRoute('/что-то-ещё'), { page: 'runs' });
    assert.deepEqual(parseRoute('/'), { page: 'runs' });
  });

  it('/runs/<проект> без идентификатора прогона не признаётся адресом прогона', () => {
    assert.deepEqual(parseRoute('/runs/a'), { page: 'runs' });
  });

  it('/runs/<проект>/<прогон>/<хвост> не признаётся адресом прогона', () => {
    assert.deepEqual(parseRoute('/runs/a/b/c'), { page: 'runs' });
  });

  it('экраны меню разбираются каждый в свой маршрут', () => {
    assert.deepEqual(parseRoute('/pipelines'), { page: 'pipelines' });
    assert.deepEqual(parseRoute('/steps'), { page: 'steps' });
    assert.deepEqual(parseRoute('/widgets'), { page: 'widgets' });
    assert.deepEqual(parseRoute('/backlog'), { page: 'backlog' });
    assert.deepEqual(parseRoute('/settings'), { page: 'settings' });
    assert.deepEqual(parseRoute('/agents'), { page: 'agents' });
    assert.deepEqual(parseRoute('/cleanup'), { page: 'cleanup' });
  });

  it('хвост за адресом экрана очереди ведёт на первый экран', () => {
    assert.deepEqual(parseRoute('/backlog/что-то'), { page: 'runs' });
  });

  it('адрес каждого пункта меню ведёт на его же экран', () => {
    // Меню и разбор адреса знают об одних экранах: пункт, чей адрес разбирается
    // в другую страницу, вёл бы не туда, куда подписан.
    for (const item of MENU) {
      assert.equal(parseRoute(item.href).page, item.page, `пункт «${item.title}»`);
    }
  });

  it('хвост за именем экрана адресом экрана не признаётся', () => {
    assert.deepEqual(parseRoute('/settings/что-то'), { page: 'runs' });
  });

  it('страница прогона подсвечивает пункт «Прогоны»', () => {
    // Своего пункта у неё нет: пункт, на котором её не видно, оставил бы
    // открытый экран без отметки в меню вовсе.
    const owners = MENU.filter((item) => item.pages.includes('run'));
    assert.deepEqual(
      owners.map((item) => item.page),
      ['runs'],
    );
  });

  // Требование ui-dashboard: «Период — в адресе, пресетами» (design.md, Решение 5)
  it('/usage/<период> разбирается в маршрут расхода со своим числом дней', () => {
    assert.deepEqual(parseRoute('/usage'), { page: 'usage', days: 30 });
    assert.deepEqual(parseRoute('/usage/7d'), { page: 'usage', days: 7 });
    assert.deepEqual(parseRoute('/usage/30d'), { page: 'usage', days: 30 });
    assert.deepEqual(parseRoute('/usage/90d'), { page: 'usage', days: 90 });
    // «Всё время» не несёт нижней границы: дни отсутствуют, а не равны нулю.
    assert.deepEqual(parseRoute('/usage/all'), { page: 'usage' });
  });

  it('неизвестный период уводит на первый экран, как и всякий неизвестный адрес', () => {
    assert.deepEqual(parseRoute('/usage/вчера'), { page: 'runs' });
  });

  it('разбор адреса и переключатель периода на экране расхода знают один набор периодов', () => {
    assert.deepEqual(
      USAGE_PERIODS.map((period) => period.key),
      ['7d', '30d', '90d', 'all'],
    );
    for (const period of USAGE_PERIODS) {
      assert.deepEqual(parseRoute(`/usage/${period.key}`), {
        page: 'usage',
        ...(period.days === undefined ? {} : { days: period.days }),
      });
    }
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
});
