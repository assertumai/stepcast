import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isApiPath, parseRoute, runHref } from '../src/ui/routes.js';

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
    assert.deepEqual(parseRoute('/что-то-ещё'), { page: 'pipelines' });
    assert.deepEqual(parseRoute('/'), { page: 'pipelines' });
  });

  it('/runs/<проект> без идентификатора прогона не признаётся адресом прогона', () => {
    assert.deepEqual(parseRoute('/runs/a'), { page: 'pipelines' });
  });

  it('/runs/<проект>/<прогон>/<хвост> не признаётся адресом прогона', () => {
    assert.deepEqual(parseRoute('/runs/a/b/c'), { page: 'pipelines' });
  });

  it('/api/... не признаётся адресом страницы', () => {
    assert.equal(isApiPath('/api/overview'), true);
    assert.equal(isApiPath('/api'), true);
    assert.equal(isApiPath('/runs/a/b'), false);
    assert.equal(isApiPath('/'), false);
  });
});
