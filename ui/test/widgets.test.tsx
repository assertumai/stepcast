import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { MigrateAction, MIGRATE_PIPELINE, Widgets, startMigration } from '../src/pages/Widgets';
import type { ProjectWidgetsView, WidgetsOverview } from '../src/api';

/**
 * `ui-widgets`, «Экран виджетов показывает причину устаревания и предлагает
 * миграцию»: причина и кнопка «мигрировать» видны только у проекта с
 * устаревшим виджетом, а не у любого проекта вовсе.
 *
 * Вызов маршрута проверяется чистой функцией `startMigration`, а ветки исхода
 * — статическим рендером первого состояния: у витрины нет инфраструктуры
 * интерактивных проверок (`fireEvent`/`act`), и тем же приёмом живут проверки
 * экрана «Решения» (`ui/test/decisions.test.tsx`).
 */

function projectWith(widgets: ProjectWidgetsView['widgets']): WidgetsOverview {
  return { generatedAt: '2026-01-01T00:00:00.000Z', projects: [{ projectKey: 'proj', widgets }] };
}

describe('ui-widgets: причина устаревания и действие миграции', () => {
  it('устаревший виджет показывает причину и кнопку «мигрировать»', () => {
    const overview = projectWith([
      { id: 'gauge', version: '1:1', deprecated: { kind: 'name', name: 'NotAName' } },
    ]);
    const html = renderToStaticMarkup(<Widgets overview={undefined} widgets={overview} />);
    assert.match(html, /NotAName/);
    assert.match(html, />мигрировать</);
  });

  it('ушедший целиком специфик назван спецификатором, а не именем', () => {
    const overview = projectWith([
      { id: 'gauge', version: '1:1', deprecated: { kind: 'specifier', name: 'gone-module' } },
    ]);
    const html = renderToStaticMarkup(<Widgets overview={undefined} widgets={overview} />);
    assert.match(html, /спецификатор/);
    assert.match(html, /gone-module/);
  });

  it('запись о смене, если она есть, тоже видна в причине', () => {
    const overview = projectWith([
      { id: 'gauge', version: '1:1', deprecated: { kind: 'name', name: 'NotAName', noteText: 'замените на Button' } },
    ]);
    const html = renderToStaticMarkup(<Widgets overview={undefined} widgets={overview} />);
    assert.match(html, /замените на Button/);
  });

  it('проект без устаревших виджетов действия миграции не показывает', () => {
    const overview = projectWith([{ id: 'clock', version: '1:1' }]);
    const html = renderToStaticMarkup(<Widgets overview={undefined} widgets={overview} />);
    assert.doesNotMatch(html, />мигрировать</);
  });

  it('загрузка — сообщение, а не отказ', () => {
    const html = renderToStaticMarkup(<Widgets overview={undefined} widgets={undefined} />);
    assert.match(html, /Загрузка/);
  });
});

describe('ui-widgets: запуск миграции', () => {
  it('зовёт маршрут запуска с пайплайном поставки и названным проектом', async () => {
    const calls: Array<{ project: string; pipeline: string }> = [];
    const outcome = await startMigration('proj', async (payload) => {
      calls.push({ ...payload });
      return { ok: true };
    });

    assert.deepEqual(calls, [{ project: 'proj', pipeline: 'stepcast:migrate-widgets' }]);
    assert.equal(MIGRATE_PIPELINE, 'stepcast:migrate-widgets');
    assert.deepEqual(outcome, { status: 'done' });
  });

  it('отказ запуска становится исходом с причиной, а не брошенной ошибкой', async () => {
    const outcome = await startMigration('proj', () => Promise.reject(new Error('проект неизвестен')));
    assert.deepEqual(outcome, { status: 'error', error: 'проект неизвестен' });
  });

  /** Приём подтверждается, а не обещается результат (`ui-widgets`, «Запуск подтверждается, а не обещает результат»). */
  it('подтверждение приёма не обещает результата миграции', () => {
    const html = renderToStaticMarkup(<MigrateAction projectKey="proj" initialStatus="done" />);
    assert.match(html, /запуск принят/);
    assert.doesNotMatch(html, /мигрирован|исправлен/);
  });

  it('отказ запуска показан на месте действия', () => {
    const html = renderToStaticMarkup(
      <MigrateAction projectKey="proj" initialStatus="error" initialError="проект неизвестен" />,
    );
    assert.match(html, /notice error/);
    assert.match(html, /проект неизвестен/);
  });

  it('до нажатия ни подтверждения, ни отказа на экране нет', () => {
    const html = renderToStaticMarkup(<MigrateAction projectKey="proj" />);
    assert.match(html, />мигрировать</);
    assert.doesNotMatch(html, /запуск принят/);
    assert.doesNotMatch(html, /notice error/);
  });
});
