import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import {
  CatalogCard,
  MigrateAction,
  MIGRATE_PIPELINE,
  Widgets,
  installableProjects,
  projectName,
  startInstall,
  startMigration,
} from '../src/pages/Widgets';
import type { BuiltinWidgetView, Overview, ProjectWidgetsView, WidgetsOverview } from '../src/api';

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
    assert.match(html, />Migrate</);
  });

  it('ушедший целиком специфик назван спецификатором, а не именем', () => {
    const overview = projectWith([
      { id: 'gauge', version: '1:1', deprecated: { kind: 'specifier', name: 'gone-module' } },
    ]);
    const html = renderToStaticMarkup(<Widgets overview={undefined} widgets={overview} />);
    assert.match(html, /specifier/);
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
    assert.doesNotMatch(html, />Migrate</);
  });

  it('проект без виджетов на экране не показывается вовсе', () => {
    const overview: WidgetsOverview = {
      generatedAt: '2026-01-01T00:00:00.000Z',
      projects: [
        { projectKey: 'empty', widgets: [] },
        { projectKey: 'proj', widgets: [{ id: 'clock', version: '1:1' }] },
      ],
    };
    const html = renderToStaticMarkup(<Widgets overview={undefined} widgets={overview} />);
    assert.match(html, /proj/);
    assert.doesNotMatch(html, /empty/);
    assert.doesNotMatch(html, /No project has widgets yet/);
  });

  it('ни одного виджета ни у одного проекта — одно объяснение, а не пустые секции', () => {
    const overview: WidgetsOverview = {
      generatedAt: '2026-01-01T00:00:00.000Z',
      projects: [
        { projectKey: 'a', widgets: [] },
        { projectKey: 'b', widgets: [] },
      ],
    };
    const html = renderToStaticMarkup(<Widgets overview={undefined} widgets={overview} />);
    assert.match(html, /No project has widgets yet/);
  });

  it('загрузка — сообщение, а не отказ', () => {
    const html = renderToStaticMarkup(<Widgets overview={undefined} widgets={undefined} />);
    assert.match(html, /Loading/);
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
    assert.match(html, /Launch accepted/);
    assert.doesNotMatch(html, /migrated|fixed/);
  });

  it('отказ запуска показан на месте действия', () => {
    const html = renderToStaticMarkup(
      <MigrateAction projectKey="proj" initialStatus="error" initialError="проект неизвестен" />,
    );
    assert.match(html, /sc-alert--destructive/);
    assert.match(html, /проект неизвестен/);
  });

  it('до нажатия ни подтверждения, ни отказа на экране нет', () => {
    const html = renderToStaticMarkup(<MigrateAction projectKey="proj" />);
    assert.match(html, />Migrate</);
    assert.doesNotMatch(html, /Launch accepted/);
    assert.doesNotMatch(html, /sc-alert--destructive/);
  });
});

describe('ui-widgets: каталог поставки', () => {
  const catalog: readonly BuiltinWidgetView[] = [
    { id: 'clock', description: 'A ticking clock.', version: '1:1' },
    { id: 'projects', description: 'Projects the daemon knows.', version: '1:2' },
  ];
  const overview: Overview = {
    generatedAt: '2026-01-01T00:00:00.000Z',
    projects: [
      { key: 'k1', path: '/home/me/alpha', runs: [] },
      { key: 'k2', runs: [] },
    ],
  };

  it('карточка каталога — идентификатор, описание, превью по ключу builtin и кнопка добавления', () => {
    const html = renderToStaticMarkup(<Widgets overview={overview} widgets={projectWith([])} catalog={catalog} />);
    assert.match(html, /Catalog/);
    assert.match(html, />clock</);
    assert.match(html, /A ticking clock\./);
    assert.match(html, />Add to project</);
  });

  it('в список проектов попадают только проекты с известным путём, подпись — последний сегмент', () => {
    assert.deepEqual(installableProjects(overview), [{ key: 'k1', path: '/home/me/alpha' }]);
    assert.equal(projectName('/home/me/alpha', 'k1'), 'alpha');
    assert.equal(projectName(undefined, 'k2'), 'k2');
  });

  it('без проектов кнопки добавления нет — объяснение на месте', () => {
    const html = renderToStaticMarkup(<CatalogCard widget={catalog[0]!} projects={[]} />);
    assert.match(html, /No projects to add to/);
    assert.doesNotMatch(html, />Add to project</);
  });

  it('установка зовёт маршрут с ключом проекта и идентификатором; отказ становится исходом', async () => {
    const calls: Array<{ projectKey: string; id: string }> = [];
    const ok = await startInstall('k1', 'clock', async (payload) => {
      calls.push({ ...payload });
      return { installed: payload };
    });
    assert.deepEqual(calls, [{ projectKey: 'k1', id: 'clock' }]);
    assert.deepEqual(ok, { status: 'done' });
    const failed = await startInstall('k1', 'clock', () => Promise.reject(new Error('already exists')));
    assert.deepEqual(failed, { status: 'error', error: 'already exists' });
  });

  it('отказ установки показан на месте карточки, подтверждение — строкой', () => {
    const projects = installableProjects(overview);
    const error = renderToStaticMarkup(<CatalogCard widget={catalog[0]!} projects={projects} initialStatus="error" initialError="already exists" />);
    assert.match(error, /sc-alert--destructive/);
    assert.match(error, /already exists/);
    const done = renderToStaticMarkup(<CatalogCard widget={catalog[0]!} projects={projects} initialStatus="done" />);
    assert.match(done, /Added — it now shows under Installed/);
  });

  it('отказ загрузки каталога — полоса, установленные виджеты при этом показаны', () => {
    const html = renderToStaticMarkup(
      <Widgets overview={overview} widgets={projectWith([{ id: 'clock', version: '1:1' }])} catalogError="Daemon responded 500" />,
    );
    assert.match(html, /Daemon responded 500/);
    assert.match(html, /Installed/);
  });
});
