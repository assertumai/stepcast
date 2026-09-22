import { useEffect, useState, type FormEvent, type JSX } from 'react';

import type { RouteDefinition } from '../../../src/parts/ui/routes.ts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Label,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@stepcast/ui';
import './routes.css';

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
  readonly navGroup?: RouteFieldSource;
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
  path: 'path',
  target: 'target',
  params: 'target params',
  values: 'value list',
  navTitle: 'menu title',
  navOrder: 'menu order',
  navGroup: 'menu group',
  navActiveFor: 'active for',
  enabled: 'enabled',
};

const FIELD_ORDER: readonly (keyof RouteSources)[] = [
  'path',
  'target',
  'params',
  'values',
  'navTitle',
  'navOrder',
  'navGroup',
  'navActiveFor',
  'enabled',
];

/**
 * Имя источника поля: встроенный слой — словом `bundled`, без пути к файлу
 * поставки (путь внутри релиза ничего пользователю не говорит и меняется с
 * каждой версией); домашний и проектный слои — файлом, который он правит.
 */
function sourceLabel(source: RouteFieldSource): string {
  return source.layer === 'builtin' ? 'bundled' : `${source.file} (${source.layer})`;
}

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
            <span className="dim"> — {sourceLabel(source)}</span>
          </li>
        );
      })}
    </ul>
  );
}

async function fetchRoutes(): Promise<RoutesResponse> {
  const response = await fetch('/api/routes');
  const data = (await response.json()) as RoutesResponse & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `Daemon responded with ${response.status}`);
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
  readonly navGroup: string;
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
  navGroup: '',
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
    navGroup: nav?.group ?? '',
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

