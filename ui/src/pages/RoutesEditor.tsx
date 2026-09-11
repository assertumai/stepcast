import { useEffect, useState, type FormEvent, type JSX } from 'react';

import type { RouteDefinition } from '../../../src/ui/routes.ts';

/**
 * Экран «Маршруты»: перечень действующих маршрутов с источником каждого
 * поля и диагностикой, добавление и правка через `POST /api/routes`
 * (`ui-routes`, design.md Решение 11, 12). Та же половина вносится и в
 * ключ перечня на неизвестном адресе (`ui/src/screens/routes.tsx`) — строка
 * состава одна, каркас лишь выбирает, где её показать.
 */

interface RouteFieldSource {
  readonly layer: 'builtin' | 'home' | 'project';
  readonly file: string;
}

interface RouteSources {
  readonly path: RouteFieldSource;
  readonly target: RouteFieldSource;
  readonly params?: RouteFieldSource;
  readonly values?: RouteFieldSource;
  readonly navTitle?: RouteFieldSource;
  readonly navOrder?: RouteFieldSource;
  readonly navActiveFor?: RouteFieldSource;
  readonly enabled?: RouteFieldSource;
}

interface RouteRow extends RouteDefinition {
  readonly sources: RouteSources;
}

/** Отключённая строка: в действующей таблице её нет, но включить её обратно — та же форма (`ui-routes`, Решение 12). */
interface DisabledRouteRow {
  readonly id: string;
  readonly path?: string;
  readonly target?: { readonly kind: string; readonly id: string };
  readonly nav?: RouteDefinition['nav'];
  readonly disabledBy: RouteFieldSource;
}

interface RoutesResponse {
  readonly routes: readonly RouteRow[];
  readonly disabled?: readonly DisabledRouteRow[];
  readonly buildError?: string;
}

/** Подписи полей строки маршрута — перечень источников читается человеком, а не по именам ключей ответа. */
const FIELD_LABEL: Readonly<Record<keyof RouteSources, string>> = {
  path: 'путь',
  target: 'цель',
  params: 'параметры цели',
  values: 'перечень значений',
  navTitle: 'название пункта',
  navOrder: 'порядок пункта',
  navActiveFor: 'подсветка',
  enabled: 'включённость',
};

const FIELD_ORDER: readonly (keyof RouteSources)[] = [
  'path',
  'target',
  'params',
  'values',
  'navTitle',
  'navOrder',
  'navActiveFor',
  'enabled',
];

/**
 * Источник каждого поля, а не одной лишь строки (`ui-routes`, «Перечень с
 * источниками»; design.md Решение 2): слияние идёт по листьям, и случай «путь
 * из проектного файла, название пункта — из домашнего» должен быть виден
 * здесь, иначе слияние по листьям нечем и проверить.
 */
function FieldSources({ sources }: { readonly sources: RouteSources }): JSX.Element {
  return (
    <ul className="routes-sources">
      {FIELD_ORDER.filter((field) => sources[field] !== undefined).map((field) => {
        const source = sources[field] as RouteFieldSource;
        return (
          <li key={field}>
            <span className="routes-source-field">{FIELD_LABEL[field]}</span>
            <span className="dim"> — {source.file} ({source.layer})</span>
          </li>
        );
      })}
    </ul>
  );
}

async function fetchRoutes(): Promise<RoutesResponse> {
  const response = await fetch('/api/routes');
  const data = (await response.json()) as RoutesResponse & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `Демон ответил ${response.status}`);
  return data;
}

type TargetKind = 'screen' | 'widget';
type Layer = 'home' | 'project';

interface FormState {
  readonly id: string;
  readonly path: string;
  readonly targetKind: TargetKind;
  readonly targetId: string;
  readonly navTitle: string;
  readonly navOrder: string;
  readonly enabled: boolean;
  readonly layer: Layer;
}

const EMPTY_FORM: FormState = {
  id: '',
  path: '',
  targetKind: 'screen',
  targetId: '',
  navTitle: '',
  navOrder: '',
  enabled: true,
  layer: 'home',
};

/**
 * Форма из строки таблицы — правка встроенного маршрута предзаполняет форму
 * его действующими значениями, а сохранение (Решение 11) кладёт их строкой
 * своего `id` в выбранный слой, не трогая встроенный файл поставки.
 *
 * Признак включённости берётся из самой строки, а не ставится в `true`:
 * отключённая строка правится той же формой, и снятая галочка обязана
 * пережить открытие формы — иначе включение обратно было бы единственным, что
 * форма умеет делать с отключённым маршрутом.
 */
function formFor(route: RouteRow | DisabledRouteRow, enabled: boolean): FormState {
  const target = route.target;
  const nav = route.nav;
  return {
    id: route.id,
    path: route.path ?? '',
    targetKind: target?.kind === 'widget' ? 'widget' : 'screen',
    targetId: target?.id ?? '',
    navTitle: nav?.title ?? '',
    navOrder: nav?.order === undefined ? '' : String(nav.order),
    enabled,
    layer: 'home',
  };
}

const LAYER_FILE: Readonly<Record<Layer, string>> = {
  home: '~/.stepcast/routes.yml',
  project: '.stepcast/routes.yml',
};

type LoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly data: RoutesResponse }
  | { readonly kind: 'error'; readonly message: string };

