import type { JSX } from 'react';

import type { RouteTable } from '../../../src/parts/ui/routes.ts';
import { Alert, AlertDescription, AlertTitle, PageHeader } from '@stepcast/ui';
import './routes.css';

/** Файл слоя, в который витрина пишет маршруты по умолчанию, — для подсказок на странице. */
export const HOME_ROUTES_FILE = '~/.stepcast/routes.yml';

export interface RoutesNoticeProps {
  readonly pathname: string;
  readonly table: RouteTable;
  /** Причина отказа последней сборки таблицы — не показывается там, где её уже называет соседний вид. */
  readonly buildError?: string | undefined;
  /** Файл слоя, в который пишутся маршруты, — для подсказки на пустой таблице (`ui-routes`, «Таблица пуста»). */
  readonly layerFile: string;
}

/**
 * Причина, по которой вместо цели показан перечень маршрутов (`ui-routes`,
 * «Адрес без маршрута показывает перечень объявленных маршрутов»): адрес не
 * разобран, стартовая страница не объявлена, действующих маршрутов нет вовсе.
 *
 * Отдельный вид, а не часть перечня, потому что перечней два: голый текстовый
 * (ниже) и полный, с источниками и формой правки, от строки `screen-routes`
 * (`ui/src/screens/routes.tsx`). Причина обязана быть названа в обоих — иначе
 * в поставочной конфигурации, где строка включена, пользователь видел бы
 * экран «Маршруты» без единого слова о том, почему он на него попал.
 *
 * Полоса предупреждения, а не заголовок страницы: в поставочной конфигурации
 * она стоит над экраном «Маршруты» с его собственной шапкой, и второй
 * заголовок над первым читался бы как две страницы разом.
 */
export function RoutesNotice({ pathname, table, buildError, layerFile }: RoutesNoticeProps): JSX.Element {
  const hasRoot = table.some((route) => route.path === '/');
  return (
    <div className="routes-notice">
      <Alert variant="warning">
        <AlertTitle>No route matches this address</AlertTitle>
        <AlertDescription>
          <p className="routes-notice-line">
            Opened <code>{pathname}</code>
          </p>
          {pathname === '/' && !hasRoot ? (
            <p className="routes-notice-line">No start page: no route declares the path “/”.</p>
          ) : null}
          {table.length === 0 ? (
            <p className="routes-notice-line">
              No active routes — all are disabled by user layers. Layer file: <code>{layerFile}</code>
            </p>
          ) : null}
        </AlertDescription>
      </Alert>
      {buildError === undefined ? null : (
        <Alert variant="destructive" className="routes-listing-error">
          Route table was not rebuilt: {buildError}
        </Alert>
      )}
    </div>
  );
}

export type RoutesListingProps = RoutesNoticeProps;

/**
 * Перечень объявленных маршрутов на неизвестном адресе — голым текстом, без
 * источников (`ui-routes`, design.md Решение 12): экран «Маршруты»
 * (`ui/src/screens/routes.tsx`) вносит более полный вид с источниками и
 * правкой в тот же ключ слота, если он в действующем составе. Этот компонент
 * — то, что видит пользователь, когда строка отключена или состав экранов
 * ещё не пришёл: витрина не должна становиться пустой страницей из-за того,
 * что выключен один экран (`ui-routes`, Решение 12).
 */
export function RoutesListing({ pathname, table, buildError, layerFile }: RoutesListingProps): JSX.Element {
  return (
    <div className="routes-listing">
      <PageHeader
        title="Routes"
        description="Every path the dashboard currently resolves and the target it opens; enable the Routes screen to edit them."
      />
      <RoutesNotice pathname={pathname} table={table} buildError={buildError} layerFile={layerFile} />
      {table.length === 0 ? null : (
        <ul className="routes-plain-list">
          {table.map((route) => (
            <li key={route.id}>
              <code>{route.path}</code> → {route.target.kind}:{route.target.id}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