function MenuCell({ route }: { readonly route: RouteRow }): JSX.Element {
  const nav = route.nav;
  if (nav === undefined) return <>—</>;
  return (
    <span className="routes-menu-cell">
      <span>
        {nav.title ?? route.target.id}
        {nav.order === undefined ? '' : ` (${nav.order})`}
      </span>
      {nav.group === undefined ? null : <Badge variant="secondary">{nav.group}</Badge>}
    </span>
  );
}

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
      setSaveError('ID, path and target are required');
      return;
    }

    const nav: Record<string, unknown> = {};
    if (form.navTitle.trim() !== '') nav.title = form.navTitle.trim();
    if (form.navOrder.trim() !== '') nav.order = Number(form.navOrder);
    if (form.navGroup.trim() !== '') nav.group = form.navGroup.trim();

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
        if (!response.ok) throw new Error(data.error ?? `Daemon responded with ${response.status}`);
        setForm(EMPTY_FORM);
        reload();
      })
      .catch((error: Error) => setSaveError(error.message))
      .finally(() => setSaving(false));
  };

  if (state.kind === 'loading') return <div className="routes-editor dim">Loading…</div>;
  if (state.kind === 'error') {
    return (
      <div className="routes-editor">
        <Alert variant="destructive">Routes were not loaded: {state.message}</Alert>
      </div>
    );
  }

  const { routes, buildError } = state.data;
  const disabled = state.data.disabled ?? [];
  const editing = form.id !== '';

  return (
    <div className="routes-editor">
      <PageHeader
        title="Routes"
        description="Active routes merged from the bundled, home and project layers, with the source of every field; edit a row or add a new one to write it into a layer file."
        actions={
          editing ? (
            <Button variant="outline" size="sm" onClick={() => setForm(EMPTY_FORM)}>
              New route
            </Button>
          ) : undefined
        }
      />
      {buildError === undefined ? null : (
        <Alert variant="destructive" className="routes-listing-error">
          Route table was not rebuilt: {buildError}
        </Alert>
      )}
      {routes.length === 0 && disabled.length === 0 ? (
        <EmptyState
          className="routes-empty"
          title="No routes"
          description="Nothing is declared in any layer; add the first route with the form below."
        />
      ) : (
        <Table className="routes-table">
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>Path</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Menu</TableHead>
              <TableHead>Field sources</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {routes.map((route) => (
              <TableRow key={route.id}>
                <TableCell>{route.id}</TableCell>
                <TableCell>
                  <code>{route.path}</code>
                </TableCell>
                <TableCell>
                  {route.target.kind}:{route.target.id}
                </TableCell>
                <TableCell>
                  <MenuCell route={route} />
                </TableCell>
                <TableCell>
                  <FieldSources sources={route.sources} />
                </TableCell>
                <TableCell>
                  <Button variant="ghost" size="sm" onClick={() => setForm(formFor(route, true))}>
                    Edit
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {/* Отключённые строки — здесь же, а не спрятаны: маршрут,
                выключенный из витрины, иначе исчезал бы из перечня совсем, и
                включить его обратно можно было бы только правкой файла руками
                (`ui-routes`, Решение 12). Слой формы — тот, в котором лежит
                `enabled: false`: строка «включён» обязана лечь поверх той
                самой, что выключила, а не под ней. */}
            {disabled.map((route) => (
              <TableRow key={`disabled:${route.id}`} className="routes-row-disabled">
                <TableCell>{route.id}</TableCell>
                <TableCell>{route.path === undefined ? '—' : <code>{route.path}</code>}</TableCell>
                <TableCell>{route.target === undefined ? '—' : `${route.target.kind}:${route.target.id}`}</TableCell>
                <TableCell>
                  <Badge variant="secondary">disabled</Badge>
                </TableCell>
                <TableCell className="dim">disabled by {sourceLabel(route.disabledBy)}</TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setForm({
                        ...formFor(route, true),
                        layer: route.disabledBy.layer === 'project' ? 'project' : 'home',
                      })
                    }
                  >
                    Enable
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Card className="routes-form-card">
        <CardHeader>
          <CardTitle>{editing ? `Edit ${form.id}` : 'New route'}</CardTitle>
          <CardDescription>
            {editing
              ? 'The row is written under its own ID into the chosen layer; the bundled file is never touched.'
              : 'Fill in the ID, the path and the target; the menu fields are optional.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={save} className="routes-form">
            <div className="routes-field">
              <Label htmlFor="route-id">ID</Label>
              <Input id="route-id" value={form.id} onChange={(event) => setForm({ ...form, id: event.target.value })} />
            </div>
            <div className="routes-field">
              <Label htmlFor="route-path">Path</Label>
              <Input
                id="route-path"
                className="mono"
                value={form.path}
                onChange={(event) => setForm({ ...form, path: event.target.value })}
                placeholder="/my/path/:param"
              />
            </div>
            <div className="routes-field">
              <Label htmlFor="route-target-kind">Target</Label>
              <Select
                value={form.targetKind}
                onValueChange={(value) => setForm({ ...form, targetKind: value as TargetKind })}
              >
                <SelectTrigger id="route-target-kind" aria-label="Target kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="screen">screen</SelectItem>
                  <SelectItem value="widget">widget</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="routes-field">
              <Label htmlFor="route-target-id">Target ID</Label>
              <Input
                id="route-target-id"
                className="mono"
                value={form.targetId}
                onChange={(event) => setForm({ ...form, targetId: event.target.value })}
                placeholder={form.targetKind === 'widget' ? 'project/id' : 'screen-id'}
              />
            </div>
            <div className="routes-field">
              <Label htmlFor="route-nav-title">Menu title</Label>
              <Input
                id="route-nav-title"
                value={form.navTitle}
                onChange={(event) => setForm({ ...form, navTitle: event.target.value })}
              />
            </div>
            <div className="routes-field">
              <Label htmlFor="route-nav-order">Menu order</Label>
              <Input
                id="route-nav-order"
                value={form.navOrder}
                onChange={(event) => setForm({ ...form, navOrder: event.target.value })}
              />
            </div>
            <div className="routes-field">
              <Label htmlFor="route-nav-group">Group</Label>
              <Input
                id="route-nav-group"
                value={form.navGroup}
                onChange={(event) => setForm({ ...form, navGroup: event.target.value })}
                placeholder="menu group"
              />
            </div>
            <div className="routes-field-inline">
              <Switch
                id="route-enabled"
                checked={form.enabled}
                onCheckedChange={(checked) => setForm({ ...form, enabled: checked })}
              />
              <Label htmlFor="route-enabled">Enabled</Label>
            </div>
            <div className="routes-field">
              <Label htmlFor="route-layer">Layer</Label>
              <Select value={form.layer} onValueChange={(value) => setForm({ ...form, layer: value as Layer })}>
                <SelectTrigger id="route-layer" aria-label="Layer">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="home">home ({LAYER_FILE.home})</SelectItem>
                  <SelectItem value="project">project ({LAYER_FILE.project})</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {saveError === undefined ? null : (
              <Alert variant="destructive" className="routes-listing-error">
                {saveError}
              </Alert>
            )}
            <div className="routes-form-actions">
              <Button type="submit" disabled={saving}>
                Save to {LAYER_FILE[form.layer]}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