export function RoutesEditor(): JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  const reload = (): void => {
    void fetchRoutes()
      .then((data) => setState({ kind: 'ready', data }))
      .catch((error: Error) => setState({ kind: 'error', message: error.message }));
  };

  useEffect(reload, []);

  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (form.id.trim() === '' || form.path.trim() === '' || form.targetId.trim() === '') {
      setSaveError('id, путь и цель обязательны');
      return;
    }

    const nav: Record<string, unknown> = {};
    if (form.navTitle.trim() !== '') nav.title = form.navTitle.trim();
    if (form.navOrder.trim() !== '') nav.order = Number(form.navOrder);

    const route: Record<string, unknown> = {
      id: form.id.trim(),
      path: form.path.trim(),
      target: form.targetKind === 'screen' ? { screen: form.targetId.trim() } : { widget: form.targetId.trim() },
      ...(Object.keys(nav).length > 0 ? { nav } : {}),
      // Признак пишется всегда, а не только когда он `false`: включённая
      // строка обязана перебивать `enabled: false` нижнего слоя, иначе
      // маршрут, отключённый однажды, витрина включить бы не смогла.
      enabled: form.enabled,
    };

    setSaving(true);
    setSaveError(undefined);
    fetch('/api/routes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ layer: form.layer, route }),
    })
      .then(async (response) => {
        const data = (await response.json()) as { error?: string };
        if (!response.ok) throw new Error(data.error ?? `Демон ответил ${response.status}`);
        setForm(EMPTY_FORM);
        reload();
      })
      .catch((error: Error) => setSaveError(error.message))
      .finally(() => setSaving(false));
  };

  if (state.kind === 'loading') return <div className="routes-editor dim">Загрузка…</div>;
  if (state.kind === 'error') {
    return <div className="routes-editor screen-error">Маршруты не получены: {state.message}</div>;
  }

  const { routes, buildError } = state.data;
  const disabled = state.data.disabled ?? [];

  return (
    <div className="routes-editor">
      <h1>Маршруты</h1>
      {buildError === undefined ? null : (
        <p className="routes-listing-error" role="alert">
          Таблица маршрутов не пересобрана: {buildError}
        </p>
      )}
      <table className="routes-table">
        <thead>
          <tr>
            <th>id</th>
            <th>путь</th>
            <th>цель</th>
            <th>меню</th>
            <th>источники полей</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {routes.map((route) => (
            <tr key={route.id}>
              <td>{route.id}</td>
              <td>
                <code>{route.path}</code>
              </td>
              <td>
                {route.target.kind}:{route.target.id}
              </td>
              <td>
                {route.nav === undefined
                  ? '—'
                  : `${route.nav.title ?? route.target.id}${route.nav.order === undefined ? '' : ` (${route.nav.order})`}`}
              </td>
              <td>
                <FieldSources sources={route.sources} />
              </td>
              <td>
                <button type="button" onClick={() => setForm(formFor(route, true))}>
                  править
                </button>
              </td>
            </tr>
          ))}
          {/* Отключённые строки — здесь же, а не спрятаны: маршрут,
              выключенный из витрины, иначе исчезал бы из перечня совсем, и
              включить его обратно можно было бы только правкой файла руками
              (`ui-routes`, Решение 12). Слой формы — тот, в котором лежит
              `enabled: false`: строка «включён» обязана лечь поверх той
              самой, что выключила, а не под ней. */}
          {disabled.map((route) => (
            <tr key={`disabled:${route.id}`} className="routes-row-disabled">
              <td>{route.id}</td>
              <td>{route.path === undefined ? '—' : <code>{route.path}</code>}</td>
              <td>{route.target === undefined ? '—' : `${route.target.kind}:${route.target.id}`}</td>
              <td className="dim">отключён</td>
              <td className="dim">
                отключён файлом {route.disabledBy.file} ({route.disabledBy.layer})
              </td>
              <td>
                <button
                  type="button"
                  onClick={() =>
                    setForm({
                      ...formFor(route, true),
                      layer: route.disabledBy.layer === 'project' ? 'project' : 'home',
                    })
                  }
                >
                  включить
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>{form.id === '' ? 'Новый маршрут' : `Правка ${form.id}`}</h2>
      <form onSubmit={save} className="routes-form">
        <label>
          id
          <input value={form.id} onChange={(event) => setForm({ ...form, id: event.target.value })} />
        </label>
        <label>
          путь
          <input
            value={form.path}
            onChange={(event) => setForm({ ...form, path: event.target.value })}
            placeholder="/мой/путь/:параметр"
          />
        </label>
        <label>
          цель
          <select
            value={form.targetKind}
            onChange={(event) => setForm({ ...form, targetKind: event.target.value as TargetKind })}
          >
            <option value="screen">экран</option>
            <option value="widget">виджет</option>
          </select>
        </label>
        <label>
          id цели
          <input
            value={form.targetId}
            onChange={(event) => setForm({ ...form, targetId: event.target.value })}
            placeholder={form.targetKind === 'widget' ? 'проект/id' : 'screen-id'}
          />
        </label>
        <label>
          название пункта меню
          <input value={form.navTitle} onChange={(event) => setForm({ ...form, navTitle: event.target.value })} />
        </label>
        <label>
          порядок пункта
          <input value={form.navOrder} onChange={(event) => setForm({ ...form, navOrder: event.target.value })} />
        </label>
        <label>
          <input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />
          включён
        </label>
        <label>
          слой
          <select value={form.layer} onChange={(event) => setForm({ ...form, layer: event.target.value as Layer })}>
            <option value="home">домашний ({LAYER_FILE.home})</option>
            <option value="project">проектный ({LAYER_FILE.project})</option>
          </select>
        </label>
        {saveError === undefined ? null : (
          <p className="routes-listing-error" role="alert">
            {saveError}
          </p>
        )}
        <button type="submit" disabled={saving}>
          Сохранить в {LAYER_FILE[form.layer]}
        </button>
      </form>
    </div>
  );
}
